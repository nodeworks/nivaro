import type { FastifyInstance } from 'fastify'
import type { Server } from 'socket.io'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { canSeeRoom } from './chat.js'
import { type HuddleRedis, huddlePeers, huddleRoomKind } from './huddle.js'
import { defaultRingDeps, ringUsers } from './huddle-ring.js'
import { getIo } from './io-holder.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Scheduled huddles (#2860). Making one posts a card message in the room
 * (the organizer's message, carrying `[huddle:<id>]` — the panel renders the
 * card from the row, so the time, the invitees and Join are always current).
 * Five minutes before the start every invitee and the organizer get a
 * reminder through the notify path; at the start the invitees are rung the
 * way a direct call rings them (huddle-ring.ts).
 *
 * Two deliverers, one claim (the chat-scheduled pattern): the per-minute
 * sweep on the deployed instance, and a timer the request arms in its own
 * process for anything within six hours (dev laptops never tick crons). The
 * conditional update of reminded_at / rang_at is the claim.
 */

export const TABLE = 'nivaro_chat_huddle_schedules'
export const REMINDER_MS = 5 * 60_000
const TIMER_HORIZON_MS = 6 * 60 * 60_000
export const DURATION_MIN = 5
export const DURATION_MAX = 480
const INVITEES_MAX = 50

export interface HuddleScheduleRow {
  id: number
  room: string
  title: string
  starts_at: Date | string
  duration_min: number
  created_by: string
  invitees: string | null
  message_id: number | null
  status: 'scheduled' | 'cancelled' | 'done'
  reminded_at: Date | string | null
  rang_at: Date | string | null
  created_at: Date | string
}

export interface HuddleScheduleCard {
  id: number
  room: string
  title: string
  starts_at: string
  ends_at: string
  duration_min: number
  status: 'scheduled' | 'cancelled' | 'done'
  organizer: { id: string; name: string | null }
  invitees: Array<{ id: string; name: string | null }>
  /** Someone is in the room's huddle right now. */
  live: boolean
  /** The viewer may cancel it (organizer or an administrator). */
  can_cancel: boolean
}

/** The message text of the card line — the marker is what the panel renders the card from. */
export function scheduleMarker(id: number): string {
  return `[huddle:${id}]`
}

export interface ScheduleInput {
  room: string
  title: string
  starts_at: string
  duration_min: number
  invitees: string[]
}

/** Pure: validate and normalise a request body. */
export function parseScheduleInput(
  body: unknown,
  now = Date.now()
): { ok: true; value: ScheduleInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const room = String(b.room ?? '').trim()
  if (huddleRoomKind(room) !== 'ok') return { ok: false, error: 'room is required' }
  const title = String(b.title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  if (!title) return { ok: false, error: 'Give the huddle a title' }
  const starts = new Date(String(b.starts_at ?? ''))
  if (Number.isNaN(starts.getTime())) return { ok: false, error: 'starts_at must be a timestamp' }
  if (starts.getTime() < now + 60_000)
    return { ok: false, error: 'Pick a time at least a minute from now' }
  if (starts.getTime() > now + 90 * 86_400_000)
    return { ok: false, error: 'Schedule within the next 90 days' }
  const duration = Number(b.duration_min ?? 30)
  if (!Number.isInteger(duration) || duration < DURATION_MIN || duration > DURATION_MAX)
    return { ok: false, error: `duration_min must be ${DURATION_MIN}–${DURATION_MAX}` }
  const raw = Array.isArray(b.invitees) ? b.invitees : []
  const invitees: string[] = []
  for (const u of raw) {
    if (typeof u !== 'string' || !/^[0-9a-f-]{36}$/i.test(u)) continue
    const id = u.toUpperCase()
    if (!invitees.includes(id)) invitees.push(id)
    if (invitees.length >= INVITEES_MAX) break
  }
  return {
    ok: true,
    value: { room, title, starts_at: starts.toISOString(), duration_min: duration, invitees }
  }
}

/** Pure: what a row needs right now — the reminder, the start ring, or nothing. */
export function dueAction(
  row: Pick<HuddleScheduleRow, 'status' | 'starts_at' | 'reminded_at' | 'rang_at'>,
  now = Date.now()
): 'remind' | 'ring' | null {
  if (row.status !== 'scheduled') return null
  const start = new Date(row.starts_at).getTime()
  if (!row.rang_at && start <= now) return 'ring'
  if (!row.reminded_at && start - REMINDER_MS <= now && start > now) return 'remind'
  return null
}

let tableKnown: { at: number; has: boolean } | null = null
export async function hasSchedulesTable(): Promise<boolean> {
  if (tableKnown && Date.now() - tableKnown.at < 60_000) return tableKnown.has
  const has = await db.schema.hasTable(TABLE).catch(() => false)
  tableKnown = { at: Date.now(), has }
  return has
}

function parseInvitees(raw: unknown): string[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? v.map((x) => String(x).toUpperCase()) : []
  } catch {
    return []
  }
}

