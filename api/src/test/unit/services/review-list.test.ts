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
        { field: 'number', label: 'PO Number', format: null },
        { field: 'hold_reason', label: 'hold_reason', format: null }
      ],
      line_columns: [
        { field: 'line_item_number', label: 'line_item_number', format: null },
        { field: 'amount', label: 'amount', format: null }
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
  // aggregate_sum ('amount') is deliberately NOT in line_columns here — it
  // must still ride in `values` (see the "aggregate_sum" test below), and
  // this base config exercises the plain single-hop walk otherwise.
  const config: ReviewListConfig = {
    host_collection: 'purchase_orders',
    collection: 'invoices',
    path: [{ kind: 'm2o', field: 'purchase_order' }],
    group_by: 'invoice_id',
    aggregate_sum: 'amount',
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
              amount: 42,
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

    // aggregate_sum rides in `values` even though it isn't in line_columns
    // (line_columns is unset here entirely).
    expect(result.rows).toEqual([
      {
        id: 'inv-9',
        group: 'GRP-9',
        values: { amount: 42 },
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
      { field: 'purchase_order.number', label: 'purchase_order.number', format: null }
    ])
  })
})

describe('resolveReviewListRows — object column specs (label override + format)', () => {
  it('emits config label/format in columns and keys values by the spec field', async () => {
    const config: ReviewListConfig = {
      ...invoicesConfig,
      group_meta: [{ field: 'number', label: 'Invoice #' }],
      line_columns: ['line_item_number', { field: 'amount', label: 'Amount', format: 'currency' }]
    }
    vi.mocked(getCollection).mockResolvedValueOnce({
      display_template: '{{first_name}} {{last_name}}'
    } as unknown as Awaited<ReturnType<typeof getCollection>>)
    const db = makeDb(invoicesResolver, [])

    const result = await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      config,
      '373944'
    )

    // Config label wins over the nivaro_fields label ('PO Number'); string
    // entries stay back-compatible with format: null.
    expect(result.columns).toEqual({
      group_meta: [{ field: 'number', label: 'Invoice #', format: null }],
      line_columns: [
        { field: 'line_item_number', label: 'line_item_number', format: null },
        { field: 'amount', label: 'Amount', format: 'currency' }
      ]
    })
    expect(result.rows[0].values).toEqual({
      number: 'INV-1',
      line_item_number: 'LI-1',
      amount: 100
    })
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

  it('accepts object column specs and rejects bad format / empty label', () => {
    const ok = baseValidConfig() as Record<string, unknown>
    ok.group_meta = ['number', { field: 'amount', label: 'Amount', format: 'currency' }]
    ok.line_columns = [{ field: 'purchase_order.number' }]
    expect(validateReviewListConfig(ok, RELATIONS)).toBeNull()

    const badFormat = baseValidConfig() as Record<string, unknown>
    badFormat.line_columns = [{ field: 'amount', format: 'money' }]
    expect(validateReviewListConfig(badFormat, RELATIONS)).toMatch(/line_columns\[0\].format/)

    const emptyLabel = baseValidConfig() as Record<string, unknown>
    emptyLabel.group_meta = [{ field: 'amount', label: '' }]
    expect(validateReviewListConfig(emptyLabel, RELATIONS)).toMatch(/group_meta\[0\].label/)

    const badField = baseValidConfig() as Record<string, unknown>
    badField.group_meta = [{ field: 'a.b.c' }]
    expect(validateReviewListConfig(badField, RELATIONS)).toMatch(/group_meta\[0\].field/)
  })

  it('validates aggregate_sum_format against the format enum', () => {
    const ok = baseValidConfig() as Record<string, unknown>
    ok.aggregate_sum = 'amount'
    ok.aggregate_sum_format = 'currency'
    expect(validateReviewListConfig(ok, RELATIONS)).toBeNull()

    const bad = baseValidConfig() as Record<string, unknown>
    bad.aggregate_sum_format = 'money'
    expect(validateReviewListConfig(bad, RELATIONS)).toMatch(/aggregate_sum_format/)
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

// ─── C1: reverse-walk anchoring must use BOTH ends of the relation ─────────
//
// A reverse hop keyed only on `one_collection === currentCollection` (or
// `related === currentCollection` for m2m) picks the FIRST matching relation
// row — ambiguous when two collections carry the same FK field name to the
// same target. The fix anchors every reverse hop with the owning collection
// taken from the deterministic forward chain (target → host) as well.

describe('resolveReviewListRows — ambiguous relation anchoring (C1)', () => {
  // unit_materials and unit_workflows both have a field named "unit" pointing
  // at "units" — real shape in this schema. unit_materials is listed FIRST so
  // a first-match lookup keyed only on one_collection would wrongly resolve
  // to it instead of unit_workflows (the collection config.path actually names).
  const AMBIGUOUS_RELATIONS: RelRow[] = [
    {
      many_collection: 'unit_materials',
      many_field: 'unit',
      one_collection: 'units',
      one_field: null,
      junction_field: null
    },
    {
      many_collection: 'unit_workflows',
      many_field: 'unit',
      one_collection: 'units',
      one_field: null,
      junction_field: null
    }
  ]

  const config: ReviewListConfig = {
    host_collection: 'units',
    collection: 'unit_workflows',
    path: [{ kind: 'm2o', field: 'unit' }],
    group_by: 'status_group',
    status: { field: 'status', options: [{ value: 'open', label: 'Open', color: 'blue' }] }
  }

  it('anchors the reverse m2o hop on the forward-chain owning collection, not the first one_collection match', async () => {
    const states: QueryState[] = []
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return AMBIGUOUS_RELATIONS
      if (state.table === 'unit_workflows') {
        const byId = state.whereIns.find(([f]) => f === 'id')
        if (byId) return [{ id: 'uw-1', status_group: 'G1', status: 'open' }]
        return [{ id: 'uw-1' }]
      }
      if (state.table === 'unit_materials') {
        throw new Error('review_list resolved the wrong table: unit_materials')
      }
      if (state.table === 'nivaro_fields') return []
      throw new Error(`unexpected table: ${state.table}`)
    }, states)

    const result = await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      config,
      'unit-1'
    )

    expect(result.rows).toEqual([
      { id: 'uw-1', group: 'G1', values: {}, status: 'open', stamp_user: null, stamp_date: null }
    ])

    const hopCall = states.find(
      (s) => s.table === 'unit_workflows' && s.whereIns.some(([f]) => f === 'unit')
    )
    expect(hopCall?.whereIns).toEqual([['unit', ['unit-1']]])
    expect(states.some((s) => s.table === 'unit_materials')).toBe(false)
  })
})

describe('resolveReviewListRows — m2m-only single hop (executed)', () => {
  const config: ReviewListConfig = {
    host_collection: 'workflows',
    collection: 'purchase_orders',
    path: [{ kind: 'm2m', field: 'workflows' }],
    group_by: 'number',
    status: { field: 'po_status', options: [{ value: 'x', label: 'X', color: 'slate' }] }
  }

  it('walks workflows → purchase_orders via the m2m alias/junction and resolves target rows', async () => {
    const states: QueryState[] = []
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS
      if (state.table === 'workflow_purchase_orders_junction') return [{ purchase_order: 'po-5' }]
      if (state.table === 'purchase_orders') {
        const byId = state.whereIns.find(([f]) => f === 'id')
        if (byId) return [{ id: 'po-5', number: 'PO-5', po_status: 'open' }]
        return [{ id: 'po-5' }]
      }
      if (state.table === 'nivaro_fields') return []
      throw new Error(`unexpected table: ${state.table}`)
    }, states)

    const result = await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      config,
      'wf-1'
    )

    expect(result.rows).toEqual([
      { id: 'po-5', group: 'PO-5', values: {}, status: 'open', stamp_user: null, stamp_date: null }
    ])

    const junctionCall = states.find((s) => s.table === 'workflow_purchase_orders_junction')
    expect(junctionCall?.whereIns).toEqual([['workflow', ['wf-1']]])
    expect(junctionCall?.selectArgs).toEqual(['purchase_order'])
  })
})

