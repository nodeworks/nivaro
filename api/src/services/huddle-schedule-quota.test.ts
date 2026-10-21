import { describe, expect, it, vi } from 'vitest'

// Security review 2026-10-21, finding 2: scheduled huddles are capped per organizer.

const fake = vi.hoisted(() => {
  const queries: Array<{ table: string; where: unknown[]; n: number }> = []
  let answers: number[] = []
  const db = (table: string) => {
    const q = { table, where: [] as unknown[], n: 0 }
    const b = {
      where(...args: unknown[]) {
        q.where.push(args.length === 1 ? args[0] : args)
        return b
      },
      async count() {
        q.n = answers.shift() ?? 0
        queries.push(q)
        return [{ n: q.n }]
      }
    }
    return b
  }
  return {
    db,
    queries,
    answer: (...n: number[]) => {
      answers = n
      queries.length = 0
    }
  }
})
vi.mock('../db/index.js', () => ({ db: fake.db }))
vi.mock('./huddle-schedule.js', () => ({ TABLE: 'nivaro_chat_huddle_schedules' }))

import {
  OPEN_SCHEDULES_MAX,
  SCHEDULES_PER_HOUR_MAX,
  scheduleQuota,
  scheduleQuotaRefusal
} from './huddle-schedule-quota.js'

describe('scheduleQuotaRefusal', () => {
  it('allows below both caps', () => {
    expect(scheduleQuotaRefusal({ open: 0, lastHour: 0 })).toBeNull()
    expect(
      scheduleQuotaRefusal({ open: OPEN_SCHEDULES_MAX - 1, lastHour: SCHEDULES_PER_HOUR_MAX - 1 })
    ).toBeNull()
  })

  it('refuses at the upcoming cap, then at the hourly cap, each with a code and a message', () => {
    expect(scheduleQuotaRefusal({ open: 20, lastHour: 0 })).toEqual({
      code: 'HUDDLE_SCHEDULE_OPEN_LIMIT',
      error: expect.stringMatching(/20 upcoming huddles/)
    })
    expect(scheduleQuotaRefusal({ open: 3, lastHour: 10 })).toEqual({
      code: 'HUDDLE_SCHEDULE_RATE_LIMIT',
      error: expect.stringMatching(/last hour/)
    })
  })
})

describe('scheduleQuota', () => {
  const now = new Date('2026-10-21T12:00:00Z')

  it('counts the organizer’s upcoming scheduled rows and everything made in the last hour', async () => {
    fake.answer(2, 1)
    expect(await scheduleQuota('U1', now)).toBeNull()
    const [open, hour] = fake.queries
    expect(open.table).toBe('nivaro_chat_huddle_schedules')
    expect(open.where).toEqual([{ created_by: 'U1', status: 'scheduled' }, ['starts_at', '>', now]])
    // Cancelled ones count toward the hour: make-and-cancel still notified everyone.
    expect(hour.where).toEqual([
      { created_by: 'U1' },
      ['created_at', '>', new Date('2026-10-21T11:00:00Z')]
    ])
  })

  it('refuses from the counts', async () => {
    fake.answer(20, 0)
    expect((await scheduleQuota('U1', now))?.code).toBe('HUDDLE_SCHEDULE_OPEN_LIMIT')
    fake.answer(0, 10)
    expect((await scheduleQuota('U1', now))?.code).toBe('HUDDLE_SCHEDULE_RATE_LIMIT')
  })
})
