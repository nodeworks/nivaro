// api/src/services/traffic-taps/what-changed.ts
/**
 * Tap `what-changed` (#2148, #2247).
 *
 * WHAT CHANGED. Per entity, the last SPAN_MIN minutes of requests by minute, each minute split by
 * the dimensions a rise can be explained by: caller, route, screen (x-nivaro-page), client build
 * (x-nivaro-client) and response size bucket. `explainRise()` finds the minute the node's errors
 * or latency rose (the split of the last 15 minutes with the biggest before → after gain), then
 * compares the 15 minutes before with the minutes since and ranks every dimension value by its
 * share of the rise. The shares are an exact decomposition: for errors each value contributes
 * errors_after(v)/N_after − errors_before(v)/N_before, for latency the same with summed ms, and
 * the contributions add up to the whole rise. Values past VALUES_PER_DIM in a minute fold into
 * `__other__` so the sums still hold.
 *
 * PARTNER EDGES. Per `<entity>><downId>` the per-minute partner calls, failures and time plus a
 * small timed latency sample — what an alert on a route → partner edge reads (#2247).
 *
 * Bounded: ENTITY_CAP entities (idle ones are evicted first), VALUES_PER_DIM values per dimension
 * per minute, EDGE_CAP partner edges. O(1) per request.
 */
import { clientFactsOf } from '../traffic-client-facts.js'
import { OTHER_KEY } from '../traffic-ring.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { MinuteTotals } from './util.js'

export const WHAT_CHANGED_TAP = 'what-changed'
export const SPAN_MIN = 30
export const HALF_MIN = 15
export const ENTITY_CAP = 200
export const VALUES_PER_DIM = 8
export const EDGE_CAP = 300
const EDGE_LAT = 120

export const DIMS = ['caller', 'route', 'screen', 'build', 'size'] as const
export type Dim = (typeof DIMS)[number]
/** [requests, errors, summed ms] */
export type Triple = [number, number, number]

export interface MinuteAgg {
  m: number
  n: number
  e: number
  ms: number
  dims: Record<Dim, Map<string, Triple>>
}
interface EntityRing {
  slots: Array<MinuteAgg | null>
  lastMin: number
}
interface EdgeLat {
  at: Int32Array
  v: Float32Array
  i: number
}
interface State {
  entities: Map<string, EntityRing>
  edgeN: MinuteTotals
  edgeE: MinuteTotals
  edgeMs: MinuteTotals
  edgeLat: Map<string, EdgeLat>
}
const state = (): State =>
  tapState<State>(WHAT_CHANGED_TAP, () => ({
    entities: new Map(),
    edgeN: new MinuteTotals(EDGE_CAP),
    edgeE: new MinuteTotals(EDGE_CAP),
    edgeMs: new MinuteTotals(EDGE_CAP),
    edgeLat: new Map()
  }))

const emptyDims = (): Record<Dim, Map<string, Triple>> => ({
  caller: new Map(),
  route: new Map(),
  screen: new Map(),
  build: new Map(),
  size: new Map()
})

/** Response size bucket label. */
export function sizeBucket(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'streamed'
  if (bytes < 1024) return 'under 1 KB'
  if (bytes < 10 * 1024) return '1–10 KB'
  if (bytes < 100 * 1024) return '10–100 KB'
  if (bytes < 1024 * 1024) return '100 KB–1 MB'
  return 'over 1 MB'
}

function addDim(map: Map<string, Triple>, value: string, isErr: boolean, ms: number): void {
  let key = value
  if (!map.has(key) && map.size >= VALUES_PER_DIM) key = OTHER_KEY
  let t = map.get(key)
  if (!t) {
    t = [0, 0, 0]
    map.set(key, t)
  }
  t[0]++
  if (isErr) t[1]++
  t[2] += ms
}

function ringFor(entity: string, min: number): EntityRing {
  const s = state()
  let r = s.entities.get(entity)
  if (r) {
    // LRU: re-insert so the oldest-touched entity is first
    if (r.lastMin !== min) {
      s.entities.delete(entity)
      s.entities.set(entity, r)
    }
    return r
  }
  if (s.entities.size >= ENTITY_CAP) {
    const first = s.entities.keys().next().value
    if (first !== undefined) s.entities.delete(first)
  }
  r = { slots: new Array(SPAN_MIN).fill(null), lastMin: min }
  s.entities.set(entity, r)
  return r
}

