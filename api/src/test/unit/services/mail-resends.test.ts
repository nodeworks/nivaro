import { beforeEach, describe, expect, it, vi } from 'vitest'

// Migration 534 helpers: the per-page resend summary (newest resend + count per original, the
// resender's name), the insert fields, the board's "resent" counts, and the missing-column
// fallback (a database behind 534 reads nothing and writes nothing extra).

const columns = vi.hoisted(() => ({ present: true }))
const dbCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn(() => {
      dbCalls.n++
      throw new Error('no db in test')
    }),
    { raw: vi.fn(), schema: { hasColumn: vi.fn(async () => columns.present) } }
  )
}))

import {
  deliveryKind,
  resendFields,
  resendSummaries,
  resendsOf,
  resetResendColumnProbe,
  summarizeResends
} from '../../../services/mail-resends.js'
import { aggregateMailStats } from '../../../services/mail-stats.js'

beforeEach(() => {
  columns.present = true
  dbCalls.n = 0
  resetResendColumnProbe()
})

describe('summarizeResends', () => {
  it('one summary per original: count, newest status, when, who (name, else email)', () => {
    const m = summarizeResends(
      [
        {
          resend_of: '12',
          status: 'failed',
          created_at: new Date('2026-11-18T19:00:00Z'),
          resent_by: 'AAA-1',
          cnt: '3'
        },
        {
          resend_of: 14,
          status: 'sent',
          created_at: '2026-11-18T18:00:00Z',
          resent_by: 'b',
          cnt: 1
        },
        {
          resend_of: 15,
          status: 'sent',
          created_at: '2026-11-18T18:00:00Z',
          resent_by: null,
          cnt: 1
        }
      ],
      [
        { id: 'aaa-1', first_name: 'Rob', last_name: 'Lee' },
        { id: 'b', first_name: '', last_name: null, email: 'b@x.com' }
      ]
    )
    expect(m.get(12)).toEqual({
      count: 3,
      last_status: 'failed',
      last_at: '2026-11-18T19:00:00.000Z',
      last_by: 'AAA-1',
      last_by_name: 'Rob Lee'
    })
    expect(m.get(14)?.last_by_name).toBe('b@x.com')
    expect(m.get(15)?.last_by_name).toBeNull()
  })
})

describe('resendFields', () => {
  it('a resend gets both columns; an ordinary send gets none', async () => {
    expect(await resendFields({ resendOf: 12, resentBy: 'u' })).toEqual({
      resend_of: 12,
      resent_by: 'u'
    })
    expect(await resendFields({})).toEqual({})
    expect(await resendFields(undefined)).toEqual({})
    expect(await resendFields({ resendOf: 0 })).toEqual({})
  })

  it('before migration 534: nothing extra, and readers never touch the table', async () => {
    columns.present = false
    expect(await resendFields({ resendOf: 12, resentBy: 'u' })).toEqual({})
    expect(await resendSummaries([12, 13])).toEqual(new Map())
    expect(await resendsOf(12)).toEqual([])
    expect(dbCalls.n).toBe(0)
  })

  it('an empty page asks nothing', async () => {
    expect(await resendSummaries([])).toEqual(new Map())
    expect(dbCalls.n).toBe(0)
  })
})

describe('delivery board resend counts', () => {
  const now = new Date('2026-11-18T20:00:00Z')
  const err = '550 5.1.1 <a@x.com>: Recipient address rejected'
  it('failure groups count resent attempts by their newest resend; bounces flag a failed resend', () => {
    const s = aggregateMailStats(
      [
        {
          id: 1,
          to: 'a@x.com',
          status: 'failed',
          template: 't',
          error: err,
          created_at: '2026-11-18T10:00:00Z'
        },
        {
          id: 2,
          to: 'b@x.com',
          status: 'failed',
          template: 't',
          error: err.replace('a@', 'b@'),
          created_at: '2026-11-18T10:05:00Z'
        },
        {
          id: 3,
          to: 'c@x.com',
          status: 'failed',
          template: 't',
          error: err.replace('a@', 'c@'),
          created_at: '2026-11-18T10:06:00Z'
        },
        // a@: resent once (failed), then again (sent) → newest = sent
        {
          id: 4,
          to: 'a@x.com',
          status: 'failed',
          template: 't',
          error: err,
          created_at: '2026-11-18T11:00:00Z',
          resend_of: 1
        },
        {
          id: 5,
          to: 'a@x.com',
          status: 'sent',
          template: 't',
          error: null,
          created_at: '2026-11-18T12:00:00Z',
          resend_of: 1
        },
        // b@: resent, failed again
        {
          id: 6,
          to: 'b@x.com',
          status: 'failed',
          template: 't',
          error: err.replace('a@', 'b@'),
          created_at: '2026-11-18T12:00:00Z',
          resend_of: 2
        }
      ],
      { days: 7, now }
    )
    const group = s.failures[0]
    // 5 failed attempts in one group; originals 1 and 2 were resent (newest: sent, failed).
    expect(group.count).toBe(5)
    expect(group.resent).toEqual({ count: 2, sent: 1, failed: 1 })
    // a@ landed on resend → not a bounce; b@ latest is a failed resend; c@ never resent.
    expect(s.bounces.map((b) => [b.email, b.last_resend ?? false])).toEqual([
      ['b@x.com', true],
      ['c@x.com', false]
    ])
  })

  it('rows without ids (before 534) leave the board as it was', () => {
    const s = aggregateMailStats(
      [
        {
          to: 'a@x.com',
          status: 'failed',
          template: 't',
          error: err,
          created_at: '2026-11-18T10:00:00Z'
        }
      ],
      { days: 7, now }
    )
    expect(s.failures[0].resent).toBeUndefined()
    expect(s.bounces[0].last_resend).toBeUndefined()
  })
})

describe('deliveryKind (Resend already-delivered guard)', () => {
  it("the original itself, an automatic retry (no person), or a person's resend", () => {
    expect(deliveryKind({ id: 12, resend_of: null }, 12)).toBe('original')
    expect(deliveryKind({ id: 51, resend_of: 12, resent_by: null }, 12)).toBe('automatic')
    expect(deliveryKind({ id: 52, resend_of: 12, resent_by: 'u-ann' }, 12)).toBe('resend')
  })
})
