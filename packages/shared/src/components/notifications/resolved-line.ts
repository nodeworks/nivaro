import type { NotificationFold, NotificationResolved } from '../../lib/notification-target'
import { getDisplayTimezone } from '../../lib/utils'

/**
 * The calm "done" line of a settled notification: "Approved by Beth · 10:42 AM".
 * The time is the clock alone when it happened today (in the reader's display
 * zone), else "Nov 12, 10:42 AM". Pure (the clock is a parameter).
 */
export function resolvedLabel(
  resolved: NotificationResolved | null | undefined,
  now: Date = new Date()
): string | null {
  if (!resolved?.text) return null
  const at = new Date(resolved.at)
  if (Number.isNaN(at.getTime())) return resolved.text
  const tz = getDisplayTimezone()
  const zone = tz ? { timeZone: tz } : {}
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-US', {
      ...zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }).format(d)
  const sameDay = day(at) === day(now)
  const when = new Intl.DateTimeFormat('en-US', {
    ...zone,
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  }).format(at)
  return `${resolved.text} · ${when}`
}

/** Pure: the folded updates worth listing (more than one), newest first. */
export function foldItems(fold: NotificationFold | null | undefined): NotificationFold['items'] {
  if (!fold || !Array.isArray(fold.items) || fold.count < 2) return []
  return [...fold.items].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}
