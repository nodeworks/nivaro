import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  creatorColumnFor,
  daysBetween,
  describeConditionRule,
  isSendBackEdge,
  onboardingSteps,
  pickUnavailable,
  splitLineFinding,
  verdictOf,
  weekBuckets
} from '../../../services/dashboard-feed.js'

describe('isSendBackEdge', () => {
  it('is a send-back when the destination sorts before the origin', () => {
    expect(isSendBackEdge(5, 2, 'Approve')).toBe(true)
  })

  it('is not a send-back on a forward or same-sort move with an ordinary label', () => {
    expect(isSendBackEdge(2, 5, 'Approve')).toBe(false)
    expect(isSendBackEdge(3, 3, 'Submit')).toBe(false)
  })

  it('counts a transition whose label says send back / sent back, whatever the sorts', () => {
    expect(isSendBackEdge(2, 5, 'Send Back')).toBe(true)
    expect(isSendBackEdge(2, 5, 'sent back to creator')).toBe(true)
    expect(isSendBackEdge(2, 5, 'SendBack')).toBe(true)
    expect(isSendBackEdge(2, 5, 'Send-back')).toBe(true)
  })

  it('treats missing sorts as unknown, falling back to the label', () => {
    expect(isSendBackEdge(null, null, 'Approve')).toBe(false)
    expect(isSendBackEdge(null, 1, 'Send back')).toBe(true)
  })

  it('an uncancel (leaving the canceled state) is never a send-back', () => {
    expect(isSendBackEdge(9, 2, 'Uncancel', 'canceled')).toBe(false)
    expect(isSendBackEdge(9, 2, 'Send back', 'CANCELED')).toBe(false)
    expect(isSendBackEdge(9, 2, 'Uncancel', 'review')).toBe(true)
  })
})

describe('splitLineFinding', () => {
  it('splits a line-scoped message into the line token and the rest', () => {
    expect(splitLineFinding('Line 3: Category is empty')).toEqual({
      line: '3',
      message: 'Category is empty'
    })
  })

  it('keeps a #-prefixed token as written', () => {
    expect(splitLineFinding('Line #12:   Price is $5.00')).toEqual({
      line: '#12',
      message: 'Price is $5.00'
    })
  })

  it('answers null for a record-level message', () => {
    expect(splitLineFinding('Vendor is required')).toBeNull()
    expect(splitLineFinding('Lines missing: 3')).toBeNull()
  })
})

describe('weekBuckets', () => {
  // Wednesday; this week began Monday 2026-09-28 (UTC).
  const now = new Date('2026-09-30T12:00:00Z')
  const row = (at: string, extra: Partial<Parameters<typeof weekBuckets>[0][number]> = {}) => ({
    at,
    send_back: false,
    completion: false,
    tta_hours: null,
    ...extra
  })

  it('counts this week apart and takes the median of the prior weeks (zero weeks included)', () => {
    const rows = [
      // this week
      row('2026-09-28T01:00:00Z', { send_back: true, tta_hours: 2 }),
      row('2026-09-30T09:00:00Z', { completion: true, tta_hours: 4 }),
      // 1 week ago: 3
      row('2026-09-21T10:00:00Z', { tta_hours: 10 }),
      row('2026-09-22T10:00:00Z', { send_back: true, tta_hours: 20 }),
      row('2026-09-27T23:59:00Z', { completion: true }),
      // 2 weeks ago: 1
      row('2026-09-15T10:00:00Z', { tta_hours: 30 }),
      // 3 weeks ago: 0
      // 4 weeks ago: 5
      row('2026-08-31T10:00:00Z'),
      row('2026-09-01T10:00:00Z'),
      row('2026-09-02T10:00:00Z', { completion: true }),
      row('2026-09-03T10:00:00Z'),
      row('2026-09-06T10:00:00Z'),
      // 5 weeks ago — outside a 4-week window
      row('2026-08-25T10:00:00Z', { send_back: true, tta_hours: 999 })
    ]
    const out = weekBuckets(rows, 4, now)
    expect(out.this_week).toEqual({ transitions: 2, send_backs: 1, completions: 1 })
    // weekly counts [3, 1, 0, 5] → transitions median (1 + 3) / 2
    expect(out.median.transitions).toBe(2)
    // send-backs [1, 0, 0, 0] → 0; completions [1, 0, 0, 1] → 0.5
    expect(out.median.send_backs).toBe(0)
    expect(out.median.completions).toBe(0.5)
    expect(out.time_to_action_hours).toEqual({ this_week: 3, median: 20 })
    // 2 send-backs over 11 transitions inside the window
    expect(out.send_back_ratio).toBeCloseTo(2 / 11)
  })

  it('answers nulls when there is nothing to measure', () => {
    const out = weekBuckets([], 4, now)
    expect(out.this_week).toEqual({ transitions: 0, send_backs: 0, completions: 0 })
    expect(out.median).toEqual({ transitions: 0, send_backs: 0, completions: 0 })
    expect(out.time_to_action_hours).toEqual({ this_week: null, median: null })
    expect(out.send_back_ratio).toBeNull()
  })

  it("buckets by the viewer's own Monday", () => {
    // 2026-09-28T02:00Z is still Sunday evening in New York → last week there.
    const rows = [row('2026-09-28T02:00:00Z')]
    expect(weekBuckets(rows, 4, now, 'UTC').this_week.transitions).toBe(1)
    expect(weekBuckets(rows, 4, now, 'America/New_York').this_week.transitions).toBe(0)
  })
})

