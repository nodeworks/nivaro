import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import { canSeeRoom as canSeeRoomReal, parseRoom } from './chat.js'
import {
  collabLeft,
  finishHuddleEnd,
  huddleEndLine,
  huddleNotesMessage,
  notePostReason,
  readHuddleEnd,
  recordAttendee,
  settleCollabWrites,
  touchCollab
} from './huddle-collab.js'
import { noteHuddleEnded, resumeRecentHuddle, roomLineAllowed } from './huddle-flood-guard.js'
import { LIVE_ROOM, pokeHuddleLive, registerHuddleLive } from './huddle-live.js'
import { markHuddling, unmarkHuddling } from './huddle-presence.js'
import {
  answerRing,
  cancelRing,
  defaultRingDeps,
  type RingDeps,
  ringTargets,
  ringUsers
} from './huddle-ring.js'
import {
  clampQuality,
  defaultSessionRecorder,
  type HuddleSessionRecorder,
  type SessionRedis
} from './huddle-sessions.js'
import { getHuddleSettings, sfuConfigured } from './huddle-settings.js'
import {
  decideHuddleMode,
  type HuddleMode,
  sfuDeleteRoom,
  sfuIdentity,
  sfuRemoveParticipant,
  sfuRoomName
} from './huddle-sfu.js'
import {
  registerHuddleStage,
  type StageFields,
  stageFieldsFrom,
  stagePatch
} from './huddle-stage.js'
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
 * huddle:peers {room, peers, mode} (to the huddle AND everyone with the room open),
 * huddle:signal {room, from, user, data}, huddle:denied {room, reason},
 * huddle:mode {room, mode} (#2859: the huddle outgrew the mesh — move to the SFU).
 * Payloads carry ids, names and SDP only — never message text.
 */

/** A participant who has not pinged for this long is gone (a browser that crashed). */
export const STALE_MS = 45_000
const KEY_TTL_S = 120
const MAX_SIGNAL_BYTES = 64 * 1024
const ROOM_MAX = 200

export interface HuddlePeer extends StageFields {
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
  /** Optional: one round trip for the "in a huddle" presence marks (#2852). */
  mget?(...keys: string[]): Promise<Array<string | null>>
}

function keys(tenant: string | null, room: string) {
  const base = `nvr:huddle:${tenant || '-'}:${room}`
  return {
    set: base,
    meta: `${base}:m`,
    start: `${base}:start`,
    mode: `${base}:mode`,
    session: `${base}:s`
  }
}

/** Rooms a huddle may run in: channels, General, record rooms and, since #2843, direct messages. */
export function huddleRoomKind(room: string): 'ok' | 'dm' | 'bad' {
  if (typeof room !== 'string' || !room || room.length > ROOM_MAX) return 'bad'
  const kind = parseRoom(room).kind
  return kind === 'unknown' ? 'bad' : 'ok'
}

function nameOf(u: User): string | null {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null
}

type StaleEvictor = (
  tenant: string | null,
  room: string,
  stale: Array<{ socket: string; user: string }>
) => void

/** Whoever prunes a stale browser also drops it from the SFU (#2859): one evictor for every
 *  caller of huddlePeers (socket handlers, REST presence, token route), installed by
 *  registerHuddle and the SFU routes; null = mesh-only, nothing to tell. */
let staleEvictor: StaleEvictor | null = null

export function setHuddleStaleEvictor(fn: StaleEvictor | null): void {
  staleEvictor = fn
}

/** The evictor built from a deps set: on an SFU huddle, each stale browser's identity is
 *  removed from the LiveKit room; fire-and-forget, failures only warn. */
export function staleEvictorFor(
  deps: Pick<HuddleDeps, 'redis' | 'sfuEvict' | 'warn'>
): StaleEvictor {
  return (tenant, room, stale) => {
    if (!deps.sfuEvict) return
    void (async () => {
      if ((await huddleMode(deps.redis, tenant, room)) !== 'sfu') return
      const session = await huddleSession(deps.redis, tenant, room)
      if (!session) return
      for (const s of stale) {
        if (!s.user) continue
        const identity = sfuIdentity(s.user, s.socket)
        try {
          await deps.sfuEvict?.({ tenant, room, session, identity })
        } catch (err) {
          deps.warn({ err, room, identity }, 'huddle: SFU eviction failed')
        }
      }
    })().catch((err) => deps.warn({ err, room }, 'huddle: SFU eviction failed'))
  }
}

/** Everyone in the room's huddle right now (stale entries pruned as a side effect, and on an
 *  SFU huddle evicted from LiveKit through the installed stale evictor). */
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
        since: Number(m.since) || now,
        // #2857/#2858 — raised hand + camera (huddle-stage.ts).
        ...stageFieldsFrom(m)
      })
    } catch {
      /* a torn meta row: skip it, the next ping rewrites it */
    }
  }
  // Drop meta rows whose set member expired.
  const stale: Array<{ socket: string; user: string }> = []
  for (const socket of Object.keys(meta)) {
    if (ids.includes(socket)) continue
    void redis.hdel(k.meta, socket)
    try {
      stale.push({
        socket,
        user: String((JSON.parse(meta[socket]) as { user?: unknown }).user ?? '')
      })
    } catch {
      stale.push({ socket, user: '' })
    }
  }
  if (stale.length) staleEvictor?.(tenant, room, stale)
  return out
}

