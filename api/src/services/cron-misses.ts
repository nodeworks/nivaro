/**
 * The cron miss detector's verdict, readable on demand (#2267).
 *
 * The detector itself lives in server.ts next to the scheduler it reads (`missedCrons`); it
 * registers its probe here so the Traffic Map can ask the same question — "which jobs did not run
 * when expected?" — without a second implementation that could drift from the one that raises
 * the issue. Dev processes with ticks off report `ticking: false` and no misses: their jobs are
 * not supposed to run, so nothing there is missed.
 */
import { cronTicksEnabled } from './cron-ticks.js'

export interface MissedCron {
  id: string
  /** ISO time the job should have last fired. */
  expected_at: string
  /** ISO time of its last recorded run; null = none recorded. */
  last_run_at: string | null
  grace_min: number
}

type Probe = () => Promise<MissedCron[]>
let probe: Probe | null = null

export function registerMissedCronProbe(fn: Probe): void {
  probe = fn
}

export interface CronMissReport {
  /** False on a process that does not tick scheduled jobs (nothing there can be missed). */
  ticking: boolean
  /** False until the detector has registered (the scheduler is not up yet). */
  ready: boolean
  misses: MissedCron[]
}

export async function currentMissedCrons(): Promise<CronMissReport> {
  const ticking = cronTicksEnabled()
  if (!ticking) return { ticking, ready: !!probe, misses: [] }
  if (!probe) return { ticking, ready: false, misses: [] }
  return { ticking, ready: true, misses: await probe() }
}

/** Test hook. */
export function resetMissedCronProbe(): void {
  probe = null
}
