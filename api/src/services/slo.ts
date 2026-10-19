/**
 * SLO dashboard (#666) — availability, p95 latency and error-budget burn per
 * instance, from the API request log, plus synthetic-monitor uptime.
 *
 *   availability  = share of requests that did not answer 5xx
 *   p95           = 95th percentile latency, read from a latency histogram
 *                   (one grouped scan instead of a percentile sort)
 *   error budget  = (1 − target) × requests in the window; consumed = 5xx
 *   burn rate     = 5xx share over the last 1h / 6h ÷ (1 − target): 1 spends
 *                   the budget exactly over the window, 14 in the last hour is
 *                   the classic page-now threshold
 *
 * Grouped by nivaro_api_logs.instance (migration 379) — several instances can
 * share one database. Rows written before the column existed read as
 * "(before tracking)". The request log keeps 14 days, so the window is capped
 * there — unless the long-history telemetry store is configured (#2544): then windows up to 30
 * days read their per-day figures from the store, and the burn rates (24 hours at most) still
 * come from the request log.
 */
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { storeEnabled } from './telemetry-store.js'
import { type StoreSloDay, storeSloRows } from './traffic-history-store.js'

export interface SloTargets {
  availability_pct: number
  p95_ms: number
  window_days: number
}

export const DEFAULT_SLO_TARGETS: SloTargets = {
  availability_pct: 99.5,
  p95_ms: 2000,
  window_days: 7
}
const LOG_RETENTION_DAYS = 14
/** With the long-history store, the standard 28/30-day windows. */
const STORE_WINDOW_DAYS = 30

/** The longest SLO window this instance can compute. */
export const maxSloWindowDays = (): number =>
  storeEnabled() ? STORE_WINDOW_DAYS : LOG_RETENTION_DAYS

export function parseSloTargets(raw: unknown): SloTargets {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      v = null
    }
  }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const num = (x: unknown, lo: number, hi: number, d: number) => {
    const n = Number(x)
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d
  }
  return {
    availability_pct: num(o.availability_pct, 50, 99.999, DEFAULT_SLO_TARGETS.availability_pct),
    p95_ms: Math.round(num(o.p95_ms, 50, 120_000, DEFAULT_SLO_TARGETS.p95_ms)),
    // A saved window longer than this instance can compute is shortened, not discarded.
    window_days: Math.round(
      Math.min(
        num(o.window_days, 1, STORE_WINDOW_DAYS, DEFAULT_SLO_TARGETS.window_days),
        maxSloWindowDays()
      )
    )
  }
}

/** Strict check for the settings PATCH; null = fine. */
export function validateSloTargets(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  const v =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw)
          } catch {
            return undefined
          }
        })()
      : raw
  if (!v || typeof v !== 'object') return 'slo_targets must be an object'
  const o = v as Record<string, unknown>
  const check = (k: string, lo: number, hi: number) => {
    if (o[k] == null) return null
    const n = Number(o[k])
    return Number.isFinite(n) && n >= lo && n <= hi ? null : `${k} must be between ${lo} and ${hi}`
  }
  return (
    check('availability_pct', 50, 99.999) ??
    check('p95_ms', 50, 120_000) ??
    check('window_days', 1, maxSloWindowDays())
  )
}

/** Latency histogram bucket → its upper edge in ms. */
const BUCKET_SQL = `CASE WHEN latency_ms < 1000 THEN (FLOOR(latency_ms / 25) + 1) * 25
  WHEN latency_ms < 10000 THEN (FLOOR(latency_ms / 250) + 1) * 250
  ELSE (FLOOR(latency_ms / 5000) + 1) * 5000 END`

/** p-th percentile from [{upper, n}] buckets (upper edge, count). */
export function percentileFromHistogram(
  buckets: Array<{ upper: number; n: number }>,
  p: number
): number | null {
  const total = buckets.reduce((s, b) => s + b.n, 0)
  if (total === 0) return null
  const want = Math.ceil(total * p)
  let seen = 0
  for (const b of [...buckets].sort((a, c) => a.upper - c.upper)) {
    seen += b.n
    if (seen >= want) return b.upper
  }
  return buckets[buckets.length - 1]?.upper ?? null
}

export interface InstanceSlo {
  instance: string
  requests: number
  errors_5xx: number
  errors_4xx: number
  availability_pct: number | null
  p95_ms: number | null
  budget: { allowed: number; consumed: number; remaining_pct: number | null }
  burn: { h1: number | null; h6: number | null; h24: number | null }
  days: Array<{
    day: string
    requests: number
    availability_pct: number | null
    p95_ms: number | null
  }>
  meets: { availability: boolean | null; p95: boolean | null }
}

