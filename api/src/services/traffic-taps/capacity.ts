// api/src/services/traffic-taps/capacity.ts
/**
 * Traffic Map: headroom (#1123) and a 15-minute load projection (#1153).
 *
 * Headroom = the current request rate against a ceiling: a configured one
 * (TRAFFIC_CAPACITY_RPS) or the best sustained minute this instance has carried (the request log
 * over the last LOG_DAYS days, folded per minute, and this process's own ring). Pool use sits
 * beside it.
 *
 * Projection = the last 15 minutes' per-minute rate, extended by its linear trend and blended
 * with how the same clock window usually moves on earlier days (from the same per-minute log
 * read). The pool estimate scales today's pool use per request/s with the projected rate.
 *
 * The log read is one grouped statement (per minute, LOG_DAYS days), cached for CACHE_MS and
 * refreshed in the background — the route never waits on it.
 */

import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { runLongSql } from '../run-long.js'
import { instanceKey } from '../settings-overrides.js'
import { currentTrafficSec } from '../traffic-map.js'
import { registerTrafficTap, SecondRing, tapState } from '../traffic-taps.js'

export const TAP_ID = 'capacity'
export const LOG_DAYS = 7
const CACHE_MS = 30 * 60_000
const POOL_SAMPLE_MS = 5000
const POOL_SAMPLES = 60 // 5 minutes

interface State {
  ring: SecondRing
}
function state(): State {
  return tapState<State>(TAP_ID, () => ({ ring: new SecondRing(2, currentTrafficSec()) }))
}

registerTrafficTap({
  id: TAP_ID,
  onRequest: (c) => {
    const r = state().ring
    r.bump(c.sec, 0)
    if (c.isError) r.bump(c.sec, 1)
  }
})

// ── pool ─────────────────────────────────────────────────────────────────────
interface TarnPool {
  numUsed?: () => number
  numPendingAcquires?: () => number
  max?: number
}
function pool(): TarnPool | null {
  const p = (db.client as unknown as { pool?: TarnPool }).pool
  return p && typeof p === 'object' ? p : null
}
const poolSamples: Array<{ at: number; used: number; pending: number; rps: number }> = []
let poolTimer: NodeJS.Timeout | null = null

/** Sample pool use beside the request rate every 5 s (idempotent; never in cloud mode). */
export function startCapacitySampling(): void {
  if (poolTimer || process.env.CLOUD_META_DB_URL) return
  poolTimer = setInterval(() => {
    const p = pool()
    if (!p) return
    const sec = currentTrafficSec()
    poolSamples.push({
      at: sec,
      used: p.numUsed?.() ?? 0,
      pending: p.numPendingAcquires?.() ?? 0,
      rps: state().ring.sum(10, sec)[0] / 10
    })
    if (poolSamples.length > POOL_SAMPLES) poolSamples.shift()
  }, POOL_SAMPLE_MS)
  poolTimer.unref?.()
}
export function stopCapacitySampling(): void {
  if (poolTimer) clearInterval(poolTimer)
  poolTimer = null
  poolSamples.length = 0
}

// ── the request log, per minute ──────────────────────────────────────────────
interface LogMinutes {
  /** Epoch minute of index 0. */
  start: number
  counts: Int32Array
  at: number
  instanceFiltered: boolean
}
let logCache: LogMinutes | null = null
let logInflight: Promise<void> | null = null
let logError: string | null = null

const SAFE_INSTANCE = /^[A-Za-z0-9_.@:-]{1,80}$/

async function readLogMinutes(): Promise<void> {
  if (!isMssql(db)) {
    logError = 'Only measured on SQL Server'
    return
  }
  const sinceMin = Math.floor(Date.now() / 60_000) - LOG_DAYS * 1440
  const since = new Date(sinceMin * 60_000).toISOString().slice(0, 19)
  const inst = instanceKey()
  const filterInstance =
    SAFE_INSTANCE.test(inst) && (await hasColumn('nivaro_api_logs', 'instance'))
  // Server-built literals only (runLongSql binds nothing): an ISO stamp and a checked instance key.
  const rows = await runLongSql<{ m: number; n: number }>(
    `SELECT DATEDIFF(minute, '${since}', created_at) AS m, COUNT(*) AS n
       FROM nivaro_api_logs WITH (NOLOCK)
      WHERE created_at >= '${since}'${filterInstance ? ` AND instance = '${inst}'` : ''}
      GROUP BY DATEDIFF(minute, '${since}', created_at)`,
    { timeoutMs: 120_000 }
  )
  const counts = new Int32Array(LOG_DAYS * 1440 + 2)
  for (const r of rows) {
    const m = Number(r.m)
    if (m >= 0 && m < counts.length) counts[m] = Number(r.n) || 0
  }
  logCache = { start: sinceMin, counts, at: Date.now(), instanceFiltered: filterInstance }
  logError = null
}

