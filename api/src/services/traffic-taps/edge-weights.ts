// api/src/services/traffic-taps/edge-weights.ts
/**
 * #2185 — what an edge weighs besides its request count: response bytes, total time and errors,
 * per map edge, so the flow canvas can draw edge thickness by any of them.
 *
 * Edge keys are the map's own: `caller>lane` (into the API) and `lane>down` (out of it).
 *  - caller → lane: every request adds its response bytes (when the body had a size), its
 *    latency and 1 when it failed.
 *  - lane → down: a request also adds its bytes and latency to each store it went through (the
 *    database, the cache, file storage); a partner call adds its own duration and 1 when it failed.
 *
 * frame:    { i: { [edge]: [bytes, ms, errors] }, o: { … } } — what this second added.
 * snapshot: the same over the window (per-minute buckets, the minute before included like the
 *           map's own minute counts), for the page to seed its rings.
 *
 * O(1) per request and bounded (EDGE_CAP edges per direction, idle ones evicted first), like the
 * map's own counters; the per-second figures only leave the process in a watched frame.
 */
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const EDGE_WEIGHTS_TAP = 'edge-weights'
/** Edges kept per direction (callers × lanes can be large on a busy instance). */
export const EDGE_CAP = 2000
const MINUTES = 15
/** Slots per edge: response bytes, total milliseconds, errors. */
const SLOTS = 3
/** Un-drained per-second figures older than this are dropped (nobody watched the frame). */
const PENDING_MAX_AGE_S = 2

/** Per-minute sums stamped with their minute, so a wrapped slot never reads stale. */
export interface MinuteSums {
  m: Int32Array
  v: Float64Array
}
export function newMinuteSums(): MinuteSums {
  return { m: new Int32Array(MINUTES).fill(-1), v: new Float64Array(MINUTES * SLOTS) }
}
export function addMinute(s: MinuteSums, sec: number, add: readonly number[]): void {
  const mn = Math.floor(sec / 60)
  const i = mn % MINUTES
  if (s.m[i] !== mn) {
    s.m[i] = mn
    s.v.fill(0, i * SLOTS, i * SLOTS + SLOTS)
  }
  for (let k = 0; k < SLOTS; k++) s.v[i * SLOTS + k] += add[k] ?? 0
}
/** Sums of the minutes covering the `windowS` seconds ending at `sec` (+ the minute before). */
export function sumMinutes(s: MinuteSums, windowS: number, sec: number): number[] {
  const minutes = Math.min(MINUTES, Math.ceil(windowS / 60) + 1)
  const cur = Math.floor(sec / 60)
  const out = [0, 0, 0]
  for (let k = 0; k < minutes; k++) {
    const mn = cur - k
    const i = ((mn % MINUTES) + MINUTES) % MINUTES
    if (s.m[i] !== mn) continue
    for (let j = 0; j < SLOTS; j++) out[j] += s.v[i * SLOTS + j]
  }
  return out
}
function newestMinute(s: MinuteSums): number {
  let n = -1
  for (let i = 0; i < MINUTES; i++) if (s.m[i] > n) n = s.m[i]
  return n
}

interface Direction {
  minutes: Map<string, MinuteSums>
  pending: Map<string, number[]>
}
interface State {
  i: Direction
  o: Direction
  /** Second of the oldest figure in `pending` (either direction); null = empty. */
  pendingSince: number | null
}
const dir = (): Direction => ({ minutes: new Map(), pending: new Map() })
const state = (): State =>
  tapState<State>(EDGE_WEIGHTS_TAP, () => ({ i: dir(), o: dir(), pendingSince: null }))

/** The edge's minute sums; null when the direction is full and nothing idle could make room. */
function slotOf(d: Direction, key: string, sec: number): MinuteSums | null {
  let s = d.minutes.get(key)
  if (s) return s
  if (d.minutes.size >= EDGE_CAP) {
    const cur = Math.floor(sec / 60)
    for (const [k, v] of d.minutes)
      if (newestMinute(v) < cur - (MINUTES - 1)) {
        d.minutes.delete(k)
        break
      }
    if (d.minutes.size >= EDGE_CAP) return null
  }
  s = newMinuteSums()
  d.minutes.set(key, s)
  return s
}

/** Count one weight sample on an edge (exported for tests). */
export function noteEdgeWeight(
  side: 'in' | 'out',
  key: string,
  sec: number,
  bytes: number,
  ms: number,
  error: boolean
): void {
  const st = state()
  // a backlog nobody drained (no watched frame) is not news when a watcher joins
  if (st.pendingSince !== null && sec - st.pendingSince > PENDING_MAX_AGE_S) {
    st.i.pending.clear()
    st.o.pending.clear()
    st.pendingSince = null
  }
  const d = side === 'in' ? st.i : st.o
  const add = [
    Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
    Number.isFinite(ms) && ms > 0 ? ms : 0,
    error ? 1 : 0
  ]
  const s = slotOf(d, key, sec)
  if (!s) return
  addMinute(s, sec, add)
  const p = d.pending.get(key)
  if (p) for (let k = 0; k < SLOTS; k++) p[k] += add[k]
  else if (d.pending.size < EDGE_CAP) d.pending.set(key, add)
  if (st.pendingSince === null) st.pendingSince = sec
}

const rounded = (v: number[]) => [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])]

function drain(d: Direction): Record<string, number[]> | null {
  if (d.pending.size === 0) return null
  const out: Record<string, number[]> = {}
  for (const [k, v] of d.pending) out[k] = rounded(v)
  d.pending.clear()
  return out
}

const tap: TrafficTap = {
  id: EDGE_WEIGHTS_TAP,
  onRequest(c) {
    const bytes = c.ev.responseBytes ?? 0
    const ms = c.ev.latencyMs
    noteEdgeWeight('in', `${c.caller}>${c.lane}`, c.sec, bytes, ms, c.isError)
    for (const d of c.downs ?? []) noteEdgeWeight('out', `${c.lane}>${d}`, c.sec, bytes, ms, false)
  },
  onOutbound(c) {
    const lane = c.entityKey.slice(0, c.entityKey.indexOf('/'))
    if (!lane) return
    noteEdgeWeight('out', `${lane}>${c.downId}`, c.sec, 0, c.ev.durationMs, c.failed)
  },
  frame() {
    const st = state()
    const i = drain(st.i)
    const o = drain(st.o)
    st.pendingSince = null
    if (!i && !o) return undefined
    return { ...(i ? { i } : {}), ...(o ? { o } : {}) }
  },
  snapshot(windowS, sec) {
    const st = state()
    const read = (d: Direction) => {
      const out: Record<string, number[]> = {}
      for (const [k, s] of d.minutes) {
        const v = sumMinutes(s, windowS, sec)
        if (v[0] || v[1] || v[2]) out[k] = rounded(v)
      }
      return out
    }
    const i = read(st.i)
    const o = read(st.o)
    if (!Object.keys(i).length && !Object.keys(o).length) return undefined
    return { i, o }
  },
  sweep(sec) {
    const st = state()
    const cur = Math.floor(sec / 60)
    for (const d of [st.i, st.o])
      for (const [k, s] of d.minutes) if (newestMinute(s) < cur - (MINUTES - 1)) d.minutes.delete(k)
  }
}
registerTrafficTap(tap)
