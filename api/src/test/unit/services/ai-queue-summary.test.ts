import { describe, expect, it, vi } from 'vitest'

// The shaper is pure, but the module imports the queue service (and through
// it the db + SLA routes) for the read half — keep those inert.
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/queues.js', () => ({ fetchQueueItems: vi.fn() }))
vi.mock('../../../services/user-scopes.js', () => ({ isAdminRole: vi.fn(async () => false) }))

const { shapeQueueSummary, QUEUE_SUMMARY_MAX_LIST_LIMIT } = await import(
  '../../../services/ai-queue-summary.js'
)
type QueueItem = import('../../../services/queues.js').QueueItem
type QueueStats = import('../../../services/queues.js').QueueStats

function row(over: Partial<QueueItem> & { item_id: string }): QueueItem {
  return {
    collection: 'orders',
    label: `Order ${over.item_id}`,
    state: 'review',
    state_color: null,
    owners: [{ id: 'u1', name: 'Beth' }],
    sla_status: 'ok',
    at_risk: false,
    at_risk_rule: null,
    aging_hours: 5,
    claimed_by: null,
    url: `/collections/orders/${over.item_id}`,
    ...over
  }
}

const queue = { id: 'Q1', name: 'Review desk', sources: ['orders'] }

const stats: QueueStats = {
  total: 6,
  by_state: { review: 4, started: 2 },
  unowned: 2,
  sla_warning: 1,
  sla_breached: 2,
  at_risk: 3
}

const items: QueueItem[] = [
  row({
    item_id: '1',
    aging_hours: 100,
    sla_status: 'breached',
    at_risk: true,
    at_risk_rule: { id: 1, name: 'On hold' }
  }),
  row({
    item_id: '2',
    aging_hours: 300,
    sla_status: 'breached',
    owners: [],
    at_risk: true,
    at_risk_rule: { id: 2, name: 'Sent back' }
  }),
  row({ item_id: '3', aging_hours: 50, owners: [], state: 'started' }),
  row({ item_id: '4', aging_hours: null, sla_status: 'warning' }),
  row({ item_id: '5', aging_hours: 20, at_risk: true, at_risk_rule: { id: 1, name: 'On hold' } }),
  row({ item_id: '6', aging_hours: 7, state: 'started', at_risk: true, at_risk_rule: null })
]

describe('shapeQueueSummary', () => {
  it('shapes the totals, the by-state breakdown and the record lists', () => {
    const out = shapeQueueSummary(items, stats, queue, {
      stateLabels: { review: 'In review' },
      friendlyIds: { 'orders:2': 'ORD-0002' },
      hoursOver: { 'orders:1': 40.26, 'orders:2': 12 }
    })
    expect(out.queue).toEqual({
      id: 'Q1',
      name: 'Review desk',
      url: '/queues/Q1',
      sources: ['orders']
    })
    expect(out.stats).toEqual({
      total: 6,
      unowned: 2,
      sla_warning: 1,
      sla_breached: 2,
      at_risk: 3,
      by_state: [
        { key: 'review', label: 'In review', count: 4 },
        { key: 'started', label: 'Started', count: 2 }
      ]
    })
    // Oldest first; a row with no aging never lists.
    expect(out.oldest.map((r) => r.id)).toEqual(['2', '1', '3', '5', '6'])
    // Friendly id becomes the label, the queue's own label rides as title.
    expect(out.oldest[0]).toEqual({
      label: 'ORD-0002',
      title: 'Order 2',
      collection: 'orders',
      id: '2',
      state: 'In review',
      aging_hours: 300,
      url: '/collections/orders/2'
    })
    expect(out.oldest[1].title).toBeUndefined()
    // Breached ordered by hours over, owners named, rounded to a tenth.
    expect(out.breached.map((r) => [r.id, r.hours_over, r.owners])).toEqual([
      ['1', 40.3, ['Beth']],
      ['2', 12, []]
    ])
    expect(out.unowned.map((r) => r.id)).toEqual(['2', '3'])
    // Top reasons by count, a rule-less at-risk row still counted.
    expect(out.at_risk_reasons).toEqual([
      { rule: 'On hold', count: 2 },
      { rule: 'Sent back', count: 1 },
      { rule: 'Unnamed rule', count: 1 }
    ])
    expect(out.truncated).toBe(false)
    expect(out.list_limit).toBe(10)
  })

  it('caps every list at the limit and clamps the limit', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      row({ item_id: String(i), aging_hours: i, sla_status: 'breached', owners: [] })
    )
    const out = shapeQueueSummary(many, { ...stats, total: 40 }, queue, {
      listLimit: 3,
      truncated: true
    })
    expect(out.oldest.map((r) => r.id)).toEqual(['39', '38', '37'])
    expect(out.breached).toHaveLength(3)
    expect(out.unowned).toHaveLength(3)
    expect(out.truncated).toBe(true)
    const wide = shapeQueueSummary(many, { ...stats, total: 40 }, queue, { listLimit: 500 })
    expect(wide.oldest).toHaveLength(QUEUE_SUMMARY_MAX_LIST_LIMIT)
    expect(wide.list_limit).toBe(QUEUE_SUMMARY_MAX_LIST_LIMIT)
    const bad = shapeQueueSummary(many, { ...stats, total: 40 }, queue, { listLimit: Number.NaN })
    expect(bad.list_limit).toBe(10)
  })

  it('breached rows without a known overrun sort after the ones with one, then by age', () => {
    const out = shapeQueueSummary(
      [
        row({ item_id: 'a', aging_hours: 500, sla_status: 'breached' }),
        row({ item_id: 'b', aging_hours: 10, sla_status: 'breached' }),
        row({ item_id: 'c', aging_hours: 200, sla_status: 'breached' })
      ],
      stats,
      queue,
      { hoursOver: { 'orders:b': 3 } }
    )
    expect(out.breached.map((r) => [r.id, r.hours_over])).toEqual([
      ['b', 3],
      ['a', null],
      ['c', null]
    ])
  })

  it('returns empty lists for an empty queue', () => {
    const out = shapeQueueSummary(
      [],
      { total: 0, by_state: {}, unowned: 0, sla_warning: 0, sla_breached: 0, at_risk: 0 },
      queue
    )
    expect(out.stats.by_state).toEqual([])
    expect(out.oldest).toEqual([])
    expect(out.breached).toEqual([])
    expect(out.unowned).toEqual([])
    expect(out.at_risk_reasons).toEqual([])
  })
})
