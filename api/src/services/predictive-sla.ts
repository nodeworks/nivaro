import { db } from '../db/index.js'

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
 * 80k-row state costs one aggregate, and cached 10 minutes per state set.
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
               LEAD(timestamp) OVER (PARTITION BY instance ORDER BY timestamp)) / 60.0 AS hrs
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

export async function getStateDurationStats(): Promise<Map<string, StateDurationStats>> {
  if (cache && Date.now() - cache.at < TTL) return cache.stats
  if (!loading) {
    loading = loadAllStats()
      .then((stats) => {
        cache = { stats, at: Date.now() }
        return stats
      })
      .finally(() => {
        loading = null
      })
  }
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
