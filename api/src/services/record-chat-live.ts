import { db } from '../db/index.js'
import { parseRoom } from './chat.js'
import { roomTypes } from './chat-records.js'
import { emitRecordEvent } from './record-events.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * A message landed in a record's chat room (rt5 #9): tell that record's open pages, so the
 * unread count on the record header's chat button moves without a reload.
 *
 * The notice is `record:chat {collection, item}` to the record room only (`record:<c>:<id>`,
 * joined after a read check) — ids, never the message, its sender or its text. Each open page
 * re-reads GET /chat/record-room AS THE VIEWER (canSeeRoom + their own watermark), so a page
 * whose viewer may not see the room still reads nothing. Reading the room elsewhere moves the
 * count through the existing `read:changed {kind:'chat', room}` on the person's own room.
 *
 * One raw lookup per message (room token → record id), cached a few minutes per tenant; a
 * room type matched on `id` needs none.
 */

export interface RoomRecordRef {
  collection: string
  id: string
}

const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 500
/** Two records sharing one token is a data problem; never fan out past a few. */
const MAX_RECORDS = 3

const cache = new Map<string, { at: number; refs: RoomRecordRef[] }>()

export interface RecordChatDeps {
  types: () => Promise<Array<{ prefix: string; collection: string; match_field: string }>>
  lookup: (collection: string, field: string, token: string) => Promise<string[]>
  emit: (collection: string, id: string) => void
  now: () => number
  tenant: () => string
}

const defaults: RecordChatDeps = {
  types: () => roomTypes(),
  lookup: async (collection, field, token) => {
    const rows = (await db(collection)
      .where(field, token)
      .limit(MAX_RECORDS)
      .select('id')) as Array<{ id: string | number }>
    return rows.map((r) => String(r.id))
  },
  emit: (collection, id) => emitRecordEvent(collection, id, 'record:chat'),
  now: () => Date.now(),
  tenant: () => currentTenantKey()
}

/** The records an entity room belongs to (raw — only used to address a notice). */
export async function recordsOfEntityRoom(
  room: string,
  deps: RecordChatDeps = defaults
): Promise<RoomRecordRef[]> {
  const parsed = parseRoom(room)
  if (parsed.kind !== 'entity' || !parsed.prefix || !parsed.token) return []
  const key = `${deps.tenant()}\u0001${room}`
  const now = deps.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.refs
  const type = (await deps.types()).find((t) => t.prefix === parsed.prefix)
  let refs: RoomRecordRef[] = []
  if (type) {
    const ids =
      type.match_field === 'id'
        ? [parsed.token]
        : await deps.lookup(type.collection, type.match_field, parsed.token).catch(() => [])
    refs = ids.slice(0, MAX_RECORDS).map((id) => ({ collection: type.collection, id }))
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(key, { at: now, refs })
  return refs
}

/** Fire-and-forget: a new message in `room` — its record pages re-read their unread count. */
export function announceRecordChat(room: string, deps: RecordChatDeps = defaults): Promise<void> {
  return recordsOfEntityRoom(room, deps)
    .then((refs) => {
      for (const r of refs) deps.emit(r.collection, r.id)
    })
    .catch(() => {
      /* best-effort: the button still refreshes on its own timer */
    })
}

/** Tests only. */
export function clearRecordChatCache(): void {
  cache.clear()
}
