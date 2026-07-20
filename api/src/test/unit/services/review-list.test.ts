import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))

import { getCollection } from '../../../services/collections.js'
import {
  type RelRow,
  type ReviewListConfig,
  resolveReviewListRows,
  validateReviewListConfig
} from '../../../services/review-list.js'

afterEach(() => vi.restoreAllMocks())

function makeLogger() {
  return { warn: vi.fn() }
}

// ─── db-mock harness (mirrors transition-requirements.test.ts's table-routing
// style, extended to record the query shape so a single resolver can tell
// apart two different calls to the same table by which whereIn/where fired). ──

interface QueryState {
  table: string
  wheres: Array<[string, unknown]>
  whereNots: Array<[string, unknown]>
  whereNotNulls: string[]
  whereIns: Array<[string, unknown[]]>
  limitVal?: number
  selectArgs: unknown[]
}

function makeDb(resolver: (state: QueryState) => unknown[], capturedStates?: QueryState[]) {
  return vi.fn((table: string) => {
    const state: QueryState = {
      table,
      wheres: [],
      whereNots: [],
      whereNotNulls: [],
      whereIns: [],
      selectArgs: []
    }
    capturedStates?.push(state)
    const qb: Record<string, unknown> = {}
    qb.where = vi.fn((field: string, val: unknown) => {
      state.wheres.push([field, val])
      return qb
    })
    qb.whereNot = vi.fn((field: string, val: unknown) => {
      state.whereNots.push([field, val])
      return qb
    })
    qb.whereNotNull = vi.fn((field: string) => {
      state.whereNotNulls.push(field)
      return qb
    })
    qb.whereIn = vi.fn((field: string, vals: unknown[]) => {
      state.whereIns.push([field, vals])
      return qb
    })
    qb.limit = vi.fn((n: number) => {
      state.limitVal = n
      return qb
    })
    qb.select = vi.fn((...args: unknown[]) => {
      state.selectArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
      return Promise.resolve(resolver(state))
    })
    return qb
  })
}

// ─── The concrete fixture: workflows (host) → purchase_orders → invoices ───

const RELATIONS: RelRow[] = [
  // invoices.purchase_order (M2O) → purchase_orders
  {
    many_collection: 'invoices',
    many_field: 'purchase_order',
    one_collection: 'purchase_orders',
    one_field: null,
    junction_field: null
  },
  // purchase_orders.workflows (M2M alias) via workflow_purchase_orders_junction
  {
    many_collection: 'workflow_purchase_orders_junction',
    many_field: 'purchase_order',
    one_collection: 'purchase_orders',
    one_field: 'workflows',
    junction_field: 'workflow'
  },
  // companion: junction → workflows (plain M2O)
  {
    many_collection: 'workflow_purchase_orders_junction',
    many_field: 'workflow',
    one_collection: 'workflows',
    one_field: null,
    junction_field: null
  }
]

const invoicesConfig: ReviewListConfig = {
  host_collection: 'workflows',
  collection: 'invoices',
  path: [
    { kind: 'm2o', field: 'purchase_order' },
    { kind: 'm2m', field: 'workflows' }
  ],
  static_filter: [{ field: 'is_on_hold', op: 'eq', value: true }],
  group_by: 'invoice_id',
  aggregate_sum: 'amount',
  group_meta: ['number', 'hold_reason'],
  line_columns: ['line_item_number', 'amount'],
  status: {
    field: 'efp_review_status',
    options: [
      { value: 'approved', label: 'Approve', color: 'green' },
      { value: 'rejected', label: 'Reject', color: 'red' },
      { value: 'under_review', label: 'In Review', color: 'amber' }
    ],
    stamp_user_field: 'approved_by',
    stamp_date_field: 'approved_on'
  }
}

const junctionRows = [
  { purchase_order: 'po-1' },
  { purchase_order: 'po-2' },
  { purchase_order: 'po-1' } // dup — the walk must dedup
]

const invoiceIdRows = [{ id: 'inv-1' }, { id: 'inv-2' }, { id: 'inv-3' }]

const invoiceFullRows = [
  {
    id: 'inv-1',
    invoice_id: 'GRP-1',
    amount: 100,
    number: 'INV-1',
    hold_reason: 'pending',
    line_item_number: 'LI-1',
    efp_review_status: 'under_review',
    approved_by: null,
    approved_on: null
  },
  {
    id: 'inv-2',
    invoice_id: 'GRP-1',
    amount: 50,
    number: 'INV-2',
    hold_reason: 'pending',
    line_item_number: 'LI-2',
    efp_review_status: 'approved',
    approved_by: 'user-1',
    approved_on: '2026-07-01T00:00:00.000Z'
  },
  {
    id: 'inv-3',
    invoice_id: 'GRP-2',
    amount: 75,
    number: 'INV-3',
    hold_reason: 'review',
    line_item_number: 'LI-3',
    efp_review_status: 'rejected',
    approved_by: 'user-2',
    approved_on: '2026-07-02T00:00:00.000Z'
  }
]