/** Record one request (exported for tests; the tap calls it). */
export function recordRequest(input: {
  entityKey: string
  sec: number
  isError: boolean
  ms: number
  caller: string
  route: string
  screen?: string | null
  build?: string | null
  bytes?: number | null
}): void {
  if (input.entityKey.endsWith(`/${OTHER_KEY}`)) return
  const min = Math.floor(input.sec / 60)
  const r = ringFor(input.entityKey, min)
  r.lastMin = Math.max(r.lastMin, min)
  const i = ((min % SPAN_MIN) + SPAN_MIN) % SPAN_MIN
  let slot = r.slots[i]
  if (!slot || slot.m !== min) {
    if (slot && slot.m > min) return // older than the slot holds now
    slot = { m: min, n: 0, e: 0, ms: 0, dims: emptyDims() }
    r.slots[i] = slot
  }
  const ms = Number.isFinite(input.ms) ? Math.max(0, input.ms) : 0
  slot.n++
  if (input.isError) slot.e++
  slot.ms += ms
  addDim(slot.dims.caller, input.caller, input.isError, ms)
  addDim(slot.dims.route, input.route, input.isError, ms)
  addDim(slot.dims.screen, input.screen || 'not reported', input.isError, ms)
  addDim(slot.dims.build, input.build || 'not reported', input.isError, ms)
  addDim(slot.dims.size, sizeBucket(input.bytes), input.isError, ms)
}

/** The entity's minutes inside [nowMin − SPAN_MIN + 1, nowMin], oldest first. */
export function entityMinutes(entityKey: string, nowMin: number): MinuteAgg[] {
  const r = state().entities.get(entityKey)
  if (!r) return []
  return r.slots
    .filter((s): s is MinuteAgg => !!s && s.m > nowMin - SPAN_MIN && s.m <= nowMin)
    .sort((a, b) => a.m - b.m)
}

// ── analysis (pure) ─────────────────────────────────────────────────────────

export type RiseMetric = 'errors' | 'latency'

interface WindowSum {
  n: number
  dims: Record<Dim, Map<string, Triple>>
}
function sumWindow(series: MinuteAgg[], from: number, to: number): WindowSum {
  const out: WindowSum = { n: 0, dims: emptyDims() }
  for (const s of series) {
    if (s.m < from || s.m >= to) continue
    out.n += s.n
    for (const d of DIMS)
      for (const [v, t] of s.dims[d]) {
        const cur = out.dims[d].get(v) ?? [0, 0, 0]
        cur[0] += t[0]
        cur[1] += t[1]
        cur[2] += t[2]
        out.dims[d].set(v, cur)
      }
  }
  return out
}
function badOf(t: Triple, metric: RiseMetric): number {
  return metric === 'errors' ? t[1] : t[2]
}
/** Errors: percent of requests; latency: mean ms. */
function rateOf(series: MinuteAgg[], from: number, to: number, metric: RiseMetric): number {
  let n = 0
  let bad = 0
  for (const s of series) {
    if (s.m < from || s.m >= to) continue
    n += s.n
    bad += metric === 'errors' ? s.e : s.ms
  }
  if (!n) return 0
  return metric === 'errors' ? (100 * bad) / n : bad / n
}

/**
 * The minute the rise began: the split p in the last HALF_MIN minutes that maximises
 * rate[p, now] − rate[p − 15, p). Null when nothing rose.
 */
export function findPivot(series: MinuteAgg[], nowMin: number, metric: RiseMetric): number | null {
  let best: number | null = null
  let gain = 0
  for (let p = nowMin - HALF_MIN + 1; p <= nowMin; p++) {
    const after = series.filter((s) => s.m >= p && s.m <= nowMin)
    if (!after.some((s) => s.n > 0)) continue
    const g = rateOf(series, p, nowMin + 1, metric) - rateOf(series, p - HALF_MIN, p, metric)
    if (g > gain + 1e-9) {
      gain = g
      best = p
    }
  }
  return best
}

export interface Factor {
  dim: Dim
  value: string
  /** Share of the rise this value explains (0–1; can exceed 1 when others fell). */
  share: number
  /** In the metric's unit: percentage points of error rate, or ms of mean latency. */
  contribution: number
  before: { n: number; bad: number }
  after: { n: number; bad: number }
  /** Not seen in the 15 minutes before. */
  is_new: boolean
}
export interface Explanation {
  metric: RiseMetric
  rose: boolean
  pivot_min: number | null
  before: { from_min: number; to_min: number; n: number; rate: number }
  after: { from_min: number; to_min: number; n: number; rate: number }
  /** after.rate − before.rate */
  delta: number
  factors: Factor[]
  by_dim: Record<Dim, Factor[]>
}