async function touch(
  redis: HuddleRedis,
  tenant: string | null,
  room: string,
  socketId: string,
  userId?: string
) {
  const k = keys(tenant, room)
  await redis.zadd(k.set, Date.now(), socketId)
  await redis.expire(k.set, KEY_TTL_S)
  await redis.expire(k.meta, KEY_TTL_S)
  await redis.expire(k.start, KEY_TTL_S)
  await redis.expire(k.mode, KEY_TTL_S)
  await redis.expire(k.session, KEY_TTL_S)
  // #2852 — the person reads "In a huddle" wherever presence is shown.
  if (userId) await markHuddling(redis, tenant, userId, room).catch(() => undefined)
  await touchCollab(redis, tenant, room, KEY_TTL_S)
}

/** The huddle's session id (#2859): random per huddle, names its LiveKit room; null = no huddle. */
export async function huddleSession(
  redis: HuddleRedis,
  tenant: string | null,
  room: string
): Promise<string | null> {
  return redis.get(keys(tenant, room).session)
}

/** How the room's huddle carries media right now (#2859); mesh until it outgrew it. */
export async function huddleMode(
  redis: HuddleRedis,
  tenant: string | null,
  room: string
): Promise<HuddleMode> {
  return (await redis.get(keys(tenant, room).mode)) === 'sfu' ? 'sfu' : 'mesh'
}

export interface HuddleDeps {
  redis: HuddleRedis
  canSeeRoom(user: User, room: string): Promise<boolean>
  settings(): Promise<{
    enabled: boolean
    max_participants: number
    /** #2859: an SFU is configured, and the size above which a huddle moves to it. */
    sfu?: boolean
    switch_at?: number
  }>
  /** Post a platform line in the room (chat-send.ts). Fixed server text only. */
  postLine(room: string, text: string): Promise<void>
  /**
   * #2854 — may this writer of the notes post a top-level message in the room under the normal
   * rules (active account, canSeeRoom, announce channels)? null = yes, else the plain reason.
   */
  noteWriterRefusal(room: string, writer: { id: string; name: string }): Promise<string | null>
  /**
   * #2854 — post the notes AS A PERSON (their last editor), through postChatMessage's normal
   * visibility and posting rules. Resolves null when posted, or the plain reason it was not.
   */
  postNote(room: string, authorId: string, text: string): Promise<string | null>
  warn(obj: Record<string, unknown>, msg: string): void
  /** #2849 — per-session tallies written to the admin analytics when a huddle ends. */
  sessions?: HuddleSessionRecorder
  /** #2851 — tell everyone watching for live huddles that the set of rooms or counts changed. */
  livePoke?(io: Pick<Server, 'to'>, room: string): void
  /** #2859: tell the SFU to drop one participant (`identity`) or, with null, close the whole
   *  LiveKit room of that huddle session. Rejections are the caller's to log, never to rethrow. */
  sfuEvict?(args: {
    tenant: string | null
    room: string
    session: string
    identity: string | null
  }): Promise<void>
  /**
   * #2843 — the other members of a direct conversation (a `dm:` room or a
   * group DM channel), rung when its huddle starts; null for any other room.
   */
  directMembers?(room: string): Promise<string[] | null>
  /** #2843/#2844 — ringing; absent = huddles never ring (tests, hosts without io). */
  ring?: RingDeps
}

