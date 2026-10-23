/**
 * Rebuild the GraphQL schema only when what it is built from changed (post-mortem 3.3).
 *
 * A realtime process makes no configuration writes, so it hears every configuration move from
 * other processes (layout autosaves, settings, rules …). A full schema build on each would cost
 * the event loop for nothing: most moves do not touch collections, fields, relations or pipeline
 * bindings. The watcher compares a fingerprint of those inputs and rebuilds only on a change.
 * One check at a time; a move during a check runs one more after it.
 */
export interface SchemaWatcher {
  /** Take the baseline (the inputs the boot build used); rebuilds if a move came first. */
  baseline(): Promise<void>
  /** A configuration move: check (debounced), rebuild when the inputs changed. */
  moved(): void
  /** Wait for a check in flight (tests). */
  idle(): Promise<void>
  stop(): void
}

export function createSchemaWatcher(deps: {
  fingerprint: () => Promise<string>
  rebuild: () => Promise<void>
  warn?: (err: unknown) => void
  debounceMs?: number
}): SchemaWatcher {
  let print: string | null = null
  let movedSinceBaseline = false
  let running: Promise<void> | null = null
  let again = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const check = (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          const next = await deps.fingerprint()
          if (print !== null && next === print) continue
          const first = print === null
          print = next
          if (!first || movedSinceBaseline) await deps.rebuild()
        } while (again)
      } catch (err) {
        deps.warn?.(err)
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    baseline: () => check(),
    moved() {
      movedSinceBaseline = true
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void check()
      }, deps.debounceMs ?? 2_000)
      timer.unref?.()
    },
    idle: async () => {
      while (running) await running
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
