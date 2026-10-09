import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { isFilesCollection, whereNotHelpVideoFile } from './help-video-files.js'
import { applyRowFilter, can, getAllowedFields, getRowFilter, scopeAllows } from './permissions.js'
import {
  applyScopeEnforcement,
  getUserScopeEnforcement,
  type ScopeEnforcement
} from './user-scopes.js'

/**
 * Read gates for NESTED GraphQL fields.
 *
 * A top-level GraphQL list goes through readItems and gets every gate. The
 * fields nested under it — `orders { lines { … } customer { … } }` — are
 * resolved with plain queries, and used to apply none: no read permission on
 * the related collection, no row filter, no user scopes, no field narrowing.
 * A role allowed to read orders could read every line, customer and tag
 * reachable from one, whatever its own policy on those collections said.
 *
 * The gate for (caller, collection) is compiled once per request and applied
 * to each nested query as a subquery on the related table, so column names
 * in a row filter can never collide with the junction the query joins.
 * A caller with nothing to enforce (an admin, a role with no row filter and
 * no scopes) pays for the permission check once and nothing per row.
 */

export interface NestedGate {
  /** May the caller read this collection at all. */
  allowed: boolean
  /** Nothing to enforce beyond `allowed` — queries run untouched. */
  open: boolean
  rowFilter: unknown | null
  scopes: ScopeEnforcement
  /** Fields the caller's policy allows; null = all. */
  fields: Set<string> | null
}

const DENY: NestedGate = {
  allowed: false,
  open: false,
  rowFilter: null,
  scopes: { filters: [], deny: true },
  fields: null
}
const OPEN: NestedGate = {
  allowed: true,
  open: true,
  rowFilter: null,
  scopes: { filters: [], deny: false },
  fields: null
}

/** File rows hang off records the caller was already allowed to read. */
const PARENT_GATED = new Set(['nivaro_files'])

const perRequest = new WeakMap<object, Map<string, Promise<NestedGate>>>()

async function compile(user: User, isAdmin: boolean, collection: string): Promise<NestedGate> {
  // An API key's scopes narrow whatever its owner may read, an administrator
  // included — the same rule can() applies to every REST read.
  if (user.api_key_scopes && !scopeAllows(user.api_key_scopes, 'read', collection)) return DENY
  const keyRestricted = (user.api_key_scope_restrictions ?? []).length > 0
  if (isAdmin && !keyRestricted) return OPEN
  if (PARENT_GATED.has(collection)) return OPEN
  const system = /^(nivaro_|directus_)/i.test(collection)
  if (system && !isAdmin) return DENY
  const [allowed, rowFilter, scopes, allowedFields] = await Promise.all([
    isAdmin ? true : can(user, 'read', collection),
    isAdmin ? null : getRowFilter(user, 'read', collection),
    getUserScopeEnforcement(user, collection),
    isAdmin ? null : getAllowedFields(user, 'read', collection)
  ])
  if (!allowed) return DENY
  const fields = allowedFields && !allowedFields.includes('*') ? new Set(allowedFields) : null
  const open = !rowFilter && !scopes.deny && scopes.filters.length === 0 && !fields
  return { allowed: true, open, rowFilter: rowFilter ?? null, scopes, fields }
}

/**
 * The gate for one related collection, for this request's caller. `ctx` is
 * the GraphQL context object — one per request — which keys the memo.
 */
export function nestedGate(
  ctx: { user?: User; isAdmin?: boolean },
  collection: string
): Promise<NestedGate> {
  if (!ctx.user) return Promise.resolve(DENY)
  let byCollection = perRequest.get(ctx)
  if (!byCollection) {
    byCollection = new Map()
    perRequest.set(ctx, byCollection)
  }
  let gate = byCollection.get(collection)
  if (!gate) {
    gate = compile(ctx.user, !!ctx.isAdmin, collection).catch(() => DENY)
    byCollection.set(collection, gate)
  }
  return gate
}

/**
 * Narrow a query over `collection` (possibly joined to other tables) to the
 * rows the caller may read. Returns false when nothing may be read — the
 * caller answers with an empty result and runs no query.
 */
export function applyNestedGate(
  q: Knex.QueryBuilder,
  collection: string,
  gate: NestedGate,
  user: User
): boolean {
  if (!gate.allowed || gate.scopes.deny) return false
  // Help-video recordings, renders and posters never read as nested file rows.
  if (isFilesCollection(collection)) whereNotHelpVideoFile(q, `${collection}.id`)
  if (gate.open) return true
  if (!gate.rowFilter && gate.scopes.filters.length === 0) return true
  const visible = db(collection).select(`${collection}.id`)
  if (gate.rowFilter) applyRowFilter(visible, gate.rowFilter as never, user)
  applyScopeEnforcement(visible, collection, gate.scopes)
  void q.whereIn(`${collection}.id`, visible)
  return true
}

/** Drop the fields the caller's policy does not allow. `id` always stays. */
export function narrowNestedRow<T extends Record<string, unknown>>(row: T, gate: NestedGate): T {
  if (!gate.fields) return row
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id' || k.startsWith('__') || gate.fields.has(k)) out[k] = v
  }
  return out as T
}
