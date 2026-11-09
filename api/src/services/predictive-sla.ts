import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Predictive SLA — "records that sat here this long usually end up late."
 *
 * For every workflow state, the FULL transition history yields a
 * distribution of completed time-in-state durations (LEAD over
 * nivaro_workflow_history per instance). A live record whose current age
 * exceeds the P80 of that distribution gets flagged predicted_risk — before
 * any hard SLA threshold trips.
 *
 * Percentiles are computed in SQL (PERCENTILE_CONT window + DISTINCT) so an
 * 80k-row state costs one aggregate. The result is shared by every process through Redis
 * (`nvr:predsla:<tenant>`, 1 h, one refresher at a time under a short lock) and held in each
 * process for 10 minutes — 2026-11-09 production ran the 6 s / 2.7M-read aggregate ~25
 * times an hour because each of 4 web tasks + the worker kept its own copy.
 * States with fewer than MIN_SAMPLES completed stays never predict — thin
 * history produces noise, not insight.
 */

export interface StateDurationStats {
  p50: number
  p80: number
  n: number
}

const MIN_SAMPLES = 30
const TTL = 10 * 60_000

let cache: { stats: Map<string, StateDurationStats>; at: number } | null = null
let loading: Promise<Map<string, StateDurationStats>> | null = null

interface PredRedis {
  get(key: string): Promise<string | null>
  set(...args: unknown[]): Promise<unknown>
  del(key: string): Promise<unknown>
}
let redis: PredRedis | null = null
/** Wired at boot (server.ts) — without it every process computes its own copy. */
export function setPredictiveSlaRedis(client: PredRedis | null): void {
  redis = client
}
const SHARED_TTL_S = 3600
const LOCK_TTL_S = 120
const sharedKey = () => `nvr:predsla:${currentTenantKey() || 'default'}`

/** The shared copy when another process computed it; else compute (one refresher at a time). */
async function loadShared(): Promise<Map<string, StateDurationStats>> {
  if (!redis) return runInBackgroundPool(() => loadAllStats())
  const key = sharedKey()
  try {
    const raw = await redis.get(key)
    if (raw) return new Map(Object.entries(JSON.parse(raw) as Record<string, StateDurationStats>))
    // Someone else is computing: use what this process has, or compute anyway when cold.
    const got = await redis.set(`${key}:lock`, '1', 'EX', LOCK_TTL_S, 'NX')
    if (got === null && cache) return cache.stats
  } catch {
    /* Redis trouble: compute locally */
  }
  const stats = await runInBackgroundPool(() => loadAllStats())
  try {
    await redis.set(key, JSON.stringify(Object.fromEntries(stats)), 'EX', SHARED_TTL_S)
    await redis.del(`${key}:lock`)
  } catch {
    /* the local copy still serves */
  }
  return stats
}

async function loadAllStats(): Promise<Map<string, StateDurationStats>> {
  const rows = (await db.raw(`
    SELECT DISTINCT
      h.to_state AS state,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h.hrs) OVER (PARTITION BY h.to_state) AS p50,
      PERCENTILE_CONT(0.8) WITHIN GROUP (ORDER BY h.hrs) OVER (PARTITION BY h.to_state) AS p80,
      COUNT(*) OVER (PARTITION BY h.to_state) AS n
    FROM (
      SELECT instance, to_state, timestamp,
             DATEDIFF(minute, timestamp,
               LEAD(timestamp) OVER (PARTITION BY instance ORDER BY timestamp, id)) / 60.0 AS hrs
      FROM nivaro_workflow_history
      WHERE to_state IS NOT NULL
    ) h
    WHERE h.hrs IS NOT NULL AND h.hrs >= 0
  `)) as Array<{ state: string; p50: number; p80: number; n: number }>

  const map = new Map<string, StateDurationStats>()
  for (const r of rows) {
    map.set(String(r.state), { p50: Number(r.p50), p80: Number(r.p80), n: Number(r.n) })
  }
  return map
}

/**
 * `opts.wait: false` (request paths): a truly cold process answers an EMPTY map at once and
 * lets the load run behind it — the aggregate over all workflow history takes 8.7 s on EFP
 * production (max 15 s), and every queue read after a deploy used to wait for it. The only
 * cost is no "historically stuck" flags for the first seconds after boot.
 */
export async function getStateDurationStats(
  opts: { wait?: boolean } = {}
): Promise<Map<string, StateDurationStats>> {
  if (cache && Date.now() - cache.at < TTL) return cache.stats
  if (!loading) {
    loading = loadShared()
      .then((stats) => {
        cache = { stats, at: Date.now() }
        return stats
      })
      .finally(() => {
        loading = null
      })
    // Swallowed on the background path only — a stale-cache holder must not
    // become an unhandled rejection when the refresh fails; the next caller
    // retries via the same `loading` gate.
    loading.catch(() => {})
  }
  // Stale-while-revalidate: the aggregate walks the ENTIRE workflow history
  // (millions of rows post-legacy-import, ~2.7s) — making one queue request
  // eat that every TTL expiry showed up as a mystery 2.7s spike in traces.
  // Ten-minute-old percentiles are indistinguishable from fresh ones for a
  // "historically stuck" flag, so an expired cache serves immediately while
  // the refresh runs behind it. Only a truly cold process ever waits.
  if (cache) return cache.stats
  if (opts.wait === false) return new Map()
  return loading
}

export function clearPredictiveCache(): void {
  cache = null
}

export interface Prediction {
  predicted: boolean
  p80_hours: number | null
  note: string | null
}

/** Flag when the record's current time-in-state exceeds the historical P80. */
export function predictStuck(
  stats: Map<string, StateDurationStats>,
  stateId: string | null | undefined,
  ageHours: number | null | undefined
): Prediction {
  if (!stateId || ageHours == null) return { predicted: false, p80_hours: null, note: null }
  const s = stats.get(String(stateId))
  if (!s || s.n < MIN_SAMPLES) return { predicted: false, p80_hours: null, note: null }
  if (ageHours <= s.p80) return { predicted: false, p80_hours: s.p80, note: null }
  return {
    predicted: true,
    p80_hours: s.p80,
    note: `80% of ${s.n} historical stays in this state finished within ${Math.round(s.p80)}h — this record is at ${Math.round(ageHours)}h`
  }
}
