import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import type { Role } from '../types.js'

/** The seeded default workspace id (migration 018). Rows without an explicit
 * workspace value belong to this workspace. */
export const DEFAULT_WORKSPACE = '00000000-0000-0000-0000-000000000001'

/** Returns the default workspace id. Kept as a function so callers don't
 * hard-code the constant and a future DB-driven default stays a drop-in. */
export function getDefaultWorkspaceId(): string {
  return DEFAULT_WORKSPACE
}

export function isDefaultWorkspace(id: string | null | undefined): boolean {
  return !id || id === DEFAULT_WORKSPACE
}

// ─── Default workspace lookup (cached) ────────────────────────────────────────

// Keyed by tenant: in cloud mode one process serves many tenants, and a
// tenant without the seeded row falls back to its own oldest workspace.
const _defaultWorkspaceIds = new Map<string, string>()

/**
 * Returns the default workspace id from the DB, cached for the process lifetime
 * (per tenant). Prefers the seeded default UUID; falls back to the oldest
 * workspace row, then the constant. Rows / collections without a workspace
 * value belong to this id.
 */
export async function fetchDefaultWorkspaceId(): Promise<string> {
  const tenant = currentTenantKey()
  const cached = _defaultWorkspaceIds.get(tenant)
  if (cached) return cached
  try {
    const seeded = await db('nivaro_workspaces')
      .where({ id: DEFAULT_WORKSPACE })
      .select('id')
      .first()
    if (seeded) {
      _defaultWorkspaceIds.set(tenant, DEFAULT_WORKSPACE)
      return DEFAULT_WORKSPACE
    }
    const first = (await db('nivaro_workspaces').orderBy('created_at').select('id').first()) as
      | { id: string }
      | undefined
    const id = first?.id ?? DEFAULT_WORKSPACE
    _defaultWorkspaceIds.set(tenant, id)
    return id
  } catch {
    // Table missing (pre-migration) — fall back to the constant without caching.
    return DEFAULT_WORKSPACE
  }
}

/** Test helper / invalidation after workspace deletion. */
export function clearDefaultWorkspaceCache(): void {
  _defaultWorkspaceIds.clear()
}

// ─── Workspace membership ─────────────────────────────────────────────────────

/**
 * May this caller work in `workspaceId`? There is no membership table: a role's
 * own workspace is its membership. Admins may use any workspace, anyone may use
 * the default one, a role with no workspace may use any, and a role tied to a
 * workspace only that one. The same rule as POST /workspaces/:id/switch
 * (routes/workspaces.ts mayUseWorkspace), but synchronous: it reads the role row
 * authenticate already loaded, so it costs nothing per request.
 */
export function workspaceAllowed(
  isAdmin: boolean | undefined,
  role: Pick<Role, 'workspace'> | null | undefined,
  workspaceId: string,
  defaultId: string
): boolean {
  if (isAdmin) return true
  const want = workspaceId.toLowerCase()
  if (want === defaultId.toLowerCase()) return true
  if (!role) return false
  return !role.workspace || String(role.workspace).toLowerCase() === want
}

// The x-workspace header and default id parked by resolveWorkspace when it ran
// before the request was signed in (the app-level hook runs before every
// route's authenticate); settleWorkspaceHeader decides once identity is known.
const PENDING = Symbol('nivaro.workspaceHeader')
type Parked = { header: string; defaultId: string }
type ParkedRequest = FastifyRequest & { [PENDING]?: Parked }

function headerValue(req: FastifyRequest): string | undefined {
  const raw = req.headers['x-workspace']
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  return v || undefined
}

/** The workspace for a signed-in caller: the header when they may use it, else
 * their current workspace, else the default. */
function pickForUser(req: FastifyRequest, header: string | undefined, defaultId: string): string {
  if (header && workspaceAllowed(req.isAdmin, req.userRole, header, defaultId)) return header
  return (req.user?.current_workspace as string | null | undefined) ?? defaultId
}

/**
 * Call once the request's identity is known (authenticate's hydrateRole). A
 * header parked before sign-in is honoured only for a workspace the caller may
 * use; otherwise the caller's current workspace, then the default. No-op when
 * nothing is parked. Synchronous — no DB.
 */
export function settleWorkspaceHeader(req: FastifyRequest): void {
  const parked = (req as ParkedRequest)[PENDING]
  if (!parked) return
  delete (req as ParkedRequest)[PENDING]
  if (!req.user) return
  req.workspaceId = pickForUser(req, parked.header, parked.defaultId)
}

export async function resolveWorkspace(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Header first (API clients, the admin app), then the user's
  // current_workspace, then the default. The header is honoured only for a
  // workspace the caller belongs to (workspaceAllowed).
  const header = headerValue(req)
  const defaultId = await fetchDefaultWorkspaceId()
  if (req.user?.id) {
    delete (req as ParkedRequest)[PENDING]
    if (header || req.user.current_workspace !== undefined) {
      req.workspaceId = pickForUser(req, header, defaultId)
      return
    }
    // A user object without the column (some test / service callers): read it.
    try {
      const user = await db('nivaro_users')
        .where({ id: req.user.id })
        .select('current_workspace')
        .first()
      req.workspaceId = (user?.current_workspace as string | null) ?? defaultId
      return
    } catch {
      // fall through to default
    }
  } else if (header) {
    // Not signed in yet: never trust the header on its own. Park it for
    // settleWorkspaceHeader; until then the request is in the default workspace.
    ;(req as ParkedRequest)[PENDING] = { header, defaultId }
  }
  req.workspaceId = defaultId
}
