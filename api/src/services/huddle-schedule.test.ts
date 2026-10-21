import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: Object.assign(() => ({}), { schema: {} }) }))
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

import { dueAction, parseScheduleInput, REMINDER_MS, scheduleMarker } from './huddle-schedule.js'

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
