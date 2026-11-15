import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import { accessStamp } from './access-stamp.js'
import { getIo } from './io-holder.js'
import { parseWatchItems } from './presence-rows.js'
import { canSeeRecordRoom, visibleRecordIds } from './socket-access.js'
import { inSocketTenant, socketTenant } from './socket-tenant.js'
import { tenantScopedRoom } from './tenant-rooms.js'

/**
 * Who is editing on a budget / planning page (realtime round 8, item 22): page-level presence
 * for grids that edit MANY records at once (the forecast worksheet, an allocation matrix, a
 * browse-then-edit record grid) — "Beth is editing allocations for 4471", with the cell she is
 * in outlined in her colour.
 *
 *   grid:watch   {collection, items}            the page's records; each joins
 *                                               `grid:<collection>:<item>` ONLY after the
 *                                               record read gate passes AS THE WATCHER (role,
 *                                               row filter, User Scopes — record:join's answer)
 *   grid:unwatch {collection?, items?}
 *   grid:here    {collection, item, field, page, state}   the sender's own cell (start / end);
 *                                               the sender must pass the same gate
 *   → grid:editing {collection, item, field, page, state, user:{id,name}}
 *
 * So a mark reaches only people who may read that record, judged as themselves on the server
 * where their socket lives (rooms ride the adapter across replicas). Payloads carry ids, a
 * page key and a cell/field name — never a value. A mark that names a real FIELD of the
 * collection carries it only to the room's sockets whose person may read that field
 * (field-change-relay fieldNameDelivery); everyone else in the room gets the same mark with
 * `field: null` (review 2026-11-14 L4). Worksheet cell keys that are not field names go to the
 * room as before. The sender's read verdict is reused only under the same access stamp (L5). Clients repeat `start` every
 * GRID_HEARTBEAT_MS and drop a mark not repeated within GRID_MARK_TTL_MS, so a mark lost
 * between replicas or after a crash fades by itself; a disconnect sends `end` for the
 * socket's marks at once. Calm / Off quiet `grid:editing` on the receiving tab
 * (live-preference LIVE_PRESENCE_EVENTS).
 */

export const GRID_WATCH_MAX = 400
export const GRID_HEARTBEAT_MS = 20_000
export const GRID_MARK_TTL_MS = 50_000
/** A sender's read verdict on one record is reused this long (heartbeats re-ask often). */
const SENDER_VERDICT_MS = 60_000
/** Announcements one socket may send per second (focus hops are already throttled client-side). */
const HERE_PER_SECOND = 8

export function gridRoomName(collection: string, item: string, tenant = ''): string {
  return tenantScopedRoom(`grid:${collection}:${item}`, tenant)
}

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const PAGE_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const FIELD_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export function cleanGridCollection(v: unknown): string | null {
  return typeof v === 'string' && COLLECTION_RE.test(v) && !/^(nivaro_|directus_)/i.test(v)
    ? v
    : null
}
export function cleanGridPage(v: unknown): string | null {
  return typeof v === 'string' && PAGE_RE.test(v) ? v : null
}
export function cleanGridField(v: unknown): string | null {
  return typeof v === 'string' && FIELD_RE.test(v) ? v : null
}
export function cleanGridItem(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s && s.length <= 200 ? s : null
}

export interface GridMark {
  collection: string
  item: string
  field: string | null
  page: string
}

/** One socket's own marks (at most one cell per page), for the disconnect `end`. */
export class GridMarkBook {
  private marks = new Map<string, GridMark & { room: string }>()
  set(room: string, m: GridMark): (GridMark & { room: string }) | null {
    const prev = this.marks.get(m.page) ?? null
    this.marks.set(m.page, { ...m, room })
    return prev && (prev.room !== room || prev.field !== m.field) ? prev : null
  }
  clear(page: string, room: string): boolean {
    const cur = this.marks.get(page)
    if (!cur || cur.room !== room) return false
    this.marks.delete(page)
    return true
  }
  drain(): Array<GridMark & { room: string }> {
    const all = [...this.marks.values()]
    this.marks.clear()
    return all
  }
  get size(): number {
    return this.marks.size
  }
}

