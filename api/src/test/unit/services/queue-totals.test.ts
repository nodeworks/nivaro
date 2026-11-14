import { afterEach, describe, expect, it, vi } from 'vitest'

// Queue totals row (2026-11-14): figures over the WHOLE result a viewer sees (scope tab +
// column filters), each row adding its own source's value, combined across sources.

const rowsFor: Record<string, unknown> = {
  nivaro_queues: { id: 'q1', materialized: false, display_config: null },
  nivaro_queue_labels: [],
  nivaro_queue_sources: [
    { id: 1, queue_id: 'q1', type: 'collection', collection: 'purchase_orders', sort: 0 },
    { id: 2, queue_id: 'q1', type: 'collection', collection: 'invoices', sort: 1 }
  ],
  'nivaro_queue_claims as c': []
}
function chain(table: string) {
  const rows = rowsFor[table]
  const p = Promise.resolve(rows)
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === 'then') return p.then.bind(p)
        if (k === 'catch') return p.catch.bind(p)
        if (k === 'first') return async () => (Array.isArray(rows) ? rows[0] : rows)
        return () => proxy
      }
    }
  )
  return proxy
}
vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => chain(t)) }))
vi.mock('../../../functions/queue-materialization-jobs.js', () => ({
  enqueueQueueMaterializationBackfill: vi.fn(async () => {})
}))
vi.mock('../../../services/queue-owner-status.js', () => ({
  markInactiveOwners: vi.fn(async () => {})
}))
// The sources' gated reads answer what each source's resolver would (as the viewer).
const sourceResults: { current: unknown[] } = { current: [] }
vi.mock('../../../services/read-gate.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/read-gate.js')>()),
  withReadGateEach: vi.fn(async () => sourceResults.current)
}))

import knex from 'knex'
import { materializedTotalsQuery } from '../../../services/queue-materialization-read.js'
import {
  combineParts,
  finishTotal,
  parseTotalsParam,
  totalsFromGroupedRows,
  totalsFromItems
} from '../../../services/queue-totals.js'
import {
  computeExtraFieldMeta,
  fetchQueueItems,
  parseQueueItemsQuery,
  type QueueItem
} from '../../../services/queues.js'
import { makeAdminUser } from '../../helpers.js'

afterEach(() => vi.clearAllMocks())

function row(
  collection: string,
  id: string,
  extra: Record<string, unknown>,
  over: Partial<QueueItem> = {}
): QueueItem {
  return {
    collection,
    item_id: id,
    label: `${collection} ${id}`,
    state: 'review',
    state_color: null,
    owners: [],
    sla_status: null,
    at_risk: false,
    aging_hours: null,
    claimed_by: null,
    url: `/collections/${collection}/${id}`,
    extra,
    ...over
  }
}

describe('totalsFromItems — combining sources', () => {
  it('adds sums and counts, takes the least / greatest, averages over the combined count', () => {
    const items = [
      row('purchase_orders', '1', { amount: '100' }),
      row('purchase_orders', '2', { amount: '$1,200.50' }),
      row('invoices', '7', { amount: 40 }),
      row('invoices', '8', { amount: 60 }),
      row('invoices', '9', { amount: 80 })
    ]
    const t = totalsFromItems(items, ['amount']).amount
    expect(t.sum).toBe(1480.5)
    expect(t.count).toBe(5)
    expect(t.min).toBe(40)
    expect(t.max).toBe(1200.5)
    // Combined sum / combined count — not the average of the two sources' averages
    // (650.25 and 60 → 355.125).
    expect(t.avg).toBe(296.1)
    expect(t.by_collection).toEqual({
      purchase_orders: { sum: 1300.5, count: 2, min: 100, max: 1200.5 },
      invoices: { sum: 180, count: 3, min: 40, max: 80 }
    })
  })

  it("each row adds its OWN source's value; a source without the column adds nothing", () => {
    // Two sources both list `total` (renamed "Amount" on the queue), from different
    // fields underneath; a third source has no such column at all.
    const items = [
      row('purchase_orders', '1', { total: 10, vendor: 'A' }),
      row('invoices', '2', { total: 5 }),
      row('tasks', '3', { title: 'no amount here' }),
      row('invoices', '4', { total: '' }),
      row('invoices', '5', { total: null }),
      row('invoices', '6', { total: 'n/a' })
    ]
    const t = totalsFromItems(items, ['total', 'missing'])
    expect(t.total).toMatchObject({ sum: 15, count: 2, min: 5, max: 10, avg: 7.5 })
    expect(Object.keys(t.total.by_collection).sort()).toEqual(['invoices', 'purchase_orders'])
    expect(t.missing).toEqual({
      sum: 0,
      count: 0,
      min: null,
      max: null,
      avg: null,
      by_collection: {}
    })
  })

  it('keeps float sums tidy', () => {
    const t = totalsFromItems([row('a', '1', { x: 0.1 }), row('b', '2', { x: 0.2 })], ['x']).x
    expect(t.sum).toBe(0.3)
  })
})

