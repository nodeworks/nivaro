/**
 * Long CPU loops on a web process must hand the event loop back often: every other request
 * on the process waits while one runs (EFP prod 2026-11-19, the stall watchdog: a staged-import
 * preview held a web process for 3.7 s in one piece while it compared a 30 MB file with live
 * data). A leaf module, so any service can pace a loop without pulling in the importers.
 *
 *   const pace = makePacer()
 *   for (const row of rows) {
 *     if (pace.due()) await pace.breathe()
 *     ...
 *   }
 *
 * `due()` is one clock read, cheap enough for every row; `breathe()` lets timers, sockets and
 * other requests run, then starts the next slice.
 */

/** Longest slice of CPU work between two yields. */
export const PACE_MS = 20

/** Let timers and sockets run between slices of CPU work on the event loop. */
export const yieldToLoop = () => new Promise<void>((r) => setImmediate(r))

export interface Pacer {
  /** True once the current slice has run its budget. */
  due(): boolean
  /** Yield to the event loop and start a new slice. */
  breathe(): Promise<void>
}

export function makePacer(budgetMs = PACE_MS): Pacer {
  let since = performance.now()
  return {
    due: () => performance.now() - since >= budgetMs,
    async breathe() {
      await yieldToLoop()
      since = performance.now()
    }
  }
}