const nivaroFieldsRows = [
  { field: 'number', label: 'PO Number' },
  { field: 'hold_reason', label: null }
]

const usersRows = [
  { id: 'user-1', first_name: 'Ann', last_name: 'Lee' },
  { id: 'user-2', first_name: 'Bo', last_name: 'Kim' }
]

function invoicesResolver(state: QueryState): unknown[] {
  if (state.table === 'nivaro_relations') return RELATIONS
  if (state.table === 'workflow_purchase_orders_junction') return junctionRows
  if (state.table === 'invoices') {
    const byId = state.whereIns.find(([f]) => f === 'id')
    if (byId) return invoiceFullRows.filter((r) => (byId[1] as string[]).includes(r.id))
    return invoiceIdRows
  }
  if (state.table === 'nivaro_fields') return nivaroFieldsRows
  if (state.table === 'nivaro_users') return usersRows
  throw new Error(`unexpected table: ${state.table}`)
}

describe('resolveReviewListRows — invoices 2-hop reverse walk (pinned fixture)', () => {
  it('walks workflows → purchase_orders (m2m) → invoices (m2o) and returns exact row/columns/truncated shape', async () => {
    vi.mocked(getCollection).mockResolvedValueOnce({
      display_template: '{{first_name}} {{last_name}}'
    } as unknown as Awaited<ReturnType<typeof getCollection>>)

    const states: QueryState[] = []
    const db = makeDb(invoicesResolver, states)
    const logger = makeLogger()

    const result = await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      invoicesConfig,
      '373944',
      logger
    )

    expect(result.truncated).toBe(false)
    expect(result.columns).toEqual({
      group_meta: [
        { field: 'number', label: 'PO Number' },
        { field: 'hold_reason', label: 'hold_reason' }
      ],
      line_columns: [
        { field: 'line_item_number', label: 'line_item_number' },
        { field: 'amount', label: 'amount' }
      ]
    })
    expect(result.rows).toEqual([
      {
        id: 'inv-1',
        group: 'GRP-1',
        values: { number: 'INV-1', hold_reason: 'pending', line_item_number: 'LI-1', amount: 100 },
        status: 'under_review',
        stamp_user: null,
        stamp_date: null
      },
      {
        id: 'inv-2',
        group: 'GRP-1',
        values: { number: 'INV-2', hold_reason: 'pending', line_item_number: 'LI-2', amount: 50 },
        status: 'approved',
        stamp_user: { id: 'user-1', label: 'Ann Lee' },
        stamp_date: '2026-07-01T00:00:00.000Z'
      },
      {
        id: 'inv-3',
        group: 'GRP-2',
        values: { number: 'INV-3', hold_reason: 'review', line_item_number: 'LI-3', amount: 75 },
        status: 'rejected',
        stamp_user: { id: 'user-2', label: 'Bo Kim' },
        stamp_date: '2026-07-02T00:00:00.000Z'
      }
    ])

    // Junction query used the correct fk-to-current / fk-to-outward columns.
    const junctionCall = states.find((s) => s.table === 'workflow_purchase_orders_junction')
    expect(junctionCall?.whereIns).toEqual([['workflow', ['373944']]])
    expect(junctionCall?.selectArgs).toEqual(['purchase_order'])

    // m2o hop deduped the junction's repeated purchase_order id.
    const invoiceIdCall = states.find(
      (s) => s.table === 'invoices' && s.whereIns.some(([f]) => f === 'purchase_order')
    )
    expect(invoiceIdCall?.whereIns).toEqual([['purchase_order', ['po-1', 'po-2']]])

    // Target query applied the static_filter eq op alongside the id linkage.
    const targetCall = states.find(
      (s) => s.table === 'invoices' && s.whereIns.some(([f]) => f === 'id')
    )
    expect(targetCall?.whereIns).toEqual([['id', ['inv-1', 'inv-2', 'inv-3']]])
    expect(targetCall?.wheres).toEqual([['is_on_hold', true]])
  })
})