describe('combineParts / finishTotal / grouped SQL rows', () => {
  it('combines parts with empty ones in between', () => {
    expect(
      combineParts([
        { sum: 3, count: 1, min: 3, max: 3 },
        { sum: 0, count: 0, min: null, max: null },
        { sum: -2, count: 2, min: -5, max: 3.5 }
      ])
    ).toEqual({ sum: 1, count: 3, min: -5, max: 3.5 })
    expect(finishTotal({})).toMatchObject({ count: 0, avg: null, min: null })
  })

  it('reads the per-collection grouped read the materialized path makes', () => {
    const t = totalsFromGroupedRows(
      [
        { collection: 'purchase_orders', s0: 300, c0: 3, n0: 50, x0: 200, s1: null, c1: 0 },
        {
          collection: 'invoices',
          s0: '100',
          c0: '1',
          n0: '100',
          x0: '100',
          s1: 9,
          c1: 3,
          n1: 1,
          x1: 5
        }
      ],
      ['amount', 'qty']
    )
    expect(t.amount).toMatchObject({ sum: 400, count: 4, min: 50, max: 200, avg: 100 })
    expect(t.qty).toMatchObject({ sum: 9, count: 3, avg: 3 })
    expect(Object.keys(t.qty.by_collection)).toEqual(['invoices'])
  })

  it('the materialized read totals every column per collection over the gated builder', () => {
    const k = knex({ client: 'mssql' })
    const sql = materializedTotalsQuery(
      k,
      k('nivaro_queue_items as qi').where('qi.queue_id', 'q1').orderBy('qi.id'),
      ['amount', 'po.total']
    ).toString()
    // The page's ORDER BY never reaches the aggregate.
    expect(sql).not.toMatch(/order by/i)
    expect(sql).toMatch(/group by \[t\]\.\[collection\]/i)
    expect(sql).toMatch(
      /SUM\(t\.v0\) AS s0, COUNT\(t\.v0\) AS c0, MIN\(t\.v0\) AS n0, MAX\(t\.v0\) AS x0/
    )
    expect(sql).toMatch(/SUM\(t\.v1\)/)
    // The typed twin first, the displayed text read like numberOfValue after it.
    expect(sql).toMatch(
      /COALESCE\(TRY_CONVERT\(float, JSON_VALUE\(qi\.extra, '\$\."__t"\."amount"\.n'\)\)/
    )
    expect(sql).toContain(`'$."po.total"'`)
  })
})

describe('parseTotalsParam / parseQueueItemsQuery', () => {
  it('keeps plain paths (extra. prefix optional), drops the rest, caps at 12', () => {
    expect(parseTotalsParam('extra.amount, qty ,bad name,1x,a..b,amount,po.total')).toEqual([
      'amount',
      'qty',
      'po.total'
    ])
    expect(parseTotalsParam(Array.from({ length: 20 }, (_, i) => `c${i}`).join(','))).toHaveLength(
      12
    )
    expect(parseTotalsParam(undefined)).toEqual([])
  })

  it('rides the items query only when asked', () => {
    expect(parseQueueItemsQuery({ totals: 'extra.amount' })).toEqual({
      ok: true,
      value: { scope: 'all', sort: '', filters: {}, totals: ['amount'] }
    })
    expect(parseQueueItemsQuery({})).toEqual({
      ok: true,
      value: { scope: 'all', sort: '', filters: {} }
    })
  })
})

describe('fetchQueueItems totals — the whole result as the viewer sees it', () => {
  const me = makeAdminUser()
  const mine = [{ id: me.id, name: 'Me' }]
  const other = [{ id: 'someone-else', name: 'Other' }]
  sourceResults.current = [
    {
      items: [
        row('purchase_orders', '1', { amount: 100, region: 'East' }, { owners: mine }),
        row('purchase_orders', '2', { amount: 200, region: 'West' }, { owners: mine }),
        row('purchase_orders', '3', { amount: 400, region: 'East' }, { owners: other })
      ],
      matchedCount: 3,
      truncated: false
    },
    {
      items: [
        row('invoices', '10', { amount: 50, region: 'East' }, { owners: mine }),
        row('invoices', '11', { amount: 70, region: 'East' }, { owners: other, state: 'paid' }),
        // The same record a second source also matched counts once.
        row('purchase_orders', '1', { amount: 100, region: 'East' }, { owners: mine })
      ],
      matchedCount: 3,
      truncated: false
    }
  ]

  it('totals every page, not just the one asked for', async () => {
    const r = await fetchQueueItems('q1', me, 'all', { page: 1, limit: 1, totals: ['amount'] })
    expect(r.items).toHaveLength(1)
    expect(r.totals?.amount).toMatchObject({ sum: 820, count: 5, min: 50, max: 400, avg: 164 })
  })

  it('follows the scope tab and the column filters', async () => {
    const mineOnly = await fetchQueueItems('q1', me, 'mine', {
      totals: ['amount'],
      page: 1,
      limit: 1
    })
    expect(mineOnly.totals?.amount).toMatchObject({ sum: 350, count: 3 })
    const east = await fetchQueueItems('q1', me, 'all', {
      totals: ['amount'],
      filters: { 'extra.region': 'East', state: ['review'] },
      page: 1,
      limit: 1
    })
    // East + review: PO 1 (100), PO 3 (400), invoice 10 (50) — invoice 11 is paid.
    expect(east.totals?.amount).toMatchObject({ sum: 550, count: 3, min: 50, max: 400 })
    expect(east.totals?.amount.by_collection.invoices).toEqual({
      sum: 50,
      count: 1,
      min: 50,
      max: 50
    })
  })

  it('answers no totals when none were asked for', async () => {
    const r = await fetchQueueItems('q1', me, 'all', { page: 1, limit: 1 })
    expect(r.totals).toBeUndefined()
  })
})

describe('computeExtraFieldMeta — which columns are number columns', () => {
  it('judges each path on every source that lists it; calculated-on-read has no total', async () => {
    const relations = [
      {
        id: 1,
        many_collection: 'purchase_orders',
        many_field: 'project',
        one_collection: 'projects',
        one_field: 'pos',
        junction_field: null
      },
      {
        id: 2,
        many_collection: 'po_years',
        many_field: 'po_id',
        one_collection: 'purchase_orders',
        one_field: 'years',
        junction_field: 'year_id'
      },
      {
        id: 3,
        many_collection: 'po_years',
        many_field: 'year_id',
        one_collection: 'funding_years',
        one_field: null,
        junction_field: 'po_id'
      }
    ]
    const fields = [
      { collection: 'purchase_orders', field: 'amount', type: 'string' },
      { collection: 'invoices', field: 'amount', type: 'decimal' },
      { collection: 'purchase_orders', field: 'vendor', type: 'string' },
      {
        collection: 'purchase_orders',
        field: 'margin',
        type: 'float',
        computed_formula: 'item.a - item.b',
        computed_store: false,
        computed_type: 'formula'
      },
      { collection: 'projects', field: 'budget', type: 'integer' },
      { collection: 'funding_years', field: 'year', type: 'integer' }
    ]
    const fakeDb = ((table: string) => {
      if (table === 'nivaro_relations') return Promise.resolve(relations)
      return { whereIn: () => ({ select: () => Promise.resolve(fields) }) }
    }) as never
    const src = (id: number, collection: string, extra: string[]) =>
      ({
        id,
        queue_id: 'q',
        type: 'collection',
        collection,
        filters: null,
        state_values: null,
        sla_filter: null,
        extra_fields: JSON.stringify(extra),
        sort: id
      }) as never
    const meta = await computeExtraFieldMeta(
      [
        src(1, 'purchase_orders', [
          'amount',
          'vendor',
          'margin',
          'project.budget',
          'project',
          'years.year'
        ]),
        src(2, 'invoices', ['amount'])
      ],
      fakeDb
    )
    const by = Object.fromEntries(meta.map((m) => [m.path, m]))
    // A string on one source and a decimal on the other: the invoices rows total.
    expect(by.amount.number).toBe(true)
    expect(by.vendor.number).toBeUndefined()
    expect(by.margin).toMatchObject({ number: true })
    expect(by.margin.no_total).toMatch(/never stored/)
    // Many-to-one hops keep one value per row.
    expect(by['project.budget'].number).toBe(true)
    // The relation field itself (an id) is not a number to add up.
    expect(by.project.number).toBeUndefined()
    // Several years per row ("2026, 2027") are a list, not one number.
    expect(by['years.year'].number).toBeUndefined()
    expect(by['years.year'].multi_value).toBe(true)
  })
})