export interface SloReport {
  targets: SloTargets
  instances: InstanceSlo[]
  monitors: Array<{
    monitor: string
    checks: number
    failing: number
    uptime_pct: number | null
    last: string | null
  }>
  instance_tracked: boolean
  computed_at: string
  /** Where the window's figures came from (`store` = the long-history store, #2544). */
  source: 'log' | 'store'
  /** The longest window this instance can compute (14, or 30 with the store). */
  window_max_days: number
  /** Set when the store was needed but did not answer (the window was cut to 14 days). */
  note?: string
}

const UNTRACKED = '(before tracking)'

export async function computeSlo(): Promise<SloReport> {
  const row = await db('nivaro_settings')
    .first('slo_targets')
    .catch(() => null)
  const targets = parseSloTargets((row as { slo_targets?: unknown } | null)?.slo_targets)
  // The histogram SQL is T-SQL; other dialects report targets only.
  if (!isMssql(db))
    return {
      targets,
      instances: [],
      monitors: [],
      instance_tracked: false,
      computed_at: new Date().toISOString(),
      source: 'log',
      window_max_days: maxSloWindowDays()
    }
  const tracked = await hasColumn('nivaro_api_logs', 'instance')
  const inst = tracked ? `ISNULL(instance, '${UNTRACKED}')` : `'${UNTRACKED}'`
  let from = new Date(Date.now() - targets.window_days * 86_400_000)
  let source: SloReport['source'] = 'log'
  let note: string | undefined
  let fromStore: { days: StoreSloDay[]; p95ByInstance: Map<string, number | null> } | null = null
  if (targets.window_days > LOG_RETENTION_DAYS && storeEnabled()) {
    try {
      fromStore = await storeSloRows(from.getTime(), Date.now())
      source = 'store'
    } catch {
      note = `The long-history store did not answer, so this covers the request log's last ${LOG_RETENTION_DAYS} days.`
      from = new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000)
    }
  }

  const hist = (
    fromStore
      ? []
      : await db.raw(
          `SELECT ${inst} AS instance, CONVERT(char(10), created_at, 23) AS day, ${BUCKET_SQL} AS upper,
            COUNT(*) AS n,
            SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS e5,
            SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS e4
       FROM nivaro_api_logs
      WHERE created_at >= ?
      GROUP BY ${inst}, CONVERT(char(10), created_at, 23), ${BUCKET_SQL}`,
          [from]
        )
  ) as Array<{ instance: string; day: string; upper: number; n: number; e5: number; e4: number }>

  const now = Date.now()
  const recent = (await db.raw(
    `SELECT ${inst} AS instance,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS t1,
            SUM(CASE WHEN created_at >= ? AND status >= 500 THEN 1 ELSE 0 END) AS e1,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS t6,
            SUM(CASE WHEN created_at >= ? AND status >= 500 THEN 1 ELSE 0 END) AS e6,
            COUNT(*) AS t24,
            SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS e24
       FROM nivaro_api_logs
      WHERE created_at >= ?
      GROUP BY ${inst}`,
    [
      new Date(now - 3_600_000),
      new Date(now - 3_600_000),
      new Date(now - 6 * 3_600_000),
      new Date(now - 6 * 3_600_000),
      new Date(now - 24 * 3_600_000)
    ]
  )) as Array<Record<string, number | string>>

  const allowedShare = 1 - targets.availability_pct / 100
  const burnOf = (t: number, e: number) =>
    t > 0 && allowedShare > 0 ? Math.round((e / t / allowedShare) * 100) / 100 : null

  const byInstance = new Map<string, typeof hist>()
  for (const h of hist) {
    const list = byInstance.get(h.instance) ?? []
    list.push(h)
    byInstance.set(h.instance, list)
  }
  const instances: InstanceSlo[] = []
  for (const [instance, rows] of byInstance) {
    const requests = rows.reduce((s, r) => s + Number(r.n), 0)
    const e5 = rows.reduce((s, r) => s + Number(r.e5), 0)
    const e4 = rows.reduce((s, r) => s + Number(r.e4), 0)
    const buckets = new Map<number, number>()
    const dayMap = new Map<string, { n: number; e5: number; b: Map<number, number> }>()
    for (const r of rows) {
      buckets.set(Number(r.upper), (buckets.get(Number(r.upper)) ?? 0) + Number(r.n))
      const d = dayMap.get(r.day) ?? { n: 0, e5: 0, b: new Map() }
      d.n += Number(r.n)
      d.e5 += Number(r.e5)
      d.b.set(Number(r.upper), (d.b.get(Number(r.upper)) ?? 0) + Number(r.n))
      dayMap.set(r.day, d)
    }
    const p95 = percentileFromHistogram(
      [...buckets].map(([upper, n]) => ({ upper, n })),
      0.95
    )
    const availability = requests ? Math.round((1 - e5 / requests) * 100_000) / 1000 : null
    const allowed = Math.floor(allowedShare * requests)
    const rec = recent.find((r) => r.instance === instance)
    instances.push({
      instance,
      requests,
      errors_5xx: e5,
      errors_4xx: e4,
      availability_pct: availability,
      p95_ms: p95,
      budget: {
        allowed,
        consumed: e5,
        remaining_pct: allowed > 0 ? Math.round((1 - e5 / allowed) * 1000) / 10 : e5 === 0 ? 100 : 0
      },
      burn: {
        h1: rec ? burnOf(Number(rec.t1), Number(rec.e1)) : null,
        h6: rec ? burnOf(Number(rec.t6), Number(rec.e6)) : null,
        h24: rec ? burnOf(Number(rec.t24), Number(rec.e24)) : null
      },
      days: [...dayMap]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, d]) => ({
          day,
          requests: d.n,
          availability_pct: d.n ? Math.round((1 - d.e5 / d.n) * 100_000) / 1000 : null,
          p95_ms: percentileFromHistogram(
            [...d.b].map(([upper, n]) => ({ upper, n })),
            0.95
          )
        })),
      meets: {
        availability: availability == null ? null : availability >= targets.availability_pct,
        p95: p95 == null ? null : p95 <= targets.p95_ms
      }
    })
  }
  if (fromStore) {
    for (const inst of storeInstances(fromStore, targets, (instance) => {
      const rec = recent.find((r) => r.instance === instance)
      return {
        h1: rec ? burnOf(Number(rec.t1), Number(rec.e1)) : null,
        h6: rec ? burnOf(Number(rec.t6), Number(rec.e6)) : null,
        h24: rec ? burnOf(Number(rec.t24), Number(rec.e24)) : null
      }
    }))
      instances.push(inst)
  }
  instances.sort((a, b) =>
    a.instance === UNTRACKED ? 1 : b.instance === UNTRACKED ? -1 : b.requests - a.requests
  )

  const mons = (await db('nivaro_job_runs')
    .where({ kind: 'monitor' })
    .where('started_at', '>=', from)
    .groupBy('job_id')
    .select('job_id')
    .count({ checks: '*' })
    .select(db.raw("SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failing"))
    .max({ last: 'started_at' })
    .catch(() => [])) as Array<{
    job_id: string
    checks: number
    failing: number
    last: Date | null
  }>

  return {
    targets,
    instances,
    monitors: mons
      .map((m) => ({
        monitor: m.job_id,
        checks: Number(m.checks),
        failing: Number(m.failing),
        uptime_pct: Number(m.checks)
          ? Math.round((1 - Number(m.failing) / Number(m.checks)) * 1000) / 10
          : null,
        last: m.last ? new Date(m.last).toISOString() : null
      }))
      .sort((a, b) => (a.uptime_pct ?? 100) - (b.uptime_pct ?? 100)),
    instance_tracked: tracked,
    computed_at: new Date().toISOString(),
    source,
    window_max_days: maxSloWindowDays(),
    ...(note ? { note } : {})
  }
}

