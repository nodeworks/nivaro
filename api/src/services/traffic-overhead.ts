// api/src/services/traffic-overhead.ts
/**
 * #2178 — what the Traffic Map costs the API it watches, and the brake that keeps it cheap.
 *
 * Measured per store (tapState, so a cloud tenant sees its own): the time spent recording
 * requests (the map's counting plus every tap), the time spent building frames, the bytes
 * handed to sockets and to the Redis relay, and how many ticker events were kept or sampled.
 * Cheap by construction: two hrtime reads per request and one add into a 60 s ring.
 *
 * The brake: once the request rate passes a threshold (setting `overhead.sample_above_rps`,
 * env TRAFFIC_SAMPLE_ABOVE_RPS), the ticker keeps 1 of every N successful-read/write events.
 * Counts, errors and every figure on the canvas stay exact — only the ticker thins out.
 */
import { SecondRing } from './traffic-ring.js'
import { currentStoreId, DEFAULT_STORE, tapState, withTrafficStore } from './traffic-taps.js'

export const OVERHEAD_TAP = 'overhead'
const SLOT = {
  req: 0,
  reqUs: 1,
  frameUs: 2,
  frames: 3,
  socketBytes: 4,
  redisBytes: 5,
  eventsSeen: 6,
  eventsSampled: 7
} as const
const SLOTS = 8
/** The report averages this many seconds. */
export const REPORT_WINDOW_S = 60
/** The rate is judged on this many seconds. */
const RATE_WINDOW_S = 5
/** Never keep fewer than 1 in this many events, however busy it gets. */
export const MAX_EVERY = 50
/** A frame's size is measured on every Nth frame and scaled (stringify costs as much as emit). */
export const FRAME_SIZE_EVERY = 4

interface State {
  ring: SecondRing
  every: number
  counter: number
  rps: number
  since: number | null
  frameNo: number
}
const state = (): State =>
  tapState<State>(OVERHEAD_TAP, () => ({
    ring: new SecondRing(SLOTS, Math.floor(Date.now() / 1000)),
    every: 1,
    counter: 0,
    rps: 0,
    since: null,
    frameNo: 0
  }))

/** Sampling starts above this many requests a second unless the settings or the env say else. */
export const DEFAULT_SAMPLE_RPS = 300
export const SAMPLE_RPS_MAX = 100_000
/** The default sampling threshold: TRAFFIC_SAMPLE_ABOVE_RPS (0 = never), else DEFAULT_SAMPLE_RPS. */
export function envSampleRps(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRAFFIC_SAMPLE_ABOVE_RPS
  if (raw === undefined || raw === '') return DEFAULT_SAMPLE_RPS
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= SAMPLE_RPS_MAX ? n : DEFAULT_SAMPLE_RPS
}

let threshold = envSampleRps()
/** The request rate (per second) above which the ticker is sampled; 0 = never. */
export function setSampleThreshold(rps: number): void {
  threshold = Number.isFinite(rps) && rps >= 0 ? Math.floor(rps) : DEFAULT_SAMPLE_RPS
}
export function sampleThreshold(): number {
  return threshold
}

/** How many events to thin to one (pure): 1 = keep all. */
export function planEvery(rps: number, thresholdRps: number): number {
  if (thresholdRps <= 0 || rps <= thresholdRps) return 1
  return Math.min(MAX_EVERY, Math.max(2, Math.ceil(rps / thresholdRps)))
}

const nowSec = () => Math.floor(Date.now() / 1000)

/** Call with the hrtime taken before recording a request (inside its store). */
export function noteRequestCost(t0: bigint): void {
  try {
    const us = Number((process.hrtime.bigint() - t0) / 1000n)
    const r = state().ring
    const sec = nowSec()
    r.bump(sec, SLOT.req)
    r.bump(sec, SLOT.reqUs, us)
  } catch {
    /* never */
  }
}

