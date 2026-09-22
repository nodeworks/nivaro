/**
 * Custom-query cache observability (#476) — in-process, since boot.
 *
 * Every execute (the route, the widget render, the server-side slug runner)
 * reports how it was answered: a cache HIT, a MISS that ran the SQL, a
 * BYPASS (the viewer asked to refresh) or an UNCACHED run (cache_ttl 0).
 * From those the panel can say what a TTL actually saves — hits × average
 * execution time — and name the queries that never cache but take seconds:
 * 14 of 33 budget queries sat at cache_ttl 0, four of them the slowest, and
 * nothing surfaced that.
 *
 * Per-process like the trace ring: a multi-replica deployment shows the
 * replica that answered. Never persisted, never on the response path's
 * failure surface.
 */

export type CacheOutcome = 'hit' | 'miss' | 'bypass' | 'uncached'

interface SlugStats {
  slug: string
  hits: number
  misses: number
  bypasses: number
  uncached_runs: number
  exec_count: number
  exec_ms_total: number
  exec_ms_max: number
  last_exec_ms: number | null
  last_run_at: string | null
  last_outcome: CacheOutcome | null
  cache_ttl: number
}

const stats = new Map<string, SlugStats>()
const SINCE = new Date().toISOString()

export function recordCacheOutcome(
  slug: string,
  outcome: CacheOutcome,
  opts: { execMs?: number; cacheTtl?: number } = {}
): void {
  const s = stats.get(slug) ?? {
    slug,
    hits: 0,
    misses: 0,
    bypasses: 0,
    uncached_runs: 0,
    exec_count: 0,
    exec_ms_total: 0,
    exec_ms_max: 0,
    last_exec_ms: null,
    last_run_at: null,
    last_outcome: null,
    cache_ttl: 0
  }
  if (outcome === 'hit') s.hits++
  else if (outcome === 'miss') s.misses++
  else if (outcome === 'bypass') s.bypasses++
  else s.uncached_runs++
  if (opts.execMs != null) {
    s.exec_count++
    s.exec_ms_total += opts.execMs
    s.exec_ms_max = Math.max(s.exec_ms_max, opts.execMs)
    s.last_exec_ms = Math.round(opts.execMs)
  }
  if (opts.cacheTtl != null) s.cache_ttl = opts.cacheTtl
  s.last_run_at = new Date().toISOString()
  s.last_outcome = outcome
  stats.set(slug, s)
}

export interface CacheStatRow extends SlugStats {
  runs: number
  hit_rate: number | null
  avg_exec_ms: number | null
  /** Execution time the cache spared: hits × average execution. */
  saved_ms: number
  advice: string | null
}

export function cacheStats(): { since: string; rows: CacheStatRow[] } {
  const rows: CacheStatRow[] = []
  for (const s of stats.values()) {
    const runs = s.hits + s.misses + s.bypasses + s.uncached_runs
    const served = s.hits + s.misses
    const avg = s.exec_count ? s.exec_ms_total / s.exec_count : null
    const hitRate = served ? s.hits / served : null
    let advice: string | null = null
    if (s.cache_ttl === 0 && avg != null && avg >= 1000 && s.uncached_runs >= 3) {
      advice = `Never cached and slow — ${Math.round(avg / 1000)}s a run, ${s.uncached_runs} runs since boot`
    } else if (s.cache_ttl > 0 && served >= 10 && hitRate != null && hitRate < 0.2) {
      advice =
        'Cached but rarely hit — parameters vary per viewer, or the TTL is shorter than the gap between views'
    } else if (s.cache_ttl > 0 && s.bypasses >= 5 && s.bypasses > s.hits) {
      advice =
        'Viewers refresh it more than they read it cached — the figure moves faster than its TTL'
    }
    rows.push({
      ...s,
      runs,
      hit_rate: hitRate == null ? null : Math.round(hitRate * 100) / 100,
      avg_exec_ms: avg == null ? null : Math.round(avg),
      saved_ms: Math.round(s.hits * (avg ?? 0)),
      advice
    })
  }
  rows.sort((a, b) => b.runs - a.runs)
  return { since: SINCE, rows }
}
