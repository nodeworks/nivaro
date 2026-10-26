import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import { channelByKey, parseRoom, type RoomVisibilityCache } from './chat.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * Live huddle badges (#2851): the room list, record tab strips and people cards show a
 * headset badge for rooms with a huddle running.
 *
 * Who is in which room never leaves the server by broadcast. A browser that wants the
 * badges emits `huddle:live-watch`; the server joins it to the tenant's `huddle-live`
 * socket room and answers THAT socket alone with `huddle:live {rooms:[{room,label,count,
 * users}]}`, keeping only the rooms canSeeRoom lets this person see. When any huddle's
 * roster changes the server sends a bare `huddle:live-poke` (no payload) to the watchers
 * and each browser asks again — so the filtering is always done per recipient, on the
 * replica that holds that person's sign-in, and a room key someone cannot see is never
 * sent to them. Counts and user ids only; no names, no content.
 */

export const LIVE_ROOM = 'huddle-live'
const POKE_DEBOUNCE_MS = 400
/** A browser asking again within this window is answered once, after the window. */
const WATCH_MIN_GAP_MS = 400
const MAX_ROOMS = 100

export interface LiveRoom {
  room: string
  label: string
  count: number
  /** Ids of the people in the huddle (the viewer can already see the room's roster). */
  users: string[]
}

export interface HuddleLiveDeps {
  /** Who is in the room's huddle right now (stale entries pruned by the lookup). */
  peers(room: string): Promise<Array<{ user: string }>>
  sessions?: { liveRooms(tenant: string | null): Promise<string[]> }
  canSeeRoom(user: User, room: string, cache?: RoomVisibilityCache): Promise<boolean>
  warn(obj: Record<string, unknown>, msg: string): void
  labelOf?(room: string): Promise<string>
}

export async function defaultLabelOf(room: string): Promise<string> {
  const p = parseRoom(room)
  if (p.kind === 'global') return 'General'
  if (p.kind === 'channel') {
    try {
      return (await channelByKey(p.channelKey ?? ''))?.name ?? room
    } catch {
      return room
    }
  }
  if (p.kind === 'dm') return 'Direct message'
  const colon = room.indexOf(':')
  return colon > 0 ? room.slice(colon + 1).toUpperCase() : room
}

/** The huddles `user` may see right now (pure given deps — tests inject fakes). */
export async function liveSnapshotFor(
  user: User,
  tenant: string | null,
  deps: HuddleLiveDeps
): Promise<LiveRoom[]> {
  const candidates = (await deps.sessions?.liveRooms(tenant)) ?? []
  const cache: RoomVisibilityCache = new Map()
  const label = deps.labelOf ?? defaultLabelOf
  const out: LiveRoom[] = []
  for (const room of candidates.slice(0, MAX_ROOMS)) {
    const peers = await deps.peers(room)
    if (!peers.length) continue
    if (!(await deps.canSeeRoom(user, room, cache))) continue
    out.push({
      room,
      label: await label(room),
      count: peers.length,
      users: [...new Set(peers.map((p) => String(p.user)))].slice(0, 16)
    })
  }
  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

const pokeTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Tell every watcher in `room` (already tenant-scoped) to ask again — coalesced. */
export function pokeHuddleLive(io: Pick<Server, 'to'>, room: string): void {
  if (pokeTimers.has(room)) return
  const t = setTimeout(() => {
    pokeTimers.delete(room)
    io.to(room).emit('huddle:live-poke')
  }, POKE_DEBOUNCE_MS)
  t.unref?.()
  pokeTimers.set(room, t)
}

interface LiveScope {
  scopedRoom(room: string): Promise<string | null>
  scopedRoomNow(room: string): string | null
  tenantNow(): string | null
}

export function registerHuddleLive(
  socket: Socket,
  getUser: () => User | null,
  scope: LiveScope,
  deps: HuddleLiveDeps
): void {
  let busy = false
  let again = false
  let last = 0

  async function send(): Promise<void> {
    const user = getUser()
    if (!user) return
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      do {
        again = false
        const wait = last + WATCH_MIN_GAP_MS - Date.now()
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        last = Date.now()
        const rooms = await liveSnapshotFor(user, scope.tenantNow(), deps)
        socket.emit('huddle:live', { rooms })
      } while (again)
    } catch (err) {
      deps.warn({ err }, 'huddle:live-watch failed')
    } finally {
      busy = false
    }
  }

  socket.on(
    'huddle:live-watch',
    inSocketTenant(socket, async () => {
      if (!getUser()) return
      const name = await scope.scopedRoom(LIVE_ROOM)
      if (name) socket.join(name)
      await send()
    })
  )

  socket.on('huddle:live-unwatch', () => {
    const name = scope.scopedRoomNow(LIVE_ROOM)
    if (name) socket.leave(name)
  })
}
