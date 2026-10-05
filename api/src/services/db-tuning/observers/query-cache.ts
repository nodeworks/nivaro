import { db } from '../../../db/index.js'
import { cacheStats } from '../../query-cache-stats.js'
import { queryFreshness } from '../../query-freshness.js'
import { type Candidate, KIND_RISK } from '../types.js'

/**
 * Query-cache observer: a saved query that runs uncached, takes a second or more and runs often
 * is proposed a TTL sized to how fresh its sources are — 6 h for nightly-fed sources, half the
 * gap between writes for live ones. A query whose sources cannot be resolved is never proposed.
 * When the first run of the day is the slow one, the proposal also turns on the daily warmer.
 */

export interface QueryFreshnessShape {
  sources: number
  nightly: boolean
  medianGapMin: number | null
}
export interface QueryCacheRow {
  id: number
  slug: string
  cache_ttl: number
  warm_daily: boolean
  runs: number
  avg_exec_ms: number
  uncached_runs: number
  sinceDays: number
  freshness: QueryFreshnessShape | null
  firstRunSlowest: boolean
}
export interface QueryCacheEvidence {
  rows: QueryCacheRow[]
}

const H = 3600
export function proposeTtl(f: QueryFreshnessShape): number {
  if (f.nightly || f.medianGapMin == null) return 6 * H
  return Math.min(24 * H, Math.max(5 * 60, Math.round((f.medianGapMin * 60) / 2)))
}

export const MIN_EXEC_MS = 1000
export const MIN_RUNS_PER_DAY = 10
export const MIN_SAVING_MS = 5000

export function observeQueryCache(ev: QueryCacheEvidence): Candidate[] {
  const out: Candidate[] = []
  for (const r of ev.rows) {
    if (r.cache_ttl > 0 || !r.freshness || r.freshness.sources === 0) continue
    const perDay = r.runs / Math.max(r.sinceDays, 1 / 24)
    if (r.avg_exec_ms < MIN_EXEC_MS || perDay < MIN_RUNS_PER_DAY) continue
    const ttl = proposeTtl(r.freshness)
    const windowsPerDay = 86_400 / ttl
    const saving = r.avg_exec_ms * Math.max(0, perDay - Math.min(perDay, windowsPerDay))
    if (saving < MIN_SAVING_MS) continue
    out.push({
      kind: 'query_cache',
      target: r.slug,
      change_key: `ttl:${ttl}:warm:${r.firstRunSlowest ? 1 : 0}`,
      title: `Cache ${r.slug} for ${Math.round(ttl / 60)} min — ${(r.avg_exec_ms / 1000).toFixed(1)} s × ${Math.round(perDay)} runs/day`,
      evidence: {
        runs_per_day: Math.round(perDay),
        avg_exec_ms: Math.round(r.avg_exec_ms),
        freshness: r.freshness,
        first_run_slowest: r.firstRunSlowest
      },
      estimate_ms_per_day: Math.round(saving),
      risk: KIND_RISK.query_cache,
      apply: {
        type: 'query_patch',
        id: r.id,
        slug: r.slug,
        patch: { cache_ttl: ttl, warm_daily: r.firstRunSlowest }
      },
      undo: {
        type: 'query_patch',
        id: r.id,
        slug: r.slug,
        patch: { cache_ttl: r.cache_ttl, warm_daily: r.warm_daily }
      }
    })
  }
  return out
}

/** The nightly feed lands before 06:00 Eastern, about 10–11 UTC. */
const NIGHTLY_CUTOFF_UTC_HOUR = 11
const DAY_MS = 86_400_000

/** Nightly = every source's newest write is unknown, older than a day, or before the cutoff. */
function isNightly(changedAt: Array<string | null>): boolean {
  return changedAt.every((at) => {
    if (!at) return true
    const t = new Date(at)
    if (Number.isNaN(t.getTime())) return true
    return Date.now() - t.getTime() > DAY_MS || t.getUTCHours() < NIGHTLY_CUTOFF_UTC_HOUR
  })
}

export async function loadQueryCacheEvidence(): Promise<QueryCacheEvidence> {
  const stats = cacheStats()
  const sinceDays = Math.max(1 / 24, (Date.now() - new Date(stats.since).getTime()) / DAY_MS)
  const bySlug = new Map(stats.rows.map((r) => [r.slug, r]))
  const queries = (await db('nivaro_custom_queries')
    .where('enabled', true)
    .select('id', 'slug', 'sql_text', 'cache_ttl', 'warm_daily', 'freshness_sources')
    .catch(() => [])) as Array<Record<string, unknown>>
  const rows: QueryCacheRow[] = []
  for (const q of queries) {
    const s = bySlug.get(String(q.slug))
    if (!s?.runs) continue
    let freshness: QueryFreshnessShape | null = null
    try {
      const f = await queryFreshness({
        id: q.id,
        sql_text: q.sql_text as string,
        freshness_sources: q.freshness_sources as string | null
      })
      if (f.sources.length) {
        const nightly = isNightly(f.sources.map((x) => x.changed_at))
        // no per-source write history yet: a live source is assumed to move about hourly
        freshness = { sources: f.sources.length, nightly, medianGapMin: nightly ? null : 60 }
      }
    } catch {
      freshness = null
    }
    const avg = s.avg_exec_ms ?? 0
    rows.push({
      id: Number(q.id),
      slug: String(q.slug),
      cache_ttl: Number(q.cache_ttl ?? 0),
      warm_daily: Boolean(q.warm_daily),
      runs: s.runs,
      avg_exec_ms: avg,
      uncached_runs: s.uncached_runs,
      sinceDays,
      freshness,
      firstRunSlowest: (s.exec_ms_max ?? 0) > avg * 2
    })
  }
  return { rows }
}