export function defaultHuddleDeps(app: FastifyInstance): HuddleDeps {
  return {
    redis: app.redis as unknown as HuddleRedis,
    canSeeRoom: (user, room) => canSeeRoomReal(user, room),
    settings: async () => {
      const s = await getHuddleSettings()
      return { ...s, sfu: sfuConfigured(s) }
    },
    async postLine(room, text) {
      const { postChatMessage } = await import('./chat-send.js')
      await postChatMessage(
        app,
        { user: null, senderId: null, senderName: 'Nivaro', system: true, skipVisibility: true },
        { room, message: text }
      )
    },
    warn: (obj, msg) => app.log.warn(obj, msg),
    sessions: defaultSessionRecorder(app.redis as unknown as SessionRedis),
    livePoke: pokeHuddleLive,
    async sfuEvict({ tenant, room, session, identity }) {
      const s = await getHuddleSettings()
      if (!sfuConfigured(s)) return
      const server = {
        livekit_url: s.livekit_url as string,
        livekit_api_key: s.livekit_api_key as string,
        livekit_api_secret: s.livekit_api_secret as string
      }
      const name = sfuRoomName(tenant, room, session)
      if (identity) await sfuRemoveParticipant(server, name, identity)
      else await sfuDeleteRoom(server, name)
    },
    async noteWriterRefusal(room, writer) {
      const { getUser } = await import('./users.js')
      const u = await getUser(writer.id).catch(() => undefined)
      if (u?.status !== 'active') return `${writer.name} can no longer post here`
      const { chatPostRefusal } = await import('./chat-send.js')
      const { isAdminRole } = await import('./permissions.js')
      const refused = await chatPostRefusal(u, room, await isAdminRole(u).catch(() => false))
      if (!refused) return null
      return refused.code === 'ANNOUNCE_ONLY'
        ? `${writer.name} cannot post in this announcement channel`
        : `${writer.name} cannot post in this room`
    },
    async postNote(room, authorId, text) {
      const { getUser } = await import('./users.js')
      const author = await getUser(authorId).catch(() => undefined)
      if (author?.status !== 'active') return 'their writer can no longer post here'
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
    }
  }
}

/** The members of a direct conversation, or null when the room is not one. */
export async function directMembersOf(room: string): Promise<string[] | null> {
  const parsed = parseRoom(room)
  if (parsed.kind === 'dm') return parsed.participants ?? []
  if (parsed.kind !== 'channel') return null
  const { channels } = await import('./chat.js')
  const ch = (await channels()).get(parsed.channelKey ?? '')
  if (!ch?.is_direct) return null
  const { db } = await import('../db/index.js')
  const ids = (await db('nivaro_chat_memberships').where({ room }).pluck('user')) as string[]
  return ids.map((u) => String(u).toUpperCase())
}

