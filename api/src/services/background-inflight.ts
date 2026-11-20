/**
 * Background work running in THIS process right now — scheduled jobs and import runs — for the
 * stall watchdog (services/stall-watchdog.ts). The watchdog's in-flight list names HTTP requests
 * only, so a stall on the cron worker (no requests) read "in flight: nothing" while ~30 hourly
 * jobs were running (EFP prod 2026-11-20, issue 1122: a 2.4 s main-loop block at 7:00 AM ET).
 *
 * In-process only, no I/O: one Map entry per running piece of work.
 */

export type BackgroundKind = 'cron' | 'import'

export interface BackgroundWork {
  kind: BackgroundKind
  label: string
  age_ms: number
}

const running = new Map<number, { kind: BackgroundKind; label: string; since: number }>()
let seq = 0

/** Mark work as running; call the returned function when it ends (idempotent). */
export function noteBackgroundWork(kind: BackgroundKind, label: string): () => void {
  const id = ++seq
  running.set(id, { kind, label, since: Date.now() })
  return () => {
    running.delete(id)
  }
}

/** Run `fn` marked as running background work. */
export async function withBackgroundWork<T>(
  kind: BackgroundKind,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const end = noteBackgroundWork(kind, label)
  try {
    return await fn()
  } finally {
    end()
  }
}

/** What is running now, longest-running first. */
export function listBackgroundWork(limit = 30, now = Date.now()): BackgroundWork[] {
  return [...running.values()]
    .sort((a, b) => a.since - b.since)
    .slice(0, limit)
    .map((w) => ({ kind: w.kind, label: w.label, age_ms: Math.max(0, now - w.since) }))
}

/** Count of running pieces of work (the list above is capped). */
export function backgroundWorkCount(): number {
  return running.size
}