describe('verdictOf', () => {
  it('is idle when nothing was sent', () => {
    expect(verdictOf([])).toEqual({ verdict: 'idle', failed_24h: 0, last_failure_at: null })
  })

  it('is failing when the newest attempt failed', () => {
    const out = verdictOf([
      { status: 'failed', at: '2026-09-28T10:00:00Z' },
      { status: 'accepted', at: '2026-09-28T09:00:00Z' },
      { status: 'failed', at: '2026-09-28T08:00:00Z' }
    ])
    expect(out).toEqual({
      verdict: 'failing',
      failed_24h: 2,
      last_failure_at: '2026-09-28T10:00:00.000Z'
    })
  })

  it('is healthy when a success landed after the last failure (order-independent)', () => {
    const out = verdictOf([
      { status: 'failed', at: '2026-09-28T08:00:00Z' },
      { status: 'pending', at: '2026-09-28T11:00:00Z' }
    ])
    expect(out.verdict).toBe('healthy')
    expect(out.failed_24h).toBe(1)
    expect(out.last_failure_at).toBe('2026-09-28T08:00:00.000Z')
  })
})

describe('onboardingSteps', () => {
  it('reads each step from its own source', () => {
    expect(
      onboardingSteps(
        { notification_prefs: { matrix: { workflow: { inapp: true } } }, timezone: 'UTC' },
        2,
        1,
        { delegate_id: 'X' }
      )
    ).toEqual({
      scope_defaults: true,
      notification_rules: true,
      timezone: true,
      watching: true,
      delegate: true
    })
  })

  it('is all false for a brand-new account', () => {
    expect(onboardingSteps(null, 0, 0, { delegate_id: null })).toEqual({
      scope_defaults: false,
      notification_rules: false,
      timezone: false,
      watching: false,
      delegate: false
    })
    expect(
      onboardingSteps({ notification_prefs: { matrix: {} }, timezone: '  ' }, 0, 0, {})
        .notification_rules
    ).toBe(false)
  })
})

