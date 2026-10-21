import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import { canSeeRoom as canSeeRoomReal, parseRoom } from './chat.js'
import type { HuddleRedis, HuddleScope } from './huddle.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * Working together in a huddle (#2854 #2855) — the parts that ride the
 * huddle's socket beside the WebRTC signalling in huddle.ts.
 *
 * Huddle notes (#2854): one shared, hand-written note per live huddle. Edits
 * arrive debounced from the browsers as `huddle:note {room, text, rev}`; the
 * last writer wins and the server hands out a rising rev so a browser can
 * tell a newer copy from an older one. The text lives in Redis next to the
 * presence set (`nvr:huddle:<tenant>:<room>:note`) with the huddle's TTL, so
 * a second replica serves the same note. When the last person leaves,
 * huddle.ts posts the note to the room as one system message (see
 * takeHuddleEnd / huddleNotesMessage).
 *
 * Follow me (#2855): in a record room's huddle one participant presents and
 * the others' record pages follow. The presenter sends where they are on the
 * record page (tab + section); the server names the record itself from the
 * room (read as the presenter), so a follower can only ever be sent to the
 * record the room is about. Followers navigate on their own, with their own
 * permissions — this is navigation, never data.
 *
 * Every event re-asks canSeeRoom and needs the sender to be IN that room's
 * huddle. Payloads carry ids, names, tab and section keys, and the note text
 * (only to the people in the huddle).
 *
 * Events (client → server): huddle:note {room, text, rev}, huddle:collab:sync {room},
 * huddle:follow {room, action: start|move|stop|request|handover|decline, step?, section?, to?}.
 * Server → client: huddle:note {room, text, rev, by, from}, huddle:note:denied {room, reason},
 * huddle:follow {room, action, presenter?, collection?, id?, step?, section?, from?},
 * huddle:follow:denied {room, reason, presenter?}.
 */

/** A note larger than this is refused (it is a note, not a document). */
export const NOTE_MAX_BYTES = 20 * 1024
/** Note writes per socket per second (the browser debounces at 500 ms). */
const NOTE_PER_SEC = 5
/** Follow moves per socket per second (#2855: throttled 4/s). */
export const FOLLOW_PER_SEC = 4
const KEY_MAX = 120
/** How long a room's record (as the presenter reads it) is reused. */
const RECORD_CACHE_MS = 60_000

export function collabKeys(tenant: string | null, room: string) {
  const base = `nvr:huddle:${tenant || '-'}:${room}`
  return {
    note: `${base}:note`,
    who: `${base}:who`,
    /** Everyone whose edit of the note was accepted (user id → name). */
    writers: `${base}:writers`,
    present: `${base}:present`,
    /** A finished huddle's unposted note, frozen apart from the live keys (huddle:note:fetch). */
    ended: `${base}:note:ended`
  }
}

/** Keep the collab keys alive exactly as long as the huddle's own keys (huddle.ts touch). */
export async function touchCollab(
  redis: HuddleRedis,
  tenant: string | null,
  room: string,
  ttlS: number
): Promise<void> {
  const k = collabKeys(tenant, room)
  await redis.expire(k.note, ttlS)
  await redis.expire(k.who, ttlS)
  await redis.expire(k.writers, ttlS)
  await redis.expire(k.present, ttlS)
  // Never k.ended: a finished huddle's note lapses on its own clock.
}

/** Everyone who was in the huddle at any point, for the end line (huddle.ts join). */
export async function recordAttendee(
  redis: HuddleRedis,
  tenant: string | null,
  room: string,
  user: string,
  name: string | null
): Promise<void> {
  await redis.hset(collabKeys(tenant, room).who, user, name || 'Someone')
}

export interface StoredNote {
  text: string
  rev: number
  by: string | null
  name: string | null
}

export function parseNote(raw: string | null): StoredNote | null {
  if (!raw) return null
  try {
    const n = JSON.parse(raw) as Partial<StoredNote>
    if (typeof n.text !== 'string') return null
    return { text: n.text, rev: Number(n.rev) || 0, by: n.by ?? null, name: n.name ?? null }
  } catch {
    return null
  }
}

/** What the end of a huddle reports: who came, the note and who wrote it last. */
export interface HuddleEnd {
  /** Everyone who was in the huddle at any point (names, for the end line). */
  names: string[]
  attendees: string[]
  note: string | null
  noteBy: string | null
  /** Everyone whose edit was accepted, in order of first edit. */
  writers: Array<{ id: string; name: string }>
}

export async function readHuddleEnd(
  redis: HuddleRedis,
  tenant: string | null,
  room: string
): Promise<HuddleEnd> {
  const k = collabKeys(tenant, room)
  const [who, raw, writers] = await Promise.all([
    redis.hgetall(k.who).catch(() => ({}) as Record<string, string>),
    redis.get(k.note).catch(() => null),
    redis.hgetall(k.writers).catch(() => ({}) as Record<string, string>)
  ])
  const names = [...new Set(Object.values(who ?? {}).filter(Boolean))]
  const parsed = parseNote(raw)
  return {
    names,
    attendees: Object.keys(who ?? {}),
    note: parsed?.text.trim() || null,
    noteBy: parsed?.by ?? null,
    writers: Object.entries(writers ?? {}).map(([id, name]) => ({ id, name: name || 'Someone' }))
  }
}

export interface EndedNote {
  text: string
  attendees: string[]
  writers: string[]
}

/**
 * Close the huddle's collab state. The live keys always go, so a new huddle in the room starts
 * empty; a note that could not be posted is frozen into its own key (with the attendees that
 * gate huddle:note:fetch) for `ttlS`, never extended by a later huddle.
 */
export async function finishHuddleEnd(
  redis: HuddleRedis,
  tenant: string | null,
  room: string,
  unposted: EndedNote | null,
  ttlS: number
): Promise<void> {
  const k = collabKeys(tenant, room)
  if (unposted) await redis.set(k.ended, JSON.stringify(unposted), 'EX', ttlS)
  await redis.del(k.who, k.note, k.writers, k.present)
}

export function parseEnded(raw: string | null): EndedNote | null {
  if (!raw) return null
  try {
    const e = JSON.parse(raw) as Partial<EndedNote>
    if (typeof e.text !== 'string' || !Array.isArray(e.attendees)) return null
    return {
      text: e.text,
      attendees: e.attendees.map(String),
      writers: (e.writers ?? []).map(String)
    }
  } catch {
    return null
  }
}

/** The plain reason a refused note post shows in the end line. */
export function notePostReason(err: unknown): string {
  const e = err as { statusCode?: number; code?: string; message?: string }
  if (e?.code === 'ANNOUNCE_ONLY') return 'only the channel owner and admins post here'
  if (e?.statusCode === 403) return 'the person who wrote them cannot post in this room'
  if (e?.statusCode && e.statusCode < 500 && e.message) {
    return e.message.replace(/\.\s*$/, '').replace(/^./, (c) => c.toLowerCase())
  }
  return 'the message could not be sent'
}

/** "Ana, Ben and Chris" — every name, the end line is the record of who came. */
export function attendeeList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The huddle's end line: "Huddle ended after 24 min · Ana, Ben and Chris". */
export function huddleEndLine(duration: string, names: string[]): string {
  const who = attendeeList(names)
  return who ? `Huddle ended after ${duration} · ${who}` : `Huddle ended after ${duration}`
}

/** The note as one message: "Huddle notes · 24 min · Ana, Ben, Chris" then the text. */
/** The note as one message: "Huddle notes · 24 min · written by Ana and Ben" then the text. */
export function huddleNotesMessage(duration: string, writers: string[], note: string): string {
  const by = attendeeList(writers)
  const head = ['Huddle notes', duration, by ? `written by ${by}` : ''].filter(Boolean).join(' · ')
  return `**${head}**\n\n${note}`
}

export interface FollowState {
  socket: string
  user: string
  name: string | null
  collection: string
  id: string
  step: string | null
  section: string | null
  since: number
}

export interface HuddleCollabDeps {
  redis: HuddleRedis
  canSeeRoom(user: User, room: string): Promise<boolean>
  /** The record a room is about, read as this person (null = none, or they cannot see it). */
  roomRecord(user: User, room: string): Promise<{ collection: string; id: string } | null>
  /** Socket ids in the room's huddle right now (huddle.ts huddlePeers). */
  peerSockets(tenant: string | null, room: string): Promise<string[]>
  warn(obj: Record<string, unknown>, msg: string): void
}

export function defaultHuddleCollabDeps(app: {
  redis: unknown
  log: { warn(obj: unknown, msg: string): void }
}): HuddleCollabDeps {
  const redis = app.redis as HuddleRedis
  return {
    redis,
    canSeeRoom: (user, room) => canSeeRoomReal(user, room),
    async roomRecord(user, room) {
      const { resolveRoomRecord } = await import('./chat-records.js')
      const rec = await resolveRoomRecord(user, room)
      return rec ? { collection: rec.collection, id: String(rec.id) } : null
    },
    async peerSockets(tenant, room) {
      const { huddlePeers } = await import('./huddle.js')
      return (await huddlePeers(redis, tenant, room)).map((p) => p.socket)
    },
    warn: (obj, msg) => app.log.warn(obj, msg)
  }
}

function nameOf(u: User): string | null {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null
}

/** A tab or section key from a browser: a short string, or nothing. */
export function cleanKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > KEY_MAX) return null
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return null
  return s
}

