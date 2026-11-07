/**
 * The one definition of a custom query's Redis cache entry (#2445).
 *
 * Every reader and writer — POST /custom-queries/:slug/execute, widget renders,
 * Ask AI's query tool and the cache warmer — builds the key here, AFTER scope
 * injection, so a scoped result can never land under an unscoped key. Widget
 * renders pass only their bound params, so their keys differ from the route's
 * for the same question (see routes/widgets-internal.ts).
 *
 * Leaf module: imports nothing of the app.
 */
import { createHash } from 'node:crypto'

/** What of a query's definition decides its answer besides the bound params. */
export interface CustomQueryKeyDef {
  sql_text?: string | null
  scope_params?: string | null
}

/**
 * Short stamp of the SQL text + scope declaration (army 6 M15): a config script
 * or editor that rewrites a query's SQL leaves every older entry behind instead
 * of serving numbers computed by the old SQL until the TTL runs out (12 h for
 * the rpt-* spend reports). Param definitions need no part here — a changed
 * default changes the bound params, which are in the key already.
 */
export function customQuerySqlStamp(def: CustomQueryKeyDef): string {
  return createHash('sha1')
    .update(`${def.sql_text ?? ''}\u0000${def.scope_params ?? ''}`)
    .digest('hex')
    .slice(0, 10)
}

/** `cq:<slug>:<sql stamp>:<params JSON>` — `cq:<slug>:*` still matches every entry of a slug. */
export function customQueryCacheKey(
  slug: string,
  params: Record<string, unknown>,
  def: CustomQueryKeyDef
): string {
  return `cq:${slug}:${customQuerySqlStamp(def)}:${JSON.stringify(params)}`
}

/** The cached value: `{cached_at, rows}`, stamped so a viewer can be told its age. */
export function customQueryCacheValue(
  rows: unknown[],
  cachedAt: Date | string = new Date()
): string {
  return JSON.stringify({
    cached_at: typeof cachedAt === 'string' ? cachedAt : cachedAt.toISOString(),
    rows
  })
}

/** `cached_at` of a stored entry, in ms; null for a bare-array (legacy) or unreadable entry. */
export function customQueryCachedAt(raw: string | null): number | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { cached_at?: unknown } | unknown[]
    if (Array.isArray(parsed) || typeof parsed?.cached_at !== 'string') return null
    const t = Date.parse(parsed.cached_at)
    return Number.isNaN(t) ? null : t
  } catch {
    return null
  }
}
