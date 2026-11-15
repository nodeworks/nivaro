import { db } from '../db/index.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { ACCESS_ROUTES, announceAccessChanged } from './record-events.js'

/**
 * Permission changes apply live (rt2 #18). A role, policy (field lists included), UI permission,
 * User Scope, tree permission or scope dimension change reaches the people it affects while they
 * are signed in: `access:changed {at, perms: true}` to their own user rooms (a "View as" tab is
 * the viewed person's socket, so it follows that person's permissions). The shared client
 * (packages/shared lib/user-sync.ts) refetches the signed-in user (menus, buttons) and every
 * query on screen as the viewer (fields, list rows); an open record they can no longer read
 * turns to the calm "You no longer have access" state (#1925, RecordLiveSync).
 *
 * Targeting — never more people than the change can touch:
 *   one person's row, scopes, copy-access, offboarding      → that person
 *   a bulk change naming people (users/bulk, user-scopes/bulk) → those people
 *   a role, its UI permissions or policies                  → the people holding that role
 *   an access request granted                               → the requester's role
 *   a person picking their own scope                        → that person
 *   everything else (dimensions, tree permissions, a role deleted, a policy deleted) → the tenant
 *
 * A role with more than ROLE_FANOUT_MAX people is told tenant-wide (one emit beats thousands).
 * Payloads carry no ids beyond the room they ride and no values.
 */

export const ROLE_FANOUT_MAX = 1000

