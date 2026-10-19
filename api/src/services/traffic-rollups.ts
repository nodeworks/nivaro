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
 * The four count series also have hourly twins (`<series>:1h`, same labels, one sample per
 * closed hour, computed from the logs); any whole-hour lookbehind reads those (see `sel`).
 *
 * Every expression is fixed text from this module; the only value in it is the configured env,
 * quoted by `envMatcher()`. Nothing a request sends becomes query text.
 */
import {
  type MetricSeries,
  metricsQuery,
  metricsRange,
  STORE_MAX_DAYS,
  storeConfig,
  storeEnabled
} from './telemetry-store.js'
import type { TimelapseGroup } from './traffic-history-analysis.js'
import { type StoreSloDay, storeCallerSteps } from './traffic-history-store.js'

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
  activePeople: 'nivaro_tm_active_people_1h',
  // Partner calls (`nvr: "out"` lines): per down node and the entity it was made for.
  downRequests: 'nivaro_tm_down_requests',
  downLatency: 'nivaro_tm_down_latency',
  // Hourly only: per caller key (no minute series per person — 13 months of those is too many).
  callerRequests: 'nivaro_tm_caller_requests:1h'
} as const

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000

/** `{env="…"}` for the configured env (escaped), or `` when there is none. */
export function envMatcher(env: string | null): string {
  if (!env) return ''
  return `{env="${env.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}`
}

/** Seconds in a MetricsQL window like `43200s` or `395d`; NaN for anything else. */
export function windowSeconds(w: string): number {
  const m = /^(\d+)([smhd])$/.exec(w)
  if (!m) return Number.NaN
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as 's' | 'm' | 'h' | 'd']
}

/** Count series with an hourly twin (`<series>:1h`, same labels, one sample per closed hour). */
const HOURLY = new Set<string>([
  SERIES.requests,
  SERIES.latency,
  SERIES.routeRequests,
  SERIES.routeLatency,
  SERIES.downRequests,
  SERIES.downLatency
])

/**
 * The selector for `metric` under a `[window]` lookbehind: the hourly twin when the window is
 * whole hours (60x fewer samples over 13 months), else the per-minute series. The hourly twin
 * has no sample for the hour still running, so a window ending now leaves that hour out.
 */
export function sel(metric: string, window?: string): string {
  const s = window ? windowSeconds(window) : Number.NaN
  const name = HOURLY.has(metric) && s >= 3600 && s % 3600 === 0 ? `${metric}:1h` : metric
  return `${name}${envMatcher(storeConfig()?.env ?? null)}`
}

