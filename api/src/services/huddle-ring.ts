import type { FastifyInstance } from 'fastify'
import type { Server } from 'socket.io'
import type { User } from '../types.js'
import type { HuddleRedis } from './huddle.js'

/**
 * Ringing (#2843, #2844): starting a huddle in a direct message, or adding
 * someone to a running one, "calls" them. Each callee gets a socket event in
 * their own user room (every tab, every replica) AND a notification through
 * the one notify path — category `huddle`, push included — so a closed tab
 * still learns of it. The call's state lives in Redis for RING_TIMEOUT_MS so
 * an answer handled on another replica is seen by the timer on this one.
 *
 * Events: server → callee `huddle:ring {room, from, name, at, scheduled?}` and
 * `huddle:ring-cancel {room, reason}`; server → caller `huddle:ringing
 * {room, users}` and `huddle:ring-result {room, user, name, accept, reason?}`.
 * Callee → server `huddle:ring-answer {room, accept}`; caller → server
 * `huddle:ring-cancel {room}`, `huddle:invite {room, users}`.
 *
 * Lines ("Amy declined the call", "No answer from Amy") go through
 * chat-send.ts like every other platform line. Payloads carry ids and names
 * only — never message text.
 */

export const RING_TIMEOUT_MS = 30_000
const RING_KEY_TTL_S = 90
/** One invite rings at most this many people. */
export const RING_MAX = 20

export type RingState = 'ringing' | 'accepted' | 'declined' | 'timeout'

export interface RingDeps {
  io: Pick<Server, 'to'>
  redis: HuddleRedis
  canSeeRoom(user: User, room: string): Promise<boolean>
  postLine(room: string, text: string): Promise<void>
  /** The user rows behind ids, keyed by UPPERCASED id (missing ids are not rung). */
  users(ids: string[]): Promise<Map<string, User>>
  /** The notify path (notification-channels.ts notifyUser) — in-app + push by the recipient's rules. */
  notify(userId: string, opts: RingNotice): Promise<void>
  warn(obj: Record<string, unknown>, msg: string): void
  timeoutMs?: number
}

export interface RingNotice {
  subject: string
  message: string
  room: string
  sender: string | null
}

export function ringKey(tenant: string | null, room: string): string {
  return `nvr:huddle:ring:${tenant || '-'}:${room}`
}

function nameOf(u: User): string | null {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null
}

/** Pure: the targets of a ring — never the caller, never twice, capped. */
export function ringTargets(from: string, users: unknown): string[] {
  if (!Array.isArray(users)) return []
  const out: string[] = []
  const me = String(from).toUpperCase()
  for (const u of users) {
    if (typeof u !== 'string' || !/^[0-9a-f-]{36}$/i.test(u)) continue
    const id = u.toUpperCase()
    if (id === me || out.includes(id)) continue
    out.push(id)
    if (out.length >= RING_MAX) break
  }
  return out
}

/** The timers of calls this process started, keyed like the Redis hash. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Ring `users` for `room` on behalf of `from`. People who cannot see the room
 * are skipped silently (the caller is never told who exists). Returns who was
 * actually rung.
 */
export async function ringUsers(
  deps: RingDeps,
  input: {
    tenant: string | null
    room: string
    from: User
    users: string[]
    /** A scheduled huddle starting (#2860): the card to open. */
    scheduled?: number | null
  }
): Promise<Array<{ id: string; name: string | null }>> {
  const targets = ringTargets(input.from.id, input.users)
  if (!targets.length) return []
  const rows = await deps.users(targets).catch(() => new Map<string, User>())
  const fromName = nameOf(input.from)
  const key = ringKey(input.tenant, input.room)
  const rung: Array<{ id: string; name: string | null }> = []
  const at = Date.now()
  for (const id of targets) {
    const callee = rows.get(id)
    // Only a real, active person who can see the room THEMSELVES is rung — an
    // invite never grants access, and a suspended account is never called.
    if (!callee || callee.status !== 'active') continue
    try {
      if (!(await deps.canSeeRoom(callee, input.room))) continue
    } catch {
      continue
    }
    const current = await deps.redis.hget(key, id).catch(() => null)
    // Already ringing (two invites in a row): one ring, one timer.
    if (current === 'ringing') continue
    await deps.redis.hset(key, id, 'ringing')
    rung.push({ id, name: nameOf(callee) })
    deps.io.to(`user:${id}`).emit('huddle:ring', {
      room: input.room,
      from: input.from.id,
      name: fromName,
      at,
      scheduled: input.scheduled ?? null
    })
    void deps
      .notify(id, {
        subject: `${fromName ?? 'Someone'} is calling you`,
        message: 'Join the huddle from the chat panel.',
        room: input.room,
        sender: input.from.id
      })
      .catch((err) => deps.warn({ err, room: input.room }, 'huddle ring notify failed'))
  }
  if (!rung.length) return rung
  await deps.redis.hset(key, '_from', JSON.stringify({ id: input.from.id, name: fromName, at }))
  await deps.redis.expire(key, RING_KEY_TTL_S)
  deps.io.to(`user:${input.from.id}`).emit('huddle:ringing', { room: input.room, users: rung })

  // The timer runs here; the answers may land on any replica, so it reads Redis.
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    timers.delete(key)
    void timeOut(deps, input.tenant, input.room).catch((err) =>
      deps.warn({ err, room: input.room }, 'huddle ring timeout failed')
    )
  }, deps.timeoutMs ?? RING_TIMEOUT_MS)
  t.unref?.()
  timers.set(key, t)
  return rung
}

