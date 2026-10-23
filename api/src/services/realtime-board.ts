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
 *   nvr:rt:board:<slot>:<process>:live   viewers + page pings + counts, every 1 s, 10 s TTL
 *   nvr:rt:board:<slot>:<process>:stats  the socket list and room sizes, every 10 s, 30 s TTL
 *   nvr:rt:board:<slot>:nodes            registry: sorted set of publishing processes, score =
 *                                        their last publish (ms); entries older than 60 s go
 *
 * <slot> is the deployment slot (instanceKey()), so deployments sharing one Redis never read
 * each other's people. A reader asks the registry which processes published lately and MGETs
 * their keys: two round trips per read, whatever the size of the key space (no SCAN).
 *
 * A reader polls the live keys every 1 s and the stats keys every 10 s into memory, so the
 * socket plugin's getters stay synchronous and no request waits on another process (no
 * fetchSockets quorum). A realtime process that stopped publishing drops out with its TTL; one
 * that stops gracefully withdraws its keys at once (withdrawBoard).
 * Who takes part (startBoard): every process with Redis registers in the registry every 5 s.
 * A process that serves sockets starts publishing — and reading the others as a peer, merging
 * them with its own sockets — only once the registry shows another process (a second replica,
 * a realtime peer, a SOCKETS=off reader); a lone process never does more than that heartbeat.
 * So a single-role deployment with several replicas gets cluster-wide viewers, page presence and
 * notification suppression too, not only the realtime tier.
 */

// 1 s, not 2: an entry is then at most ~2 s old when read (publish + read interval), inside the
// 3 s the notification skip trusts — at 2 s about a quarter of real viewers read as too old.
const LIVE_MS = 1_000
const STATS_MS = 10_000
const LIVE_TTL_S = 10
const STATS_TTL_S = 30
/** Registry entries older than this are trimmed (their keys have long expired). */
const REGISTRY_KEEP_MS = 60_000
/** A read older than this is stale: callers that must not guess (the concurrency sample) skip. */
const FRESH_MS = 6_000
/** Notification suppression trusts a board entry only this young (a deliver beats a wrong skip). */
export const VIEWING_MAX_AGE_MS = 3_000
/** The deployment slot. In development every API on the laptop is its own deployment (Rob's
 *  API and a throwaway on another port share Redis and NODE_ENV): the port tells them apart. */
const boardSlot = () =>
  process.env.NODE_ENV === 'development'
    ? `${instanceKey()}-${process.env.PORT ?? ''}`
    : instanceKey()
const keyPrefix = () => `nvr:rt:board:${boardSlot()}:`
const registryKey = () => `${keyPrefix()}nodes`
const partKey = (node: string, part: 'live' | 'stats') => `${keyPrefix()}${node}:${part}`

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
  /** Ops topic rooms (issue-view / ticket / layout) → their viewers, one entry per socket. */
  topics?: Record<string, BoardTopicViewer[]>
}

