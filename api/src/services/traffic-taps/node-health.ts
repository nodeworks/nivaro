// api/src/services/traffic-taps/node-health.ts
/**
 * Traffic Map: how this API process itself is doing.
 *
 * #1142 event-loop lag (perf_hooks monitorEventLoopDelay) and GC pauses — a slow node whose SQL
 * is fast is CPU-bound, and these say so. #1101 realtime health: how long each journaled socket
 * emit spent in Redis (event-journal), emits that went out unjournaled, and how many tabs watch
 * each live view (watch:* rooms on this node).
 *
 * Sampled every SAMPLE_S seconds into a ring covering the map's 15 minutes, whether or not anyone
 * watches the map (a cheap read of a histogram and two counters). `startNodeHealth` is called once
 * by the route plugin; tests drive the pure summarisers.
 */
import {
  monitorEventLoopDelay,
  PerformanceObserver,
  constants as perfConstants
} from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import { setJournalObserver } from '../event-journal.js'
import { getIo } from '../io-holder.js'
import { splitTenantRoom } from '../socket-transport.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { RING_SECONDS } from '../traffic-ring.js'
import { registerTrafficTap } from '../traffic-taps.js'

export const TAP_ID = 'node-health'
export const SAMPLE_S = 5
const SLOTS = RING_SECONDS / SAMPLE_S

export interface HealthSample {
  /** Epoch second the sample closed. */
  at: number
  loop_p50: number
  loop_p99: number
  loop_max: number
  gc_count: number
  gc_ms: number
  gc_max: number
  emits: number
  emit_ms_max: number
  /** Journaling times of the sample (for percentiles), capped. */
  emit_ms: number[]
  unjournaled: number
}

const samples: HealthSample[] = []

/** #2158 — memory still held right after a major collection (what the process cannot give back). */
export interface HeapPoint {
  at: number
  mb: number
}
/** Newest post-major-GC points kept (at most one per HEAP_MIN_GAP_S), any age. */
const HEAP_KEEP = 120
const HEAP_MIN_GAP_S = 10
const heapPoints: HeapPoint[] = []
const MB = 1024 * 1024
const r1 = (v: number) => Math.round(v * 10) / 10

function noteHeapAfterGc(): void {
  try {
    const at = Math.floor(Date.now() / 1000)
    const last = heapPoints[heapPoints.length - 1]
    if (last && at - last.at < HEAP_MIN_GAP_S) return
    heapPoints.push({ at, mb: r1(getHeapStatistics().used_heap_size / MB) })
    if (heapPoints.length > HEAP_KEEP) heapPoints.shift()
  } catch {
    /* no heap figure */
  }
}
let gc = { count: 0, ms: 0, max: 0 }
let journal = { emits: 0, max: 0, ms: [] as number[], unjournaled: 0 }
let started = false
let timer: NodeJS.Timeout | null = null
let hist: ReturnType<typeof monitorEventLoopDelay> | null = null
let observer: PerformanceObserver | null = null

const ns = (v: number) => (Number.isFinite(v) ? Math.round((v / 1e6) * 10) / 10 : 0)

function closeSample(): void {
  const at = Math.floor(Date.now() / 1000)
  const h = hist
  const s: HealthSample = {
    at,
    loop_p50: h ? ns(h.percentile(50)) : 0,
    loop_p99: h ? ns(h.percentile(99)) : 0,
    loop_max: h ? ns(h.max) : 0,
    gc_count: gc.count,
    gc_ms: Math.round(gc.ms * 10) / 10,
    gc_max: Math.round(gc.max * 10) / 10,
    emits: journal.emits,
    emit_ms_max: Math.round(journal.max * 10) / 10,
    emit_ms: journal.ms,
    unjournaled: journal.unjournaled
  }
  h?.reset()
  gc = { count: 0, ms: 0, max: 0 }
  journal = { emits: 0, max: 0, ms: [], unjournaled: 0 }
  samples.push(s)
  if (samples.length > SLOTS) samples.shift()
}

/** Start sampling (idempotent). Never in cloud mode — the map records nothing there. */
export function startNodeHealth(): void {
  if (started || process.env.CLOUD_META_DB_URL) return
  started = true
  try {
    hist = monitorEventLoopDelay({ resolution: 20 })
    hist.enable()
  } catch {
    hist = null
  }
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const kind = (e as unknown as { detail?: { kind?: number }; kind?: number }).detail?.kind
        if (
          (kind ?? (e as unknown as { kind?: number }).kind) ===
          perfConstants.NODE_PERFORMANCE_GC_MAJOR
        )
          noteHeapAfterGc()
        gc.count++
        gc.ms += e.duration
        if (e.duration > gc.max) gc.max = e.duration
      }
    })
    observer.observe({ entryTypes: ['gc'] })
  } catch {
    observer = null
  }
  try {
    setJournalObserver((ms, journaled) => {
      journal.emits++
      if (ms > journal.max) journal.max = ms
      if (journal.ms.length < 200) journal.ms.push(ms)
      if (!journaled) journal.unjournaled++
    })
  } catch {
    /* no journal figures */
  }
  timer = setInterval(closeSample, SAMPLE_S * 1000)
  timer.unref?.()
}

