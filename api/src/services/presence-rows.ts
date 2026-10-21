/**
 * Presence on list rows (#2486): a list subscribes to "who has this record open" for the
 * rows on its page, and the server pushes changes instead of the old 30 s count poll.
 *
 * A watcher sits in `rows:<record room>` (the record room name, tenant prefix included, so
 * one watch room is one tenant's record). Every change to a record room's viewer set is
 * pushed there as `presence:rows {collection, item, user_ids}` — ids only, the realtime
 * payload rule; names come from the visibility-filtered `GET /presence/people`.
 */

/** Rows a socket may watch at once (a page is 100 rows; a few lists on one screen fit). */
export const PRESENCE_WATCH_MAX = 300
/** Items one `presence:watch` message may name. */
export const PRESENCE_WATCH_BATCH_MAX = 100

export function rowsRoomName(recordRoom: string): string {
  return `rows:${recordRoom}`
}

/** Clean the item ids of a watch message: strings, non-empty, distinct, capped. */
export function parseWatchItems(items: unknown, max = PRESENCE_WATCH_BATCH_MAX): string[] {
  if (!Array.isArray(items)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) continue
    const id = String(raw).trim()
    if (!id || id.length > 200 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

/** The distinct people in a record room's socket → viewer map (one person, many tabs = one). */
export function distinctViewerIds(viewers: Iterable<{ id: string }> | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of viewers ?? []) {
    const key = String(v.id).toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(String(v.id))
  }
  return out
}