export interface BoardTopicViewer {
  socket: string
  id: string
  name: string
  selected?: string | null
  at?: number
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

/** What a publisher collects: the live part every second, the socket list every 10 s. */
export interface BoardCollector {
  live: () => LocalBoard['live']
  stats: () => LocalBoard['stats']
}

type BoardRedis = Pick<
  Redis,
  'set' | 'mget' | 'del' | 'zadd' | 'zrem' | 'zrangebyscore' | 'zremrangebyscore' | 'pexpire'
>

let publisher: ReturnType<typeof setInterval>[] = []
let publisherRedis: BoardRedis | null = null
let reader: ReturnType<typeof setInterval>[] = []
let liveBoards: BoardLive[] = []
let statsBoards: BoardStats[] = []
let liveReadAt = 0
let statsReadAt = 0
/** A stats read older than this is not trusted (stats are published every 10 s, 30 s TTL). */
const STATS_FRESH_MS = 30_000
let readerOn = false
let peersOn = false
let peerChange: ((rooms: string[]) => void) | null = null

/**
 * A realtime process: called with the rooms whose OTHER-process viewers changed after a board
 * read (record rooms and ops topic rooms), so it can tell its own sockets the new list. A join
 * or leave on one process is only broadcast with what the others' board said at that moment;
 * this re-tells the list once the board catches up (same-moment joins, a leave elsewhere).
 */
export function onPeerBoardChange(fn: ((rooms: string[]) => void) | null): void {
  peerChange = fn
}

/** Room → the other processes' viewers there, one comparable string per room. */
function peerRoomPrints(boards: readonly BoardLive[]): Map<string, string> {
  const by = new Map<string, string[]>()
  for (const b of boards) {
    if (b.node === INSTANCE_ID) continue
    for (const [room, list] of [
      ...Object.entries(b.viewers ?? {}),
      ...Object.entries(b.topics ?? {})
    ]) {
      const cur = by.get(room) ?? []
      for (const v of list as Array<{ socket: string; id: string; selected?: unknown }>)
        cur.push(`${b.node}/${v.socket}/${v.id}/${String(v.selected ?? '')}`)
      by.set(room, cur)
    }
  }
  return new Map([...by].map(([room, list]) => [room, list.sort().join('|')]))
}

/** Exported for tests: the rooms whose prints differ between two reads. */
export function changedPeerRooms(
  before: readonly BoardLive[],
  after: readonly BoardLive[]
): string[] {
  const a = peerRoomPrints(before)
  const b = peerRoomPrints(after)
  const out: string[] = []
  for (const room of new Set([...a.keys(), ...b.keys()]))
    if (a.get(room) !== b.get(room)) out.push(room)
  return out
}

/** Realtime processes: publish this process's share. Idempotent; returns the stop function. */
export function startBoardPublisher(redis: BoardRedis, collect: BoardCollector): () => void {
  stopBoardPublisher()
  publisherRedis = redis
  const put = async (part: 'live' | 'stats') => {
    try {
      const share = part === 'live' ? collect.live() : collect.stats()
      const at = Date.now()
      const body = { node: INSTANCE_ID, at, ...share }
      await redis.set(
        partKey(INSTANCE_ID, part),
        JSON.stringify(body),
        'EX',
        part === 'live' ? LIVE_TTL_S : STATS_TTL_S
      )
      if (part === 'live') {
        await redis.zadd(registryKey(), at, INSTANCE_ID)
        await redis.zremrangebyscore(registryKey(), '-inf', at - REGISTRY_KEEP_MS)
        await redis.pexpire(registryKey(), REGISTRY_KEEP_MS * 2)
      }
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

/** Graceful stop: stop publishing and take this process's share off the board at once. */
export async function withdrawBoard(): Promise<void> {
  const redis = publisherRedis
  stopBoardPublisher()
  publisherRedis = null
  if (!redis) return
  try {
    await redis.zrem(registryKey(), INSTANCE_ID)
    await redis.del(partKey(INSTANCE_ID, 'live'), partKey(INSTANCE_ID, 'stats'))
  } catch {
    /* the TTLs clear it anyway */
  }
}

/** Registry members that are readers (SOCKETS=off), not publishers. */
const READER_PREFIX = 'reader:'

async function readAll<T>(
  redis: BoardRedis,
  part: 'live' | 'stats',
  includeOwn = false
): Promise<T[]> {
  const nodes = (
    (await redis.zrangebyscore(registryKey(), Date.now() - REGISTRY_KEEP_MS, '+inf')) as string[]
  ).filter(
    // This process's own sockets are read live, never from its own (older) board entry.
    (n) => !n.startsWith(READER_PREFIX) && (includeOwn || n !== INSTANCE_ID)
  )
  if (nodes.length === 0) return []
  const out: T[] = []
  for (const v of await redis.mget(nodes.slice(0, 200).map((n) => partKey(n, part)))) {
    if (!v) continue
    try {
      out.push(JSON.parse(v) as T)
    } catch {
      /* a corrupt entry is skipped */
    }
  }
  return out
}

/**
 * SOCKETS=off processes: keep the board in memory; the socket plugin's getters answer from it.
 * `peers`: a realtime process reading the OTHER realtime processes' viewers for its own
 * `record:viewers` broadcasts — its getters keep answering from its own sockets.
 * Idempotent; returns the stop function.
 */
export function startBoardReader(
  redis: BoardRedis,
  /** `includeOwn`: tests that run publisher and reader in one process. */
  opts: { peers?: boolean; includeOwn?: boolean } = {}
): () => void {
  stopBoardReader()
  readerOn = !opts.peers
  peersOn = !!opts.peers
  const live = async () => {
    const before = liveBoards
    try {
      liveBoards = await readAll<BoardLive>(redis, 'live', opts.includeOwn)
      liveReadAt = Date.now()
    } catch {
      // Redis trouble degrades to this process's own sockets: once the last good read is too
      // old, drop it (the views already ignore it) and re-tell the rooms it named.
      if (liveBoards.length && Date.now() - liveReadAt > FRESH_MS) liveBoards = []
    }
    if (opts.peers && peerChange && before !== liveBoards) {
      const rooms = changedPeerRooms(before, liveBoards)
      if (rooms.length) peerChange(rooms)
    }
  }
  const stats = async () => {
    try {
      statsBoards = await readAll<BoardStats>(redis, 'stats', opts.includeOwn)
      statsReadAt = Date.now()
    } catch {
      if (statsBoards.length && Date.now() - statsReadAt > STATS_FRESH_MS) statsBoards = []
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
  peersOn = false
}

const DISCOVER_MS = 5_000
/** Another process counts as present while its registry entry is this fresh. */
const PRESENT_MS = 15_000
/** With nobody else for this long, a publishing process goes back to the heartbeat only. */
const IDLE_OFF_MS = 60_000

/**
 * Take part in the board (see the header). `serves`: this process holds sockets. Returns the
 * stop function (also withdraws this process's entries). Never in cloud mode.
 */
export function startBoard(
  redis: BoardRedis,
  opts: { serves: boolean; collect?: BoardCollector }
): () => Promise<void> {
  let stopped = false
  /** Register (and keep the registry trimmed and expiring — a crashed process's entry goes). */
  const register = async (member: string) => {
    const now = Date.now()
    await redis.zadd(registryKey(), now, member)
    await redis.zremrangebyscore(registryKey(), '-inf', now - REGISTRY_KEEP_MS)
    await redis.pexpire(registryKey(), REGISTRY_KEEP_MS * 2)
  }
  if (!opts.serves) {
    const member = `${READER_PREFIX}${INSTANCE_ID}`
    const beat = () => {
      if (!stopped) void register(member).catch(() => {})
    }
    beat()
    const t = setInterval(beat, DISCOVER_MS)
    t.unref?.()
    startBoardReader(redis)
    return async () => {
      stopped = true
      clearInterval(t)
      stopBoardReader()
      await redis.zrem(registryKey(), member).catch(() => 0)
    }
  }
  let active = false
  let lastOthers = 0
  const tick = async () => {
    if (stopped) return
    const now = Date.now()
    let present: string[] | null = null
    try {
      if (!active) await register(INSTANCE_ID)
      if (stopped) return
      present = (
        (await redis.zrangebyscore(registryKey(), now - PRESENT_MS, '+inf')) as string[]
      ).filter((n) => n !== INSTANCE_ID)
    } catch {
      /* Redis away: nobody seen this tick (the idle-off below still runs) */
    }
    if (stopped) return
    if (present && present.length > 0) lastOthers = now
    if (present && present.length > 0 && !active && opts.collect) {
      active = true
      startBoardPublisher(redis, opts.collect)
      startBoardReader(redis, { peers: true })
    } else if (active && now - lastOthers > IDLE_OFF_MS) {
      active = false
      stopBoardReader()
      liveBoards = []
      statsBoards = []
      await withdrawBoard()
    }
  }
  void tick()
  const t = setInterval(() => void tick(), DISCOVER_MS)
  t.unref?.()
  return async () => {
    stopped = true
    clearInterval(t)
    stopBoardReader()
    await withdrawBoard()
    await redis.zrem(registryKey(), INSTANCE_ID).catch(() => 0)
  }
}

/** Is this process merging the board — a SOCKETS=off reader, or a socket-serving peer? */
export function boardMergeOn(): boolean {
  return readerOn || peersOn
}

/** Is this process reading the board (a SOCKETS=off process with Redis)? */
export function boardReaderOn(): boolean {
  return readerOn
}

/** Read within the last 6 s and at least one realtime process answered. */
export function boardFresh(now = Date.now()): boolean {
  return readerOn && liveView(now).length > 0
}

/**
 * The other processes' live entries this process may trust now: none once the last good read
 * is older than 6 s (Redis trouble = this process's own sockets only), and no entry its
 * publisher wrote more than 10 s ago (the key's own TTL). Every view reads through this.
 */
function liveView(now = Date.now()): BoardLive[] {
  if (now - liveReadAt > FRESH_MS) return []
  return liveBoards.filter((b) => now - (Number(b.at) || 0) <= LIVE_TTL_S * 1000)
}

/** The same for the socket lists (30 s). */
function statsView(now = Date.now()): BoardStats[] {
  if (now - statsReadAt > STATS_FRESH_MS) return []
  return statsBoards.filter((b) => now - (Number(b.at) || 0) <= STATS_TTL_S * 1000)
}

export function boardLive(): readonly BoardLive[] {
  return liveView()
}

export function boardStats(): readonly BoardStats[] {
  return statsView()
}

/** Tests: load boards as a reader would have. */
export function setBoardsForTests(live: BoardLive[], stats: BoardStats[] = [], at = Date.now()) {
  liveBoards = live
  statsBoards = stats
  liveReadAt = at
  statsReadAt = at
  readerOn = true
}

/** Tests: load the other processes' boards as a socket-serving peer would have. */
export function setPeerBoardsForTests(live: BoardLive[], stats: BoardStats[] = []) {
  liveBoards = live
  statsBoards = stats
  liveReadAt = Date.now()
  statsReadAt = Date.now()
  readerOn = false
  peersOn = true
}

/** Tests: forget everything. */
export function resetBoard(): void {
  stopBoardPublisher()
  stopBoardReader()
  liveBoards = []
  statsBoards = []
  liveReadAt = 0
  statsReadAt = 0
}

// ── Views over the board (the socket plugin's getters fall back to these) ───────────────────

const TENANT_ROOM = /^t:([^:]+):(.+)$/

/** Viewers of a (tenant-scoped) record room held by OTHER realtime processes. */
export function boardPeerViewers(
  room: string
): Array<{ socket: string; id: string; name: string }> {
  const out: Array<{ socket: string; id: string; name: string }> = []
  for (const b of liveView()) if (b.node !== INSTANCE_ID) out.push(...(b.viewers?.[room] ?? []))
  return out
}

/** Viewers of an ops topic room (tenant-scoped) held by OTHER realtime processes. */
export function boardPeerTopicViewers(room: string): BoardTopicViewer[] {
  const out: BoardTopicViewer[] = []
  for (const b of liveView()) if (b.node !== INSTANCE_ID) out.push(...(b.topics?.[room] ?? []))
  return out
}

/**
 * Is `userId` in the (tenant-scoped) record room on a realtime process, by a board entry younger
 * than `maxAgeMs`? Notification suppression asks: an older entry (a process that just crashed,
 * a person who just left) does not skip a notification — delivering beats a wrong skip.
 */
export function boardIsViewing(
  room: string,
  userId: string,
  maxAgeMs = VIEWING_MAX_AGE_MS,
  now = Date.now()
): boolean {
  for (const b of liveView()) {
    if (now - Math.min(Number(b.at) || 0, now) > maxAgeMs) continue
    for (const v of b.viewers?.[room] ?? []) if (v.id === userId) return true
  }
  return false
}

type Viewer = { id: string; name: string }

/** Record rooms of one tenant with their viewers (one entry per socket). */
export function boardRecordViewers(
  tenant: string
): Array<{ collection: string; item: string; viewers: Viewer[] }> {
  const byRoom = new Map<string, Map<string, Viewer>>()
  for (const b of liveView())
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
  for (const b of liveView())
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
  for (const b of liveView())
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
  for (const b of statsView()) {
    for (const s of b.sockets ?? []) sockets.push({ ...s, node: b.node })
    for (const r of b.rooms ?? []) rooms.set(r.room, (rooms.get(r.room) ?? 0) + r.size)
  }
  const list = [...rooms].map(([room, size]) => ({ room, size }))
  list.sort((a, b) => b.size - a.size)
  return { sockets, rooms: list.slice(0, 100) }
}

/** The person a socket on any realtime process signed in as (from the stats board). */
export function boardSocketUser(socketId: string): Viewer | null {
  for (const b of statsView())
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
  for (const b of liveView()) n += Number(b.rooms?.[room]) || 0
  return n
}

/** Is `userId` signed in on a realtime process? */
export function boardHasUser(userId: string): boolean {
  for (const b of liveView()) if (b.users?.includes(userId)) return true
  return false
}

/**
 * Members of `room` wherever they are: this process's sockets, plus — on a SOCKETS=off process —
 * the realtime processes' (from the board, up to ~2 s old). For the "is anyone listening?"
 * checks in front of an emit; the emit itself rides the adapter either way.
 */
export function roomListeners(
  io: { sockets?: { adapter?: { rooms?: Map<string, Set<string>> } } } | null | undefined,
  room: string
): number {
  const local = io?.sockets?.adapter?.rooms?.get(room)?.size ?? 0
  return readerOn || peersOn ? local + boardRoomSize(room) : local
}

/** Sockets and signed-in people across the other processes, plus this one's (`own`). */
export function boardConcurrency(
  own: { sockets: number; users: Iterable<string> } = { sockets: 0, users: [] }
): { sockets: number; users: number } {
  let sockets = own.sockets
  const users = new Set<string>(own.users)
  for (const b of liveView()) {
    sockets += Number(b.sockets) || 0
    for (const u of b.users ?? []) users.add(u)
  }
  return { sockets, users: users.size }
}
