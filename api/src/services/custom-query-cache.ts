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

/**
 * The bound params a key was built from — the inverse of customQueryCacheKey,
 * kept beside it so the key has one definition. Null for another slug's key or
 * one that cannot be read. Entries written before the SQL stamp joined the key
 * (`cq:<slug>:<params JSON>`) read too.
 */
export function customQueryKeyParams(key: string, slug: string): Record<string, unknown> | null {
  const prefix = `cq:${slug}:`
  if (!key.startsWith(prefix)) return null
  let rest = key.slice(prefix.length)
  if (!rest.startsWith('{')) {
    const cut = rest.indexOf(':')
    if (cut < 0) return null
    rest = rest.slice(cut + 1)
  }
  try {
    const parsed = JSON.parse(rest) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Which cached runs of a query a drop takes: those one of `values` can be in. */
export interface CustomQueryDropMatch {
  /** The bound parameter that says which records a run covers. */
  param: string
  /** The values whose rows changed. */
  values: Array<string | number>
}

/** What a scope that allows no value is injected as (custom-query-scope.ts): the run holds no rows. */
const MATCHES_NOTHING = '__scope_empty__'

/** A bound value as the list of values it names: the comma convention scope injection and the
 *  STRING_SPLIT procedures share, compared the way SQL Server compares text (trimmed, any case). */
function namedValues(bound: unknown): string[] {
  const parts = Array.isArray(bound) ? bound.map(String) : String(bound).split(',')
  return parts.map((v) => v.trim().toLowerCase()).filter(Boolean)
}

/**
 * Can this cached run hold rows of one of `match.values`? Yes when the run was
 * bound to a list naming one of them, and yes when `match.param` did not narrow
 * it at all (absent, null, empty: it spans every value, so any change reaches
 * it). A key that cannot be read is treated as touched — when in doubt, drop.
 */
export function customQueryKeyTouches(
  key: string,
  slug: string,
  match: CustomQueryDropMatch
): boolean {
  const params = customQueryKeyParams(key, slug)
  if (!params) return true
  const bound = params[match.param]
  if (bound === undefined || bound === null) return true
  const named = namedValues(bound)
  if (named.length === 0) return true
  if (named.length === 1 && named[0] === MATCHES_NOTHING) return false
  const changed = new Set(match.values.map((v) => String(v).trim().toLowerCase()))
  return named.some((v) => changed.has(v))
}

interface DropRedis {
  scanStream(o: { match: string; count: number }): NodeJS.ReadableStream
  del(...keys: string[]): Promise<number>
}

/**
 * Drop cached runs of a query: every one (no `match`), or only those a changed
 * value can be in (customQueryKeyTouches) — a write to one record then leaves
 * every other record's cached run in place. Returns how many entries went; 0
 * without Redis, and a Redis failure is 0, never a throw.
 *
 * One SCAN over `cq:<slug>:*`. In cloud mode that pattern spans every tenant's
 * entries of the slug, so a drop reaches them all: more misses, never a wrong
 * answer.
 */
export function dropCustomQueryCache(
  redis: DropRedis | null | undefined,
  slug: string,
  match?: CustomQueryDropMatch | null
): Promise<number> {
  if (!redis) return Promise.resolve(0)
  return new Promise((resolve) => {
    const pending: Array<Promise<number>> = []
    let stream: NodeJS.ReadableStream
    try {
      stream = redis.scanStream({ match: `cq:${slug}:*`, count: 1000 })
    } catch {
      resolve(0)
      return
    }
    stream.on('data', (keys: string[]) => {
      const gone = match ? keys.filter((k) => customQueryKeyTouches(k, slug, match)) : keys
      if (gone.length > 0) pending.push(redis.del(...gone).catch(() => 0))
    })
    stream.on('end', () => {
      void Promise.all(pending).then((ns) => resolve(ns.reduce((a, b) => a + b, 0)))
    })
    stream.on('error', () => resolve(0))
  })
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
