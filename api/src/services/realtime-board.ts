import type { Redis } from 'ioredis'
import { instanceKey } from './instance-key.js'
import { INSTANCE_ID } from './instance-roster.js'

/**
 * The realtime board (post-mortem 3.3): what the realtime processes' sockets know, for the
 * processes that hold none.
 *
 * Several answers come from the sockets themselves — who is viewing a record (the "N viewing"
 * chip, now-editing, notification suppression #269), who is on a page (#42, replay
 * auto-signals #1371), the socket list and room sizes (Realtime console, Traffic Map, chaos
 * steady state) and the concurrency sample. A web process with SOCKETS=off holds no sockets, so
 * every realtime process publishes its share here and those processes read it back:
 *
 *   nvr:rt:board:<slot>:<process>:live   viewers + page pings + counts, every 2 s, 10 s TTL
 *   nvr:rt:board:<slot>:<process>:stats  the socket list and room sizes, every 10 s, 30 s TTL
 *
 * <slot> is the deployment slot (instanceKey()), so deployments sharing one Redis never read
 * each other's people.
 *
 * A reader polls the live keys every 2 s and the stats keys every 10 s into memory, so the
 * socket plugin's getters stay synchronous and no request waits on another process (no
 * fetchSockets quorum). A realtime process that stopped publishing drops out with its TTL.
 * Only realtime processes publish and only SOCKETS=off processes read: a deployment without
 * the tier never touches these keys.
 */

const LIVE_MS = 2_000
const STATS_MS = 10_000
const LIVE_TTL_S = 10
const STATS_TTL_S = 30
/** A read older than this is stale: callers that must not guess (the concurrency sample) skip. */
const FRESH_MS = 6_000
const keyPrefix = () => `nvr:rt:board:${instanceKey()}:`

/** socket.data key the socket plugin writes on every `page:at` ping (read across processes). */
export const PAGE_AT_KEY = 'nvrPageAt'

export interface PageAtData {
  user: { id: string; name: string }
  path: string
  since: number
  app: string | null
  /** '' self-hosted; the cloud tenant key otherwise. */
  tenant: string
}

export interface BoardViewer {
  socket: string
  id: string
  name: string
}

export interface BoardLive {
  node: string
  at: number
  sockets: number
  /** Signed-in people with at least one socket. */
  users: string[]
  /** Tenant-scoped record room → its viewers. */
  viewers: Record<string, BoardViewer[]>
  pages: Array<PageAtData & { socket: string }>
  /** Members of the rooms code checks before it bothers to emit (`watch:*`, chaos partitions). */
  rooms?: Record<string, number>
}

export interface BoardStats {
  node: string
  at: number
  sockets: Array<Record<string, unknown> & { id: string }>
  rooms: Array<{ room: string; size: number }>
}

export interface LocalBoard {
  live: Omit<BoardLive, 'node' | 'at'>
  stats: Omit<BoardStats, 'node' | 'at'>
}

type BoardRedis = Pick<Redis, 'set' | 'scan' | 'mget'>

let publisher: ReturnType<typeof setInterval>[] = []
let reader: ReturnType<typeof setInterval>[] = []
let liveBoards: BoardLive[] = []
let statsBoards: BoardStats[] = []
let liveReadAt = 0
let readerOn = false

/** Realtime processes: publish this process's share. Idempotent; returns the stop function. */
export function startBoardPublisher(redis: BoardRedis, collect: () => LocalBoard): () => void {
  stopBoardPublisher()
  const put = async (part: 'live' | 'stats') => {
    try {
      const b = collect()
      const body = { node: INSTANCE_ID, at: Date.now(), ...(part === 'live' ? b.live : b.stats) }
      await redis.set(
        `${keyPrefix()}${INSTANCE_ID}:${part}`,
        JSON.stringify(body),
        'EX',
        part === 'live' ? LIVE_TTL_S : STATS_TTL_S
      )
    } catch {
      /* Redis away — the next tick tries again; readers see the TTL lapse */
    }
  }
  void put('live')
  void put('stats')
  publisher = [
    setInterval(() => void put('live'), LIVE_MS),
    setInterval(() => void put('stats'), STATS_MS)
  ]
  for (const t of publisher) t.unref?.()
  return stopBoardPublisher
}

