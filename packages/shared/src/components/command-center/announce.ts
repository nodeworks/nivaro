/**
 * The board's polite live region (CC-27): when the number of things needing attention changes,
 * screen readers hear it once — never on every poll, never for the first load.
 */

/** Items in a /attention answer (a list, or {items}); null when there is no answer yet. */
export function attentionCount(data: unknown): number | null {
  if (Array.isArray(data)) return data.length
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items))
    return (data as { items: unknown[] }).items.length
  return null
}

/** What to announce when the count moves from `prev` to `next` ('' = say nothing). */
export function attentionAnnouncement(prev: number | null, next: number | null): string {
  if (prev === null || next === null || prev === next) return ''
  if (next === 0) return 'Nothing needs attention now.'
  const what = next === 1 ? '1 item needs attention' : `${next} items need attention`
  return next > prev ? `${what} — ${next - prev} new.` : `${what}.`
}
