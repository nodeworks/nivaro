import { tenantState } from './ai-tenant-state.js'

/**
 * When the daily retention pass (services/retention-pass.ts) last ran and runs next — read by the
 * Log retention inventory (#17). Held per app: self-hosted the one app ('' key) and its boot timer;
 * on a Hub shared deployment each app's run of the `retention-pass` job keeps its own status.
 * Nivaro Cloud never runs the pass.
 */
interface PassStatus {
  lastRunAt: Date | null
  nextRunAt: Date | null
  lastResult: { activity_deleted: number; activity_bridged: number; error?: string } | null
}

const status = tenantState<PassStatus>(() => ({
  lastRunAt: null,
  nextRunAt: null,
  lastResult: null
}))

export function noteRetentionPassStarted(at = new Date()): void {
  status().lastRunAt = at
}

export function noteRetentionPassScheduled(next: Date): void {
  status().nextRunAt = next
}

export function noteRetentionPassResult(r: {
  activity_deleted: number
  activity_bridged: number
  error?: string
}): void {
  status().lastResult = r
}

export function retentionPassSchedule(): {
  last_run_at: string | null
  next_run_at: string | null
  last_result: PassStatus['lastResult']
} {
  const s = status()
  return {
    last_run_at: s.lastRunAt?.toISOString() ?? null,
    next_run_at: s.nextRunAt?.toISOString() ?? null,
    last_result: s.lastResult
  }
}