export function stopBoardPublisher(): void {
  for (const t of publisher) clearInterval(t)
  publisher = []
}

async function readAll<T>(redis: BoardRedis, part: 'live' | 'stats'): Promise<T[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${keyPrefix()}*:${part}`, 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0' && keys.length < 200)
  if (keys.length === 0) return []
  const out: T[] = []
  for (const v of await redis.mget(keys)) {
    if (!v) continue
    try {
      out.push(JSON.parse(v) as T)
    } catch {
      /* a corrupt entry is skipped */
    }
  }
  return out
}

/** SOCKETS=off processes: keep the board in memory. Idempotent; returns the stop function. */
export function startBoardReader(redis: BoardRedis): () => void {
  stopBoardReader()
  readerOn = true
  const live = async () => {
    try {
      liveBoards = await readAll<BoardLive>(redis, 'live')
      liveReadAt = Date.now()
    } catch {
      /* keep the last read; it goes stale and says so */
    }
  }
  const stats = async () => {
    try {
      statsBoards = await readAll<BoardStats>(redis, 'stats')
    } catch {
      /* keep the last read */
    }
  }
  void live()
  void stats()
  reader = [setInterval(() => void live(), LIVE_MS), setInterval(() => void stats(), STATS_MS)]
  for (const t of reader) t.unref?.()
  return stopBoardReader
}

export function stopBoardReader(): void {
  for (const t of reader) clearInterval(t)
  reader = []
  readerOn = false
}

/** Is this process reading the board (a SOCKETS=off process with Redis)? */
export function boardReaderOn(): boolean {
  return readerOn
}

/** Read within the last 6 s and at least one realtime process answered. */
export function boardFresh(now = Date.now()): boolean {
  return readerOn && now - liveReadAt < FRESH_MS && liveBoards.length > 0
}

export function boardLive(): readonly BoardLive[] {
  return liveBoards
}

export function boardStats(): readonly BoardStats[] {
  return statsBoards
}

/** Tests: load boards as a reader would have. */
export function setBoardsForTests(live: BoardLive[], stats: BoardStats[] = [], at = Date.now()) {
  liveBoards = live
  statsBoards = stats
  liveReadAt = at
  readerOn = true
}

/** Tests: forget everything. */
export function resetBoard(): void {
  stopBoardPublisher()
  stopBoardReader()
  liveBoards = []
  statsBoards = []
  liveReadAt = 0
}

// ── Views over the board (the socket plugin's getters fall back to these) ───────────────────

const TENANT_ROOM = /^t:([^:]+):(.+)$/

/** Is `userId` in the (tenant-scoped) record room on any realtime process? */
export function boardIsViewing(room: string, userId: string): boolean {
  for (const b of liveBoards)
    for (const v of b.viewers?.[room] ?? []) if (v.id === userId) return true
  return false
}

type Viewer = { id: string; name: string }

/** Record rooms of one tenant with their viewers (one entry per socket). */
export function boardRecordViewers(
  tenant: string
): Array<{ collection: string; item: string; viewers: Viewer[] }> {
  const byRoom = new Map<string, Map<string, Viewer>>()
  for (const b of liveBoards)
    for (const [scoped, list] of Object.entries(b.viewers ?? {})) {
      const m = TENANT_ROOM.exec(scoped)
      if ((m ? m[1] : '') !== tenant) continue
      const room = m ? m[2] : scoped
      let map = byRoom.get(room)
      if (!map) {
        map = new Map()
        byRoom.set(room, map)
      }
      for (const v of list) map.set(v.socket, { id: v.id, name: v.name })
    }
  const out: Array<{ collection: string; item: string; viewers: Viewer[] }> = []
  for (const [room, map] of byRoom) {
    const r = room.match(/^record:([^:]+):(.+)$/)
    if (r) out.push({ collection: r[1], item: r[2], viewers: [...map.values()] })
  }
  return out
}

/** Users whose latest page ping is `path` (earliest arrival per person). */
export function boardUsersOnPath(
  path: string,
  tenant: string
): Array<{ id: string; name: string; since: number }> {
  const seen = new Map<string, { id: string; name: string; since: number }>()
  for (const b of liveBoards)
    for (const p of b.pages ?? []) {
      if (p.path !== path || p.tenant !== tenant || !p.user) continue
      const cur = seen.get(p.user.id)
      if (!cur || p.since < cur.since) seen.set(p.user.id, { ...p.user, since: p.since })
    }
  return [...seen.values()]
}

/** Users whose latest page ping sits under any of `prefixes`. */
export function boardUsersOnPathPrefix(prefixes: string[], tenant: string): string[] {
  const ids = new Set<string>()
  for (const b of liveBoards)
    for (const p of b.pages ?? []) {
      if (p.tenant !== tenant || !p.user) continue
      const under = prefixes.some(
        (x) => p.path === x || p.path.startsWith(`${x}/`) || p.path.startsWith(`${x}?`)
      )
      if (under) ids.add(p.user.id)
    }
  return [...ids]
}

/** Every realtime process's socket list and room sizes (rooms summed by name). */
export function boardRealtimeStats(): {
  sockets: Array<Record<string, unknown> & { id: string }>
  rooms: Array<{ room: string; size: number }>
} {
  const sockets: Array<Record<string, unknown> & { id: string }> = []
  const rooms = new Map<string, number>()
  for (const b of statsBoards) {
    for (const s of b.sockets ?? []) sockets.push({ ...s, node: b.node })
    for (const r of b.rooms ?? []) rooms.set(r.room, (rooms.get(r.room) ?? 0) + r.size)
  }
  const list = [...rooms].map(([room, size]) => ({ room, size }))
  list.sort((a, b) => b.size - a.size)
  return { sockets, rooms: list.slice(0, 100) }
}

/** The person a socket on any realtime process signed in as (from the stats board). */
export function boardSocketUser(socketId: string): Viewer | null {
  for (const b of statsBoards)
    for (const s of b.sockets ?? []) if (s.id === socketId) return (s.user as Viewer | null) ?? null
  return null
}

/** Rooms whose member count gates an emit: watch rooms and chaos partition rooms. */
export function isGateRoom(room: string): boolean {
  const r = TENANT_ROOM.exec(room)?.[2] ?? room
  return r.startsWith('watch:') || r.startsWith('chaos-partition:')
}

/** Members of `room` on the realtime processes (gate rooms only). */
export function boardRoomSize(room: string): number {
  let n = 0
  for (const b of liveBoards) n += Number(b.rooms?.[room]) || 0
  return n
}

/** Is `userId` signed in on a realtime process? */
export function boardHasUser(userId: string): boolean {
  for (const b of liveBoards) if (b.users?.includes(userId)) return true
  return false
}

/**
 * Members of `room` wherever they are: this process's sockets, plus — on a SOCKETS=off process —
 * the realtime processes' (from the board, up to ~4 s old). For the "is anyone listening?"
 * checks in front of an emit; the emit itself rides the adapter either way.
 */
export function roomListeners(
  io: { sockets?: { adapter?: { rooms?: Map<string, Set<string>> } } } | null | undefined,
  room: string
): number {
  const local = io?.sockets?.adapter?.rooms?.get(room)?.size ?? 0
  return readerOn ? local + boardRoomSize(room) : local
}

/** Sockets and signed-in people across the realtime processes. */
export function boardConcurrency(): { sockets: number; users: number } {
  let sockets = 0
  const users = new Set<string>()
  for (const b of liveBoards) {
    sockets += Number(b.sockets) || 0
    for (const u of b.users ?? []) users.add(u)
  }
  return { sockets, users: users.size }
}
