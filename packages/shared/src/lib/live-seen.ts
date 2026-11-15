/**
 * When did this tab last HEAR about a record? (realtime idea 14)
 *
 * Every socket adapter calls `noteLiveSeen` for each event it receives (admin lib/socket.ts and
 * the shared socket-realtime adapter, live and replayed). The missed-update detector asks
 * `lastLiveSeen(collection, id)`: a value that changed on screen with no event heard after the
 * screen loaded it is a live update this tab never got.
 *
 * Only ids and times are kept (never values), capped, newest kept.
 */

const MAX_KEYS = 5000
const byRecord = new Map<string, number>()
const byCollection = new Map<string, number>()

const recordKey = (collection: string, id: string | number) => `${collection}\u0000${String(id)}`

function remember(map: Map<string, number>, key: string, at: number): void {
  map.delete(key)
  map.set(key, at)
  if (map.size > MAX_KEYS) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

/** Note one received event (any name; only collection-shaped payloads count). */
export function noteLiveSeen(event: string, payload: unknown, at: number = Date.now()): void {
  if (event !== 'collection:update' || !payload || typeof payload !== 'object') return
  const p = payload as {
    collection?: unknown
    item?: unknown
    items?: unknown
    many?: unknown
    coalesced?: unknown
  }
  if (typeof p.collection !== 'string' || !p.collection) return
  const c = p.collection
  if (p.coalesced) {
    if (p.many || !Array.isArray(p.items)) {
      remember(byCollection, c, at)
      return
    }
    for (const id of p.items.slice(0, 500)) {
      if (id != null) remember(byRecord, recordKey(c, id as string | number), at)
    }
    return
  }
  if (p.item == null || p.item === '*') {
    remember(byCollection, c, at)
    return
  }
  remember(byRecord, recordKey(c, p.item as string | number), at)
}

/** The last time an event named this record (or its whole collection); null = never. */
export function lastLiveSeen(collection: string, id: string | number): number | null {
  const r = byRecord.get(recordKey(collection, id))
  const c = byCollection.get(collection)
  if (r == null && c == null) return null
  return Math.max(r ?? 0, c ?? 0)
}

export function __resetLiveSeenForTests(): void {
  byRecord.clear()
  byCollection.clear()
}