/** Rank every dimension value by its share of the rise between the two windows (pure). */
export function explainRise(
  series: MinuteAgg[],
  nowMin: number,
  metric: RiseMetric,
  pivotMin?: number | null
): Explanation {
  const pivot = pivotMin ?? findPivot(series, nowMin, metric)
  const p = pivot ?? nowMin - HALF_MIN + 1
  const b = sumWindow(series, p - HALF_MIN, p)
  const a = sumWindow(series, p, nowMin + 1)
  const beforeRate = rateOf(series, p - HALF_MIN, p, metric)
  const afterRate = rateOf(series, p, nowMin + 1, metric)
  const delta = afterRate - beforeRate
  const scale = metric === 'errors' ? 100 : 1
  const factors: Factor[] = []
  for (const d of DIMS) {
    const values = new Set([...a.dims[d].keys(), ...b.dims[d].keys()])
    for (const v of values) {
      const ta = a.dims[d].get(v) ?? [0, 0, 0]
      const tb = b.dims[d].get(v) ?? [0, 0, 0]
      const ca = a.n ? (scale * badOf(ta, metric)) / a.n : 0
      const cb = b.n ? (scale * badOf(tb, metric)) / b.n : 0
      const contribution = ca - cb
      factors.push({
        dim: d,
        value: v,
        share: delta > 0 ? contribution / delta : 0,
        contribution: Math.round(contribution * 100) / 100,
        before: { n: tb[0], bad: Math.round(badOf(tb, metric)) },
        after: { n: ta[0], bad: Math.round(badOf(ta, metric)) },
        is_new: tb[0] === 0 && ta[0] > 0
      })
    }
  }
  const ranked = factors
    .filter((f) => f.contribution > 0 && (delta <= 0 || f.share >= 0.05))
    .sort((x, y) => y.contribution - x.contribution)
  const byDim = {} as Record<Dim, Factor[]>
  for (const d of DIMS) byDim[d] = ranked.filter((f) => f.dim === d).slice(0, 3)
  const round = (v: number) => Math.round(v * 100) / 100
  return {
    metric,
    rose: pivot != null && delta > 0,
    pivot_min: pivot,
    before: { from_min: p - HALF_MIN, to_min: p, n: b.n, rate: round(beforeRate) },
    after: { from_min: p, to_min: nowMin + 1, n: a.n, rate: round(afterRate) },
    delta: round(delta),
    factors: ranked.slice(0, 10),
    by_dim: byDim
  }
}

// ── partner edges ───────────────────────────────────────────────────────────

/** Record one partner call attributed to an entity (exported for tests). */
export function recordOutbound(
  entityKeyOf: string,
  downId: string,
  sec: number,
  failed: boolean,
  ms: number
): void {
  const s = state()
  const key = `${entityKeyOf}>${downId}`
  s.edgeN.add(key, sec, 1)
  if (failed) s.edgeE.add(key, sec, 1)
  if (Number.isFinite(ms) && ms > 0) s.edgeMs.add(key, sec, ms)
  let l = s.edgeLat.get(key)
  if (!l) {
    if (s.edgeLat.size >= EDGE_CAP) {
      const first = s.edgeLat.keys().next().value
      if (first !== undefined) s.edgeLat.delete(first)
    }
    l = { at: new Int32Array(EDGE_LAT).fill(-1), v: new Float32Array(EDGE_LAT), i: 0 }
    s.edgeLat.set(key, l)
  }
  l.at[l.i] = sec
  l.v[l.i] = Number.isFinite(ms) ? ms : 0
  l.i = (l.i + 1) % EDGE_LAT
}

/** Partner calls on one `<entity>><downId>` edge over the window. */
export function partnerEdgeTotals(
  key: string,
  windowS: number,
  sec: number
): { req: number; error: number; p95: number } {
  const s = state()
  const lat = s.edgeLat.get(key)
  const vals: number[] = []
  if (lat) for (let i = 0; i < EDGE_LAT; i++) if (lat.at[i] > sec - windowS) vals.push(lat.v[i])
  vals.sort((a, b) => a - b)
  return {
    req: s.edgeN.sum(key, windowS, sec),
    error: s.edgeE.sum(key, windowS, sec),
    p95: vals.length
      ? Math.round(vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))])
      : 0
  }
}

registerTrafficTap({
  id: WHAT_CHANGED_TAP,
  onRequest: (c) => {
    const f = clientFactsOf(c.ev.req)
    recordRequest({
      entityKey: c.entityKey,
      sec: c.sec,
      isError: c.isError,
      ms: c.ev.latencyMs,
      caller: c.caller,
      route: c.route,
      screen: f.page ? (f.app ? `${f.app} ${f.page}` : f.page) : null,
      build: f.build ?? null,
      bytes: c.ev.responseBytes ?? null
    })
  },
  onOutbound: (c) => {
    if (c.entityKey.endsWith('/__background__')) return
    recordOutbound(c.entityKey, c.downId, c.sec, c.failed, c.ev.durationMs)
  },
  sweep: (sec) => {
    const s = state()
    const min = Math.floor(sec / 60)
    for (const [k, r] of s.entities) if (r.lastMin < min - SPAN_MIN) s.entities.delete(k)
    s.edgeN.sweep(sec)
    s.edgeE.sweep(sec)
    s.edgeMs.sweep(sec)
    for (const [k, l] of s.edgeLat) if (Math.max(...l.at) < sec - 900) s.edgeLat.delete(k)
  }
})
