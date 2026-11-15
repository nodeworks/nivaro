import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { tenantState } from '../ai-tenant-state.js'

/**
 * "Usually 2 d" on a watch row's mini timeline: the median time records stay in each pipeline
 * step, from finished stays in the last year of workflow history (a stay = a history row into
 * the step until the instance's next history row). ONE read for every step at once, cached a
 * day per tenant, made on the background pool; a request never waits on it longer than
 * WAIT_MS — until it lands rows simply show the time in step without a comparison.
 */

export const MEDIAN_TTL_MS = 24 * 60 * 60 * 1000
const WAIT_MS = 1200
const LOOKBACK_DAYS = 365
/** A step needs this many finished stays before "usually" means anything. */
export const MEDIAN_MIN_STAYS = 5

interface MedianCache {
  at: number
  medians: Map<string, number>
  flight: Promise<Map<string, number>> | null
}

const cache = tenantState<MedianCache>(() => ({ at: 0, medians: new Map(), flight: null }))

/** Median of finished stays (seconds) per to-state id. Exported for tests. */
export function mediansFromStays(
  stays: Array<{ state: string; secs: number | null }>,
  minStays = MEDIAN_MIN_STAYS
): Map<string, number> {
  const by = new Map<string, number[]>()
  for (const s of stays) {
    if (s.secs == null || !Number.isFinite(s.secs) || s.secs < 0) continue
    const k = String(s.state).toLowerCase()
    const list = by.get(k)
    if (list) list.push(s.secs)
    else by.set(k, [s.secs])
  }
  const out = new Map<string, number>()
  for (const [k, list] of by) {
    if (list.length < minStays) continue
    list.sort((a, z) => a - z)
    const mid = Math.floor(list.length / 2)
    out.set(k, list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2)
  }
  return out
}

async function readMedians(): Promise<Map<string, number>> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  if (!isMssql(db)) {
    // Other dialects: the stays come back and the median is taken here.
    const stays = (await db.raw(
      `SELECT to_state AS state, secs FROM (
         SELECT h.to_state,
                (julianday(LEAD(h.timestamp) OVER (PARTITION BY h.instance ORDER BY h.timestamp, h.id))
                  - julianday(h.timestamp)) * 86400 AS secs
           FROM nivaro_workflow_history h WHERE h.timestamp >= ?) s
       WHERE secs IS NOT NULL AND state IS NOT NULL`,
      [since.toISOString()]
    )) as Array<{ state: string; secs: number | null }>
    return mediansFromStays(Array.isArray(stays) ? stays : [])
  }
  // Median per step in SQL (PERCENTILE_CONT) so a big history never travels to the process.
  const rows = (await db.raw(
    `SELECT DISTINCT s.to_state AS state,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.secs) OVER (PARTITION BY s.to_state) AS med,
            COUNT(*) OVER (PARTITION BY s.to_state) AS n
       FROM (
         SELECT h.to_state,
                DATEDIFF(SECOND, h.[timestamp],
                  LEAD(h.[timestamp]) OVER (PARTITION BY h.instance ORDER BY h.[timestamp], h.id)) AS secs
           FROM nivaro_workflow_history h
          WHERE h.[timestamp] >= ?
       ) s
      WHERE s.secs IS NOT NULL AND s.to_state IS NOT NULL`,
    [since]
  )) as Array<{ state: string; med: number | null; n: number }>
  const out = new Map<string, number>()
  for (const r of rows)
    if (r.med != null && Number(r.n) >= MEDIAN_MIN_STAYS)
      out.set(String(r.state).toLowerCase(), Number(r.med))
  return out
}

/**
 * The cached medians; refreshes in the background once a day. Waits at most WAIT_MS for a
 * first read, then answers what it has (possibly nothing) — never an error.
 */
export async function stepMedians(): Promise<Map<string, number>> {
  const c = cache()
  const fresh = Date.now() - c.at < MEDIAN_TTL_MS
  if (fresh) return c.medians
  if (!c.flight) {
    c.flight = runInBackgroundPool(() => readMedians())
      .then((m) => {
        c.medians = m
        c.at = Date.now()
        return m
      })
      .catch(() => {
        // Try again in an hour rather than on every read.
        c.at = Date.now() - MEDIAN_TTL_MS + 60 * 60 * 1000
        return c.medians
      })
      .finally(() => {
        c.flight = null
      })
  }
  const flight = c.flight
  return Promise.race([
    flight,
    new Promise<Map<string, number>>((r) => setTimeout(() => r(c.medians), WAIT_MS).unref?.())
  ])
}
