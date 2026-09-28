import { db } from '../db/index.js'
import { getUserScopes, listScopeDimensions } from './user-scopes.js'

/** One entry of `nivaro_custom_queries.scope_params`: which User-Scope
 *  dimension a query parameter carries, and whether the allowance is
 *  injected as raw target ids or as the dimension's display values. */
export interface ScopeParamDef {
  dimension: string
  /** 'id' (raw target ids, default) | 'display' (dimension display_field values). */
  translate?: 'id' | 'display'
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
  isAdmin: boolean
): Promise<void> {
  if (!scopeParamsRaw || isAdmin || !userId) return
  const declared = parseJson<Record<string, ScopeParamDef>>(scopeParamsRaw)
  if (!declared || typeof declared !== 'object') return

  const entries = Object.entries(declared).filter(([, d]) => d && typeof d.dimension === 'string')
  if (entries.length === 0) return

  const [scopes, dimensions] = await Promise.all([getUserScopes(userId), listScopeDimensions()])

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
