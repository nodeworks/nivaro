/**
 * Cooperative job cancellation (#302, the honest scope): heavy in-process
 * loops (rollup backfills, find-replace) check a cancel flag between chunks
 * and stop cleanly — killable without killing the API. True child-process
 * isolation stays with Inngest (queue materialization already runs there).
 * Flags are in-process, matching where the loops run.
 */

const cancelled = new Set<number>()

export function requestCancel(runId: number): void {
  cancelled.add(runId)
}

export function isCancelled(runId: number): boolean {
  return cancelled.has(runId)
}

export function clearCancel(runId: number): void {
  cancelled.delete(runId)
}