/** The cached per-minute log (kicking off a refresh when stale); null until the first read. */
export function logMinutes(): LogMinutes | null {
  const stale = !logCache || Date.now() - logCache.at > CACHE_MS
  if (stale && !logInflight) {
    logInflight = readLogMinutes()
      .catch((err) => {
        logError = err instanceof Error ? err.message.slice(0, 200) : 'read failed'
      })
      .finally(() => {
        logInflight = null
      })
  }
  return logCache
}
export function setLogMinutesForTest(v: LogMinutes | null): void {
  logCache = v
}

// ── pure figures ─────────────────────────────────────────────────────────────
/** Busiest single minute in the counts (requests in that minute). */
export function bestMinute(counts: ArrayLike<number>): { n: number; index: number } {
  let n = 0
  let index = -1
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > n) {
      n = counts[i]
      index = i
    }
  }
  return { n, index }
}

/**
 * How the next 15 minutes usually compare with the last 15 at this clock time: the mean over
 * earlier days of (requests in [t, t+15m)) / (requests in [t−15m, t)). Days with no traffic in
 * the earlier window are skipped; null when no day qualifies.
 */
export function seasonalRatio(
  counts: ArrayLike<number>,
  startMinute: number,
  nowMinute: number,
  days = LOG_DAYS
): number | null {
  const ratios: number[] = []
  for (let d = 1; d <= days; d++) {
    const t = nowMinute - d * 1440 - startMinute
    if (t - 15 < 0 || t + 15 > counts.length) continue
    let prev = 0
    let next = 0
    for (let i = t - 15; i < t; i++) prev += counts[i]
    for (let i = t; i < t + 15; i++) next += counts[i]
    if (prev >= 15) ratios.push(next / prev)
  }
  if (!ratios.length) return null
  ratios.sort((a, b) => a - b)
  return ratios[Math.floor(ratios.length / 2)]
}

export interface Projection {
  /** Projected req/s for each of the next 15 minutes. */
  points: number[]
  trend: 'rising' | 'falling' | 'flat'
  /** Minutes until the projected rate passes the ceiling (null = not within 15). */
  minutes_to_ceiling: number | null
  /** Minutes until the projected pool use reaches the pool size (null = not within 15 / unknown). */
  minutes_to_pool_limit: number | null
  /** Pool connections in use per request/s right now (null = not measurable). */
  pool_per_rps: number | null
  seasonal_ratio: number | null
}

/**
 * Next 15 minutes from the last 15 minutes' per-minute rates (req/s, oldest first): least-squares
 * trend, blended half and half with the seasonal ratio when one is known, never below zero.
 */
export function projectLoad(input: {
  minuteRps: number[]
  seasonalRatio: number | null
  ceilingRps: number | null
  poolPerRps: number | null
  poolMax: number | null
}): Projection {
  const y = input.minuteRps.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const n = y.length
  const xm = (n - 1) / 2
  const ym = n ? y.reduce((a, b) => a + b, 0) / n : 0
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (y[i] - ym)
    den += (i - xm) ** 2
  }
  const slope = den > 0 ? num / den : 0
  // Recent level: the last 3 minutes, so one quiet minute does not set the base.
  const base = n ? y.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, n) : 0
  const points: number[] = []
  for (let k = 1; k <= 15; k++) {
    const trend = base + slope * k
    const seasonal =
      input.seasonalRatio != null ? base * (1 + ((input.seasonalRatio - 1) * k) / 15) : null
    const v = seasonal != null ? (trend + seasonal) / 2 : trend
    points.push(Math.max(0, Math.round(v * 100) / 100))
  }
  const rel = ym > 0 ? (points[14] - base) / ym : 0
  const trend: Projection['trend'] = rel > 0.15 ? 'rising' : rel < -0.15 ? 'falling' : 'flat'
  const firstAbove = (limit: number | null, scale = 1) => {
    if (limit == null || !(limit > 0)) return null
    const i = points.findIndex((p) => p * scale >= limit)
    return i < 0 ? null : i + 1
  }
  return {
    points,
    trend,
    minutes_to_ceiling: firstAbove(input.ceilingRps),
    minutes_to_pool_limit:
      input.poolPerRps != null && input.poolPerRps > 0
        ? firstAbove(input.poolMax, input.poolPerRps)
        : null,
    pool_per_rps: input.poolPerRps,
    seasonal_ratio: input.seasonalRatio
  }
}

