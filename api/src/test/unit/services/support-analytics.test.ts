import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import { summarizeSupport, type TicketFact, timing } from '../../../services/support-analytics.js'

const t0 = '2026-10-20T00:00:00Z'
const at = (h: number) => new Date(Date.parse(t0) + h * 3_600_000).toISOString()
const fact = (o: Partial<TicketFact>): TicketFact => ({
  id: 1,
  category: 'Access',
  team: 'IT',
  collection: null,
  requester: 'U1',
  requester_name: 'Ada',
  created_at: t0,
  completed_at: null,
  status: 'open',
  first_reply_at: null,
  reopened: false,
  has_clip: false,
  has_screenshot: false,
  ...o
})

describe('timing', () => {
  it('p50 / p75 and the share within target', () => {
    const t = timing([1, 2, 3, 10], 4)
    expect(t).toMatchObject({ samples: 4, p50_hours: 3, p75_hours: 10, within_target: 0.75 })
  })
  it('empty is null, not zero', () => {
    expect(timing([], 4)).toMatchObject({ samples: 0, p50_hours: null, within_target: null })
  })
})

describe('summarizeSupport', () => {
  const facts = [
    fact({ id: 1, status: 'done', completed_at: at(10), first_reply_at: at(1), has_clip: true }),
    fact({
      id: 2,
      status: 'done',
      completed_at: at(30),
      first_reply_at: at(5),
      reopened: true,
      collection: 'orders'
    }),
    fact({
      id: 3,
      category: null,
      team: null,
      requester: 'U2',
      requester_name: 'Bo',
      has_screenshot: true
    }),
    fact({ id: 4, status: 'cancelled' })
  ]
  const s = summarizeSupport(facts)
  it('totals and breakdowns', () => {
    expect(s.totals).toEqual({ tickets: 4, open: 1, done: 2, cancelled: 1 })
    expect(s.by_type[0]).toEqual({ name: 'Access', tickets: 3 })
    expect(s.by_type.at(-1)?.name).toBe('No type')
    expect(s.by_team.map((t) => t.name)).toContain('Administrators')
    expect(s.by_collection.map((c) => c.collection)).toContain('General Support')
  })
  it('response and resolution against targets', () => {
    expect(s.first_response).toMatchObject({ samples: 2, within_target: 0.5 })
    expect(s.resolution).toMatchObject({ samples: 2, p50_hours: 30, within_target: 1 })
  })
  it('reopen rate over tickets that were ever closed', () => {
    expect(s.reopen).toMatchObject({ reopened: 1, closed_ever: 3 })
    expect(s.reopen.rate).toBeCloseTo(1 / 3)
  })
  it('evidence share and busiest requesters', () => {
    expect(s.evidence).toMatchObject({
      with_clip: 1,
      with_screenshot: 1,
      with_either: 2,
      share: 0.5
    })
    expect(s.busiest_requesters[0]).toMatchObject({ id: 'U1', tickets: 3 })
  })
})
