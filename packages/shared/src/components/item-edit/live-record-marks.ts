/**
 * Which records a live write from someone else just touched (RecordLiveSync
 * marks them before it refetches). The record form only shows "was X · who"
 * field notes for a refetch that follows such a mark, and only for the fields
 * the write named — a refetch for any other reason (Edit taking the lock,
 * window focus, Summary → Edit loading more fields after a reload) is not
 * someone else's change and shows nothing.
 */

const WINDOW_MS = 15_000

interface Mark {
  at: number
  /** Field names the write named; null = it did not say (may be any). */
  fields: string[] | null
}

const marks = new Map<string, Mark>()
const keyOf = (collection: string, itemId: string) => `${collection}:${itemId}`

export function markLiveRecordWrite(
  collection: string,
  itemId: string,
  fields: string[] | null | undefined
): void {
  const key = keyOf(collection, itemId)
  const prev = marks.get(key)
  const now = Date.now()
  const merged =
    !fields || (prev && prev.fields === null && now - prev.at < WINDOW_MS)
      ? null
      : [...new Set([...(prev && now - prev.at < WINDOW_MS ? (prev.fields ?? []) : []), ...fields])]
  marks.set(key, { at: now, fields: merged })
}

/** The live write that explains a refetch of this record, or null. */
export function liveRecordWrite(collection: string, itemId: string, now = Date.now()): Mark | null {
  const mark = marks.get(keyOf(collection, itemId))
  if (!mark || now - mark.at > WINDOW_MS) return null
  return mark
}

/** Tests only. */
export function clearLiveRecordMarks(): void {
  marks.clear()
}
