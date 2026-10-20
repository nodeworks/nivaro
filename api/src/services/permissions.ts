import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { Policy, Role, User } from '../types.js'
import { cachedAccess } from './permission-cache.js'
import { isSystemCollection, systemReadableColumns } from './system-collections.js'

export type Action = 'create' | 'read' | 'update' | 'delete'

// ─── Row-Level Security ───────────────────────────────────────────────────────

export interface RowCondition {
  field: string
  op: string
  value?: unknown
}

export const ROW_FILTER_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'null',
  'nnull'
] as const

/** Parse + validate a row_filter JSON string. Returns null when absent/invalid/empty. */
export function parseRowFilter(raw: unknown): RowCondition[] | null {
  if (!raw) return null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const valid = parsed.every(
    (c) =>
      c !== null &&
      typeof c === 'object' &&
      typeof (c as RowCondition).field === 'string' &&
      (c as RowCondition).field.length > 0 &&
      (ROW_FILTER_OPS as readonly string[]).includes((c as RowCondition).op)
  )
  return valid ? (parsed as RowCondition[]) : null
}

/**
 * Read the row-level security filter from the matching policy for a user +
 * action + collection. Admins always get null (no filter). Policies without a
 * row_filter return null — fully opt-in, existing behavior unchanged.
 */
export async function getRowFilter(
  user: User,
  action: Action,
  collection: string
): Promise<RowCondition[] | null> {
  if (!user.role) return null
  return cachedAccess(
    user,
    'row-filter',
    `${action}\u0001${collection}`,
    () => roleRowFilter(user, action, collection),
    cloneConditions
  )
}

function cloneConditions(v: RowCondition[] | null): RowCondition[] | null {
  return v === null ? null : structuredClone(v)
}

async function roleRowFilter(
  user: User,
  action: Action,
  collection: string
): Promise<RowCondition[] | null> {
  const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
  if (!role || role.admin_access) return null

  // A system table answers only to a policy naming it; can() refuses a read
  // that only a filtered wildcard would admit, so this never reads unfiltered.
  const system = isSystemCollection(collection)
  const policy = (await db('nivaro_policies')
    .where({ role: user.role, action })
    .where((qb) => {
      qb.where({ collection })
      if (!system) qb.orWhere({ collection: '*' })
    })
    // Prefer an exact-collection policy over the wildcard when both exist
    .orderByRaw(`CASE WHEN collection = '*' THEN 1 ELSE 0 END`)
    .first()) as { row_filter?: string | null } | undefined

  if (!policy) return null
  return parseRowFilter(policy.row_filter)
}

/** Substitute dynamic tokens before binding. */
function resolveValue(value: unknown, user: User): unknown {
  if (value === '$CURRENT_USER') return user.id
  if (value === '$CURRENT_ROLE') return user.role
  return value
}

/**
 * Apply parsed row filter conditions onto a knex query builder. Conditions are
 * ANDed. All values go through bindings; field names are bound via ??.
 */
export function applyRowFilter(
  query: Knex.QueryBuilder,
  conditions: RowCondition[],
  user: User
): void {
  for (const c of conditions) {
    const field = db.raw('??', [c.field])
    const val = resolveValue(c.value, user)
    switch (c.op) {
      case 'eq':
        query.where(field, '=', val as Knex.Value)
        break
      case 'neq':
        query.where(field, '!=', val as Knex.Value)
        break
      case 'gt':
        query.where(field, '>', val as Knex.Value)
        break
      case 'gte':
        query.where(field, '>=', val as Knex.Value)
        break
      case 'lt':
        query.where(field, '<', val as Knex.Value)
        break
      case 'lte':
        query.where(field, '<=', val as Knex.Value)
        break
      case 'contains':
        query.where(field, 'like', `%${val}%`)
        break
      case 'in': {
        const list = Array.isArray(val)
          ? val
          : String(val ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        query.whereIn(
          field as unknown as string,
          list.map((v) => resolveValue(v, user)) as Knex.Value[]
        )
        break
      }
      case 'null':
        query.whereNull(field as unknown as string)
        break
      case 'nnull':
        query.whereNotNull(field as unknown as string)
        break
    }
  }
}

/** Whether a key's scope list covers one action on one collection. */
export function scopeAllows(
  scopes: Array<{ collection: string; actions: string[] }>,
  action: string,
  collection: string
): boolean {
  return scopes.some(
    (s) =>
      (s.collection === '*' || s.collection === collection) &&
      Array.isArray(s.actions) &&
      (s.actions.includes('*') || s.actions.includes(action))
  )
}

/** A scope list that restricts nothing. */
export function scopesAreOpen(scopes: Array<{ collection: string; actions: string[] }>): boolean {
  return scopes.some(
    (s) => s.collection === '*' && Array.isArray(s.actions) && s.actions.includes('*')
  )
}

export async function can(user: User, action: Action, collection: string): Promise<boolean> {
  if (!user.role) return false
  // An API key's scopes come first: they narrow whatever the owner may do,
  // an administrator included.
  if (user.api_key_scopes && !scopeAllows(user.api_key_scopes, action, collection)) {
    user.api_key_scope_denied = { action, collection }
    return false
  }
  return cachedAccess(
    user,
    'can',
    `${action}\u0001${collection}`,
    () => roleCan(user, action, collection),
    sameValue
  )
}

function sameValue<T>(v: T): T {
  return v
}

/** What the role's policies say (the part of can() after the key's own scopes). */
async function roleCan(user: User, action: Action, collection: string): Promise<boolean> {
  const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
  if (!role) return false
  if (role.admin_access) return true
  // A non-admin never writes a system table, and reads only the listed ones
  // (still through a policy, the wildcard included, so nobody gains a read).
  if (isSystemCollection(collection) && (action !== 'read' || !systemReadableColumns(collection)))
    return false

  const policy = (await db<Policy>('nivaro_policies')
    .where({ role: user.role, action })
    .where((qb) => {
      qb.where({ collection }).orWhere({ collection: '*' })
    })
    // An exact-collection policy wins over the wildcard when both exist.
    .orderByRaw(`CASE WHEN collection = '*' THEN 1 ELSE 0 END`)
    .first()) as (Policy & { row_filter?: string | null }) | undefined

  if (!policy) return false
  // A system table reached only through the wildcard is read unfiltered (its
  // row filter speaks of business columns), so a filtered wildcard reads none:
  // a role meant to read people under a filter holds an explicit policy.
  if (isSystemCollection(collection) && policy.collection === '*') {
    const filter = parseRowFilter(policy.row_filter)
    if (filter && filter.length > 0) return false
  }
  return true
}

/** Same tolerance for the sibling JSON-text columns on a policy row: a bad
 *  value degrades to null instead of taking the whole response down. */
export function parseJsonColumn(value: unknown): Record<string, unknown> | null {
  if (value == null || value === '') return null
  if (typeof value === 'object') return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    console.warn(`[permissions] ignoring unparseable policy JSON: ${value.slice(0, 60)}`)
    return null
  }
}

