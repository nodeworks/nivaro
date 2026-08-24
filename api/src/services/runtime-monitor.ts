import { trackError } from './error-tracking.js'

/**
 * Runtime health monitor (#234): event-loop lag + memory, sampled in-process.
 * Lag is measured as timer drift (a 500ms timer firing at 900ms means the loop
 * was blocked ~400ms). Sustained breaches raise a deduped issue via the error
 * tracker — same fingerprint while it persists, so one incident is one row.
 */

const SAMPLE_MS = 500
const LAG_WARN_MS = 300
const RSS_WARN_MB = Number(process.env.RUNTIME_RSS_WARN_MB || 2048)

let lastSample = Date.now()
let recentLags: number[] = []
let maxLag1m = 0
let breachStreak = 0
let timer: ReturnType<typeof setInterval> | null = null

export function startRuntimeMonitor(): void {
  if (timer) return
  lastSample = Date.now()
  timer = setInterval(() => {
    const now = Date.now()
    const lag = Math.max(0, now - lastSample - SAMPLE_MS)
    lastSample = now
    recentLags.push(lag)
    if (recentLags.length > 120) recentLags = recentLags.slice(-120)
    maxLag1m = Math.max(...recentLags)

    const rssMb = process.memoryUsage.rss() / 1_048_576
    const lagBad = lag > LAG_WARN_MS
    const memBad = rssMb > RSS_WARN_MB
    breachStreak = lagBad || memBad ? breachStreak + 1 : 0
    // ~30s of continuous breach before raising — a single GC pause is noise.
    if (breachStreak === 60) {
      void trackError({
        source: 'server',
        route: 'runtime-monitor',
        severity: 'high',
        message: lagBad
          ? `Event loop lag sustained above ${LAG_WARN_MS}ms (max ${Math.round(maxLag1m)}ms over the last minute)`
          : `Process RSS at ${Math.round(rssMb)}MB, above the ${RSS_WARN_MB}MB warn threshold`,
        stack: JSON.stringify({ max_lag_ms: Math.round(maxLag1m), rss_mb: Math.round(rssMb) })
      }).catch(() => {})
    }
  }, SAMPLE_MS)
  timer.unref()
}

export function runtimeStats(): {
  uptime_seconds: number
  rss_mb: number
  heap_used_mb: number
  heap_total_mb: number
  event_loop_lag_ms: { current: number; max_1m: number }
} {
  const mem = process.memoryUsage()
  return {
    uptime_seconds: Math.round(process.uptime()),
    rss_mb: Math.round(mem.rss / 1_048_576),
    heap_used_mb: Math.round(mem.heapUsed / 1_048_576),
    heap_total_mb: Math.round(mem.heapTotal / 1_048_576),
    event_loop_lag_ms: {
      current: recentLags[recentLags.length - 1] ?? 0,
      max_1m: Math.round(maxLag1m)
    }
  }
}