async function callOf(
  deps: RingDeps,
  tenant: string | null,
  room: string
): Promise<{ from: { id: string; name: string | null }; callees: Map<string, RingState> } | null> {
  const all: Record<string, string> = await deps.redis
    .hgetall(ringKey(tenant, room))
    .catch(() => ({}) as Record<string, string>)
  const rawFrom = all._from
  if (!rawFrom) return null
  let from: { id: string; name: string | null }
  try {
    from = JSON.parse(rawFrom)
  } catch {
    return null
  }
  const callees = new Map<string, RingState>()
  for (const [k, v] of Object.entries(all)) if (k !== '_from') callees.set(k, v as RingState)
  return { from, callees }
}

/** Nobody left ringing: the call record goes. */
async function settleIfDone(deps: RingDeps, tenant: string | null, room: string) {
  const call = await callOf(deps, tenant, room)
  if (!call) return
  if ([...call.callees.values()].some((s) => s === 'ringing')) return
  const key = ringKey(tenant, room)
  const t = timers.get(key)
  if (t) clearTimeout(t)
  timers.delete(key)
  await deps.redis.del(key)
}

/** A callee answered: the caller hears it; a decline is a line in the room. */
export async function answerRing(
  deps: RingDeps,
  input: { tenant: string | null; room: string; user: User; accept: boolean }
): Promise<boolean> {
  const call = await callOf(deps, input.tenant, input.room)
  const id = String(input.user.id).toUpperCase()
  if (!call || call.callees.get(id) !== 'ringing') return false
  await deps.redis.hset(
    ringKey(input.tenant, input.room),
    id,
    input.accept ? 'accepted' : 'declined'
  )
  const name = nameOf(input.user)
  deps.io.to(`user:${call.from.id}`).emit('huddle:ring-result', {
    room: input.room,
    user: input.user.id,
    name,
    accept: input.accept
  })
  if (!input.accept) await deps.postLine(input.room, `${name ?? 'Someone'} declined the call`)
  await settleIfDone(deps, input.tenant, input.room)
  return true
}

/** The caller stopped ringing (cancel, or left the huddle): callees' toasts close, no line. */
export async function cancelRing(
  deps: RingDeps,
  input: { tenant: string | null; room: string; by: User }
): Promise<boolean> {
  const call = await callOf(deps, input.tenant, input.room)
  if (!call || String(call.from.id).toUpperCase() !== String(input.by.id).toUpperCase())
    return false
  const key = ringKey(input.tenant, input.room)
  const t = timers.get(key)
  if (t) clearTimeout(t)
  timers.delete(key)
  for (const [id, state] of call.callees) {
    if (state !== 'ringing') continue
    deps.io.to(`user:${id}`).emit('huddle:ring-cancel', { room: input.room, reason: 'cancelled' })
  }
  await deps.redis.del(key)
  return true
}

/** RING_TIMEOUT_MS passed: whoever never answered missed the call. */
export async function timeOut(deps: RingDeps, tenant: string | null, room: string): Promise<void> {
  const call = await callOf(deps, tenant, room)
  if (!call) return
  const missed = [...call.callees].filter(([, s]) => s === 'ringing').map(([id]) => id)
  if (missed.length) {
    const rows = await deps.users(missed).catch(() => new Map<string, User>())
    const names = new Map([...rows].map(([id, u]) => [id, nameOf(u)]))
    for (const id of missed) {
      deps.io.to(`user:${id}`).emit('huddle:ring-cancel', { room, reason: 'timeout' })
      deps.io.to(`user:${call.from.id}`).emit('huddle:ring-result', {
        room,
        user: id,
        name: names.get(id) ?? null,
        accept: false,
        reason: 'timeout'
      })
      await deps.postLine(room, `No answer from ${names.get(id) ?? 'someone'}`)
    }
  }
  await deps.redis.del(ringKey(tenant, room))
}

/** Tests: drop every pending timer. */
export function clearRingTimersForTests(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}

export function defaultRingDeps(
  app: FastifyInstance,
  base: Pick<RingDeps, 'canSeeRoom' | 'postLine' | 'warn'>
): RingDeps {
  return {
    ...base,
    io: app.io as unknown as Pick<Server, 'to'>,
    redis: app.redis as unknown as HuddleRedis,
    async users(ids) {
      const { db } = await import('../db/index.js')
      const rows = (await db('nivaro_users').whereIn('id', ids)) as User[]
      const out = new Map<string, User>()
      for (const r of rows) out.set(String(r.id).toUpperCase(), r)
      return out
    },
    async notify(userId, n) {
      const { notifyUser } = await import('./notification-channels.js')
      await notifyUser(app, userId, {
        subject: n.subject,
        message: n.message,
        category: 'huddle',
        sender: n.sender,
        collection: '__chat__',
        item: n.room,
        target: { kind: 'chat', room: n.room, action: 'open' },
        source: { kind: 'huddle', label: 'Huddle call' }
      })
    }
  }
}
