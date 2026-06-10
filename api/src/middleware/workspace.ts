import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'

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

let _defaultWorkspaceId: string | null = null

/**
 * Returns the default workspace id from the DB, cached for the process lifetime.
 * Prefers the seeded default UUID; falls back to the oldest workspace row, then
 * the constant. Rows / collections without a workspace value belong to this id.
 */
export async function fetchDefaultWorkspaceId(): Promise<string> {
  if (_defaultWorkspaceId) return _defaultWorkspaceId
  try {
    const seeded = await db('nivaro_workspaces')
      .where({ id: DEFAULT_WORKSPACE })
      .select('id')
      .first()
    if (seeded) {
      _defaultWorkspaceId = DEFAULT_WORKSPACE
      return _defaultWorkspaceId
    }
    const first = (await db('nivaro_workspaces').orderBy('created_at').select('id').first()) as
      | { id: string }
      | undefined
    _defaultWorkspaceId = first?.id ?? DEFAULT_WORKSPACE
    return _defaultWorkspaceId
  } catch {
    // Table missing (pre-migration) — fall back to the constant without caching.
    return DEFAULT_WORKSPACE
  }
}

/** Test helper / invalidation after workspace deletion. */
export function clearDefaultWorkspaceCache(): void {
  _defaultWorkspaceId = null
}

export async function resolveWorkspace(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Header takes priority (for API clients), then user's current_workspace, then default
  const header = req.headers['x-workspace'] as string | undefined
  if (header) {
    req.workspaceId = header
    return
  }
  if (req.user?.id) {
    try {
      const user = await db('nivaro_users')
        .where({ id: req.user.id })
        .select('current_workspace')
        .first()
      req.workspaceId =
        (user?.current_workspace as string | null) ?? (await fetchDefaultWorkspaceId())
      return
    } catch {
      // fall through to default
    }
  }
  req.workspaceId = await fetchDefaultWorkspaceId()
}