function nameOf(u: Partial<User> | undefined): string | null {
  if (!u) return null
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null
}

async function usersById(ids: string[]): Promise<Map<string, User>> {
  if (!ids.length) return new Map()
  const rows = (await db('nivaro_users').whereIn('id', ids.slice(0, 200))) as User[]
  const out = new Map<string, User>()
  for (const r of rows) out.set(String(r.id).toUpperCase(), r)
  return out
}

/** Make a schedule as `user`; invitees who cannot see the room are dropped. */
export async function createHuddleSchedule(
  app: FastifyInstance,
  user: User,
  input: ScheduleInput
): Promise<HuddleScheduleCard> {
  const people = await usersById(input.invitees)
  const invitees: string[] = []
  for (const id of input.invitees) {
    const u = people.get(id)
    if (!u || u.status !== 'active' || id === String(user.id).toUpperCase()) continue
    if (await canSeeRoom(u, input.room).catch(() => false)) invitees.push(id)
  }
  const [ins] = await db(TABLE)
    .insert({
      room: input.room,
      title: input.title,
      starts_at: new Date(input.starts_at),
      duration_min: input.duration_min,
      created_by: user.id,
      invitees: JSON.stringify(invitees),
      status: 'scheduled',
      created_at: new Date()
    })
    .returning('id')
  const id = Number(typeof ins === 'object' && ins !== null ? (ins as { id: number }).id : ins)
  // The card line, as the organizer, through the one send path.
  try {
    const { postChatMessage } = await import('./chat-send.js')
    const msg = await postChatMessage(
      app,
      { user },
      {
        room: input.room,
        message: `Scheduled a huddle ${scheduleMarker(id)}`,
        clientId: `huddle-${id}`
      }
    )
    await db(TABLE).where({ id }).update({ message_id: msg.id })
  } catch (err) {
    app.log.warn({ err, id }, 'huddle schedule: card message failed')
  }
  const when = new Date(input.starts_at)
  void Promise.all(
    invitees.map((uid) =>
      notify(app, uid, {
        subject: `Huddle scheduled: ${input.title}`,
        message: `${nameOf(user) ?? 'Someone'} invited you — ${when.toUTCString()}.`,
        room: input.room,
        sender: user.id
      })
    )
  ).catch(() => undefined)
  armHuddleTimers(app, id, when)
  return (await scheduleCard(app, id, user, false)) as HuddleScheduleCard
}

async function notify(
  app: FastifyInstance,
  userId: string,
  n: { subject: string; message: string; room: string; sender: string | null }
): Promise<void> {
  const { notifyUser } = await import('./notification-channels.js')
  await notifyUser(app, userId, {
    subject: n.subject,
    message: n.message,
    category: 'huddle',
    sender: n.sender,
    collection: '__chat__',
    item: n.room,
    target: { kind: 'chat', room: n.room, action: 'open' },
    source: { kind: 'huddle', label: 'Scheduled huddle' }
  })
}

export async function getScheduleRow(id: number): Promise<HuddleScheduleRow | null> {
  if (!(await hasSchedulesTable())) return null
  const row = (await db(TABLE).where({ id }).first()) as HuddleScheduleRow | undefined
  return row ?? null
}

/** The card for a viewer who can see the row's room (the caller checks that). */
export async function scheduleCard(
  app: FastifyInstance,
  id: number,
  viewer: User,
  isAdmin: boolean
): Promise<HuddleScheduleCard | null> {
  const row = await getScheduleRow(id)
  if (!row) return null
  const inviteeIds = parseInvitees(row.invitees)
  const people = await usersById([String(row.created_by).toUpperCase(), ...inviteeIds])
  const starts = new Date(row.starts_at)
  let live = false
  try {
    const peers = await huddlePeers(
      app.redis as unknown as HuddleRedis,
      currentTenantKey() || null,
      row.room
    )
    live = peers.length > 0
  } catch {
    live = false
  }
  return {
    id: row.id,
    room: row.room,
    title: row.title,
    starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + row.duration_min * 60_000).toISOString(),
    duration_min: row.duration_min,
    status: row.status,
    organizer: {
      id: String(row.created_by),
      name: nameOf(people.get(String(row.created_by).toUpperCase()))
    },
    invitees: inviteeIds.map((uid) => ({ id: uid, name: nameOf(people.get(uid)) })),
    live,
    can_cancel:
      row.status === 'scheduled' &&
      (isAdmin || String(row.created_by).toUpperCase() === String(viewer.id).toUpperCase())
  }
}

/** Upcoming (and just-started) huddles of a room, soonest first. */
export async function roomSchedules(room: string): Promise<HuddleScheduleRow[]> {
  if (!(await hasSchedulesTable())) return []
  return (await db(TABLE)
    .where({ room, status: 'scheduled' })
    .where('starts_at', '>=', new Date(Date.now() - 4 * 60 * 60_000))
    .orderBy('starts_at')
    .limit(20)) as HuddleScheduleRow[]
}