/** Pool connections in use per request/s, from samples with traffic (null when unmeasurable). */
export function poolPerRps(list: Array<{ used: number; rps: number }>): number | null {
  const busy = list.filter((s) => s.rps > 0.05)
  if (busy.length < 3) return null
  const used = busy.reduce((a, s) => a + s.used, 0) / busy.length
  const rps = busy.reduce((a, s) => a + s.rps, 0) / busy.length
  return rps > 0 && used > 0 ? Math.round((used / rps) * 1000) / 1000 : null
}

export interface CapacityReport {
  now_rps: number
  /** Busiest minute this process saw in its ring (req/s). */
  ring_best_rps: number
  ceiling: {
    rps: number | null
    source: 'configured' | 'measured' | 'ring' | null
    /** When the measured busiest minute happened (ISO), when measured. */
    at: string | null
    measuring: boolean
    error: string | null
    instance_filtered: boolean
  }
  headroom_pct: number | null
  pool: { used: number; pending: number; max: number; saturated_pct: number }
  projection: Projection
}

export function capacityReport(sec = currentTrafficSec()): CapacityReport {
  const ring = state().ring
  const nowRps = ring.sum(60, sec)[0] / 60
  // per-minute rates over the ring (15 points of 60 s)
  const minuteCounts = ring.series(900, sec, 15)
  const minuteRps = minuteCounts.map((c) => c / 60)
  const ringBest = Math.max(0, ...minuteRps)
  const configured = Number(process.env.TRAFFIC_CAPACITY_RPS)
  const log = logMinutes()
  let ceilingRps: number | null = null
  let source: CapacityReport['ceiling']['source'] = null
  let at: string | null = null
  if (Number.isFinite(configured) && configured > 0) {
    ceilingRps = configured
    source = 'configured'
  } else if (log || logError) {
    // Until the request log has been read once the ceiling is unknown — a fresh process's own
    // ring would make any rate read as ~100% of what it can carry.
    const best = log ? bestMinute(log.counts) : { n: 0, index: -1 }
    const measured = best.n / 60
    if (measured >= ringBest && measured > 0) {
      ceilingRps = Math.round(measured * 100) / 100
      source = 'measured'
      at = log ? new Date((log.start + best.index) * 60_000).toISOString() : null
    } else if (ringBest > 0) {
      ceilingRps = Math.round(ringBest * 100) / 100
      source = 'ring'
    }
  }
  const p = pool()
  const used = p?.numUsed?.() ?? 0
  const max = p?.max ?? 0
  const recent = poolSamples.slice(-12)
  const saturated = recent.length
    ? Math.round((100 * recent.filter((s) => max > 0 && s.used >= max).length) / recent.length)
    : 0
  const nowMinute = Math.floor((sec * 1000) / 60_000)
  const ratio = log ? seasonalRatio(log.counts, log.start, nowMinute) : null
  return {
    now_rps: Math.round(nowRps * 100) / 100,
    ring_best_rps: Math.round(ringBest * 100) / 100,
    ceiling: {
      rps: ceilingRps,
      source,
      at,
      measuring: !log && !logError,
      error: logError,
      instance_filtered: log?.instanceFiltered ?? false
    },
    headroom_pct: ceilingRps ? Math.round((100 * nowRps) / ceilingRps) : null,
    pool: {
      used,
      pending: p?.numPendingAcquires?.() ?? 0,
      max,
      saturated_pct: saturated
    },
    projection: projectLoad({
      minuteRps,
      seasonalRatio: ratio,
      ceilingRps,
      poolPerRps: poolPerRps(poolSamples),
      poolMax: max || null
    })
  }
}