/**
 * `nivaro_policies.fields` narrows a policy to specific columns, with `null`
 * meaning "all fields". The legacy Directus import also wrote the literal
 * string `*` for that same meaning, which is NOT valid JSON — a bare
 * JSON.parse threw and 500'd every caller (16 rows across 4 roles were in
 * this state, which made those roles' detail page and every items read for
 * their members fail outright).
 *
 * `*` maps to null, the encoding this codebase already uses for unrestricted.
 * Any other unparseable value also degrades to null rather than throwing: the
 * column can only ever NARROW an access decision the action-level policy has
 * already granted, so a corrupt narrowing list must not be able to take down
 * reads. It is logged so the bad row still gets fixed.
 */
export function parsePolicyFields(value: unknown): string[] | null {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value as string[]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '*') return null
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as string[]) : null
  } catch {
    console.warn(`[permissions] ignoring unparseable policy fields value: ${trimmed.slice(0, 60)}`)
    return null
  }
}

export async function getAllowedFields(
  user: User,
  action: Action,
  collection: string
): Promise<string[] | null> {
  if (!user.role) return []
  return cachedAccess(
    user,
    'fields',
    `${action}\u0001${collection}`,
    () => roleAllowedFields(user, action, collection),
    cloneFields
  )
}

function cloneFields(v: string[] | null): string[] | null {
  return v === null ? null : [...v]
}

async function roleAllowedFields(
  user: User,
  action: Action,
  collection: string
): Promise<string[] | null> {
  const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
  if (role?.admin_access) return null // null = all fields

  const policy = await db<Policy>('nivaro_policies')
    .where({ role: user.role, action })
    .where((qb) => {
      qb.where({ collection }).orWhere({ collection: '*' })
    })
    .first()

  if (!policy) return []
  const fields = parsePolicyFields(policy.fields)
  if (!isSystemCollection(collection)) return fields
  // A system table reads only its listed columns, narrowed further by the
  // policy's own list; one not listed reads nothing.
  const readable = action === 'read' ? await existingReadableColumns(collection) : []
  return fields === null ? readable : readable.filter((c) => fields.includes(c))
}

const readableColumnsCache = new Map<string, Promise<string[]>>()

/** The listed readable columns the table actually has (an older or
 *  self-hosted schema may lack some); learnt once per process. */
function existingReadableColumns(collection: string): Promise<string[]> {
  const key = collection.toLowerCase()
  const wanted = systemReadableColumns(key)
  if (!wanted) return Promise.resolve([])
  let hit = readableColumnsCache.get(key)
  if (!hit) {
    hit = Promise.resolve(db(key).columnInfo())
      .then((info) => {
        const have = new Set(Object.keys(info ?? {}).map((c) => c.toLowerCase()))
        return wanted.filter((c) => have.has(c))
      })
      .catch(() => {
        readableColumnsCache.delete(key)
        return ['id']
      })
    readableColumnsCache.set(key, hit)
  }
  return hit
}

/** Whether the user's role is an administrator's. */
export async function isAdminRole(user: User): Promise<boolean> {
  if (!user?.role) return false
  return cachedAccess(user, 'admin', '', () => roleIsAdmin(user), sameValue)
}

async function roleIsAdmin(user: User): Promise<boolean> {
  const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
  return !!role?.admin_access
}

export async function getPoliciesForRole(
  roleId: string
): Promise<(Policy & { row_filter: RowCondition[] | null })[]> {
  const rows = (await db<Policy>('nivaro_policies').where({ role: roleId })) as (Policy & {
    row_filter?: string | null
  })[]
  return rows.map((p) => ({
    ...p,
    fields: parsePolicyFields(p.fields),
    permissions: parseJsonColumn(p.permissions),
    row_filter: parseRowFilter(p.row_filter)
  }))
}