describe('daysBetween', () => {
  it('counts whole days, flooring partial ones', () => {
    expect(daysBetween('2026-09-01T00:00:00Z', '2026-09-04T12:00:00Z')).toBe(3)
  })

  it('is never negative and reads Date objects too', () => {
    expect(daysBetween(new Date('2026-09-04T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))).toBe(0)
  })

  it('answers 0 for an unreadable date', () => {
    expect(daysBetween('not a date', '2026-09-04T00:00:00Z')).toBe(0)
  })
})

describe('creatorColumnFor', () => {
  it('prefers a field flagged user-created (JSON array special) that physically exists', () => {
    const fields = [
      { field: 'owner_person', special: '["user-created"]' },
      { field: 'user_created', special: null }
    ]
    expect(creatorColumnFor(fields, ['id', 'owner_person', 'user_created'])).toBe('owner_person')
  })

  it('reads a bare or comma-list special', () => {
    expect(creatorColumnFor([{ field: 'made_by', special: 'm2o,user-created' }], ['made_by'])).toBe(
      'made_by'
    )
  })

  it('ignores a flagged field that has no physical column', () => {
    expect(creatorColumnFor([{ field: 'ghost', special: 'user-created' }], ['id', 'creator'])).toBe(
      'creator'
    )
  })

  it('falls back to user_created, then creator, then created_by (case-insensitive)', () => {
    expect(creatorColumnFor([], ['id', 'created_by', 'creator'])).toBe('creator')
    expect(creatorColumnFor([], ['id', 'CREATED_BY'])).toBe('CREATED_BY')
    expect(creatorColumnFor([], ['id', 'user_created', 'creator'])).toBe('user_created')
  })

  it('answers null when nothing names a creator', () => {
    expect(creatorColumnFor([], ['id', 'name'])).toBeNull()
  })
})

describe('pickUnavailable', () => {
  const base = {
    first_name: 'Pat',
    last_name: 'Lee',
    email: 'pat@example.com',
    status: 'active',
    is_redacted: false,
    is_out_of_office: false,
    delegate_id: null,
    delegate_expires_at: null
  }

  it('lists a suspended owner', () => {
    const out = pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A', status: 'suspended' }])
    expect(out).toEqual([{ id: 'A', name: 'Pat Lee', reason: 'suspended', delegate: null }])
  })

  it('lists a redacted owner as redacted', () => {
    const out = pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A', is_redacted: 1 }])
    expect(out[0]?.reason).toBe('redacted')
  })

  it('an out-of-office owner whose delegation expired is out with no delegate', () => {
    const out = pickUnavailable(
      [{ id: 'A' }],
      [
        {
          ...base,
          id: 'A',
          is_out_of_office: true,
          delegate_id: 'X',
          delegate_expires_at: new Date('2020-01-01T00:00:00Z')
        },
        { ...base, id: 'X', first_name: 'Kim' }
      ]
    )
    expect(out).toEqual([{ id: 'A', name: 'Pat Lee', reason: 'out', delegate: null }])
  })

  it('an out-of-office owner with a working delegate names the delegate', () => {
    const out = pickUnavailable(
      [{ id: 'a' }],
      [
        { ...base, id: 'A', is_out_of_office: 1, delegate_id: 'x', delegate_expires_at: null },
        { ...base, id: 'X', first_name: 'Kim', last_name: 'Diaz' }
      ]
    )
    expect(out).toEqual([
      {
        id: 'a',
        name: 'Pat Lee',
        reason: 'out',
        delegate: { id: 'X', name: 'Kim Diaz', expires_at: null }
      }
    ])
  })

  it('an active owner is not listed', () => {
    expect(pickUnavailable([{ id: 'A' }], [{ ...base, id: 'A' }])).toEqual([])
  })
})

describe('describeConditionRule', () => {
  it('words the common operators', () => {
    expect(describeConditionRule({ field: 'vendor', op: 'nnull', value: null })).toBe(
      'Vendor must be set'
    )
    expect(describeConditionRule({ field: 'workflow_type', op: 'eq', value: 2 })).toBe(
      'Workflow Type must be 2'
    )
    expect(describeConditionRule({ field: 'status', op: 'in', value: 'a, b' })).toBe(
      'Status must be one of a, b'
    )
  })

  it('names the child collection for a related-rows rule', () => {
    expect(
      describeConditionRule({
        field: 'workflow_line_items:workflow',
        op: 'related_some',
        value: null
      })
    ).toBe('Needs at least one Workflow Line Items row')
  })

  it('walks a dotted field', () => {
    expect(
      describeConditionRule({ field: 'unit.schedule_date', op: 'within_days', value: 45 })
    ).toBe('Unit › Schedule Date must be within 45 days')
  })
})