/** `metric{env="…", k="v", …}` — extra matchers are fixed names from this module, values escaped. */
export function selWith(metric: string, extra: Record<string, string>, window?: string): string {
  const base = sel(metric, window)
  const brace = base.indexOf('{')
  const name = brace < 0 ? base : base.slice(0, brace)
  const parts = brace < 0 ? [] : [base.slice(brace + 1, -1)]
  for (const [k, v] of Object.entries(extra))
    parts.push(`${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return parts.length ? `${name}{${parts.join(',')}}` : name
}

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
      (w) => `sum by (entity, stats_result) (sum_over_time(${sel(SERIES.requests, w)}[${w}]))`,
      from,
      to,
      stepS,
      signal
    ),
    stepRange(
      (w) => `sum by (entity, stats_result) (sum_over_time(${sel(SERIES.latency, w)}[${w}]))`,
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

/** Partner nodes (`d:<down id>`) per step over [from, to), from the `nvr: "out"` rollups. */
export async function rollupDownSteps(
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<TimelapseGroup[]> {
  const [requests, latency] = await Promise.all([
    stepRange(
      (w) => `sum by (down, stats_result) (sum_over_time(${sel(SERIES.downRequests, w)}[${w}]))`,
      from,
      to,
      stepS,
      signal
    ),
    stepRange(
      (w) => `sum by (down, stats_result) (sum_over_time(${sel(SERIES.downLatency, w)}[${w}]))`,
      from,
      to,
      stepS,
      signal
    )
  ])
  return groupsOf(
    foldSteps(requests, latency, (l) => l.down || null, from, to, stepS),
    'd:'
  )
}

/** Cells → time-lapse groups with `prefix` on each key (steps with no requests dropped). */
function groupsOf(cells: Map<string, Map<number, Cell>>, prefix: string): TimelapseGroup[] {
  const out: TimelapseGroup[] = []
  for (const [k, byStep] of cells) {
    for (const [s, c] of byStep) {
      if (!c.n) continue
      out.push({
        s,
        key: `${prefix}${k}`,
        n: Math.round(c.n),
        e: Math.round(c.e),
        p95: percentileFromBuckets(c.buckets, 0.95) ?? 0
      })
    }
  }
  return out
}

/**
 * Callers (`c:<caller key>`) per step from the hourly per-caller rollups — for windows past the
 * log store's month (no latency there, so p95 is 0). Steps must be whole hours.
 */
export async function rollupCallerSteps(
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<TimelapseGroup[]> {
  const requests = await stepRange(
    (w) => `sum by (caller, stats_result) (sum_over_time(${sel(SERIES.callerRequests)}[${w}]))`,
    from,
    to,
    stepS,
    signal
  )
  return groupsOf(
    foldSteps(requests, [], (l) => l.caller || null, from, to, stepS),
    'c:'
  )
}

/**
 * The Traffic Map time-lapse from the telemetry stack (#2544): map nodes and partners from the
 * rollups; callers from the raw access lines while the log store still holds the window (31
 * days), else from the hourly per-caller rollups (whole-hour steps only). A failing partner or
 * caller read leaves those nodes out; a failing node read throws, so the caller can fall back.
 */
export async function stackSteps(
  from: number,
  to: number,
  stepS: number,
  nowMs = Date.now(),
  signal?: AbortSignal
): Promise<TimelapseGroup[]> {
  const rawCallers = from >= nowMs - STORE_MAX_DAYS * DAY_MS
  const callers = rawCallers
    ? storeCallerSteps(from, to, stepS, signal)
    : stepS % 3600 === 0
      ? rollupCallerSteps(from, to, stepS, signal)
      : Promise.resolve([])
  const [nodes, downs, people] = await Promise.all([
    rollupSteps(from, to, stepS, signal),
    rollupDownSteps(from, to, stepS, signal).catch(() => []),
    callers.catch(() => [])
  ])
  return [...nodes, ...downs, ...people]
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
      (w) => `sum by (stats_result) (sum_over_time(${sel(SERIES.requests, w)}[${w}]))`,
      from,
      to,
      stepS,
      signal
    ),
    stepRange(
      (w) => `sum by (stats_result) (sum_over_time(${sel(SERIES.latency, w)}[${w}]))`,
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
      `sum by (route, stats_result) (sum_over_time(${sel(SERIES.routeRequests, w)}[${w}]))`,
      signal,
      to
    ),
    metricsQuery(
      `sum by (route, stats_result) (sum_over_time(${sel(SERIES.routeLatency, w)}[${w}]))`,
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
      `sum by (stats_result) (sum_over_time(${sel(SERIES.requests, w)}[${w}]))`,
      signal,
      to
    ),
    metricsQuery(
      `sum by (stats_result) (sum_over_time(${sel(SERIES.latency, w)}[${w}]))`,
      signal,
      to
    )
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

let dataFromCache: { at: number; value: number | null } | null = null

/**
 * When the rollups start (epoch ms of the first request sample within ROLLUP_MAX_DAYS), so a
 * long view can say "Data from …" instead of looking like quiet months. Cached for an hour;
 * null when there is none or the store does not answer.
 */
export async function rollupDataFrom(nowMs = Date.now()): Promise<number | null> {
  if (dataFromCache && nowMs - dataFromCache.at < HOUR_MS) return dataFromCache.value
  const w = `${ROLLUP_MAX_DAYS}d`
  let value: number | null = null
  try {
    const [first] = await metricsQuery(
      `min(tfirst_over_time(${sel(SERIES.requests, w)}[${w}]))`,
      undefined,
      nowMs
    )
    value = first && Number.isFinite(first.value) ? Math.round(first.value * 1000) : null
  } catch {
    return null
  }
  dataFromCache = { at: nowMs, value }
  return value
}

export function resetRollupDataFromForTests(): void {
  dataFromCache = null
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
      (win) => `sum by (inst, stats_result) (sum_over_time(${sel(SERIES.requests, win)}[${win}]))`,
      dayFrom,
      dayTo,
      stepS,
      signal
    ),
    stepRange(
      (win) => `sum by (inst, stats_result) (sum_over_time(${sel(SERIES.latency, win)}[${win}]))`,
      dayFrom,
      dayTo,
      stepS,
      signal
    ),
    metricsQuery(
      `sum by (inst, stats_result) (sum_over_time(${sel(SERIES.latency, w)}[${w}]))`,
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

export interface BusiestMinutes {
  /** Requests in the busiest single minute in the window (0 = no data). */
  best_rpm: number
  /** Start of that minute (epoch ms), when known. */
  at: number | null
  /** Busiest minute per week (UTC weeks starting Monday), oldest first. */
  weekly: Array<{ week: string; peak_rpm: number }>
  /** End of the first day with any data (epoch ms), or null. */
  data_from: number | null
}

/** Monday 00:00 UTC of the week holding `t`, as YYYY-MM-DD. */
export function weekOf(t: number): string {
  const d = dayFloor(t)
  const back = (new Date(d).getUTCDay() + 6) % 7
  return new Date(d - back * DAY_MS).toISOString().slice(0, 10)
}

/** Fold daily peaks ([day END ms, peak per minute]) into the weekly peaks and the best day. */
export function foldDailyPeaks(points: Array<[number, number]>): {
  best: { t: number; v: number } | null
  weekly: Array<{ week: string; peak_rpm: number }>
  first: number | null
} {
  const weeks = new Map<string, number>()
  let best: { t: number; v: number } | null = null
  let first: number | null = null
  for (const [t, v] of points) {
    if (!Number.isFinite(v) || v <= 0) continue
    if (first == null || t < first) first = t
    // A day's point is stamped at its END, so the day itself is the one just before.
    const wk = weekOf(t - 1)
    weeks.set(wk, Math.max(weeks.get(wk) ?? 0, v))
    if (!best || v > best.v) best = { t, v }
  }
  const weekly = [...weeks]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, peak]) => ({ week, peak_rpm: Math.round(peak) }))
  return { best, weekly, first }
}

/**
 * The busiest single minute over the last `days` days (the capacity ceiling, #2544): daily
 * peaks of the per-minute request total, then the exact minute inside the best day. `instance`
 * narrows to one instance's lines (the `inst` label), the way the request-log ceiling does.
 */
export async function rollupBusiestMinutes(
  days: number,
  instance: string | null,
  nowMs = Date.now(),
  signal?: AbortSignal
): Promise<BusiestMinutes> {
  const extra: Record<string, string> = { stats_result: 'n' }
  if (instance) extra.inst = instance
  // Each minute's own total (its samples only — never a stale earlier minute), peaked per day.
  const perMinute = `sum(sum_over_time(${selWith(SERIES.requests, extra)}[1m]))`
  const end = Math.ceil(nowMs / DAY_MS) * DAY_MS
  const start = end - Math.max(1, Math.min(ROLLUP_MAX_DAYS, Math.round(days))) * DAY_MS
  const daily = await metricsRange(
    `max_over_time(${perMinute}[1d:1m])`,
    start + DAY_MS,
    end,
    DAY_MS / 1000,
    signal
  )
  const { best, weekly, first } = foldDailyPeaks(daily.flatMap((sr) => sr.points))
  if (!best) return { best_rpm: 0, at: null, weekly, data_from: first }
  let at: number | null = null
  try {
    const minutes = await metricsRange(perMinute, best.t - DAY_MS + 60_000, best.t, 60, signal)
    let top = 0
    for (const sr of minutes)
      for (const [t, v] of sr.points)
        if (Number.isFinite(v) && v > top) {
          top = v
          // The point covers the minute ENDING at t.
          at = t - 60_000
        }
  } catch {
    at = null
  }
  return { best_rpm: Math.round(best.v), at, weekly, data_from: first }
}