/** InstanceSlo rows from the store's per-instance, per-day figures (#2544). */
export function storeInstances(
  rows: { days: StoreSloDay[]; p95ByInstance: Map<string, number | null> },
  targets: SloTargets,
  burnFor: (instance: string) => InstanceSlo['burn']
): InstanceSlo[] {
  const allowedShare = 1 - targets.availability_pct / 100
  const byInstance = new Map<string, StoreSloDay[]>()
  for (const d of rows.days) {
    const list = byInstance.get(d.instance) ?? []
    list.push(d)
    byInstance.set(d.instance, list)
  }
  const out: InstanceSlo[] = []
  for (const [instance, days] of byInstance) {
    const requests = days.reduce((s, d) => s + d.n, 0)
    const e5 = days.reduce((s, d) => s + d.e5, 0)
    const e4 = days.reduce((s, d) => s + d.e4, 0)
    const p95 = rows.p95ByInstance.get(instance) ?? null
    const availability = requests ? Math.round((1 - e5 / requests) * 100_000) / 1000 : null
    const allowed = Math.floor(allowedShare * requests)
    out.push({
      instance,
      requests,
      errors_5xx: e5,
      errors_4xx: e4,
      availability_pct: availability,
      p95_ms: p95,
      budget: {
        allowed,
        consumed: e5,
        remaining_pct: allowed > 0 ? Math.round((1 - e5 / allowed) * 1000) / 10 : e5 === 0 ? 100 : 0
      },
      burn: burnFor(instance),
      days: [...days]
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((d) => ({
          day: d.day,
          requests: d.n,
          availability_pct: d.n ? Math.round((1 - d.e5 / d.n) * 100_000) / 1000 : null,
          p95_ms: d.p95
        })),
      meets: {
        availability: availability == null ? null : availability >= targets.availability_pct,
        p95: p95 == null ? null : p95 <= targets.p95_ms
      }
    })
  }
  return out
}
