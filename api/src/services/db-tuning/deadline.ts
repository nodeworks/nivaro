/** Longest any one observer may spend reading its evidence. */
export const OBSERVER_TIMEOUT_MS = 10 * 60_000

/**
 * Rejects once `ms` pass. The wrapped work is not cancelled (a running query cannot be called
 * back from here) — the run stops waiting for it and goes on without its candidates.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) {
    work.catch(() => {})
    return Promise.reject(new Error(`${label}: the run's time budget is spent`))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} took longer than ${Math.round(ms / 1000)} s`)),
      ms
    )
    timer.unref?.()
  })
  // a late failure of the abandoned work must not surface as an unhandled rejection
  work.catch(() => {})
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
