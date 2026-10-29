/**
 * When this process's daily retention pass (server.ts runRetentionPurge) last ran and runs
 * next — read by the Log retention inventory (#17). The pass is a per-process timer (self-hosted
 * only, never cloud), so this is process state, not tenant state.
 */
let lastRunAt: Date | null = null
let nextRunAt: Date | null = null
let lastResult: { activity_deleted: number; activity_bridged: number; error?: string } | null = null

export function noteRetentionPassStarted(at = new Date()): void {
  lastRunAt = at
}

export function noteRetentionPassScheduled(next: Date): void {
  nextRunAt = next
}

export function noteRetentionPassResult(r: {
  activity_deleted: number
  activity_bridged: number
  error?: string
}): void {
  lastResult = r
}

export function retentionPassSchedule(): {
  last_run_at: string | null
  next_run_at: string | null
  last_result: typeof lastResult
} {
  return {
    last_run_at: lastRunAt?.toISOString() ?? null,
    next_run_at: nextRunAt?.toISOString() ?? null,
    last_result: lastResult
  }
}
