import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/chat-bot.js', () => ({ botUserId: vi.fn() }))
vi.mock('../../../services/chat.js', () => ({ channels: vi.fn(), parseRoom: vi.fn() }))

import { type ChatAnalyticsRow, computeChatAnalytics } from '../../../services/chat-analytics.js'

const A = 'AAAAAAAA-0000-0000-0000-000000000001'
const B = 'BBBBBBBB-0000-0000-0000-000000000002'
const DM = `dm:${A}:${B}`

function row(id: number, room: string, sender: string, iso: string, att = false): ChatAnalyticsRow {
  return { id, room, sender, date_created: new Date(iso), has_attachments: att }
}

const kindOf = (room: string) =>
  room.startsWith('dm:')
    ? 'dm'
    : room === 'global'
      ? 'general'
      : room.startsWith('ch:')
        ? 'channel'
        : 'record'

function run(rows: ChatAnalyticsRow[], exclude: (r: ChatAnalyticsRow) => boolean = () => false) {
  return computeChatAnalytics(rows, {
    days: 7,
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2026-09-08T00:00:00Z'),
    timeZone: 'UTC',
    truncated: false,
    reactions: 3,
    kindOf: kindOf as never,
    labelOf: (r) => (r === 'global' ? 'General' : r),
    excludeFromResponse: exclude
  })
}

describe('computeChatAnalytics', () => {
  it('measures DM first response from the start of a run, not each message', () => {
    const out = run([
      row(1, DM, A, '2026-09-02T10:00:00Z'),
      row(2, DM, A, '2026-09-02T10:05:00Z'), // same run — not a new question
      row(3, DM, B, '2026-09-02T10:30:00Z'), // 30 min after the run began
      row(4, DM, A, '2026-09-02T10:40:00Z') // 10 min after B's message
    ])
    expect(out.dm_response.samples).toBe(2)
    expect(out.dm_response.median_minutes).toBe(10)
    expect(out.dm_response.p90_minutes).toBe(30)
    expect(out.dm_response.within_hour_pct).toBe(100)
  })

  it('ignores replies more than a week later and excluded senders', () => {
    const out = run(
      [
        row(1, DM, A, '2026-08-20T10:00:00Z'),
        row(2, DM, B, '2026-09-02T10:00:00Z'), // 13 days later: a new conversation
        row(3, DM, A, '2026-09-02T10:01:00Z')
      ].concat([row(4, DM, B, '2026-09-02T10:02:00Z')]),
      (r) => r.id === 4
    )
    expect(out.dm_response.samples).toBe(1)
    expect(out.dm_response.median_minutes).toBe(1)
  })

  it('fills quiet days and ranks channels without naming DMs', () => {
    const out = run([
      row(1, 'global', A, '2026-09-03T09:00:00Z', true),
      row(2, 'ch:eng', A, '2026-09-03T09:00:00Z'),
      row(3, 'ch:eng', B, '2026-09-05T15:00:00Z'),
      row(4, DM, B, '2026-09-05T15:00:00Z')
    ])
    expect(out.totals).toMatchObject({
      messages: 4,
      senders: 2,
      active_rooms: 3,
      attachments: 1,
      reactions: 3
    })
    expect(out.per_day.length).toBeGreaterThanOrEqual(7)
    expect(out.per_day.find((d) => d.day === '2026-09-04')?.messages).toBe(0)
    expect(out.busiest_channels.map((c) => c.room)).toEqual(['ch:eng', 'global'])
    expect(out.busiest_channels.some((c) => c.room.startsWith('dm:'))).toBe(false)
    expect(out.by_hour[9]).toBe(2)
    expect(out.by_kind.find((k) => k.kind === 'dm')).toEqual({ kind: 'dm', messages: 1, rooms: 1 })
  })
})
