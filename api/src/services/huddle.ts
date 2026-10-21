import type { FastifyInstance } from 'fastify'
import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import { canSeeRoom as canSeeRoomReal, parseRoom } from './chat.js'
import {
  clearHuddleEnd,
  collabLeft,
  huddleEndLine,
  huddleNotesMessage,
  notePostReason,
  readHuddleEnd,
  recordAttendee,
  settleCollabWrites,
  touchCollab
} from './huddle-collab.js'
import { getHuddleSettings } from './huddle-settings.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * Huddles (#2457): WebRTC audio, with an optional screen share, in a channel
 * or a record's room. The server never carries media — it relays the
 * offer/answer/candidate signals between the browsers in a room and keeps the
 * participant list.
 *
 * Signals ride the chat socket and are gated by the SAME canSeeRoom the chat
 * routes use, checked again on EVERY signal (a membership revoked mid-call
 * stops the next offer). Who is in a huddle lives in Redis with a TTL, so a
 * second replica sees the same list and a crashed browser falls out within
 * STALE_MS. Joining the first person and leaving the last one post a system
 * line through chat-send.ts, the one send path.
 *
 * Events (client → server): huddle:join {room}, huddle:leave {room},
 * huddle:signal {room, to, data}, huddle:state {room, muted?, screen?},
 * huddle:ping {room}. Server → client: huddle:joined {room, self, peers},
 * huddle:peers {room, peers} (to the huddle AND everyone with the room open),
 * huddle:signal {room, from, user, data}, huddle:denied {room, reason}.
 * Payloads carry ids, names and SDP only — never message text.
 */

/** A participant who has not pinged for this long is gone (a browser that crashed). */
export const STALE_MS = 45_000
const KEY_TTL_S = 120
const MAX_SIGNAL_BYTES = 64 * 1024
const ROOM_MAX = 200

export interface HuddlePeer {
  socket: string
  user: string
  name: string | null
  muted: boolean
  screen: boolean
  since: number
}

/** The slice of ioredis the presence set uses (typed small so tests can fake it). */
export interface HuddleRedis {
  zadd(key: string, score: number, member: string): Promise<unknown>
  zrem(key: string, member: string): Promise<unknown>
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>
  zrange(key: string, start: number, stop: number): Promise<string[]>
  zcard(key: string): Promise<number>
  hset(key: string, field: string, value: string): Promise<unknown>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, field: string): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  expire(key: string, seconds: number): Promise<unknown>
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<unknown>
}

function keys(tenant: string | null, room: string) {
  const base = `nvr:huddle:${tenant || '-'}:${room}`
  return { set: base, meta: `${base}:m`, start: `${base}:start` }
}

/** Rooms a huddle may run in: channels, General and record rooms (DMs are not in v1). */
export function huddleRoomKind(room: string): 'ok' | 'dm' | 'bad' {
  if (typeof room !== 'string' || !room || room.length > ROOM_MAX) return 'bad'
  const kind = parseRoom(room).kind
  if (kind === 'dm') return 'dm'
  return kind === 'unknown' ? 'bad' : 'ok'
}

function nameOf(u: User): string | null {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null
}

/** Everyone in the room's huddle right now (stale entries pruned as a side effect). */
export async function huddlePeers(
  redis: HuddleRedis,
  tenant: string | null,
  room: string,
  now = Date.now()
): Promise<HuddlePeer[]> {
  const k = keys(tenant, room)
  await redis.zremrangebyscore(k.set, '-inf', now - STALE_MS)
  const ids = await redis.zrange(k.set, 0, -1)
  if (!ids.length) return []
  const meta = await redis.hgetall(k.meta)
  const out: HuddlePeer[] = []
  for (const socket of ids) {
    const raw = meta[socket]
    if (!raw) continue
    try {
      const m = JSON.parse(raw) as Partial<HuddlePeer>
      out.push({
        socket,
        user: String(m.user ?? ''),
        name: m.name ?? null,
        muted: !!m.muted,
        screen: !!m.screen,
        since: Number(m.since) || now
      })
    } catch {
      /* a torn meta row: skip it, the next ping rewrites it */
    }
  }
  // Drop meta rows whose set member expired.
  for (const socket of Object.keys(meta)) {
    if (!ids.includes(socket)) void redis.hdel(k.meta, socket)
  }
  return out
}

