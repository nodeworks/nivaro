/**
 * "Someone moved this record while you were editing" (army 11 f4 M4). Two
 * sources tell the editor: the server's `lock:moved` notice (names who and
 * where, only when they held the edit lock) and the form noticing its own
 * edits turned unsaveable after a state change (any case, no names). One
 * toast slot per record; the named notice wins for a while.
 */

const NAMED_WINDOW_MS = 15_000
const named = new Map<string, number>()

export function movedNoticeId(collection: string, item: string | number): string {
  return `nvr-record-moved:${collection}:${String(item)}`
}

/** The named notice was shown for this record now. */
export function noteNamedMovedNotice(
  collection: string,
  item: string | number,
  now = Date.now()
): void {
  named.set(movedNoticeId(collection, item), now)
}

/** Whether a named notice was shown for this record moments ago (the generic one then stays quiet). */
export function namedMovedNoticeRecent(
  collection: string,
  item: string | number,
  now = Date.now()
): boolean {
  const at = named.get(movedNoticeId(collection, item))
  return at != null && now - at < NAMED_WINDOW_MS
}

/** The editor's notice text for a `lock:moved` payload. */
export function movedNoticeText(p: {
  by_name?: unknown
  state_label?: unknown
  still_editable?: unknown
}): string {
  const who = typeof p.by_name === 'string' && p.by_name.trim() ? p.by_name.trim() : 'Someone'
  const where =
    typeof p.state_label === 'string' && p.state_label.trim() ? ` to ${p.state_label.trim()}` : ''
  return p.still_editable === false
    ? `${who} moved this record${where} while you were editing. What you haven’t saved can no longer be saved here — it stays on this page so you can copy it.`
    : `${who} moved this record${where} while you were editing. You can still save your changes.`
}

/** The generic notice when the form finds its unsaved edits locked by a state change. */
export function lockedAfterMoveText(lockMessage: string): string {
  const base = lockMessage.trim().replace(/[.\s]+$/, '')
  return `${base}. What you haven’t saved can no longer be saved here — it stays on this page so you can copy it.`
}