export interface GridPresenceDeps {
  canSee: (user: User, collection: string, item: string) => Promise<boolean>
  /**
   * The sockets of `room` (other than `self`) that may be told `field`: 'all' when the name is
   * not a field of the collection (a worksheet cell key), else the field's readers. A failure
   * is treated as nobody (the row mark still goes out, without the field).
   */
  markReaders: (
    room: string,
    self: string,
    collection: string,
    field: string
  ) => Promise<string[] | 'all'>
  visible: (user: User, collection: string, items: string[]) => Promise<string[]>
  tenant: (socket: Socket) => Promise<string | null>
  wrap: <A extends unknown[]>(
    socket: Socket,
    fn: (...args: A) => Promise<void> | void
  ) => (...args: A) => Promise<void> | void
  now: () => number
}

/** A room's readers of one field, reused briefly under the same access stamp (heartbeats). */
const READERS_TTL_MS = 3_000
const readersCache = new Map<string, { at: number; to: Promise<string[] | 'all'> }>()

async function defaultMarkReaders(
  room: string,
  self: string,
  collection: string,
  field: string
): Promise<string[] | 'all'> {
  const { getFields } = await import('./collections.js')
  if (!(await getFields(collection)).some((f) => f.field === field)) return 'all'
  const io = getIo()
  if (!io) return []
  // Every socket in the room on every replica, time-boxed (a slow replica = nobody named).
  let timer: ReturnType<typeof setTimeout> | undefined
  const sockets = await Promise.race([
    io.in(room).fetchSockets(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fetchSockets timed out')), 1_500)
    })
  ]).finally(() => clearTimeout(timer))
  const viewers = sockets
    .filter((s) => s.id !== self && s.data?.nvrUserId)
    .map((s) => ({
      socket: s.id,
      id: String(s.data.nvrUserId),
      kind: (s.data?.nvrBind as { kind?: string } | undefined)?.kind
    }))
  if (viewers.length === 0) return []
  const { fieldNameDelivery } = await import('./field-change-relay.js')
  return fieldNameDelivery(viewers, collection, field)
}

function cachedMarkReaders(
  room: string,
  self: string,
  collection: string,
  field: string
): Promise<string[] | 'all'> {
  const key = `${room}\u0001${field}\u0001${accessStamp()}`
  const now = Date.now()
  const hit = readersCache.get(key)
  if (hit && now - hit.at < READERS_TTL_MS)
    return hit.to.then((to) => (to === 'all' ? to : to.filter((id) => id !== self)))
  const to = defaultMarkReaders(room, '', collection, field)
  if (readersCache.size > 500) readersCache.clear()
  readersCache.set(key, { at: now, to })
  to.catch(() => readersCache.delete(key))
  return to.then((list) => (list === 'all' ? list : list.filter((id) => id !== self)))
}

const defaultDeps: GridPresenceDeps = {
  canSee: (u, c, i) => canSeeRecordRoom(u, c, i),
  markReaders: cachedMarkReaders,
  visible: (u, c, items) => visibleRecordIds(u, c, items),
  tenant: async (socket) => {
    if (!process.env.CLOUD_META_DB_URL) return ''
    const t = await socketTenant(socket)
    return t ? t.tenantId || t.slug : null
  },
  wrap: (socket, fn) => inSocketTenant(socket, fn),
  now: () => Date.now()
}

