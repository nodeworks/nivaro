import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A long scheduled job that works through a list says it is still moving (prod 2026-11-20,
 * issue 1351: the 10:30 workflow auto-sweep placed ~60 MDSi orders, ~18 s each, after an
 * import moved 1,154 unit schedule dates — the fixed 15-minute watchdog called it hung while it
 * was working). Inside a scheduled tick (plugins/cron.ts runs the tick inside
 * `runWithCronProgress`), each call restarts that tick's watchdog: the job reads as hung only
 * after its budget passes with NO progress. Outside a tick it does nothing.
 *
 * Leaf module: anything may import it without pulling in the scheduler.
 */
const tick = new AsyncLocalStorage<{ progress: () => void }>()

export function noteCronProgress(): void {
  tick.getStore()?.progress()
}

export function runWithCronProgress<T>(onProgress: () => void, fn: () => Promise<T>): Promise<T> {
  return tick.run({ progress: onProgress }, fn)
}
