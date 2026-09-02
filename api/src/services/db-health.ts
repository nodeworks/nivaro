import { db } from '../db/index.js'

/**
 * DB outage posture (#329): a 5s probe loop maintains one process-wide
 * healthy flag. While the database is down, API writes/reads fail FAST with
 * an honest 503 (server.ts hook) instead of every request hanging out the
 * 15s tedious timeout; the same probe notices recovery within seconds.
 */

let healthy = true
let lastError: string | null = null
let downSince: Date | null = null
let timer: ReturnType<typeof setInterval> | null = null
let failStreak = 0

/**
 * One slow probe is NOT an outage. On this stack the probe shares the
 * connection pool with real work, so a busy pool or a latency spike on the
 * shared SQL server can blow a single 2.5s race while the database is
 * perfectly fine — and flipping unhealthy on one miss turned every such
 * blip into a burst of DB_UNAVAILABLE 503s (measured: hundreds/day, zero
 * actual outages). Trip only after sustained failure; recover on the first
 * success so a real outage still clears fast.
 */
const FAIL_THRESHOLD = 3
const PROBE_TIMEOUT_MS = 4000

export function isDbHealthy(): boolean {
  return healthy
}

export function dbHealthState(): { healthy: boolean; down_since: Date | null; error: string | null } {
  return { healthy, down_since: downSince, error: lastError }
}

async function probe(): Promise<void> {
  try {
    await Promise.race([
      db.raw('SELECT 1'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), PROBE_TIMEOUT_MS))
    ])
    if (!healthy) console.log('[db-health] database recovered')
    healthy = true
    failStreak = 0
    lastError = null
    downSince = null
  } catch (err) {
    failStreak++
    lastError = String(err instanceof Error ? err.message : err).slice(0, 300)
    if (failStreak < FAIL_THRESHOLD) {
      console.warn(`[db-health] probe failed (${failStreak}/${FAIL_THRESHOLD}) — ${lastError}`)
      return
    }
    if (healthy) {
      downSince = new Date()
      console.error(
        `[db-health] database unreachable after ${failStreak} consecutive probe failures — serving fast 503s until it recovers`
      )
    }
    healthy = false
  }
}

export function startDbHealthProbe(): void {
  if (timer) return
  timer = setInterval(() => void probe(), 5000)
  timer.unref?.()
}