const nameOf = (u: User) =>
  ([u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Someone').slice(0, 80)

export function registerGridPresence(
  io: Pick<Server, 'to'>,
  socket: Socket,
  getUser: () => User | null,
  deps: GridPresenceDeps = defaultDeps
): void {
  const watched = new Set<string>()
  const book = new GridMarkBook()
  const verdicts = new Map<string, { ok: boolean; until: number; stamp: string }>()
  let windowStart = 0
  let inWindow = 0

  const senderMay = async (user: User, collection: string, item: string, room: string) => {
    const now = deps.now()
    const stamp = accessStamp()
    const hit = verdicts.get(room)
    // Reused only under the same access stamp: an access re-check drops it (review L5).
    if (hit && hit.until > now && hit.stamp === stamp) return hit.ok
    const ok = await deps.canSee(user, collection, item).catch(() => false)
    if (verdicts.size > 500) verdicts.clear()
    verdicts.set(room, { ok, until: now + SENDER_VERDICT_MS, stamp })
    return ok
  }

  const emitMark = async (
    room: string,
    user: User,
    m: GridMark,
    state: 'start' | 'end',
    viaIo = false
  ): Promise<void> => {
    const payload = {
      collection: m.collection,
      item: m.item,
      field: m.field,
      page: m.page,
      state,
      user: { id: user.id, name: nameOf(user) }
    }
    const roomOut = viaIo ? io.to(room) : socket.to(room)
    if (m.field == null) {
      roomOut.emit('grid:editing', payload)
      return
    }
    let readers: string[] | 'all' = []
    try {
      readers = await deps.markReaders(room, socket.id, m.collection, m.field)
    } catch {
      readers = []
    }
    if (readers === 'all') {
      roomOut.emit('grid:editing', payload)
      return
    }
    // The field to its readers; the row mark without it to everyone else in the room.
    if (readers.length) io.to(readers).emit('grid:editing', payload)
    roomOut.except(readers).emit('grid:editing', { ...payload, field: null })
  }

  socket.on(
    'grid:watch',
    deps.wrap(socket, async (payload: { collection?: unknown; items?: unknown }) => {
      const user = getUser()
      const collection = cleanGridCollection(payload?.collection)
      if (!user || !collection) return
      const asked = parseWatchItems(payload?.items)
      if (asked.length === 0) return
      const tenant = await deps.tenant(socket)
      if (tenant == null) return
      const fresh = asked.filter((i) => !watched.has(gridRoomName(collection, i, tenant)))
      if (watched.size + fresh.length > GRID_WATCH_MAX) return
      // Judged as the WATCHER: a record they may not open is never a room they sit in.
      for (const item of await deps.visible(user, collection, asked)) {
        const room = gridRoomName(collection, item, tenant)
        // A room an access re-check took away is asked for again (access:changed) — rejoin it.
        if (watched.has(room) && socket.rooms?.has(room)) continue
        watched.add(room)
        socket.join(room)
      }
    })
  )

  socket.on(
    'grid:unwatch',
    deps.wrap(socket, async (payload?: { collection?: unknown; items?: unknown }) => {
      const collection = cleanGridCollection(payload?.collection)
      if (!collection) {
        for (const room of watched) socket.leave(room)
        watched.clear()
        return
      }
      const tenant = await deps.tenant(socket)
      if (tenant == null) return
      for (const item of parseWatchItems(payload?.items)) {
        const room = gridRoomName(collection, item, tenant)
        if (watched.delete(room)) socket.leave(room)
      }
    })
  )

  socket.on(
    'grid:here',
    deps.wrap(
      socket,
      async (payload: {
        collection?: unknown
        item?: unknown
        field?: unknown
        page?: unknown
        state?: unknown
      }) => {
        const user = getUser()
        const collection = cleanGridCollection(payload?.collection)
        const item = cleanGridItem(payload?.item)
        const page = cleanGridPage(payload?.page)
        if (!user || !collection || !item || !page) return
        const field = payload?.field == null ? null : cleanGridField(payload.field)
        if (payload?.field != null && !field) return
        const state = payload?.state === 'end' ? 'end' : 'start'
        const now = deps.now()
        if (now - windowStart >= 1000) {
          windowStart = now
          inWindow = 0
        }
        if (++inWindow > HERE_PER_SECOND) return
        const tenant = await deps.tenant(socket)
        if (tenant == null) return
        const room = gridRoomName(collection, item, tenant)
        const mark: GridMark = { collection, item, field, page }
        if (state === 'end') {
          if (book.clear(page, room)) await emitMark(room, user, mark, 'end')
          return
        }
        if (!(await senderMay(user, collection, item, room))) return
        // Moving to another record on the same page ends the mark on the previous one.
        const prev = book.set(room, mark)
        if (prev && prev.room !== room) await emitMark(prev.room, user, prev, 'end')
        await emitMark(room, user, mark, 'start')
      }
    )
  )

  socket.on('disconnect', () => {
    const user = getUser()
    const left = book.drain()
    if (!user) return
    // The socket has left its rooms by now: the end goes through the server.
    for (const m of left) void deps.wrap(socket, () => emitMark(m.room, user, m, 'end', true))()
  })
}