describe('resolveReviewListRows — m2o-only single hop', () => {
  const config: ReviewListConfig = {
    host_collection: 'purchase_orders',
    collection: 'invoices',
    path: [{ kind: 'm2o', field: 'purchase_order' }],
    group_by: 'invoice_id',
    status: { field: 'efp_review_status', options: [{ value: 'x', label: 'X', color: 'slate' }] }
  }

  it('resolves invoices whose purchase_order matches the host record id', async () => {
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS
      if (state.table === 'invoices') {
        const byId = state.whereIns.find(([f]) => f === 'id')
        if (byId) {
          return [
            {
              id: 'inv-9',
              invoice_id: 'GRP-9',
              efp_review_status: 'under_review'
            }
          ]
        }
        return [{ id: 'inv-9' }]
      }
      if (state.table === 'nivaro_fields') return []
      throw new Error(`unexpected table: ${state.table}`)
    })

    const result = await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      config,
      'po-1'
    )

    expect(result.rows).toEqual([
      {
        id: 'inv-9',
        group: 'GRP-9',
        values: {},
        status: 'under_review',
        stamp_user: null,
        stamp_date: null
      }
    ])
    expect(result.truncated).toBe(false)
  })
})

describe('resolveReviewListRows — cap truncation', () => {
  const config: ReviewListConfig = {
    host_collection: 'purchase_orders',
    collection: 'invoices',
    path: [{ kind: 'm2o', field: 'purchase_order' }],
    group_by: 'invoice_id',
    status: { field: 'efp_review_status', options: [{ value: 'x', label: 'X', color: 'slate' }] }
  }

  it('sets truncated: true and warns when a hop query hits the 2000 cap', async () => {
    const cappedIdRows = Array.from({ length: 2000 }, (_, i) => ({ id: `inv-${i}` }))
    const logger = makeLogger()
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS
      if (state.table === 'invoices') {
        const byId = state.whereIns.find(([f]) => f === 'id')
        if (byId) return []
        return cappedIdRows
      }
      if (state.table === 'nivaro_fields') return []
      throw new Error(`unexpected table: ${state.table}`)
    })

    const result = await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      config,
      'po-1',
      logger
    )

    expect(result.truncated).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'invoices', hop: 'purchase_order' }),
      expect.stringContaining('truncated')
    )
  })
})

describe('resolveReviewListRows — dead relation', () => {
  const config: ReviewListConfig = {
    host_collection: 'purchase_orders',
    collection: 'invoices',
    path: [{ kind: 'm2o', field: 'nonexistent_fk' }],
    group_by: 'invoice_id',
    status: { field: 'efp_review_status', options: [{ value: 'x', label: 'X', color: 'slate' }] }
  }

  it('throws statusCode 400 naming the hop field when no relation resolves the hop', async () => {
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS
      throw new Error(`unexpected table: ${state.table}`)
    })

    await expect(
      resolveReviewListRows(
        db as unknown as Parameters<typeof resolveReviewListRows>[0],
        config,
        'po-1'
      )
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('nonexistent_fk') })
  })
})

describe('resolveReviewListRows — static_filter ops', () => {
  const config: ReviewListConfig = {
    host_collection: 'purchase_orders',
    collection: 'invoices',
    path: [{ kind: 'm2o', field: 'purchase_order' }],
    static_filter: [
      { field: 'is_on_hold', op: 'eq', value: true },
      { field: 'status', op: 'neq', value: 'void' },
      { field: 'closed_at', op: 'nnull' }
    ],
    group_by: 'invoice_id',
    status: { field: 'efp_review_status', options: [{ value: 'x', label: 'X', color: 'slate' }] }
  }

  it('applies eq → where, neq → whereNot, nnull → whereNotNull on the target query', async () => {
    const states: QueryState[] = []
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS
      if (state.table === 'invoices') {
        const byId = state.whereIns.find(([f]) => f === 'id')
        return byId ? [] : [{ id: 'inv-1' }]
      }
      if (state.table === 'nivaro_fields') return []
      throw new Error(`unexpected table: ${state.table}`)
    }, states)

    await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      config,
      'po-1'
    )

    const targetCall = states.find(
      (s) => s.table === 'invoices' && s.whereIns.some(([f]) => f === 'id')
    )
    expect(targetCall?.wheres).toEqual([['is_on_hold', true]])
    expect(targetCall?.whereNots).toEqual([['status', 'void']])
    expect(targetCall?.whereNotNulls).toEqual(['closed_at'])
  })
})

