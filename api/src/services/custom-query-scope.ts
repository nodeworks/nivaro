import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { tablesReadBy } from './query-freshness.js'
import { currentTenantKey } from './tenant-rooms.js'
import {
  getUserScopes,
  listScopeDimensions,
  type ScopeDimension,
  scopeHopsFor
} from './user-scopes.js'

/** One entry of `nivaro_custom_queries.scope_params`: which User-Scope
 *  dimension a query parameter carries, and whether the allowance is
 *  injected as raw target ids or as the dimension's display values. */
export interface ScopeParamDef {
  dimension: string
  /** 'id' (raw target ids, default) | 'display' (dimension display_field values). */
  translate?: 'id' | 'display'
}

/** The query being run, for the coverage gate in applyScopeParams. */
export interface ScopeGateQuery {
  slug?: string | null
  sqlText: string | null | undefined
}

/**
 * `scope_params` key an administrator sets on a query that reads scoped
 * tables yet exposes nothing a User Scope should hide (a zone picker, a
 * lookup list): `{"$not_scoped": {"reason": "…"}}`. It turns the coverage
 * gate off for that query; declared params alongside it still apply.
 */
export const NOT_SCOPED_KEY = '$not_scoped'

function isNotScoped(declared: Record<string, unknown> | null): boolean {
  return !!declared && typeof declared === 'object' && declared[NOT_SCOPED_KEY] != null
}

/** Refusal for a restricted person running raw SQL its scope_params do not cover. */
export class QueryNotScopedError extends Error {
  statusCode = 403
  code = 'QUERY_NOT_SCOPED'
  constructor(
    public slug: string | null,
    public dimensions: string[]
  ) {
    super(
      `This report reads data your access is limited by (${dimensions.join(', ')}), but it is not set up to limit its results to what you may see. Ask an administrator to add the matching scope parameters.`
    )
  }
}

// (tenant, dimension, sql) → does the dimension reach a table the SQL reads?
// Five minutes, like the scope-coverage report: a query's tables change only
// with its SQL (part of the key); relation changes reach it within the TTL.
const REACH_TTL = 5 * 60_000
const REACH_MAX = 2000
const reachMemo = new Map<string, { at: number; value: Promise<boolean> }>()

function sqlKey(sql: string): string {
  return createHash('sha1').update(sql).digest('hex')
}

function dimensionReaches(dim: ScopeDimension, sql: string): Promise<boolean> {
  const key = `${currentTenantKey()}|${dim.name}|${sqlKey(sql)}`
  const hit = reachMemo.get(key)
  if (hit && Date.now() - hit.at < REACH_TTL) return hit.value
  const value = (async () => {
    const [tables, registered] = await Promise.all([
      tablesReadBy(sql),
      db('nivaro_collections').pluck('collection') as Promise<string[]>
    ])
    const known = new Set(registered.map((c) => c.toLowerCase()))
    for (const t of tables) {
      if (!known.has(t)) continue
      if ((await scopeHopsFor(dim, t)) !== null) return true
    }
    return false
  })()
  if (reachMemo.size >= REACH_MAX) reachMemo.clear()
  reachMemo.set(key, { at: Date.now(), value })
  value.catch(() => {
    if (reachMemo.get(key)?.value === value) reachMemo.delete(key)
  })
  return value
}

/**
 * Fail closed (Army 7 blocker): a person with a restrict-mode User Scope may
 * run raw SQL only when every dimension they are restricted on, and that
 * reaches a table the SQL reads, is carried by the query's scope_params.
 * Otherwise the raw SQL would return rows the items service hides from them.
 * Unrestricted people and administrators are never refused here. A failure
 * to work out the tables refuses too — the restricted answer is "no rows",
 * never "all rows".
 */
async function assertQueryCoversScopes(
  query: ScopeGateQuery,
  covered: Set<string>,
  scopes: Awaited<ReturnType<typeof getUserScopes>>,
  dimensions: ScopeDimension[]
): Promise<void> {
  const sql = query.sqlText ?? ''
  if (!sql.trim()) return
  const restricted = new Set(
    scopes.filter((s) => s.mode === 'restrict' && s.values.length > 0).map((s) => s.dimension)
  )
  const missing: string[] = []
  for (const name of restricted) {
    if (covered.has(name)) continue
    const dim = dimensions.find((d) => d.name === name)
    if (!dim) continue // inactive dimension: enforced nowhere
    let reaches = true
    try {
      reaches = await dimensionReaches(dim, sql)
    } catch {
      reaches = true
    }
    if (reaches) missing.push(dim.label || dim.name)
  }
  if (missing.length) throw new QueryNotScopedError(query.slug ?? null, missing)
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Inject the caller's restrict-mode scope allowance into declared params.
 *
 * Custom queries are raw SQL — the items-service scope enforcement can never
 * reach inside them, so this is where the documented raw-SQL gap closes. Per
 * declared param:
 *   - admin, or no restriction on the dimension → untouched.
 *   - param omitted → the full allowance is injected (comma-joined, the
 *     STRING_SPLIT convention procs conventionally use).
 *   - param provided → intersected with the allowance. An empty intersection
 *     injects a value that matches nothing — a caller asking for a zone they
 *     are not allowed gets zero rows, never everything.
 *
 * Runs BEFORE the cache key is built, so scoped and unscoped callers can
 * never share a cached result.
 */
export async function applyScopeParams(
  scopeParamsRaw: string | null,
  finalParams: Record<string, unknown>,
  userId: string | null | undefined,
  isAdmin: boolean,
  query?: ScopeGateQuery
): Promise<void> {
  if (isAdmin || !userId) return
  const declared = parseJson<Record<string, ScopeParamDef>>(scopeParamsRaw)
  const entries =
    declared && typeof declared === 'object'
      ? Object.entries(declared).filter(([, d]) => d && typeof d.dimension === 'string')
      : []
  // Without the query's SQL there is nothing to gate (older callers); without
  // declared params there is nothing to inject.
  if (entries.length === 0 && query?.sqlText == null) return

  const [scopes, dimensions] = await Promise.all([getUserScopes(userId), listScopeDimensions()])

  if (query?.sqlText != null && !isNotScoped(declared)) {
    await assertQueryCoversScopes(
      query,
      new Set(entries.map(([, d]) => d.dimension)),
      scopes,
      dimensions
    )
  }

  for (const [param, def] of entries) {
    const restriction = scopes.find(
      (s) => s.mode === 'restrict' && s.dimension === def.dimension && s.values.length > 0
    )
    if (!restriction) continue // unrestricted on this dimension

    let allowed = restriction.values.map(String)
    if (def.translate === 'display') {
      const dim = dimensions.find((d) => d.name === def.dimension)
      if (dim?.target_collection && dim.display_field) {
        try {
          const rows = (await db(dim.target_collection)
            .whereIn('id', restriction.values)
            .select(dim.display_field)) as Array<Record<string, unknown>>
          allowed = rows.map((r) => String(r[dim.display_field as string])).filter(Boolean)
        } catch {
          // Translation failing must fail CLOSED for a restricted user —
          // untranslatable allowance means no rows, not all rows.
          allowed = []
        }
      }
    }

    const provided = finalParams[param]
    if (provided == null || provided === '') {
      finalParams[param] = allowed.length ? allowed.join(',') : '__scope_empty__'
      continue
    }
    const requested = String(provided)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    const allowedSet = new Set(allowed.map((v) => v.toLowerCase()))
    const kept = requested.filter((v) => allowedSet.has(v.toLowerCase()))
    finalParams[param] = kept.length ? kept.join(',') : '__scope_empty__'
  }
}