/** One frame built (micros), and its wire size when this frame was measured. */
export function noteFrameCost(sec: number, micros: number): void {
  state().ring.bump(sec, SLOT.frames)
  state().ring.bump(sec, SLOT.frameUs, Math.round(micros))
}
/** Whether this frame's size should be measured (every FRAME_SIZE_EVERY-th). */
export function measureThisFrame(): boolean {
  const st = state()
  st.frameNo++
  return st.frameNo % FRAME_SIZE_EVERY === 0
}
/** Bytes handed to browsers for one frame (scaled up for the frames not measured). */
export function noteSocketBytes(sec: number, bytes: number): void {
  state().ring.bump(sec, SLOT.socketBytes, Math.round(bytes * FRAME_SIZE_EVERY))
}
/** Bytes sent or received by the Redis relay, attributed to the store the message names. */
export function noteRedisBytes(store: string | null | undefined, bytes: number): void {
  try {
    withTrafficStore(store || DEFAULT_STORE, () => {
      state().ring.bump(nowSec(), SLOT.redisBytes, Math.round(bytes))
    })
  } catch {
    /* never */
  }
}

/** Should this ticker event be queued? Errors always; the rest 1 in `every` while sampling. */
export function keepEvent(isError: boolean): boolean {
  if (currentStoreId() === '') return true
  const st = state()
  const sec = nowSec()
  st.ring.bump(sec, SLOT.eventsSeen)
  if (isError || st.every <= 1) return true
  st.counter++
  if (st.counter % st.every === 0) return true
  st.ring.bump(sec, SLOT.eventsSampled)
  return false
}

/** Once a second per store (the emitter): re-judge the request rate and the sampling step. */
export function overheadTick(sec: number): void {
  const st = state()
  const s = st.ring.sum(RATE_WINDOW_S, sec)
  st.rps = s[SLOT.req] / RATE_WINDOW_S
  const every = planEvery(st.rps, threshold)
  if (every > 1 && st.every <= 1) st.since = Date.now()
  if (every <= 1) st.since = null
  st.every = every
}

export interface MapMemoryFacts {
  entities: number
  callers: number
  downs: number
  bytes: number
}
export interface OverheadReport {
  window_s: number
  req_per_s: number
  /** Time recording requests + building frames, per second, in milliseconds. */
  cpu_ms_per_s: number
  /** The same as a share of one core. */
  cpu_pct: number
  record_us_per_req: number
  frame_ms: number
  frames_per_s: number
  socket_bytes_per_s: number
  redis_bytes_per_s: number
  events_seen_per_s: number
  events_sampled_per_s: number
  sampling: {
    on: boolean
    /** Keep 1 event in this many (1 = all). */
    every: number
    threshold_rps: number
    rps: number
    since: string | null
  }
  memory: MapMemoryFacts & { process_rss: number; process_heap_used: number }
  watchers: number
}

/** Round to `d` decimals. */
const r = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

/** The figures for the current store (call inside it). */
export function overheadReport(memory: MapMemoryFacts, watchers: number): OverheadReport {
  const st = state()
  const sec = nowSec()
  const s = st.ring.sum(REPORT_WINDOW_S, sec)
  const w = REPORT_WINDOW_S
  const cpuMs = (s[SLOT.reqUs] + s[SLOT.frameUs]) / 1000 / w
  const mem = process.memoryUsage()
  return {
    window_s: w,
    req_per_s: r(s[SLOT.req] / w),
    cpu_ms_per_s: r(cpuMs, 2),
    cpu_pct: r(cpuMs / 10, 2),
    record_us_per_req: s[SLOT.req] ? r(s[SLOT.reqUs] / s[SLOT.req]) : 0,
    frame_ms: s[SLOT.frames] ? r(s[SLOT.frameUs] / 1000 / s[SLOT.frames], 2) : 0,
    frames_per_s: r(s[SLOT.frames] / w, 2),
    socket_bytes_per_s: Math.round(s[SLOT.socketBytes] / w),
    redis_bytes_per_s: Math.round(s[SLOT.redisBytes] / w),
    events_seen_per_s: r(s[SLOT.eventsSeen] / w),
    events_sampled_per_s: r(s[SLOT.eventsSampled] / w),
    sampling: {
      on: st.every > 1,
      every: st.every,
      threshold_rps: threshold,
      rps: r(st.rps),
      since: st.since ? new Date(st.since).toISOString() : null
    },
    memory: { ...memory, process_rss: mem.rss, process_heap_used: mem.heapUsed },
    watchers
  }
}
