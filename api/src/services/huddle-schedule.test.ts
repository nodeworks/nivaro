import { describe, expect, it, vi } from 'vitest'

/** A tiny knex stand-in: rows by table, every chain op recorded. */
const fake = vi.hoisted(() => {
  const ops: Array<{ table: string; op: string; arg?: unknown }> = []
  const rows: Record<string, Array<Record<string, unknown>>> = {}
  let nextId = 1
  const builder = (table: string) => {
    let filter: Record<string, unknown> = {}
    const b: Record<string, unknown> = {
      insert(v: Record<string, unknown>) {
        ops.push({ table, op: 'insert', arg: v })
        const row = { id: nextId++, ...v }
        if (!rows[table]) rows[table] = []
        rows[table].push(row)
        return { returning: async () => [{ id: row.id }] }
      },
      where(w: Record<string, unknown>) {
        filter = { ...filter, ...w }
        return b
      },
      whereIn: () => b,
      whereNull: () => b,
      orderBy: () => b,
      limit: () => b,
      select: () => b,
      async first() {
        return (rows[table] ?? []).find((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
      },
      async update(v: Record<string, unknown>) {
        ops.push({ table, op: 'update', arg: v })
        let n = 0
        for (const r of rows[table] ?? []) {
          if (Object.entries(filter).every(([k, val]) => r[k] === val)) {
            Object.assign(r, v)
            n++
          }
        }
        return n
      },
      async delete() {
        ops.push({ table, op: 'delete', arg: filter })
        rows[table] = (rows[table] ?? []).filter(
          (r) => !Object.entries(filter).every(([k, v]) => r[k] === v)
        )
        return 1
      },
      // biome-ignore lint/suspicious/noThenProperty: a knex builder IS awaitable
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
        return Promise.resolve(
          (rows[table] ?? []).filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
        ).then(res, rej)
      }
    }
    return b
  }
  const db = Object.assign(builder, { schema: { hasTable: async () => true } })
  return { db, ops, rows }
})
vi.mock('../db/index.js', () => ({ db: fake.db }))
const sendMock = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('./chat-send.js', () => {
  class ChatSendError extends Error {
    statusCode: number
    code: string
    constructor(statusCode: number, message: string, code = 'CHAT_SEND_REFUSED') {
      super(message)
      this.statusCode = statusCode
      this.code = code
    }
  }
  return { ChatSendError, postChatMessage: sendMock.post }
})
vi.mock('./notification-channels.js', () => ({ notifyUser: async () => ({}) }))
vi.mock('./chat.js', () => ({
  canSeeRoom: async () => true,
  parseRoom: (room: string) => {
    if (room.startsWith('dm:')) return { kind: 'dm', room }
    if (room.startsWith('ch:')) return { kind: 'channel', room }
    if (room.includes(':')) return { kind: 'entity', room }
    return { kind: 'unknown', room }
  }
}))
vi.mock('./huddle-settings.js', () => ({ getHuddleSettings: async () => ({}) }))
vi.mock('./socket-tenant.js', () => ({
  inSocketTenant: (_s: unknown, h: (...a: unknown[]) => unknown) => h
}))
vi.mock('./io-holder.js', () => ({ getIo: () => null }))
vi.mock('./tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

import type { User } from '../types.js'
import {
  cancelHuddleSchedule,
  createHuddleSchedule,
  dueAction,
  parseScheduleInput,
  REMINDER_MS,
  scheduleMarker,
  TABLE
} from './huddle-schedule.js'

const app = { log: { warn: () => {} }, redis: {} } as never
const rob = {
  id: 'U-ROB',
  first_name: 'Rob',
  last_name: 'Lee',
  email: 'rob@x',
  status: 'active'
} as User
const input = {
  room: 'ch:news',
  title: 'Launch day; all hands',
  starts_at: '2026-10-22T15:00:00.000Z',
  duration_min: 30,
  invitees: []
}

const NOW = Date.parse('2026-10-22T14:00:00Z')
const AMY = '11111111-1111-1111-1111-111111111111'

describe('parseScheduleInput', () => {
  it('normalises a good body: trimmed title, ISO start, unique upper-cased invitees', () => {
    const r = parseScheduleInput(
      {
        room: 'ch:ops',
        title: '  Sprint   review ',
        starts_at: '2026-10-22T15:00:00Z',
        duration_min: 45,
        invitees: [AMY.toLowerCase(), AMY, 'junk', 7]
      },
      NOW
    )
    expect(r).toEqual({
      ok: true,
      value: {
        room: 'ch:ops',
        title: 'Sprint review',
        starts_at: '2026-10-22T15:00:00.000Z',
        duration_min: 45,
        invitees: [AMY]
      }
    })
  })

  it('refuses a bad room, no title, the past, far future and silly durations', () => {
    const base = { room: 'ch:ops', title: 'x', starts_at: '2026-10-22T15:00:00Z', duration_min: 30 }
    expect(parseScheduleInput({ ...base, room: 'nope' }, NOW)).toMatchObject({ ok: false })
    expect(parseScheduleInput({ ...base, title: '   ' }, NOW)).toMatchObject({ ok: false })
    expect(parseScheduleInput({ ...base, starts_at: '2026-10-22T13:00:00Z' }, NOW)).toMatchObject({
      ok: false
    })
    expect(parseScheduleInput({ ...base, starts_at: '2027-10-22T13:00:00Z' }, NOW)).toMatchObject({
      ok: false
    })
    expect(parseScheduleInput({ ...base, duration_min: 2 }, NOW)).toMatchObject({ ok: false })
    expect(parseScheduleInput({ ...base, duration_min: 30.5 }, NOW)).toMatchObject({ ok: false })
  })
})

describe('dueAction', () => {
  const row = {
    status: 'scheduled' as const,
    starts_at: new Date(NOW),
    reminded_at: null,
    rang_at: null
  }
  it('reminds inside the five-minute window, rings at the start, then nothing', () => {
    expect(dueAction(row, NOW - REMINDER_MS - 1)).toBeNull()
    expect(dueAction(row, NOW - REMINDER_MS)).toBe('remind')
    expect(dueAction({ ...row, reminded_at: new Date() }, NOW - 1000)).toBeNull()
    expect(dueAction(row, NOW)).toBe('ring')
    // A reminder never went out but the start passed: ring, never a late reminder.
    expect(dueAction(row, NOW + 60_000)).toBe('ring')
    expect(dueAction({ ...row, rang_at: new Date() }, NOW + 1)).toBeNull()
    expect(dueAction({ ...row, status: 'cancelled' }, NOW)).toBeNull()
  })
})

describe('scheduleMarker', () => {
  it('is the token the chat panel renders the card from', () => {
    expect(scheduleMarker(12)).toBe('[huddle:12]')
  })
})

describe('createHuddleSchedule posts the card as the person, through the send path', () => {
  it('a refused post (announce-only channel) refuses the schedule and removes the row', async () => {
    const { ChatSendError } = await import('./chat-send.js')
    sendMock.post.mockRejectedValueOnce(
      new ChatSendError(403, 'Only the channel owner and admins post here.', 'ANNOUNCE_ONLY')
    )
    await expect(createHuddleSchedule(app, rob, false, input)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ANNOUNCE_ONLY'
    })
    expect(fake.rows[TABLE] ?? []).toEqual([])
    expect(fake.ops.map((o) => o.op)).toEqual(['insert', 'delete'])
    // The post was made as the person (no system flag, no visibility bypass).
    const actor = sendMock.post.mock.calls[0][1] as Record<string, unknown>
    expect(actor).toEqual({ user: rob, isAdmin: false })
  })

  it('a successful post stores the message id; the cancel line is fixed text without the title', async () => {
    fake.ops.length = 0
    sendMock.post.mockResolvedValueOnce({ id: 77 })
    const card = await createHuddleSchedule(app, rob, false, input)
    expect(card.title).toBe(input.title)
    expect(fake.rows[TABLE][0]).toMatchObject({ message_id: 77, status: 'scheduled' })
    const posted = sendMock.post.mock.calls.at(-1)?.[2] as { message: string }
    expect(posted.message).toBe(`Scheduled a huddle ${scheduleMarker(card.id)}`)

    sendMock.post.mockResolvedValueOnce({ id: 78 })
    expect(await cancelHuddleSchedule(app, card.id, rob, false)).toBe(true)
    const line = sendMock.post.mock.calls.at(-1)?.[2] as { message: string }
    expect(line.message).toBe('A scheduled huddle was cancelled')
    expect(line.message).not.toContain(input.title)
  })
})