/** The deps with ringing wired in (socketio.ts); defaultHuddleDeps alone never rings. */
export function fullHuddleDeps(app: FastifyInstance): HuddleDeps {
  const base = defaultHuddleDeps(app)
  return {
    ...base,
    directMembers: directMembersOf,
    ring: defaultRingDeps(app, base)
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

  /** The newest quality write, so a leave right behind it tallies the report first. */
  let qualityWrite: Promise<unknown> = Promise.resolve()

  /** Session tallies are best-effort: a Redis hiccup never breaks the call. */
  async function record(fn: () => Promise<unknown> | undefined, room: string): Promise<void> {
    try {
      await fn()
    } catch (err) {
      deps.warn({ err, room }, 'huddle session tally failed')
    }
  }

  /** Drop people from the SFU: one identity, or (identity null) the session's whole room. */
  async function evict(room: string, session: string | null, identity: string | null) {
    if (!session || !deps.sfuEvict) return
    const tenant = scope.tenantNow()
    try {
      await deps.sfuEvict({ tenant, room, session, identity })
    } catch (err) {
      deps.warn({ err, room, identity }, 'huddle: SFU eviction failed')
    }
  }

  // Every roster read on this process now evicts the stale browsers it prunes (#2859).
  setHuddleStaleEvictor(staleEvictorFor(deps))
  const peersOf = (room: string) => huddlePeers(deps.redis, scope.tenantNow(), room)

  /**
   * Nobody left: close the SFU room, forget the keys, record the session, post the notes as a
   * person (#2854) and say how long it ran. The start key is the claim: a second caller finds
   * it gone and returns.
   */
  async function endHuddle(room: string) {
    const tenant = scope.tenantNow()
    const k = keys(tenant, room)
    const start = await deps.redis.get(k.start)
    if (start == null) return
    // #2854 — a last note edit on this socket lands before the notes are read.
    await settleCollabWrites(socket)
    const [mode, session, end] = await Promise.all([
      huddleMode(deps.redis, tenant, room),
      huddleSession(deps.redis, tenant, room),
      readHuddleEnd(deps.redis, tenant, room)
    ])
    await deps.redis.del(k.start, k.meta, k.set, k.mode, k.session)
    if (mode === 'sfu') await evict(room, session, null)
    const ms = Date.now() - Number(start)
    await record(() => deps.sessions?.end(tenant, room), room)
    const duration = formatHuddleDuration(ms)
    // The notes are people's words: they post as a person (never the system line), and
    // only when EVERY writer may post here — nobody's words go out under another's rights.
    // Refused = not posted, frozen for the attendees instead.
    let unposted: string | null = null
    const writers = end.writers.length
      ? end.writers
      : end.noteBy
        ? [{ id: end.noteBy, name: 'Someone' }]
        : []
    if (end.note) {
      if (!writers.length) unposted = 'nobody from the huddle could post them'
      for (const w of writers) {
        if (unposted) break
        unposted = await deps.noteWriterRefusal(room, w)
      }
      const author = end.noteBy ?? writers.at(-1)?.id
      if (!unposted && author) {
        const names = writers.map((w) => w.name)
        unposted = await deps.postNote(room, author, huddleNotesMessage(duration, names, end.note))
      }
    }
    await finishHuddleEnd(
      deps.redis,
      tenant,
      room,
      unposted && end.note
        ? { text: end.note, attendees: end.attendees, writers: writers.map((w) => w.id) }
        : null,
      KEY_TTL_S
    )
    const line = huddleEndLine(duration, end.names)
    // Finding 1 — join/leave churn: a restart that ended again at once, or a room past its
    // line budget, gets no "ended" line (unposted notes always say so).
    const quiet = await noteHuddleEnded(deps.redis, tenant, room, Number(start)).catch(() => false)
    if (unposted) await deps.postLine(room, `${line} · notes were not posted: ${unposted}`)
    else if (!quiet && (await roomLineAllowed(deps.redis, tenant, room).catch(() => true))) {
      await deps.postLine(room, line)
    }
    if (unposted) socket.emit('huddle:note:unposted', { room, reason: unposted })
  }

  async function broadcast(room: string) {
    const tenant = scope.tenantNow()
    const peers = await peersOf(room)
    if (peers.length === 0) await endHuddle(room)
    const mode = peers.length ? await huddleMode(deps.redis, tenant, room) : 'mesh'
    const payload = { room, peers, mode }
    const chat = scope.scopedRoomNow(`chat:${room}`)
    if (chat) io.to(chat).emit('huddle:peers', payload)
    // People in the huddle with the room closed still need the list.
    const h = scope.scopedRoomNow(`huddle:${room}`)
    if (h) io.to(h).emit('huddle:peers', payload)
    const watchers = scope.scopedRoomNow(LIVE_ROOM)
    if (watchers) deps.livePoke?.(io, watchers)
    return peers
  }

  async function join(payload: { room?: unknown }): Promise<void> {
    const room = payload?.room
    const user = getUser()
    if (!user) return deny(room, 'not-signed-in')
    const kind = huddleRoomKind(room as string)
    if (kind !== 'ok') return deny(room, 'bad-room')
    const r = room as string
    try {
      const settings = await deps.settings()
      if (!settings.enabled) return deny(r, 'off')
      if (!(await deps.canSeeRoom(user, r))) return deny(r, 'no-access')
      const tenant = scope.tenantNow()
      const peers = await peersOf(r)
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
      await touch(deps.redis, tenant, r, socket.id, user.id)
      await recordAttendee(deps.redis, tenant, r, user.id, nameOf(user))
      setData({ room: r })
      const name = await scope.scopedRoom(`huddle:${r}`)
      if (name) socket.join(name)
      const first = peers.length === 0
      // Finding 1 — the same huddle restarting within seconds keeps its start, posts no
      // "started" line and rings nobody again.
      const resumed = first
        ? await resumeRecentHuddle(deps.redis, tenant, r, since).catch(() => null)
        : null
      if (first) {
        // A fresh session: a new id (so a new LiveKit room), no leftover mode. Whatever the
        // previous session's SFU room still holds is closed first.
        const stale = await huddleSession(deps.redis, tenant, r)
        if (stale && (await huddleMode(deps.redis, tenant, r)) === 'sfu') {
          await evict(r, stale, null)
        }
        await deps.redis.del(k.mode)
        await deps.redis.set(k.session, randomBytes(12).toString('base64url'), 'EX', KEY_TTL_S)
        await deps.redis.set(k.start, String(resumed?.start ?? since), 'EX', KEY_TTL_S)
      }
      // #2859: one more person than the mesh comfortably carries → everyone moves to the SFU.
      const before = first ? 'mesh' : await huddleMode(deps.redis, tenant, r)
      const count = peers.length + (already ? 0 : 1)
      const mode = decideHuddleMode(before, count, {
        sfu: !!settings.sfu,
        switch_at: settings.switch_at ?? Number.POSITIVE_INFINITY
      })
      if (mode !== before) await deps.redis.set(k.mode, mode, 'EX', KEY_TTL_S)
      socket.emit('huddle:joined', {
        room: r,
        self: socket.id,
        peers: peers.filter((p) => p.socket !== socket.id),
        mode
      })
      if (mode !== before) {
        const h = scope.scopedRoomNow(`huddle:${r}`)
        if (h) io.to(h).emit('huddle:mode', { room: r, mode })
      }
      await broadcast(r)
      await record(
        () => deps.sessions?.joined(tenant, r, String(user.id), peers.length + (already ? 0 : 1)),
        r
      )
      if (first && !resumed && (await roomLineAllowed(deps.redis, tenant, r).catch(() => true))) {
        await deps.postLine(r, `${nameOf(user) ?? 'Someone'} started a huddle`)
      }
      // #2843 — the first person in a direct conversation's huddle calls the others.
      if (first && !resumed && deps.ring && deps.directMembers) {
        const members = await deps.directMembers(r).catch(() => null)
        if (members?.length) {
          await ringUsers(deps.ring, { tenant, room: r, from: user, users: members })
        }
      }
    } catch (err) {
      deps.warn({ err, room: r }, 'huddle:join failed')
      deny(r, 'unavailable')
    }
  }

  async function leave(room: string) {
    await qualityWrite
    const tenant = scope.tenantNow()
    const k = keys(tenant, room)
    try {
      // #2859: on the SFU, the server drops the connection too — a token outlives nothing.
      const user = getUser()
      if ((await huddleMode(deps.redis, tenant, room)) === 'sfu') {
        const raw = await deps.redis.hget(k.meta, socket.id)
        const owner = raw ? String((JSON.parse(raw) as { user?: unknown }).user ?? '') : ''
        const id = owner || (user ? String(user.id) : '')
        if (id) {
          const session = await huddleSession(deps.redis, tenant, room)
          await evict(room, session, sfuIdentity(id, socket.id))
        }
      }
      await deps.redis.zrem(k.set, socket.id)
      await deps.redis.hdel(k.meta, socket.id)
      if (user) {
        await unmarkHuddling(deps.redis, tenant, user.id, room).catch(() => undefined)
        // Leaving while people are still ringing hangs up on them.
        if (deps.ring) await cancelRing(deps.ring, { tenant, room, by: user }).catch(() => false)
      }
      if (data()?.room === room) setData(undefined)
      const name = scope.scopedRoomNow(`huddle:${room}`)
      if (name) socket.leave(name)
      // #2855 — the presenter leaving ends Follow me (before the roster read that may end it all).
      await collabLeft(io, scope, deps.redis, tenant, room, socket.id)
      // The broadcast's roster read ends the huddle when nobody is left.
      await broadcast(room)
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
        const peers = await peersOf(room)
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
      async (payload: {
        room?: unknown
        muted?: unknown
        screen?: unknown
        hand?: unknown
        camera?: unknown
      }) => {
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
            screen: typeof payload.screen === 'boolean' ? payload.screen : !!prev.screen,
            ...stagePatch(payload, prev)
          }
          await deps.redis.hset(k.meta, socket.id, JSON.stringify(next))
          await touch(deps.redis, tenant, room, socket.id, user.id)
          if (next.screen) await record(() => deps.sessions?.screenShared(tenant, room), room)
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
        await touch(deps.redis, scope.tenantNow(), room, socket.id, user.id)
      } catch {
        /* the next ping tries again */
      }
    })
  )

  // #2849 — a leaving browser reports how its calls went (clamped; counts only, no media).
  // Acked so the client can send it just before huddle:leave and be sure it landed first.
  socket.on(
    'huddle:quality',
    inSocketTenant(
      socket,
      async (payload: { room?: unknown } & Record<string, unknown>, ack?: (r: unknown) => void) => {
        const done = (): void => {
          if (typeof ack === 'function') ack({ ok: true })
        }
        const room = payload?.room
        const q = clampQuality(payload)
        if (typeof room !== 'string' || data()?.room !== room || !q || !getUser()) {
          done()
          return
        }
        qualityWrite = record(() => deps.sessions?.quality(scope.tenantNow(), room, q), room)
        await qualityWrite
        done()
      }
    )
  )

  // #2851 — live huddle badges (watch/poke/snapshot live in huddle-live.ts).
  registerHuddleLive(socket, getUser, scope, {
    peers: (room) => huddlePeers(deps.redis, scope.tenantNow(), room),
    sessions: deps.sessions,
    canSeeRoom: deps.canSeeRoom,
    warn: deps.warn
  })

  // ── Calls (#2843 invite #2844) — the ring state machine lives in huddle-ring.ts ──
  socket.on(
    'huddle:invite',
    inSocketTenant(socket, async (payload: { room?: unknown; users?: unknown }) => {
      const room = payload?.room
      const user = getUser()
      if (!user || !deps.ring || typeof room !== 'string' || data()?.room !== room) return
      const users = ringTargets(user.id, payload?.users)
      if (!users.length) return
      try {
        if (!(await stillAllowed(user, room))) return
        await ringUsers(deps.ring, { tenant: scope.tenantNow(), room, from: user, users })
      } catch (err) {
        deps.warn({ err, room }, 'huddle:invite failed')
      }
    })
  )

  socket.on(
    'huddle:ring-answer',
    inSocketTenant(socket, async (payload: { room?: unknown; accept?: unknown }) => {
      const room = payload?.room
      const user = getUser()
      if (!user || !deps.ring || typeof room !== 'string' || huddleRoomKind(room) !== 'ok') return
      try {
        await answerRing(deps.ring, {
          tenant: scope.tenantNow(),
          room,
          user,
          accept: payload?.accept === true
        })
      } catch (err) {
        deps.warn({ err, room }, 'huddle:ring-answer failed')
      }
    })
  )

  socket.on(
    'huddle:ring-cancel',
    inSocketTenant(socket, async (payload: { room?: unknown }) => {
      const room = payload?.room
      const user = getUser()
      if (!user || !deps.ring || typeof room !== 'string') return
      try {
        await cancelRing(deps.ring, { tenant: scope.tenantNow(), room, by: user })
      } catch (err) {
        deps.warn({ err, room }, 'huddle:ring-cancel failed')
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

  // #2857 — reactions + lower all hands (huddle-stage.ts).
  registerHuddleStage(io, socket, getUser, {
    room: () => data()?.room,
    stillAllowed,
    broadcast,
    scopedRoomNow: (r) => scope.scopedRoomNow(r),
    metaKey: (r) => keys(scope.tenantNow(), r).meta,
    redis: deps.redis,
    warn: deps.warn
  })
}
