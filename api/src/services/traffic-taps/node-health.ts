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
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { setJournalObserver } from '../event-journal.js'
import { getIo } from '../io-holder.js'
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

/** Test hook. */
export function stopNodeHealth(): void {
  if (timer) clearInterval(timer)
  timer = null
  hist?.disable()
  hist = null
  observer?.disconnect()
  observer = null
  setJournalObserver(null)
  started = false
  samples.length = 0
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
  for (const [room, set] of rooms) {
    if (room.startsWith('watch:')) out.push({ room: room.slice(6), tabs: set.size })
  }
  return out.sort((a, b) => b.tabs - a.tabs).slice(0, 20)
}

export function nodeHealth(windowS: number, sec: number): NodeHealthSummary {
  return { ...summarizeHealth(samples, windowS, sec), watch: watchRooms() }
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
      watch: watchRooms()
    }
  },
  snapshot: (windowS, sec) => (started ? nodeHealth(windowS, sec) : undefined)
})