export async function cancelHuddleSchedule(
  app: FastifyInstance,
  id: number,
  by: User,
  isAdmin: boolean
): Promise<boolean> {
  const row = await getScheduleRow(id)
  if (!row || row.status !== 'scheduled') return false
  if (!isAdmin && String(row.created_by).toUpperCase() !== String(by.id).toUpperCase()) return false
  const n = Number(
    await db(TABLE).where({ id, status: 'scheduled' }).update({ status: 'cancelled' })
  )
  if (!n) return false
  try {
    const { postChatMessage } = await import('./chat-send.js')
    await postChatMessage(
      app,
      { user: null, senderId: null, senderName: 'Nivaro', system: true, skipVisibility: true },
      { room: row.room, message: `${nameOf(by) ?? 'Someone'} cancelled the huddle "${row.title}"` }
    )
  } catch (err) {
    app.log.warn({ err, id }, 'huddle schedule: cancel line failed')
  }
  return true
}

// ── Delivery ────────────────────────────────────────────────────────────────

const armed = new Set<string>()

/** In-process timers for the reminder and the start (within the horizon). */
export function armHuddleTimers(app: FastifyInstance, id: number, startsAt: Date): void {
  for (const [kind, at] of [
    ['remind', startsAt.getTime() - REMINDER_MS],
    ['ring', startsAt.getTime()]
  ] as const) {
    const wait = at - Date.now()
    if (wait > TIMER_HORIZON_MS) continue
    const key = `${id}:${kind}`
    if (armed.has(key)) continue
    armed.add(key)
    const t = setTimeout(() => {
      armed.delete(key)
      void deliverSchedule(app, id).catch(() => undefined)
    }, Math.max(0, wait) + 250)
    t.unref?.()
  }
}

/** The per-minute sweep: every row whose reminder or start is due. */
export async function runDueHuddleSchedules(app: FastifyInstance): Promise<number> {
  if (!(await hasSchedulesTable())) return 0
  const soon = new Date(Date.now() + REMINDER_MS)
  const rows = (await db(TABLE)
    .where({ status: 'scheduled' })
    .where('starts_at', '<=', soon)
    .orderBy('starts_at')
    .limit(100)) as HuddleScheduleRow[]
  let n = 0
  for (const row of rows) {
    if (dueAction(row) && (await deliverSchedule(app, row.id))) n++
  }
  return n
}

async function deliverSchedule(app: FastifyInstance, id: number): Promise<boolean> {
  const row = await getScheduleRow(id)
  if (!row) return false
  const action = dueAction(row)
  if (!action) return false
  const now = new Date()
  const inviteeIds = parseInvitees(row.invitees)
  const organizerId = String(row.created_by).toUpperCase()
  const people = await usersById([organizerId, ...inviteeIds])
  const organizer = people.get(organizerId)
  const starts = new Date(row.starts_at)
  if (action === 'remind') {
    const claimed = Number(
      await db(TABLE)
        .where({ id, status: 'scheduled' })
        .whereNull('reminded_at')
        .update({ reminded_at: now })
    )
    if (!claimed) return false
    const minutes = Math.max(1, Math.round((starts.getTime() - Date.now()) / 60_000))
    for (const uid of [organizerId, ...inviteeIds]) {
      const u = people.get(uid)
      if (!u || u.status !== 'active') continue
      if (!(await canSeeRoom(u, row.room).catch(() => false))) continue
      await notify(app, uid, {
        subject: `Huddle in ${minutes} min: ${row.title}`,
        message: 'Open the room and press Join when it starts.',
        room: row.room,
        sender: organizer?.id ?? null
      }).catch((err) => app.log.warn({ err, id }, 'huddle schedule: reminder failed'))
    }
    return true
  }
  const claimed = Number(
    await db(TABLE)
      .where({ id, status: 'scheduled' })
      .whereNull('rang_at')
      .update({ rang_at: now, status: 'done' })
  )
  if (!claimed) return false
  // Already in progress (someone pressed Join early)? Nobody rings a huddle that is on.
  const io = getIo()
  if (organizer && io && inviteeIds.length) {
    const deps = defaultRingDeps(app, {
      canSeeRoom,
      async postLine(room, text) {
        const { postChatMessage } = await import('./chat-send.js')
        await postChatMessage(
          app,
          { user: null, senderId: null, senderName: 'Nivaro', system: true, skipVisibility: true },
          { room, message: text }
        )
      },
      warn: (obj, msg) => app.log.warn(obj, msg)
    })
    deps.io = io as unknown as Pick<Server, 'to'>
    await ringUsers(deps, {
      tenant: currentTenantKey() || null,
      room: row.room,
      from: organizer,
      users: inviteeIds,
      scheduled: row.id
    }).catch((err) => app.log.warn({ err, id }, 'huddle schedule: ring failed'))
  }
  if (organizer && organizer.status === 'active') {
    await notify(app, organizerId, {
      subject: `Your huddle is starting: ${row.title}`,
      message: 'Open the room and press Join.',
      room: row.room,
      sender: null
    }).catch(() => undefined)
  }
  return true
}