/** At most `limit` events per rolling second, per socket and kind. */
function rateGate(limit: number) {
  const hits: number[] = []
  return (now = Date.now()): boolean => {
    while (hits.length && now - hits[0] >= 1000) hits.shift()
    if (hits.length >= limit) return false
    hits.push(now)
    return true
  }
}

type SocketData = { huddle?: { room: string }; huddleCollabWrite?: Promise<unknown> }

/** huddle.ts leave(): wait for a note write this socket still has in flight before the end
 *  reads the note (a last edit and Leave arrive together). */
export async function settleCollabWrites(socket: { data: unknown }): Promise<void> {
  const p = (socket.data as SocketData).huddleCollabWrite
  if (p) await p.catch(() => undefined)
}

/** huddle.ts leave(): the presenter leaving ends Follow me for everyone. */
export async function collabLeft(
  io: Pick<Server, 'to'>,
  scope: HuddleScope,
  redis: HuddleRedis,
  tenant: string | null,
  room: string,
  socketId: string
): Promise<void> {
  const k = collabKeys(tenant, room)
  const cur = parseFollow(await redis.get(k.present))
  if (!cur || cur.socket !== socketId) return
  await redis.del(k.present)
  const h = scope.scopedRoomNow(`huddle:${room}`)
  if (h) io.to(h).emit('huddle:follow', { room, action: 'stop', presenter: presenterOf(cur) })
}