describe('resolveReviewListRows — 4-hop reverse walk (m2o, m2m, m2o, m2m)', () => {
  const RELATIONS_4HOP: RelRow[] = [
    // line_items.invoice (m2o) → invoices
    {
      many_collection: 'line_items',
      many_field: 'invoice',
      one_collection: 'invoices',
      one_field: null,
      junction_field: null
    },
    // invoices m2m alias "purchase_orders" via invoice_po_junction
    {
      many_collection: 'invoice_po_junction',
      many_field: 'invoice',
      one_collection: 'invoices',
      one_field: 'purchase_orders',
      junction_field: 'purchase_order'
    },
    {
      many_collection: 'invoice_po_junction',
      many_field: 'purchase_order',
      one_collection: 'purchase_orders',
      one_field: null,
      junction_field: null
    },
    // purchase_orders.workflow (m2o) → workflows
    {
      many_collection: 'purchase_orders',
      many_field: 'workflow',
      one_collection: 'workflows',
      one_field: null,
      junction_field: null
    },
    // workflows m2m alias "companies" via workflow_company_junction
    {
      many_collection: 'workflow_company_junction',
      many_field: 'workflow',
      one_collection: 'workflows',
      one_field: 'companies',
      junction_field: 'company'
    },
    {
      many_collection: 'workflow_company_junction',
      many_field: 'company',
      one_collection: 'companies',
      one_field: null,
      junction_field: null
    }
  ]

  const config: ReviewListConfig = {
    host_collection: 'companies',
    collection: 'line_items',
    path: [
      { kind: 'm2o', field: 'invoice' },
      { kind: 'm2m', field: 'purchase_orders' },
      { kind: 'm2o', field: 'workflow' },
      { kind: 'm2m', field: 'companies' }
    ],
    group_by: 'li_group',
    status: { field: 'li_status', options: [{ value: 'open', label: 'Open', color: 'blue' }] }
  }

  it('walks companies → workflows → purchase_orders → invoices → line_items across all 4 hops, in table order', async () => {
    const states: QueryState[] = []
    const db = makeDb((state) => {
      if (state.table === 'nivaro_relations') return RELATIONS_4HOP
      if (state.table === 'workflow_company_junction') return [{ workflow: 'wf-9' }]
      if (state.table === 'purchase_orders') return [{ id: 'po-9' }]
      if (state.table === 'invoice_po_junction') return [{ invoice: 'inv-9' }]
      if (state.table === 'line_items') {
        const byId = state.whereIns.find(([f]) => f === 'id')
        if (byId) return [{ id: 'li-9', li_group: 'GRP-9', li_status: 'open' }]
        return [{ id: 'li-9' }]
      }
      if (state.table === 'nivaro_fields') return []
      throw new Error(`unexpected table: ${state.table}`)
    }, states)

    const result = await resolveReviewListRows(
      db as unknown as Parameters<typeof resolveReviewListRows>[0],
      config,
      'company-1'
    )

    expect(result.rows).toEqual([
      { id: 'li-9', group: 'GRP-9', values: {}, status: 'open', stamp_user: null, stamp_date: null }
    ])

    // Full table-query sequence, in order — proves every hop anchored to the
    // correct table across the entire chain, not just a lucky first match.
    expect(states.map((s) => s.table)).toEqual([
      'nivaro_relations',
      'workflow_company_junction',
      'purchase_orders',
      'invoice_po_junction',
      'line_items',
      'line_items',
      'nivaro_fields'
    ])

    expect(states[1].whereIns).toEqual([['company', ['company-1']]])
    expect(states[1].selectArgs).toEqual(['workflow'])

    expect(states[2].whereIns).toEqual([['workflow', ['wf-9']]])

    expect(states[3].whereIns).toEqual([['purchase_order', ['po-9']]])
    expect(states[3].selectArgs).toEqual(['invoice'])

    expect(states[4].whereIns).toEqual([['invoice', ['inv-9']]])
  })
})