/** Stop sampling (the owning app closed; tests). */
export function stopNodeHealth(): void {
  if (timer) clearInterval(timer)
  timer = null
  hist?.disable()
  hist = null
  observer?.disconnect()
  observer = null
  try {
    setJournalObserver(null)
  } catch {
    /* as in start: no journal figures to detach */
  }
  started = false
  samples.length = 0
  heapPoints.length = 0
}

/** Test hook: push a post-GC heap point. */
export function pushHeapPoint(p: HeapPoint): void {
  heapPoints.push(p)
  if (heapPoints.length > HEAP_KEEP) heapPoints.shift()
}

/** A steady climb needs at least this many post-GC points spanning this many seconds. */
export const HEAP_MIN_POINTS = 6
export const HEAP_MIN_SPAN_S = 300
/** MB per minute the fitted line must climb, and how well the points must follow it (r²). */
export const HEAP_GROW_MB_PER_MIN = 0.5
export const HEAP_MIN_R2 = 0.6
/** …and the rise must also be this big overall: 10 MB, or 10% of the start when that is less. */
export const HEAP_MIN_RISE_MB = 10
export const HEAP_MIN_RISE_SHARE = 0.1

export interface HeapTrend {
  points: number
  span_s: number
  slope_mb_per_min: number
  r2: number
  growing: boolean
  /** Minutes until the heap limit at this slope; null unless growing and a limit is known. */
  minutes_to_limit: number | null
}

/**
 * Is the memory held after garbage collection climbing steadily? A least-squares line through
 * the post-GC points: it must climb (slope), follow the points closely (r²) and rise by more
 * than noise. Pure — the tap and its tests both call it.
 */
export function heapTrend(points: HeapPoint[], limitMb: number | null = null): HeapTrend {
  const none: HeapTrend = {
    points: points.length,
    span_s: 0,
    slope_mb_per_min: 0,
    r2: 0,
    growing: false,
    minutes_to_limit: null
  }
  if (points.length < 2) return none
  const t0 = points[0].at
  const span = points[points.length - 1].at - t0
  const n = points.length
  let sx = 0
  let sy = 0
  for (const p of points) {
    sx += (p.at - t0) / 60
    sy += p.mb
  }
  const mx = sx / n
  const my = sy / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of points) {
    const dx = (p.at - t0) / 60 - mx
    const dy = p.mb - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  if (sxx === 0) return { ...none, span_s: span }
  const slope = sxy / sxx
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy)
  const rise = points[n - 1].mb - points[0].mb
  const growing =
    n >= HEAP_MIN_POINTS &&
    span >= HEAP_MIN_SPAN_S &&
    slope >= HEAP_GROW_MB_PER_MIN &&
    r2 >= HEAP_MIN_R2 &&
    rise >= Math.min(HEAP_MIN_RISE_MB, points[0].mb * HEAP_MIN_RISE_SHARE)
  const left = limitMb != null ? limitMb - points[n - 1].mb : null
  return {
    points: n,
    span_s: span,
    slope_mb_per_min: r1(slope),
    r2: Math.round(r2 * 100) / 100,
    growing,
    minutes_to_limit:
      growing && left != null && left > 0 && slope > 0 ? Math.round(left / slope) : null
  }
}

export interface HeapSummary {
  /** Newest memory held after a major collection; null until one has run. */
  after_gc_mb: number | null
  used_mb: number
  rss_mb: number
  limit_mb: number | null
  /** Post-GC points, oldest first (at most 60, for the sparkline). */
  series: number[]
  trend: HeapTrend
}

/** The heap figures now: post-GC points of the last `windowS` seconds (at least the last 6). */
export function heapSummary(windowS = 1800, sec = Math.floor(Date.now() / 1000)): HeapSummary {
  let used = 0
  let limit: number | null = null
  try {
    const h = getHeapStatistics()
    used = h.used_heap_size / MB
    limit = h.heap_size_limit / MB
  } catch {
    /* none */
  }
  const inWin = heapPoints.filter((p) => p.at > sec - windowS)
  const pts = inWin.length >= HEAP_MIN_POINTS ? inWin : heapPoints.slice(-HEAP_MIN_POINTS)
  return {
    after_gc_mb: heapPoints.length ? heapPoints[heapPoints.length - 1].mb : null,
    used_mb: r1(used),
    rss_mb: r1(process.memoryUsage().rss / MB),
    limit_mb: limit != null ? Math.round(limit) : null,
    series: pts.slice(-60).map((p) => p.mb),
    trend: heapTrend(pts, limit)
  }
}

