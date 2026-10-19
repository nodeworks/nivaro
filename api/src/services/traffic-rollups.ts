// api/src/services/traffic-rollups.ts
/**
 * Request rollups in the metrics store (#2544 Phase 5) — 13 months of the Traffic Map's numbers
 * without keeping 13 months of request lines. The stack's vmalert turns the access lines in
 * VictoriaLogs into per-minute series (VictoriaMetrics keeps them 13 months); this module sums
 * them over each step.
 *
 * Series contract (VictoriaMetrics, `env` = TELEMETRY_STORE_ENV matched exactly — a `selftest`
 * env exists too; `stats_result` = which figure, on every series):
 *  - nivaro_tm_requests{env, inst, entity, stats_result="n"|"e"|"e5"}
 *        requests / status >= 400 / status >= 500 per minute, map node (`<lane>/<entity>`), instance
 *  - nivaro_tm_latency{env, inst, entity, stats_result="le_25"…"le_30000"|"le_inf"}
 *        CUMULATIVE counts of requests at or under each bound (ms); le_inf = every request
 *  - nivaro_route_requests / nivaro_route_latency{env, route, stats_result=…}
 *        the same per route template ("GET /api/…")
 *  - nivaro_tm_active_people_1h{env, stats_result="n"}
 *        distinct signed-in callers in the hour
 * Sample timestamps are whole minutes (hours for the 1h series); each sample covers the interval
 * ENDING at its timestamp. Every read here asks for points at the END of each step with a
 * lookbehind of exactly one step, so the point at `from + (s + 1) * step` is step `s` — the
 * same buckets stepIndex() in traffic-history-store.ts hands out. Steps with no samples (before
 * the rollups started, quiet hours) are simply absent and read as zero.
 * If 13-month reads over minute samples get slow at production volume, add hourly recording
 * rules (`<series>:1h` = sum_over_time(<series>[1h]) every hour) and point SERIES at them: the
 * arithmetic here does not change.
 *
 * Every expression is fixed text from this module; the only value in it is the configured env,
 * quoted by `envMatcher()`. Nothing a request sends becomes query text.
 */
import {
  type MetricSeries,
  metricsQuery,
  metricsRange,
  storeConfig,
  storeEnabled
} from './telemetry-store.js'
import type { TimelapseGroup } from './traffic-history-analysis.js'
import type { StoreSloDay } from './traffic-history-store.js'

/** How far back rollups are read (the metrics store keeps 13 months). */
export const ROLLUP_MAX_DAYS = 400
/** The longest window the screens offer from rollups (13 months). */
export const ROLLUP_WINDOW_DAYS = 395

export const rollupsEnabled = (): boolean => storeEnabled()

/** Latency bucket upper bounds (ms) the rollups count requests under. */
export const LATENCY_BOUNDS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000] as const
const LE_INF = 'le_inf'

const SERIES = {
  requests: 'nivaro_tm_requests',
  latency: 'nivaro_tm_latency',
  routeRequests: 'nivaro_route_requests',
  routeLatency: 'nivaro_route_latency',
  activePeople: 'nivaro_tm_active_people_1h'
} as const

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000

/** `{env="…"}` for the configured env (escaped), or `` when there is none. */
export function envMatcher(env: string | null): string {
  if (!env) return ''
  return `{env="${env.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}`
}

const sel = (metric: string) => `${metric}${envMatcher(storeConfig()?.env ?? null)}`

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * The p-quantile (0..1) of cumulative latency buckets (`le_25`…`le_30000`, `le_inf`), linearly
 * interpolated inside the bucket that crosses it. Past the last bound it answers that bound.
 * Null when there were no requests.
 */
export function percentileFromBuckets(buckets: Record<string, number>, p: number): number | null {
  const total = Math.max(
    num(buckets[LE_INF]),
    ...LATENCY_BOUNDS.map((b) => num(buckets[`le_${b}`]))
  )
  if (!(total > 0)) return null
  const target = Math.min(1, Math.max(0, p)) * total
  let prevBound = 0
  let prevCount = 0
  for (const bound of LATENCY_BOUNDS) {
    // Cumulative counts never fall; a missing bucket holds the previous count.
    const count = Math.max(prevCount, num(buckets[`le_${bound}`]))
    if (count >= target && count > 0) {
      const span = count - prevCount
      const frac = span > 0 ? (target - prevCount) / span : 1
      return Math.round(prevBound + Math.max(0, Math.min(1, frac)) * (bound - prevBound))
    }
    prevBound = bound
    prevCount = count
  }
  return LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1]
}

