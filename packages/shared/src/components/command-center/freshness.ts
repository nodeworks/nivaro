/**
 * Board freshness (CC-21): how old the snapshot on screen is, and when to say it is stale.
 * The snapshot polls every 20 s; one failed poll is a blip, two in a row means the board is
 * showing old data and says so ("Couldn't refresh — showing data from 2:10 PM").
 */

export const STALE_AFTER_FAILURES = 2

/** "just now", "6s ago", "4m ago", "2h ago" — short, for a live-updating header label. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 2) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Clock time of a timestamp in the viewer's locale, 12-hour where that is the custom. */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export type Freshness =
  | { kind: 'loading' }
  | { kind: 'fresh'; label: string }
  | { kind: 'stale'; since: string; label: string }
  | { kind: 'failed' }

/**
 * failures = snapshot polls that failed since the last one that worked (see countFailures).
 * No data yet + failures → 'failed' (nothing to show at all); no data yet → 'loading'.
 */
export function freshness(input: {
  updatedAt: number | null
  failures: number
  now: number
}): Freshness {
  const { updatedAt, failures, now } = input
  if (!updatedAt) return failures >= STALE_AFTER_FAILURES ? { kind: 'failed' } : { kind: 'loading' }
  const label = `Updated ${formatAge(now - updatedAt)}`
  if (failures >= STALE_AFTER_FAILURES) return { kind: 'stale', since: clockTime(updatedAt), label }
  return { kind: 'fresh', label }
}

/**
 * Consecutive failed polls from React Query's counters: errors counted since the error count
 * that stood when data last arrived. `mark` is that remembered count.
 */
export function countFailures(errorUpdateCount: number, mark: number): number {
  return Math.max(0, errorUpdateCount - mark)
}
