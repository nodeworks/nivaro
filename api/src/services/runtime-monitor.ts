import { readFileSync } from 'node:fs'
import { trackError } from './error-tracking.js'
import { noteLagSample } from './ops-signals.js'

/**
 * Runtime health monitor (#234): event-loop lag + memory, sampled in-process.
 * Lag is measured as timer drift (a 500ms timer firing at 900ms means the loop
 * was blocked ~400ms). Sustained breaches raise a deduped issue via the error
 * tracker — same fingerprint while it persists, so one incident is one row.
 */

const SAMPLE_MS = 500
const LAG_WARN_MS = 300
/** The container's memory limit in MB (cgroup v2, else v1), or null outside a limit. */
export function cgroupMemoryLimitMb(
  read: (path: string) => string | null = (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }
): number | null {
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const raw = read(p)?.trim()
    if (!raw || raw === 'max') continue
    const bytes = Number(raw)
    // v1 reports ~2^63 for "no limit".
    if (Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 50) return Math.floor(bytes / 1048576)
  }
  return null
}

/** RSS warn level: RUNTIME_RSS_WARN_MB, else 80% of the container limit, never under 2048 MB
 *  (2026-11-09: 8 GiB web tasks importing big invoice files tripped a fixed 2048 MB warning). */
export function rssWarnMb(envValue: string | undefined, limitMb: number | null): number {
  const fromEnv = Number(envValue)
  if (envValue && Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return limitMb ? Math.max(2048, Math.floor(limitMb * 0.8)) : 2048
}

const RSS_WARN_MB = rssWarnMb(process.env.RUNTIME_RSS_WARN_MB, cgroupMemoryLimitMb())

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
    // Per-minute peaks for the event-loop stall monitor (ops-signals.ts), every node.
    noteLagSample(lag, now)
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