async function touch(redis: HuddleRedis, tenant: string | null, room: string, socketId: string) {
  const k = keys(tenant, room)
  await redis.zadd(k.set, Date.now(), socketId)
  await redis.expire(k.set, KEY_TTL_S)
  await redis.expire(k.meta, KEY_TTL_S)
  await redis.expire(k.start, KEY_TTL_S)
  await touchCollab(redis, tenant, room, KEY_TTL_S)
}

export interface HuddleDeps {
  redis: HuddleRedis
  canSeeRoom(user: User, room: string): Promise<boolean>
  settings(): Promise<{ enabled: boolean; max_participants: number }>
  /** Post a platform line in the room (chat-send.ts). Fixed server text only. */
  postLine(room: string, text: string): Promise<void>
  /**
   * #2854 — post the huddle's notes AS A PERSON (people wrote them): the note's last editor,
   * else `fallback` (the last one to leave), through the normal visibility and posting rules.
   * Resolves null when posted, or the plain reason it was not.
   */
  postNote(
    room: string,
    editorId: string | null,
    fallback: User | null,
    text: string
  ): Promise<string | null>
  warn(obj: Record<string, unknown>, msg: string): void
}

export function defaultHuddleDeps(app: FastifyInstance): HuddleDeps {
  return {
    redis: app.redis as unknown as HuddleRedis,
    canSeeRoom: (user, room) => canSeeRoomReal(user, room),
    settings: () => getHuddleSettings(),
    async postLine(room, text) {
      const { postChatMessage } = await import('./chat-send.js')
      await postChatMessage(
        app,
        { user: null, senderId: null, senderName: 'Nivaro', system: true, skipVisibility: true },
        { room, message: text }
      )
    },
    async postNote(room, editorId, fallback, text) {
      const { getUser } = await import('./users.js')
      const editor = editorId ? await getUser(editorId).catch(() => undefined) : undefined
      const author = editor && editor.status === 'active' ? editor : fallback
      if (!author) return 'nobody from the huddle could post them'
      try {
        const { postChatMessage } = await import('./chat-send.js')
        const { isAdminRole } = await import('./permissions.js')
        await postChatMessage(
          app,
          { user: author, isAdmin: await isAdminRole(author).catch(() => false) },
          { room, message: text }
        )
        return null
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode
        if (!status || status >= 500) app.log.warn({ err, room }, 'huddle notes post failed')
        return notePostReason(err)
      }
    },
    warn: (obj, msg) => app.log.warn(obj, msg)
  }
}

export interface HuddleScope {
  /** The tenant-scoped socket room name (null = no tenant yet; join nothing). */
  scopedRoom(room: string): Promise<string | null>
  scopedRoomNow(room: string): string | null
  /** '' self-hosted; the tenant key in cloud; null before it resolved. */
  tenantNow(): string | null
}

type HuddleData = { room: string }

