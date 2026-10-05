import { db } from '../../../db/index.js'
import { cacheStats } from '../../query-cache-stats.js'
import { queryFreshness } from '../../query-freshness.js'
import { type Candidate, KIND_RISK } from '../types.js'

/**
 * Query-cache observer: a saved query that runs uncached, takes a second or more and runs often
 * is proposed a TTL sized to how often its sources are written — measured from the activity log
 * over the last 7 days: 6 h when the window is mostly quiet (nightly-fed), else half the median gap.
 * A source with no activity rows (a table no hook writes through) cannot be measured: the query
 * is labelled `gap_assumed` and its TTL capped at 5 min. A query whose sources cannot be resolved
 * is never proposed. When the first run of the day is the slow one, the warmer is turned on too.
 */

export interface QueryFreshnessShape {
  sources: number
  nightly: boolean
  medianGapMin: number | null
  /** Some source had no activity rows to measure: the TTL is capped at ASSUMED_GAP_TTL. */
  gapAssumed?: boolean
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
const MIN_TTL = 60
export const ASSUMED_GAP_TTL = 5 * 60
export const NIGHTLY_GAP_MIN = 20 * 60
const QUIET_GAP_MIN = 6 * 60
const NIGHTLY_QUIET_SHARE = 0.8
const DAY_MS = 86_400_000
const WINDOW_DAYS = 7
const WINDOW_MIN = WINDOW_DAYS * 24 * 60
/** Newest activity rows read per source; a busier table's median comes from its recent writes. */
const MAX_WRITES_PER_SOURCE = 5000

export function proposeTtl(f: QueryFreshnessShape): number {
  const ttl =
    f.nightly || f.medianGapMin == null
      ? 6 * H
      : Math.min(24 * H, Math.max(MIN_TTL, Math.round((f.medianGapMin * 60) / 2)))
  return f.gapAssumed ? Math.min(ttl, ASSUMED_GAP_TTL) : ttl
}

/** Gaps in minutes between consecutive distinct write minutes, in time order. */
function writeGaps(stamps: Array<Date | string>): number[] {
  const minutes = [
    ...new Set(
      stamps.map((s) => Math.floor(new Date(s).getTime() / 60_000)).filter(Number.isFinite)
    )
  ].sort((a, b) => a - b)
  return minutes.slice(1).map((m, i) => m - minutes[i])
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Median gap in minutes between distinct write minutes; null with fewer than two. */
export function medianGapMinutes(stamps: Array<Date | string>): number | null {
  return median(writeGaps(stamps))
}

/**
 * Nightly = the window is mostly quiet: gaps of 6 h or more add up to at least 80% of it, and one
 * of them lasts 20 h or more. A nightly burst (a write a minute for ten minutes) has a 1-minute
 * median, so the median alone never finds it. Only gaps between writes count, not the stretch
 * before the first write or after the last.
 */
function isNightly(gaps: number[]): boolean {
  const quiet = gaps.filter((g) => g >= QUIET_GAP_MIN).reduce((a, g) => a + g, 0)
  return quiet / WINDOW_MIN >= NIGHTLY_QUIET_SHARE && gaps.some((g) => g >= NIGHTLY_GAP_MIN)
}

/** A query's freshness from each source's write stamps (any source's write makes it stale). */
export function freshnessFromWrites(perSource: Array<Array<Date | string>>): QueryFreshnessShape {
  const gapAssumed = perSource.some((w) => w.length === 0)
  const all = perSource.flat()
  const gaps = writeGaps(all)
  // a single write minute in the whole window: written about once a week
  const medianGapMin = all.length ? (median(gaps) ?? WINDOW_MIN) : null
  const nightly = isNightly(gaps)
  return { sources: perSource.length, nightly, medianGapMin, gapAssumed }
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
        gap_assumed: r.freshness.gapAssumed === true,
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

async function writeStamps(table: string, since: Date): Promise<Array<Date | string>> {
  const rows = (await db('nivaro_activity')
    .where('collection', table)
    .whereIn('action', ['create', 'update', 'delete'])
    .where('timestamp', '>', since)
    .orderBy('timestamp', 'desc')
    .limit(MAX_WRITES_PER_SOURCE)
    .select('timestamp')
    .catch(() => [])) as Array<{ timestamp: Date | string }>
  return rows.map((r) => r.timestamp)
}

export async function loadQueryCacheEvidence(): Promise<QueryCacheEvidence> {
  const stats = cacheStats()
  const sinceDays = Math.max(1 / 24, (Date.now() - new Date(stats.since).getTime()) / DAY_MS)
  const bySlug = new Map(stats.rows.map((r) => [r.slug, r]))
  const queries = (await db('nivaro_custom_queries')
    .where('enabled', true)
    .select('id', 'slug', 'sql_text', 'cache_ttl', 'warm_daily', 'freshness_sources')
    .catch(() => [])) as Array<Record<string, unknown>>
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS)
  const stampsByTable = new Map<string, Promise<Array<Date | string>>>()
  const stampsFor = (table: string) => {
    const key = table.toLowerCase()
    let hit = stampsByTable.get(key)
    if (!hit) {
      hit = writeStamps(table, since)
      stampsByTable.set(key, hit)
    }
    return hit
  }
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
      if (f.sources.length)
        freshness = freshnessFromWrites(await Promise.all(f.sources.map((x) => stampsFor(x.table))))
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
