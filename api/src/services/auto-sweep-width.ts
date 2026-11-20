/**
 * How many records the hourly workflow auto-sweep moves at once (AUTO_SWEEP_CONCURRENCY).
 *
 * Prod 2026-11-20: a schedule-date import made ~160 inventory requests eligible for
 * "Auto-submit (MDSi)"; the sweep moved them one at a time and MDSi answers each order in
 * ~15 s (5–40 s), so the batch took ~50 minutes. Running a few at once cuts that roughly by the
 * width — but every one of them is a partner call, so it stays at 1 (one at a time, as before)
 * until the partner confirms it accepts parallel orders. Bounded to 1–6.
 */
export const AUTO_SWEEP_MAX_WIDTH = 6

export function autoSweepWidth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTO_SWEEP_CONCURRENCY
  const n = raw == null || raw.trim() === '' ? 1 : Number(raw)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(AUTO_SWEEP_MAX_WIDTH, Math.floor(n))
}

/**
 * Run `fn` over `items` with at most `width` running at once, in list order. A failure in one
 * item is reported through `onError` and never stops the others.
 */
export async function runWithWidth<T>(
  items: readonly T[],
  width: number,
  fn: (item: T) => Promise<void>,
  onError: (err: unknown, item: T) => void = () => {}
): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++]
      try {
        await fn(item)
      } catch (err) {
        onError(err, item)
      }
    }
  }
  const lanes = Math.max(1, Math.min(Math.floor(width) || 1, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
}