export type PermissionTarget =
  | { kind: 'tenant' }
  | { kind: 'users'; ids: string[] }
  | { kind: 'roles'; ids: string[] }
  | { kind: 'policy'; id: string }
  | { kind: 'access-request'; id: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ONE_PERSON = new RegExp(
  `^/api/(?:users|user-scopes|offboarding|items/nivaro_users)/(${UUID})(?:/(?!impact\\b)[^?]*)?$`,
  'i'
)
const ITEMS_ACCESS_TABLE =
  /^\/api\/items\/(?:nivaro_roles|nivaro_policies|nivaro_user_scopes|nivaro_tree_permissions|nivaro_scope_dimensions)(?:[/?]|$)/
const READ_LIKE = /\/(impact|simulate|row-filter-impact|preview|coverage|dry-run)\b/

function idsFrom(body: unknown, key: string): string[] {
  const v = (body as Record<string, unknown> | null | undefined)?.[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

/**
 * Who a successful write should tell that their permissions moved; null = nobody. Pure — the
 * route hook resolves roles / policies / access requests to people. Exported for tests.
 */
export function permissionTarget(req: {
  method: string
  url: string
  isAdmin?: boolean
  user?: { id?: string } | null
  body?: unknown
}): PermissionTarget | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null
  const path = req.url.split('?')[0]
  const self = req.user?.id ? String(req.user.id) : null
  // A person narrowing their own scopes: only them (the one access write a non-admin makes).
  if (/^\/api\/users\/me\/scopes\b/.test(path)) return self ? { kind: 'users', ids: [self] } : null
  if (!req.isAdmin) return null
  if (READ_LIKE.test(path)) return null
  const access = ACCESS_ROUTES.test(req.url) || ITEMS_ACCESS_TABLE.test(path)
  const person = ONE_PERSON.exec(path)
  if (!access && !person) return null
  if (/^\/api\/users\/cards\b/.test(path)) return null
  if (person) return { kind: 'users', ids: [person[1]] }
  if (/^\/api\/users\/bulk\b/.test(path)) {
    const ids = idsFrom(req.body, 'ids')
    return ids.length ? { kind: 'users', ids } : { kind: 'tenant' }
  }
  if (/^\/api\/user-scopes\/bulk\b/.test(path)) {
    const ids = idsFrom(req.body, 'user_ids')
    return ids.length ? { kind: 'users', ids } : { kind: 'tenant' }
  }
  const policy = /^\/api\/roles\/policies\/([^/]+)$/.exec(path)
  if (policy)
    return req.method === 'DELETE' ? { kind: 'tenant' } : { kind: 'policy', id: policy[1] }
  const role = /^\/api\/roles\/([^/]+)(?:\/(ui-permissions|policies))?$/.exec(path)
  if (role) {
    // A new role holds nobody yet; a deleted one can no longer be asked who held it.
    if (!role[2] && req.method === 'POST') return null
    if (!role[2] && req.method === 'DELETE') return { kind: 'tenant' }
    return { kind: 'roles', ids: [role[1]] }
  }
  if (path === '/api/roles') return null
  const request = /^\/api\/access-requests\/([^/]+)\/resolve$/.exec(path)
  if (request) return { kind: 'access-request', id: request[1] }
  return { kind: 'tenant' }
}

export interface PermissionLookups {
  roleOfPolicy: (policyId: string) => Promise<string | null>
  roleOfAccessRequest: (requestId: string) => Promise<string | null>
  /** People holding any of the roles; null when more than `max`. */
  peopleInRoles: (roleIds: string[], max: number) => Promise<string[] | null>
}

const dbLookups: PermissionLookups = {
  async roleOfPolicy(id) {
    const row = (await db('nivaro_policies').where({ id }).first('role')) as
      | { role?: string | null }
      | undefined
    return row?.role ? String(row.role) : null
  },
  async roleOfAccessRequest(id) {
    const row = (await db('nivaro_access_requests as r')
      .leftJoin('nivaro_users as u', 'u.id', 'r.user')
      .where('r.id', id)
      .first('u.role as role')) as { role?: string | null } | undefined
    return row?.role ? String(row.role) : null
  },
  async peopleInRoles(roleIds, max) {
    const rows = (await selectInChunks(roleIds, 500, (chunk) =>
      whereInList(db('nivaro_users'), 'role', chunk)
        .whereNull('account_kind')
        .limit(max + 1)
        .select('id')
    )) as Array<{ id: string }>
    if (rows.length > max) return null
    return rows.map((r) => String(r.id))
  }
}

/** Resolve a target to the people to tell ('tenant' = everyone). Exported for tests. */
export async function permissionAudience(
  target: PermissionTarget,
  lookups: PermissionLookups = dbLookups
): Promise<'tenant' | string[]> {
  switch (target.kind) {
    case 'tenant':
      return 'tenant'
    case 'users':
      return [...new Set(target.ids)]
    case 'roles': {
      const people = await lookups.peopleInRoles(target.ids, ROLE_FANOUT_MAX)
      return people ?? 'tenant'
    }
    case 'policy': {
      const role = await lookups.roleOfPolicy(target.id)
      if (!role) return 'tenant'
      return (await lookups.peopleInRoles([role], ROLE_FANOUT_MAX)) ?? 'tenant'
    }
    case 'access-request': {
      const role = await lookups.roleOfAccessRequest(target.id)
      if (!role) return 'tenant'
      return (await lookups.peopleInRoles([role], ROLE_FANOUT_MAX)) ?? 'tenant'
    }
  }
}

/**
 * rt4 #12: a person's socket joins `user:<id>` with the id as the database gives it (upper
 * case on SQL Server), while an id taken from a request path is spelled as the caller wrote
 * it. Both spellings are told (only one room exists), so a person waiting on the Request
 * access screen hears an approval made through a lower-case link. Exported for tests.
 */
export function userRoomSpellings(ids: readonly string[]): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    out.add(id)
    out.add(id.toUpperCase())
    out.add(id.toLowerCase())
  }
  return [...out]
}

/** The onResponse step: tell the affected people (best-effort, never throws). */
export async function announcePermissionChange(
  target: PermissionTarget,
  lookups: PermissionLookups = dbLookups,
  announce: (opts: { userId?: string }) => void = announceAccessChanged
): Promise<void> {
  try {
    const audience = await permissionAudience(target, lookups)
    if (audience === 'tenant') announce({})
    else for (const userId of userRoomSpellings(audience)) announce({ userId })
  } catch {
    // Could not tell who: tell everyone (a refetch beats a stale menu).
    announce({})
  }
}
