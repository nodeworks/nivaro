import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { rawRows } from '../../db/raw-rows.js'
import { dateDiff, qi } from '../../db/sql-dialect.js'
import { tenantState } from '../ai-tenant-state.js'

/**
 * "Usually 2 d" on a watch row's mini timeline: the median time records stay in each pipeline
 * step, from finished stays in the last year of workflow history (a stay = a history row into
 * the step until the instance's next history row). Only real waits count (isRealStay): a stay
 * of at least a minute that a person ended — automatic skips and automation moves are left out. ONE read for every step at once, cached a
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

/** A stay shorter than this was never a wait (an automatic skip, a double click). */
export const MIN_REAL_STAY_S = 60

export interface Stay {
  state: string
  secs: number | null
  /** Who made the move that ENDED the stay (null = no person: an automatic move). */
  left_by?: string | null
  /** That move's origin marker ('machine' = an automation moved it). */
  left_origin?: string | null
}

/**
 * Whether a finished stay counts toward "usually N": it lasted at least a minute and a person
 * ended it. Automatic skips and automations (no person, or origin 'machine') and stays left
 * within seconds of arriving say nothing about how long people take. The SQL in readMedians
 * applies the same rule. Exported for tests.
 */
export function isRealStay(s: Stay): boolean {
  if (s.secs == null || !Number.isFinite(s.secs) || s.secs < MIN_REAL_STAY_S) return false
  if (s.left_by === null) return false
  if (String(s.left_origin ?? '').toLowerCase() === 'machine') return false
  return true
}

/** Median of real stays (seconds) per to-state id. Exported for tests. */
export function mediansFromStays(stays: Stay[], minStays = MEDIAN_MIN_STAYS): Map<string, number> {
  const by = new Map<string, number[]>()
  for (const s of stays) {
    if (!isRealStay(s)) continue
    const secs = Number(s.secs)
    const k = String(s.state).toLowerCase()
    const list = by.get(k)
    if (list) list.push(secs)
    else by.set(k, [secs])
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
    const lead = (col: string) =>
      `LEAD(${col}) OVER (PARTITION BY h.instance ORDER BY h.${qi(db, 'timestamp')}, h.id)`
    const stays = rawRows<Stay>(
      await db.raw(
        `SELECT to_state AS state, secs, left_by, left_origin FROM (
         SELECT h.to_state,
                ${dateDiff(db, 'second', `h.${qi(db, 'timestamp')}`, lead(`h.${qi(db, 'timestamp')}`))} AS secs,
                ${lead(`h.${qi(db, 'user')}`)} AS left_by,
                ${lead('h.origin')} AS left_origin
           FROM nivaro_workflow_history h WHERE h.${qi(db, 'timestamp')} >= ?) s
       WHERE secs IS NOT NULL AND to_state IS NOT NULL`,
        [since]
      )
    )
    return mediansFromStays(stays)
  }
  // Median per step in SQL (PERCENTILE_CONT) so a big history never travels to the process.
  const rows = (await db.raw(
    `SELECT DISTINCT s.to_state AS state,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.secs) OVER (PARTITION BY s.to_state) AS med,
            COUNT(*) OVER (PARTITION BY s.to_state) AS n
       FROM (
         SELECT h.to_state,
                DATEDIFF(SECOND, h.[timestamp],
                  LEAD(h.[timestamp]) OVER (PARTITION BY h.instance ORDER BY h.[timestamp], h.id)) AS secs,
                LEAD(h.[user]) OVER (PARTITION BY h.instance ORDER BY h.[timestamp], h.id) AS left_by,
                LEAD(h.origin) OVER (PARTITION BY h.instance ORDER BY h.[timestamp], h.id) AS left_origin
           FROM nivaro_workflow_history h
          WHERE h.[timestamp] >= ?
       ) s
      -- isRealStay(): at least a minute, ended by a person, not by an automation.
      WHERE s.secs >= ? AND s.to_state IS NOT NULL AND s.left_by IS NOT NULL
        AND (s.left_origin IS NULL OR s.left_origin <> 'machine')`,
    [since, MIN_REAL_STAY_S]
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
