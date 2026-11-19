/**
 * Record rooms held by THIS tab, per holder (realtime audit, efp L1, 2026-11-18). A record page
 * and a peek / drill-down sheet of the same record both join `record:<c>:<id>`; the socket (and
 * the shared worker) keep one membership per tab, so the first `record:leave` — closing the
 * peek — took the page out of the room: its viewer list emptied, "X is editing" marks stopped
 * and others stopped seeing the person.
 *
 * Rule: a join is always passed on (a join sent again after a reconnect must reach the new
 * server socket, and the server's join is idempotent); a leave only when no other holder in this
 * tab still has the record open. Holders are named (a hook instance's own id), not counted, so a
 * re-sent join never inflates anything. A payload without a holder is the anonymous holder ''.
 */

export interface RecordRoomRef {
  collection: string
  item: string
}

export interface RecordRoomHolds {
  /** Note a holder. Always pass the join on. Returns the room, or null for a junk payload. */
  join(payload: unknown): RecordRoomRef | null
  /** Drop a holder. Returns the room when the leave should be passed on (no holder left). */
  leave(payload: unknown): RecordRoomRef | null
  /** Every room some holder in this tab still has open (re-joined after a reconnect). */
  held(): RecordRoomRef[]
  /** Is this room held by anyone in this tab? */
  has(collection: string, item: string | number): boolean
}

function refOf(payload: unknown): (RecordRoomRef & { holder: string }) | null {
  const p = (payload ?? {}) as { collection?: unknown; item?: unknown; holder?: unknown }
  if (typeof p.collection !== 'string' || !p.collection || p.item == null || p.item === '')
    return null
  return {
    collection: p.collection,
    item: String(p.item),
    holder: typeof p.holder === 'string' ? p.holder : ''
  }
}

const keyOf = (collection: string, item: string) => `${collection}\u0000${item}`

export function createRecordRoomHolds(): RecordRoomHolds {
  const rooms = new Map<string, { ref: RecordRoomRef; holders: Set<string> }>()
  return {
    join(payload) {
      const r = refOf(payload)
      if (!r) return null
      const key = keyOf(r.collection, r.item)
      const entry = rooms.get(key) ?? {
        ref: { collection: r.collection, item: r.item },
        holders: new Set<string>()
      }
      entry.holders.add(r.holder)
      rooms.set(key, entry)
      return entry.ref
    },
    leave(payload) {
      const r = refOf(payload)
      if (!r) return null
      const key = keyOf(r.collection, r.item)
      const entry = rooms.get(key)
      if (!entry) return { collection: r.collection, item: r.item }
      entry.holders.delete(r.holder)
      if (entry.holders.size > 0) return null
      rooms.delete(key)
      return entry.ref
    },
    held() {
      return [...rooms.values()].map((e) => e.ref)
    },
    has(collection, item) {
      return rooms.has(keyOf(collection, String(item)))
    }
  }
}

let holderSeq = 0
/** A holder id for one hook instance (unique within the tab). */
export function newRecordRoomHolder(prefix = 'h'): string {
  holderSeq += 1
  return `${prefix}${holderSeq}`
}
