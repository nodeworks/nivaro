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
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 2500))
    ])
    if (!healthy) console.log('[db-health] database recovered')
    healthy = true
    lastError = null
    downSince = null
  } catch (err) {
    if (healthy) {
      downSince = new Date()
      console.error('[db-health] database unreachable — serving fast 503s until it recovers')
    }
    healthy = false
    lastError = String(err instanceof Error ? err.message : err).slice(0, 300)
  }
}

export function startDbHealthProbe(): void {
  if (timer) return
  timer = setInterval(() => void probe(), 5000)
  timer.unref?.()
}