export function formatHuddleDuration(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** Wire the huddle:* events onto one connection. */
export function registerHuddle(
  io: Pick<Server, 'to'>,
  socket: Socket,
  getUser: () => User | null,
  scope: HuddleScope,
  deps: HuddleDeps
): void {
  const data = () => (socket.data as { huddle?: HuddleData }).huddle
  const setData = (d: HuddleData | undefined) => {
    ;(socket.data as { huddle?: HuddleData }).huddle = d
  }
  const deny = (room: unknown, reason: string): void => {
    socket.emit('huddle:denied', { room: typeof room === 'string' ? room : null, reason })
  }

  async function broadcast(room: string) {
    const tenant = scope.tenantNow()
    const peers = await huddlePeers(deps.redis, tenant, room)
    const payload = { room, peers }
    const chat = scope.scopedRoomNow(`chat:${room}`)
    if (chat) io.to(chat).emit('huddle:peers', payload)
    // People in the huddle with the room closed still need the list.
    const h = scope.scopedRoomNow(`huddle:${room}`)
    if (h) io.to(h).emit('huddle:peers', payload)
    return peers
  }

  async function join(payload: { room?: unknown }): Promise<void> {
    const room = payload?.room
    const user = getUser()
    if (!user) return deny(room, 'not-signed-in')
    const kind = huddleRoomKind(room as string)
    if (kind !== 'ok') return deny(room, kind === 'dm' ? 'no-dm' : 'bad-room')
    const r = room as string
    try {
      const settings = await deps.settings()
      if (!settings.enabled) return deny(r, 'off')
      if (!(await deps.canSeeRoom(user, r))) return deny(r, 'no-access')
      const tenant = scope.tenantNow()
      const peers = await huddlePeers(deps.redis, tenant, r)
      const already = peers.some((p) => p.socket === socket.id)
      if (!already && peers.length >= settings.max_participants) return deny(r, 'full')
      const prev = data()
      if (prev && prev.room !== r) await leave(prev.room)
      const k = keys(tenant, r)
      const since = Date.now()
      await deps.redis.hset(
        k.meta,
        socket.id,
        JSON.stringify({ user: user.id, name: nameOf(user), muted: false, screen: false, since })
      )
      await touch(deps.redis, tenant, r, socket.id)
      await recordAttendee(deps.redis, tenant, r, user.id, nameOf(user))
      setData({ room: r })
      const name = await scope.scopedRoom(`huddle:${r}`)
      if (name) socket.join(name)
      const first = peers.length === 0
      if (first) await deps.redis.set(k.start, String(since), 'EX', KEY_TTL_S)
      socket.emit('huddle:joined', {
        room: r,
        self: socket.id,
        peers: peers.filter((p) => p.socket !== socket.id)
      })
      await broadcast(r)
      if (first) await deps.postLine(r, `${nameOf(user) ?? 'Someone'} started a huddle`)
    } catch (err) {
      deps.warn({ err, room: r }, 'huddle:join failed')
      deny(r, 'unavailable')
    }
  }

  async function leave(room: string) {
    const tenant = scope.tenantNow()
    const k = keys(tenant, room)
    try {
      await deps.redis.zrem(k.set, socket.id)
      await deps.redis.hdel(k.meta, socket.id)
      if (data()?.room === room) setData(undefined)
      const name = scope.scopedRoomNow(`huddle:${room}`)
      if (name) socket.leave(name)
      const left = await broadcast(room)
      // #2855 — the presenter leaving ends Follow me; #2854 — a last note edit lands first.
      await collabLeft(io, scope, deps.redis, tenant, room, socket.id)
      if (left.length === 0) {
        await settleCollabWrites(socket)
        const start = await deps.redis.get(k.start)
        const end = await readHuddleEnd(deps.redis, tenant, room)
        const ms = start ? Date.now() - Number(start) : 0
        const duration = formatHuddleDuration(ms)
        // The notes are people's words: they post as a person (never the system line), and a
        // person the room refuses means they are not posted — kept for the attendees instead.
        const unposted = end.note
          ? await deps.postNote(
              room,
              end.noteBy,
              getUser(),
              huddleNotesMessage(duration, end.names, end.note)
            )
          : null
        await clearHuddleEnd(deps.redis, tenant, room, !!unposted, KEY_TTL_S)
        await deps.redis.del(k.start, k.meta, k.set)
        const line = huddleEndLine(duration, end.names)
        await deps.postLine(room, unposted ? `${line} · notes were not posted: ${unposted}` : line)
        if (unposted) socket.emit('huddle:note:unposted', { room, reason: unposted })
      }
    } catch (err) {
      deps.warn({ err, room }, 'huddle:leave failed')
    }
  }

  /** Every heartbeat, state change and signal re-asks canSeeRoom: access revoked mid-call
   *  removes the person (peers drop the link on the next huddle:peers broadcast). */
  async function stillAllowed(user: User, room: string): Promise<boolean> {
    if (await deps.canSeeRoom(user, room)) return true
    deny(room, 'no-access')
    await leave(room)
    return false
  }

  socket.on('huddle:join', inSocketTenant(socket, join))

  socket.on(
    'huddle:leave',
    inSocketTenant(socket, async (payload: { room?: unknown }) => {
      const room = typeof payload?.room === 'string' ? payload.room : data()?.room
      if (room && data()?.room === room) await leave(room)
    })
  )

  socket.on(
    'huddle:signal',
    inSocketTenant(socket, async (payload: { room?: unknown; to?: unknown; data?: unknown }) => {
      const user = getUser()
      const room = payload?.room
      const to = payload?.to
      if (!user || typeof room !== 'string' || typeof to !== 'string' || !to) return
      if (data()?.room !== room) return
      if (!payload.data || JSON.stringify(payload.data).length > MAX_SIGNAL_BYTES) return
      try {
        // Re-checked on every signal: a membership revoked mid-call stops here.
        if (!(await deps.canSeeRoom(user, room))) {
          deny(room, 'no-access')
          await leave(room)
          return
        }
        const peers = await huddlePeers(deps.redis, scope.tenantNow(), room)
        if (!peers.some((p) => p.socket === to)) return
        io.to(to).emit('huddle:signal', {
          room,
          from: socket.id,
          user: { id: user.id, name: nameOf(user) },
          data: payload.data
        })
      } catch (err) {
        deps.warn({ err, room }, 'huddle:signal failed')
      }
    })
  )

  socket.on(
    'huddle:state',
    inSocketTenant(
      socket,
      async (payload: { room?: unknown; muted?: unknown; screen?: unknown }) => {
        const room = payload?.room
        if (typeof room !== 'string' || data()?.room !== room) return
        const user = getUser()
        if (!user) return
        try {
          if (!(await stillAllowed(user, room))) return
          const tenant = scope.tenantNow()
          const k = keys(tenant, room)
          const raw = await deps.redis.hget(k.meta, socket.id)
          const prev = raw ? (JSON.parse(raw) as Partial<HuddlePeer>) : {}
          const next = {
            user: prev.user ?? user.id,
            name: prev.name ?? nameOf(user),
            since: prev.since ?? Date.now(),
            muted: typeof payload.muted === 'boolean' ? payload.muted : !!prev.muted,
            screen: typeof payload.screen === 'boolean' ? payload.screen : !!prev.screen
          }
          await deps.redis.hset(k.meta, socket.id, JSON.stringify(next))
          await touch(deps.redis, tenant, room, socket.id)
          await broadcast(room)
        } catch (err) {
          deps.warn({ err, room }, 'huddle:state failed')
        }
      }
    )
  )

  socket.on(
    'huddle:ping',
    inSocketTenant(socket, async (payload: { room?: unknown }) => {
      const room = payload?.room
      if (typeof room !== 'string' || data()?.room !== room) return
      const user = getUser()
      if (!user) {
        await leave(room)
        return
      }
      try {
        // A ping is what keeps a member listed: no access, no heartbeat.
        if (!(await stillAllowed(user, room))) return
        await touch(deps.redis, scope.tenantNow(), room, socket.id)
      } catch {
        /* the next ping tries again */
      }
    })
  )

  socket.on(
    'disconnect',
    inSocketTenant(socket, async () => {
      const d = data()
      if (d) await leave(d.room)
    })
  )
}