describe('resolveReviewListRows — dot-path label resolution (one M2O hop)', () => {
  const config: ReviewListConfig = {
    host_collection: 'purchase_orders',
    collection: 'invoices',
    path: [{ kind: 'm2o', field: 'purchase_order' }],
    group_by: 'invoice_id',
    group_meta: ['purchase_order.number'],
    status: { field: 'efp_review_status', options: [{ value: 'x', label: 'X', color: 'slate' }] }
  }

  it('resolves the related record field named after the dot, not a display template', async () => {
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS
      if (state.table === 'invoices') {
        const byId = state.whereIns.find(([f]) => f === 'id')
        if (byId) {
          return [
            {
              id: 'inv-1',
              invoice_id: 'GRP-1',
              purchase_order: 'po-1',
              efp_review_status: 'under_review'
            }
          ]
        }
        return [{ id: 'inv-1' }]
      }
      if (state.table === 'purchase_orders') {
        expect(state.whereIns).toEqual([['id', ['po-1']]])
        expect(state.selectArgs).toEqual(['id', 'number'])
        return [{ id: 'po-1', number: 'PO-100' }]
      }
      if (state.table === 'nivaro_fields') return []
      throw new Error(`unexpected table: ${state.table}`)
    })

    const result = await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      config,
      'po-1'
    )

    expect(result.rows[0].values).toEqual({ 'purchase_order.number': 'PO-100' })
    expect(result.columns.group_meta).toEqual([
      { field: 'purchase_order.number', label: 'purchase_order.number' }
    ])
  })
})

// ─── validateReviewListConfig — config validation matrix ───────────────────

function baseValidConfig(): unknown {
  return {
    host_collection: 'workflows',
    collection: 'invoices',
    path: [
      { kind: 'm2o', field: 'purchase_order' },
      { kind: 'm2m', field: 'workflows' }
    ],
    group_by: 'invoice_id',
    status: {
      field: 'efp_review_status',
      options: [{ value: 'approved', label: 'Approve', color: 'green' }]
    }
  }
}

describe('validateReviewListConfig', () => {
  it('accepts a valid config that resolves against relations and terminates at host_collection', () => {
    expect(validateReviewListConfig(baseValidConfig(), RELATIONS)).toBeNull()
  })

  it('rejects a bad identifier (host_collection)', () => {
    const cfg = {
      ...(baseValidConfig() as Record<string, unknown>),
      host_collection: '1bad; DROP TABLE x;--'
    }
    expect(validateReviewListConfig(cfg, RELATIONS)).toMatch(/host_collection/)
  })

  it('rejects a bad identifier in a path hop field', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.path = [{ kind: 'm2o', field: 'not a field!' }]
    expect(validateReviewListConfig(cfg, RELATIONS)).toMatch(/path\[0\]\.field/)
  })

  it('rejects more than 4 hops', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.path = [
      { kind: 'm2o', field: 'a' },
      { kind: 'm2o', field: 'b' },
      { kind: 'm2o', field: 'c' },
      { kind: 'm2o', field: 'd' },
      { kind: 'm2o', field: 'e' }
    ]
    expect(validateReviewListConfig(cfg, RELATIONS)).toMatch(/at most 4 hops/)
  })

  it('rejects a path that does not terminate at host_collection', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.host_collection = 'not_workflows'
    expect(validateReviewListConfig(cfg, RELATIONS)).toMatch(
      /does not terminate at host_collection/
    )
  })

  it('rejects a path hop with no matching relation', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.path = [{ kind: 'm2o', field: 'ghost_field' }]
    expect(validateReviewListConfig(cfg, RELATIONS)).toMatch(/ghost_field/)
  })

  it('rejects duplicate status option values', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.status = {
      field: 'efp_review_status',
      options: [
        { value: 'approved', label: 'Approve', color: 'green' },
        { value: 'approved', label: 'Approve Again', color: 'blue' }
      ]
    }
    expect(validateReviewListConfig(cfg, RELATIONS)).toMatch(/duplicate/)
  })

  it('rejects empty status.options', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.status = { field: 'efp_review_status', options: [] }
    expect(validateReviewListConfig(cfg, RELATIONS)).toMatch(/non-empty/)
  })

  it('rejects a dot-path with more than one hop', () => {
    const cfg = baseValidConfig() as Record<string, unknown>
    cfg.group_meta = ['a.b.c']
    expect(validateReviewListConfig(cfg, RELATIONS)).toMatch(/group_meta/)
  })

  it('rejects a non-object config', () => {
    expect(validateReviewListConfig('nope', RELATIONS)).toMatch(/object/)
  })
})

describe('static_filter value requirement', () => {
  it('rejects eq/neq filters missing a value; nnull needs none', () => {
    const base = {
      host_collection: 'workflows',
      collection: 'invoices',
      path: [
        { kind: 'm2o', field: 'purchase_order' },
        { kind: 'm2m', field: 'workflows' }
      ],
      group_by: 'invoice_id',
      status: { field: 's', options: [{ value: 'a', label: 'A', color: 'green' }] }
    }
    expect(
      validateReviewListConfig(
        { ...base, static_filter: [{ field: 'is_on_hold', op: 'eq' }] },
        RELATIONS
      )
    ).toMatch(/value is required/)
    expect(
      validateReviewListConfig(
        { ...base, static_filter: [{ field: 'is_on_hold', op: 'nnull' }] },
        RELATIONS
      )
    ).toBeNull()
  })
})