export function parseFollow(raw: string | null): FollowState | null {
  if (!raw) return null
  try {
    const f = JSON.parse(raw) as Partial<FollowState>
    if (!f.socket || !f.collection || f.id == null) return null
    return {
      socket: String(f.socket),
      user: String(f.user ?? ''),
      name: f.name ?? null,
      collection: String(f.collection),
      id: String(f.id),
      step: f.step ?? null,
      section: f.section ?? null,
      since: Number(f.since) || Date.now()
    }
  } catch {
    return null
  }
}

function presenterOf(f: FollowState) {
  return { socket: f.socket, user: f.user, name: f.name }
}

function followPayload(room: string, action: string, f: FollowState) {
  return {
    room,
    action,
    presenter: presenterOf(f),
    collection: f.collection,
    id: f.id,
    step: f.step,
    section: f.section
  }
}

/** Wire huddle:note, huddle:follow and huddle:collab:sync onto one connection. */
export function registerHuddleCollab(
  io: Pick<Server, 'to'>,
  socket: Socket,
  getUser: () => User | null,
  scope: HuddleScope,
  deps: HuddleCollabDeps,
  ttlS = 120
): void {
  const sd = () => socket.data as SocketData
  const inHuddle = (room: unknown): room is string =>
    typeof room === 'string' && !!room && sd().huddle?.room === room
  const noteGate = rateGate(NOTE_PER_SEC)
  const followGate = rateGate(FOLLOW_PER_SEC)
  const records = new Map<string, { at: number; rec: { collection: string; id: string } | null }>()

  async function allowed(user: User, room: string): Promise<boolean> {
    return deps.canSeeRoom(user, room).catch(() => false)
  }

  function toHuddle(room: string, event: string, payload: unknown) {
    const h = scope.scopedRoomNow(`huddle:${room}`)
    if (h) io.to(h).emit(event, payload)
  }

  // ── Huddle notes (#2854) ──────────────────────────────────────────────────
  async function writeNote(user: User, room: string, text: string, rev: unknown) {
    const tenant = scope.tenantNow()
    const k = collabKeys(tenant, room)
    const prev = parseNote(await deps.redis.get(k.note))
    const stored = prev?.rev ?? 0
    // The rev a browser sends is the copy it edited — never more than the server handed out. A
    // rev it could not have seen (huge, fractional, negative) is refused, never trusted.
    const base = typeof rev === 'number' ? rev : Number(rev)
    if (!Number.isSafeInteger(base) || base < 0 || base > stored) {
      socket.emit('huddle:note:denied', { room, reason: 'bad-rev', rev: stored })
      return
    }
    // Last writer wins (an edit of an older copy too); only the server moves the rev.
    const next: StoredNote = {
      text,
      rev: stored + 1,
      by: user.id,
      name: nameOf(user)
    }
    await deps.redis.set(k.note, JSON.stringify(next), 'EX', ttlS)
    // Every writer is checked before the end posts the note (#2854): words never go out under
    // someone else's posting rights.
    await deps.redis.hset(k.writers, user.id, next.name || 'Someone')
    await deps.redis.expire(k.writers, ttlS)
    toHuddle(room, 'huddle:note', {
      room,
      text: next.text,
      rev: next.rev,
      by: { id: user.id, name: next.name },
      from: socket.id
    })
  }

  socket.on(
    'huddle:note',
    inSocketTenant(socket, async (payload: { room?: unknown; text?: unknown; rev?: unknown }) => {
      const room = payload?.room
      const user = getUser()
      if (!user || !inHuddle(room) || typeof payload.text !== 'string') return
      if (Buffer.byteLength(payload.text, 'utf8') > NOTE_MAX_BYTES) {
        socket.emit('huddle:note:denied', { room, reason: 'too-long' })
        return
      }
      if (!noteGate()) {
        socket.emit('huddle:note:denied', { room, reason: 'rate' })
        return
      }
      const text = payload.text
      const work = (async () => {
        if (!(await allowed(user, room))) {
          socket.emit('huddle:note:denied', { room, reason: 'no-access' })
          return
        }
        await writeNote(user, room, text, payload.rev)
      })().catch((err) => deps.warn({ err, room }, 'huddle:note failed'))
      sd().huddleCollabWrite = work
      await work
    })
  )

  socket.on(
    'huddle:collab:sync',
    inSocketTenant(socket, async (payload: { room?: unknown }) => {
      const room = payload?.room
      const user = getUser()
      if (!user || !inHuddle(room)) return
      try {
        if (!(await allowed(user, room))) return
        const k = collabKeys(scope.tenantNow(), room)
        const [rawNote, rawFollow] = await Promise.all([
          deps.redis.get(k.note),
          deps.redis.get(k.present)
        ])
        const note = parseNote(rawNote)
        if (note) {
          socket.emit('huddle:note', {
            room,
            text: note.text,
            rev: note.rev,
            by: { id: note.by, name: note.name },
            from: null
          })
        }
        const follow = parseFollow(rawFollow)
        if (follow) socket.emit('huddle:follow', followPayload(room, 'state', follow))
      } catch (err) {
        deps.warn({ err, room }, 'huddle:collab:sync failed')
      }
    })
  )

  // A note the end could not post stays readable to the people who were in the huddle.
  socket.on(
    'huddle:note:fetch',
    inSocketTenant(socket, async (payload: { room?: unknown }) => {
      const room = payload?.room
      const user = getUser()
      if (!user || typeof room !== 'string' || !room) return
      try {
        if (!(await allowed(user, room))) return
        // Only the frozen note of a finished huddle, and only for the people who were in it.
        const ended = parseEnded(await deps.redis.get(collabKeys(scope.tenantNow(), room).ended))
        const me = String(user.id).toUpperCase()
        if (!ended || !ended.attendees.some((a) => a.toUpperCase() === me)) return
        socket.emit('huddle:note:kept', { room, text: ended.text })
      } catch (err) {
        deps.warn({ err, room }, 'huddle:note:fetch failed')
      }
    })
  )

  // ── Follow me (#2855) ─────────────────────────────────────────────────────
  async function recordFor(user: User, room: string) {
    const hit = records.get(room)
    if (hit && Date.now() - hit.at < RECORD_CACHE_MS) return hit.rec
    const rec = await deps.roomRecord(user, room).catch(() => null)
    records.set(room, { at: Date.now(), rec })
    return rec
  }

  const denyFollow = (room: string, reason: string, extra: Record<string, unknown> = {}): void => {
    socket.emit('huddle:follow:denied', { room, reason, ...extra })
  }

  socket.on(
    'huddle:follow',
    inSocketTenant(
      socket,
      async (payload: {
        room?: unknown
        action?: unknown
        step?: unknown
        section?: unknown
        to?: unknown
      }) => {
        const room = payload?.room
        const action = payload?.action
        const user = getUser()
        if (!user || !inHuddle(room) || typeof action !== 'string') return
        if (parseRoom(room).kind !== 'entity') return denyFollow(room, 'not-record')
        if (!followGate()) return denyFollow(room, 'rate')
        try {
          if (!(await allowed(user, room))) return denyFollow(room, 'no-access')
          const tenant = scope.tenantNow()
          const k = collabKeys(tenant, room)
          const cur = parseFollow(await deps.redis.get(k.present))
          const mine = cur?.socket === socket.id
          const live =
            cur && !mine ? (await deps.peerSockets(tenant, room)).includes(cur.socket) : false

          if (action === 'start' || action === 'move') {
            if (cur && !mine && live) {
              return denyFollow(room, 'busy', { presenter: presenterOf(cur) })
            }
            if (action === 'move' && !mine) return
            const rec = await recordFor(user, room)
            if (!rec) return denyFollow(room, 'no-record')
            const next: FollowState = {
              socket: socket.id,
              user: user.id,
              name: nameOf(user),
              collection: rec.collection,
              id: rec.id,
              step: cleanKey(payload.step),
              section: cleanKey(payload.section),
              since: mine && cur ? cur.since : Date.now()
            }
            await deps.redis.set(k.present, JSON.stringify(next), 'EX', ttlS)
            toHuddle(room, 'huddle:follow', followPayload(room, mine ? 'move' : 'start', next))
            return
          }

          if (action === 'stop') {
            if (!mine || !cur) return
            await deps.redis.del(k.present)
            toHuddle(room, 'huddle:follow', { room, action: 'stop', presenter: presenterOf(cur) })
            return
          }

          if (action === 'request') {
            // Taking over asks the current presenter; it never just happens.
            if (!cur || mine || !live) return
            io.to(cur.socket).emit('huddle:follow', {
              room,
              action: 'request',
              from: { socket: socket.id, user: user.id, name: nameOf(user) }
            })
            return
          }

          if (action === 'handover' || action === 'decline') {
            const to = typeof payload.to === 'string' ? payload.to : ''
            if (!mine || !cur || !to) return
            if (!(await deps.peerSockets(tenant, room)).includes(to)) return
            if (action === 'decline') {
              io.to(to).emit('huddle:follow', {
                room,
                action: 'declined',
                presenter: presenterOf(cur)
              })
              return
            }
            await deps.redis.del(k.present)
            toHuddle(room, 'huddle:follow', { room, action: 'stop', presenter: presenterOf(cur) })
            io.to(to).emit('huddle:follow', {
              room,
              action: 'granted',
              presenter: presenterOf(cur)
            })
          }
        } catch (err) {
          deps.warn({ err, room }, 'huddle:follow failed')
        }
      }
    )
  )
}