/** Test hook: push a sample. */
export function pushHealthSample(s: HealthSample): void {
  samples.push(s)
  if (samples.length > SLOTS) samples.shift()
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

export interface NodeHealthSummary {
  heap?: HeapSummary
  window_s: number
  sample_s: number
  loop: { p50: number; p99: number; max: number; series: number[] }
  gc: { count: number; ms: number; max: number; per_min: number }
  journal: { emits: number; p95_ms: number; max_ms: number; unjournaled: number }
  watch: Array<{ room: string; tabs: number }>
}

/** The window's samples folded into one summary (`series` = loop p99 per point, oldest first). */
export function summarizeHealth(
  list: HealthSample[],
  windowS: number,
  sec: number,
  points = 30
): Omit<NodeHealthSummary, 'watch'> {
  const inWin = list.filter((s) => s.at > sec - windowS && s.at <= sec)
  const p99s = inWin.map((s) => s.loop_p99).sort((a, b) => a - b)
  const p50s = inWin.map((s) => s.loop_p50).sort((a, b) => a - b)
  const emitMs = inWin.flatMap((s) => s.emit_ms).sort((a, b) => a - b)
  const gcCount = inWin.reduce((a, s) => a + s.gc_count, 0)
  const series = new Array<number>(points).fill(0)
  for (const s of inWin) {
    const i = Math.min(points - 1, Math.floor(((s.at - (sec - windowS)) / windowS) * points))
    if (i >= 0) series[i] = Math.max(series[i], s.loop_p99)
  }
  return {
    window_s: windowS,
    sample_s: SAMPLE_S,
    loop: {
      p50: pct(p50s, 0.5),
      p99: pct(p99s, 0.95),
      max: inWin.reduce((a, s) => Math.max(a, s.loop_max), 0),
      series
    },
    gc: {
      count: gcCount,
      ms: Math.round(inWin.reduce((a, s) => a + s.gc_ms, 0)),
      max: inWin.reduce((a, s) => Math.max(a, s.gc_max), 0),
      per_min: windowS > 0 ? Math.round((gcCount * 600) / windowS) / 10 : 0
    },
    journal: {
      emits: inWin.reduce((a, s) => a + s.emits, 0),
      p95_ms: Math.round(pct(emitMs, 0.95) * 10) / 10,
      max_ms: inWin.reduce((a, s) => Math.max(a, s.emit_ms_max), 0),
      unjournaled: inWin.reduce((a, s) => a + s.unjournaled, 0)
    }
  }
}

/** Tabs watching each live view (watch:* rooms) on this node. */
export function watchRooms(): Array<{ room: string; tabs: number }> {
  const io = getIo() as unknown as {
    sockets?: { adapter?: { rooms?: Map<string, Set<string>> } }
  } | null
  const rooms = io?.sockets?.adapter?.rooms
  if (!rooms) return []
  const out: Array<{ room: string; tabs: number }> = []
  // Cloud: the caller's tenant's watch rooms only (`t:<tenant>:watch:<room>`, and the Traffic
  // Map's `watch:traffic-map:t:<tenant>`).
  const tenant = currentTenantKey()
  for (const [scoped, set] of rooms) {
    const { tenant: roomTenant, room } = splitTenantRoom(scoped)
    if (!room.startsWith('watch:')) continue
    const store = /^watch:traffic-map:t:(.+)$/.exec(room)
    if (store ? store[1] !== tenant : roomTenant !== tenant) continue
    out.push({ room: store ? 'traffic-map' : room.slice(6), tabs: set.size })
  }
  return out.sort((a, b) => b.tabs - a.tabs).slice(0, 20)
}

export function nodeHealth(windowS: number, sec: number): NodeHealthSummary {
  return { ...summarizeHealth(samples, windowS, sec), watch: watchRooms(), heap: heapSummary() }
}

registerTrafficTap({
  id: TAP_ID,
  // Live figures: the newest closed sample (no allocation beyond the reply object).
  frame: () => {
    const s = samples[samples.length - 1]
    if (!s) return undefined
    return {
      at: s.at,
      loop_p99: s.loop_p99,
      loop_max: s.loop_max,
      gc_ms: s.gc_ms,
      emits: s.emits,
      emit_ms_max: s.emit_ms_max,
      heap_mb: heapPoints.length ? heapPoints[heapPoints.length - 1].mb : null,
      watch: watchRooms()
    }
  },
  snapshot: (windowS, sec) => (started ? nodeHealth(windowS, sec) : undefined)
})