/** Approximate mean (ms) from cumulative buckets: each bucket's requests at its midpoint. */
export function meanFromBuckets(buckets: Record<string, number>): number | null {
  const total = num(buckets[LE_INF])
  if (!(total > 0)) return null
  let prevBound = 0
  let prevCount = 0
  let sum = 0
  for (const bound of LATENCY_BOUNDS) {
    const count = Math.max(prevCount, num(buckets[`le_${bound}`]))
    sum += (count - prevCount) * ((prevBound + bound) / 2)
    prevBound = bound
    prevCount = count
  }
  // Slower than the last bound: counted at the bound (a floor, not a guess).
  sum += Math.max(0, total - prevCount) * prevBound
  return Math.round((sum / total) * 10) / 10
}

/** Step index of a point read at the END of its step (`from + (s + 1) * step`), or -1. */
export function endStepIndex(t: number, from: number, to: number, stepS: number): number {
  const stepMs = stepS * 1000
  const steps = Math.max(1, Math.ceil((to - from) / stepMs))
  if (!Number.isFinite(t)) return -1
  const s = Math.round((t - from) / stepMs) - 1
  return s >= 0 && s < steps ? s : -1
}

/** One range read with the point at each step's end and a one-step lookbehind. */
function stepRange(
  expr: (window: string) => string,
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<MetricSeries[]> {
  return metricsRange(expr(`${Math.round(stepS)}s`), from + stepS * 1000, to, stepS, signal)
}

interface Cell {
  n: number
  e: number
  e5: number
  buckets: Record<string, number>
}
const newCell = (): Cell => ({ n: 0, e: 0, e5: 0, buckets: {} })

/** Fold request + latency series into cells keyed by `key(labels)` and step. */
function foldSteps(
  requests: MetricSeries[],
  latency: MetricSeries[],
  key: (labels: Record<string, string>) => string | null,
  from: number,
  to: number,
  stepS: number
): Map<string, Map<number, Cell>> {
  const out = new Map<string, Map<number, Cell>>()
  const cell = (k: string, s: number) => {
    let byStep = out.get(k)
    if (!byStep) {
      byStep = new Map()
      out.set(k, byStep)
    }
    let c = byStep.get(s)
    if (!c) {
      c = newCell()
      byStep.set(s, c)
    }
    return c
  }
  for (const series of requests) {
    const k = key(series.labels)
    const which = series.labels.stats_result
    if (k == null || (which !== 'n' && which !== 'e' && which !== 'e5')) continue
    for (const [t, v] of series.points) {
      const s = endStepIndex(t, from, to, stepS)
      if (s < 0 || !Number.isFinite(v)) continue
      cell(k, s)[which] += v
    }
  }
  for (const series of latency) {
    const k = key(series.labels)
    const which = series.labels.stats_result
    if (k == null || !which?.startsWith('le_')) continue
    for (const [t, v] of series.points) {
      const s = endStepIndex(t, from, to, stepS)
      if (s < 0 || !Number.isFinite(v)) continue
      const c = cell(k, s)
      c.buckets[which] = (c.buckets[which] ?? 0) + v
    }
  }
  return out
}

/** Requests, errors and p95 per step and map node over [from, to) — the time-lapse groups. */
export async function rollupSteps(
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<TimelapseGroup[]> {
  const [requests, latency] = await Promise.all([
    stepRange(
      (w) => `sum by (entity, stats_result) (sum_over_time(${sel(SERIES.requests)}[${w}]))`,
      from,
      to,
      stepS,
      signal
    ),
    stepRange(
      (w) => `sum by (entity, stats_result) (sum_over_time(${sel(SERIES.latency)}[${w}]))`,
      from,
      to,
      stepS,
      signal
    )
  ])
  const cells = foldSteps(requests, latency, (l) => l.entity || null, from, to, stepS)
  const out: TimelapseGroup[] = []
  for (const [entity, byStep] of cells) {
    for (const [s, c] of byStep) {
      if (!c.n) continue
      out.push({
        s,
        key: `e:${entity}`,
        n: Math.round(c.n),
        e: Math.round(c.e),
        p95: percentileFromBuckets(c.buckets, 0.95) ?? 0
      })
    }
  }
  return out
}

/** Peak hourly distinct signed-in people inside each step over [from, to). */
export async function rollupActive(
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<number[]> {
  const steps = Math.max(1, Math.ceil((to - from) / (stepS * 1000)))
  const active: number[] = new Array(steps).fill(0)
  // `max` across series: one per env (stats_result="n").
  const series = await stepRange(
    (w) => `max(max_over_time(${sel(SERIES.activePeople)}[${w}]))`,
    from,
    to,
    stepS,
    signal
  )
  for (const sr of series) {
    for (const [t, v] of sr.points) {
      const s = endStepIndex(t, from, to, stepS)
      if (s >= 0 && Number.isFinite(v)) active[s] = Math.max(active[s], Math.round(v))
    }
  }
  return active
}

export interface RollupStep {
  /** Step start (epoch ms). */
  at: number
  n: number
  e: number
  e5: number
  p50: number | null
  p95: number | null
  avg_ms: number | null
}

/** Whole-instance requests, errors and latency per step over [from, to). */
export async function rollupTotals(
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<RollupStep[]> {
  const [requests, latency] = await Promise.all([
    stepRange(
      (w) => `sum by (stats_result) (sum_over_time(${sel(SERIES.requests)}[${w}]))`,
      from,
      to,
      stepS,
      signal
    ),
    stepRange(
      (w) => `sum by (stats_result) (sum_over_time(${sel(SERIES.latency)}[${w}]))`,
      from,
      to,
      stepS,
      signal
    )
  ])
  const byStep = foldSteps(requests, latency, () => 'all', from, to, stepS).get('all')
  if (!byStep) return []
  return [...byStep]
    .sort((a, b) => a[0] - b[0])
    .map(([s, c]) => ({
      at: from + s * stepS * 1000,
      n: Math.round(c.n),
      e: Math.round(c.e),
      e5: Math.round(c.e5),
      p50: percentileFromBuckets(c.buckets, 0.5),
      p95: percentileFromBuckets(c.buckets, 0.95),
      avg_ms: meanFromBuckets(c.buckets)
    }))
}

/** A lookbehind covering [from, to) in whole hours (at least one). */
const hoursWindow = (from: number, to: number) =>
  `${Math.max(1, Math.ceil((to - from) / HOUR_MS))}h`

/** Fold instant samples into `{key → {n, e, e5, buckets}}`. */
function foldInstant(
  requests: Array<{ labels: Record<string, string>; value: number }>,
  latency: Array<{ labels: Record<string, string>; value: number }>,
  key: (labels: Record<string, string>) => string
): Map<string, Cell> {
  const out = new Map<string, Cell>()
  const cell = (k: string) => {
    let c = out.get(k)
    if (!c) {
      c = newCell()
      out.set(k, c)
    }
    return c
  }
  for (const r of requests) {
    const which = r.labels.stats_result
    if ((which === 'n' || which === 'e' || which === 'e5') && Number.isFinite(r.value))
      cell(key(r.labels))[which] += r.value
  }
  for (const r of latency) {
    const which = r.labels.stats_result
    if (!which?.startsWith('le_') || !Number.isFinite(r.value)) continue
    const c = cell(key(r.labels))
    c.buckets[which] = (c.buckets[which] ?? 0) + r.value
  }
  return out
}

export interface RollupRoute {
  method: string
  path: string
  route: string
  n: number
  e: number
  e5: number
  p50: number | null
  p95: number | null
  avg_ms: number | null
}

/** Per route template over [from, to): calls, errors and latency, busiest first. */
export async function rollupRouteTotals(
  from: number,
  to: number,
  limit = 20,
  signal?: AbortSignal
): Promise<RollupRoute[]> {
  const w = hoursWindow(from, to)
  const [requests, latency] = await Promise.all([
    metricsQuery(
      `sum by (route, stats_result) (sum_over_time(${sel(SERIES.routeRequests)}[${w}]))`,
      signal,
      to
    ),
    metricsQuery(
      `sum by (route, stats_result) (sum_over_time(${sel(SERIES.routeLatency)}[${w}]))`,
      signal,
      to
    )
  ])
  const cells = foldInstant(requests, latency, (l) => l.route || '(unknown)')
  return [...cells]
    .filter(([, c]) => c.n > 0)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map(([route, c]) => {
      const space = route.indexOf(' ')
      return {
        method: space > 0 ? route.slice(0, space) : '',
        path: space > 0 ? route.slice(space + 1) : route,
        route,
        n: Math.round(c.n),
        e: Math.round(c.e),
        e5: Math.round(c.e5),
        p50: percentileFromBuckets(c.buckets, 0.5),
        p95: percentileFromBuckets(c.buckets, 0.95),
        avg_ms: meanFromBuckets(c.buckets)
      }
    })
}

/** Whole-window totals over [from, to): requests, errors, p50 / p95 and an approximate mean. */
export async function rollupSummary(
  from: number,
  to: number,
  signal?: AbortSignal
): Promise<Omit<RollupStep, 'at'>> {
  const w = hoursWindow(from, to)
  const [requests, latency] = await Promise.all([
    metricsQuery(
      `sum by (stats_result) (sum_over_time(${sel(SERIES.requests)}[${w}]))`,
      signal,
      to
    ),
    metricsQuery(`sum by (stats_result) (sum_over_time(${sel(SERIES.latency)}[${w}]))`, signal, to)
  ])
  const c = foldInstant(requests, latency, () => 'all').get('all') ?? newCell()
  return {
    n: Math.round(c.n),
    e: Math.round(c.e),
    e5: Math.round(c.e5),
    p50: percentileFromBuckets(c.buckets, 0.5),
    p95: percentileFromBuckets(c.buckets, 0.95),
    avg_ms: meanFromBuckets(c.buckets)
  }
}

/** UTC midnight at or before `t`. */
const dayFloor = (t: number) => Math.floor(t / DAY_MS) * DAY_MS

/**
 * SLO rows from rollups: per instance and UTC day — requests, 5xx, 4xx and p95 — plus each
 * instance's whole-window p95. Same shape storeSloRows (traffic-history-store.ts) returns.
 */
export async function rollupSloRows(
  from: number,
  to: number,
  signal?: AbortSignal
): Promise<{ days: StoreSloDay[]; p95ByInstance: Map<string, number | null> }> {
  const dayFrom = dayFloor(from)
  const dayTo = dayFloor(to) + DAY_MS
  const stepS = DAY_MS / 1000
  const w = hoursWindow(from, to)
  const [requests, latency, windowLatency] = await Promise.all([
    stepRange(
      (win) => `sum by (inst, stats_result) (sum_over_time(${sel(SERIES.requests)}[${win}]))`,
      dayFrom,
      dayTo,
      stepS,
      signal
    ),
    stepRange(
      (win) => `sum by (inst, stats_result) (sum_over_time(${sel(SERIES.latency)}[${win}]))`,
      dayFrom,
      dayTo,
      stepS,
      signal
    ),
    metricsQuery(
      `sum by (inst, stats_result) (sum_over_time(${sel(SERIES.latency)}[${w}]))`,
      signal,
      to
    )
  ])
  const instOf = (l: Record<string, string>) => l.inst || '(unknown)'
  const cells = foldSteps(requests, latency, instOf, dayFrom, dayTo, stepS)
  const days: StoreSloDay[] = []
  for (const [instance, byStep] of cells) {
    for (const [s, c] of byStep) {
      if (!c.n) continue
      days.push({
        instance,
        day: new Date(dayFrom + s * DAY_MS).toISOString().slice(0, 10),
        n: Math.round(c.n),
        e5: Math.round(c.e5),
        e4: Math.max(0, Math.round(c.e - c.e5)),
        p95: percentileFromBuckets(c.buckets, 0.95)
      })
    }
  }
  days.sort((a, b) => a.instance.localeCompare(b.instance) || a.day.localeCompare(b.day))
  const p95ByInstance = new Map<string, number | null>()
  for (const [instance, c] of foldInstant([], windowLatency, instOf))
    p95ByInstance.set(instance, percentileFromBuckets(c.buckets, 0.95))
  return { days, p95ByInstance }
}
