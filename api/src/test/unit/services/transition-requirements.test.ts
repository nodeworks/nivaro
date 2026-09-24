import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { evaluateTransitionRequirements } from '../../../services/transition-requirements.js'

afterEach(() => vi.restoreAllMocks())

function makeLogger() {
  return { warn: vi.fn() }
}

describe('evaluateTransitionRequirements — read-time identifier re-validation', () => {
  it('skips a hand-edited malicious child_fields entry without ever touching the database', async () => {
    const dbMock = vi.fn(() => {
      throw new Error('database should never be queried for a malformed entry')
    })
    const logger = makeLogger()

    const requirements = JSON.stringify([
      {
        type: 'child_fields',
        // Hand-edited past the create/PATCH validator — not a valid identifier.
        collection: 'users; DROP TABLE nivaro_users;--',
        fk_field: 'workflow',
        fields: ['req_id']
      }
    ])

    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      requirements,
      'item-1',
      logger
    )

    expect(result).toBeNull()
    expect(dbMock).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.any(Object) }),
      expect.stringContaining('malformed child_fields entry')
    )
  })

  it('skips an entry with an invalid fk_field identifier without touching the database', async () => {
    const dbMock = vi.fn(() => {
      throw new Error('database should never be queried for a malformed entry')
    })
    const logger = makeLogger()

    const requirements = JSON.stringify([
      {
        type: 'child_fields',
        collection: 'workflow_line_items',
        fk_field: '1); DROP TABLE workflow_line_items;--',
        fields: ['req_id']
      }
    ])

    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      requirements,
      'item-1',
      logger
    )

    expect(result).toBeNull()
    expect(dbMock).not.toHaveBeenCalled()
  })
})

describe('evaluateTransitionRequirements — child-query failure fails open loudly', () => {
  it('logs a warning and treats the requirement as passed when the child-row query throws', async () => {
    const logger = makeLogger()
    const dbMock = vi.fn((table: string) => {
      if (table === 'nivaro_fields') {
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      }
      // Child collection query: where(...).limit(2000).select([...]) — throws to
      // simulate a misconfigured fk_field (column doesn't exist, bad grants, etc).
      return {
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            select: vi.fn(() => Promise.reject(new Error('column "workflow" does not exist')))
          }))
        }))
      }
    })

    const requirements = JSON.stringify([
      {
        type: 'child_fields',
        collection: 'workflow_line_items',
        fk_field: 'workflow',
        fields: ['req_id']
      }
    ])

    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      requirements,
      'item-1',
      logger
    )

    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'workflow_line_items',
        fkField: 'workflow'
      }),
      expect.stringContaining('child row query failed')
    )
  })

  it('falls back to console.warn (its own logger) when no logger is passed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dbMock = vi.fn((table: string) => {
      if (table === 'nivaro_fields') {
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      }
      return {
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            select: vi.fn(() => Promise.reject(new Error('boom')))
          }))
        }))
      }
    })

    const requirements = JSON.stringify([
      {
        type: 'child_fields',
        collection: 'workflow_line_items',
        fk_field: 'workflow',
        fields: ['req_id']
      }
    ])

    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      requirements,
      'item-1'
    )

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })
})

// ─── child_fields field metadata ─────────────────────────────────────────────
// A minimal chainable knex stand-in: every builder method returns the builder,
// `select`/`first`/await resolve that table's rows. Filters are ignored — each
// test controls the rows per table, which is all these assertions need.
type FakeBuilder = Record<string, ReturnType<typeof vi.fn>>
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const builders: Record<string, FakeBuilder[]> = {}
  const fn = vi.fn((table: string) => {
    if (!(table in tables)) throw new Error(`no fake rows for table ${table}`)
    const rows = tables[table]
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNull', 'limit', 'orderBy']) {
      b[m] = vi.fn(() => b)
    }
    b.select = vi.fn(() => Promise.resolve(rows))
    b.first = vi.fn(() => Promise.resolve(rows[0]))
    // Awaiting the bare builder resolves the rows, like a real knex builder.
    // biome-ignore lint/suspicious/noThenProperty: deliberately thenable
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    const list = builders[table] ?? []
    builders[table] = list
    list.push(b as FakeBuilder)
    return b
  })
  return Object.assign(fn, { builders })
}

const LINE_RELATIONS = [
  // child row's own M2O: line.expenditure_type → tasks
  {
    many_collection: 'order_lines',
    many_field: 'expenditure_type',
    one_collection: 'tasks',
    one_field: null,
    junction_field: null
  },
  // M2M alias: line.warehouses via junction order_lines_warehouses
  {
    many_collection: 'order_lines_warehouses',
    many_field: 'order_lines_id',
    one_collection: 'order_lines',
    one_field: 'warehouses',
    junction_field: 'warehouses_id'
  },
  {
    many_collection: 'order_lines_warehouses',
    many_field: 'warehouses_id',
    one_collection: 'warehouses',
    one_field: null,
    junction_field: null
  }
]

async function evaluateLines(
  tables: Record<string, Array<Record<string, unknown>>>,
  entry: Record<string, unknown>
) {
  const dbMock = fakeDb(tables)
  const logger = makeLogger()
  const result = await evaluateTransitionRequirements(
    dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
    JSON.stringify([
      { type: 'child_fields', collection: 'order_lines', fk_field: 'order', ...entry }
    ]),
    'order-1',
    logger
  )
  return { result, logger, dbMock }
}

describe('evaluateTransitionRequirements — child_fields field kinds', () => {
  it('tags a required child M2O column as an m2o picker over its related collection', async () => {
    const { result } = await evaluateLines(
      {
        nivaro_fields: [{ field: 'expenditure_type', label: 'Expenditure Type', type: 'integer' }],
        nivaro_relations: LINE_RELATIONS,
        order_lines: [{ id: 1, expenditure_type: null }]
      },
      { fields: ['expenditure_type'] }
    )
    expect(result).not.toBeNull()
    const block = result?.[0]
    if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
    expect(block.fields[0]).toMatchObject({
      field: 'expenditure_type',
      label: 'Expenditure Type',
      kind: 'm2o',
      related_collection: 'tasks'
    })
    expect(block.rows[0].complete).toBe(false)
  })

  it('still tags an M2M alias as m2m and leaves a plain scalar without a kind', async () => {
    const { result } = await evaluateLines(
      {
        nivaro_fields: [{ field: 'sales_order_id', label: 'Sales Order ID', type: 'string' }],
        nivaro_relations: LINE_RELATIONS,
        order_lines: [{ id: 1, sales_order_id: null }],
        order_lines_warehouses: []
      },
      { fields: ['sales_order_id', 'warehouses'] }
    )
    const block = result?.[0]
    if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
    const byField = Object.fromEntries(block.fields.map((f) => [f.field, f]))
    expect(byField.sales_order_id.kind).toBeUndefined()
    expect(byField.warehouses).toMatchObject({
      kind: 'm2m',
      related_collection: 'warehouses',
      junction: 'order_lines_warehouses'
    })
  })

  it('reports a filled child M2O column as complete (the raw id is the value)', async () => {
    const { result } = await evaluateLines(
      {
        nivaro_fields: [],
        nivaro_relations: LINE_RELATIONS,
        order_lines: [{ id: 1, expenditure_type: 7 }],
        tasks: [{ id: 7, name: 'Backbone' }]
      },
      { fields: ['expenditure_type'] }
    )
    // Every row complete → the gate passes → null.
    expect(result).toBeNull()
  })
})

describe('evaluateTransitionRequirements — optional_when.in_query', () => {
  const lineTables = {
    nivaro_fields: [{ field: 'sales_order_id', label: 'Sales Order ID', type: 'string' }],
    nivaro_relations: LINE_RELATIONS,
    order_lines: [{ id: 1, sales_order_id: null }],
    // line 1's junction row: warehouse 5
    order_lines_warehouses: [{ order_lines_id: 1, warehouses_id: 5 }]
  }
  const entry = (rule: Record<string, unknown>) => ({
    fields: ['sales_order_id', 'warehouses'],
    optional_when: { sales_order_id: rule }
  })

  it('resolves the waiver list from a filtered query and hands the dialog a plain `in`', async () => {
    const { result, dbMock } = await evaluateLines(
      { ...lineTables, warehouses: [{ id: 3 }, { id: 5 }] },
      entry({
        field: 'warehouses',
        in_query: { collection: 'warehouses', filter: { ordering_system: ['auto_a', 'auto_b'] } },
        placeholder: 'Auto-assigned'
      })
    )
    // Line 1 sits on warehouse 5, which the query returned → waived → nothing blocks.
    expect(result).toBeNull()
    const wh = dbMock.builders.warehouses[0]
    expect(wh.whereIn).toHaveBeenCalledWith('ordering_system', ['auto_a', 'auto_b'])
    expect(wh.limit).toHaveBeenCalledWith(500)
    expect(wh.select).toHaveBeenCalledWith('id')
  })

  it('exposes the resolved list (not the query) on the field meta when a row still blocks', async () => {
    const { result } = await evaluateLines(
      {
        ...lineTables,
        order_lines_warehouses: [{ order_lines_id: 1, warehouses_id: 4 }], // manual warehouse
        warehouses: [{ id: 3 }, { id: 5 }]
      },
      entry({ field: 'warehouses', in_query: { collection: 'warehouses' }, placeholder: 'Auto' })
    )
    const block = result?.[0]
    if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
    expect(block.fields[0].optional_when).toEqual({
      field: 'warehouses',
      in: [3, 5],
      placeholder: 'Auto'
    })
    expect(block.rows[0].complete).toBe(false)
  })

  it('unions a static `in` with the query result', async () => {
    const { result } = await evaluateLines(
      { ...lineTables, warehouses: [{ id: 3 }] },
      entry({ field: 'warehouses', in: [5], in_query: { collection: 'warehouses' } })
    )
    expect(result).toBeNull() // 5 came from the static list
  })

  it('uses value_field and null / scalar filter forms', async () => {
    const { dbMock } = await evaluateLines(
      { ...lineTables, warehouses: [{ code: 5 }] },
      entry({
        field: 'warehouses',
        in_query: {
          collection: 'warehouses',
          filter: { region: null, active: true },
          value_field: 'code'
        }
      })
    )
    const wh = dbMock.builders.warehouses[0]
    expect(wh.whereNull).toHaveBeenCalledWith('region')
    expect(wh.where).toHaveBeenCalledWith('active', true)
    expect(wh.select).toHaveBeenCalledWith('code')
  })

  it('fails closed: a query that throws drops the rule and the field stays required', async () => {
    const tables = { ...lineTables, warehouses: [] as Array<Record<string, unknown>> }
    const dbMock = fakeDb(tables)
    const boom = new Error('Invalid column name ordering_system')
    const original = dbMock.getMockImplementation() as (t: string) => Record<string, unknown>
    dbMock.mockImplementation((table: string) => {
      const b = original(table)
      if (table === 'warehouses') b.select = vi.fn(() => Promise.reject(boom))
      return b
    })
    const logger = makeLogger()
    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      JSON.stringify([
        {
          type: 'child_fields',
          collection: 'order_lines',
          fk_field: 'order',
          ...entry({ field: 'warehouses', in_query: { collection: 'warehouses' } })
        }
      ]),
      'order-1',
      logger
    )
    const block = result?.[0]
    if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
    expect(block.fields[0].optional_when).toBeUndefined()
    expect(block.rows[0].complete).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, target: 'sales_order_id' }),
      expect.stringContaining('in_query failed')
    )
  })

  it('fails closed on a system collection or a bad identifier without querying it', async () => {
    for (const bad of [
      { collection: 'nivaro_users' },
      { collection: 'warehouses; DROP TABLE x' },
      { collection: 'warehouses', value_field: 'id; --' },
      { collection: 'warehouses', filter: { 'a b': 1 } }
    ]) {
      const { result, logger, dbMock } = await evaluateLines(
        { ...lineTables, warehouses: [{ id: 5 }], nivaro_users: [{ id: 5 }] },
        entry({ field: 'warehouses', in_query: bad })
      )
      const block = result?.[0]
      if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
      expect(block.fields[0].optional_when).toBeUndefined()
      // The m2m alias legitimately reads warehouses for row labels (select '*');
      // the waiver query (select 'id' / the given value_field) must never run.
      for (const b of dbMock.builders.warehouses ?? []) {
        expect(b.select).not.toHaveBeenCalledWith('id')
        expect(b.select).not.toHaveBeenCalledWith('id; --')
      }
      expect(dbMock.builders.nivaro_users ?? []).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ target: 'sales_order_id' }),
        expect.stringContaining('in_query malformed')
      )
    }
  })

  it('drops a rule whose query matches nothing and has no static list', async () => {
    const { result } = await evaluateLines(
      { ...lineTables, warehouses: [] },
      entry({ field: 'warehouses', in_query: { collection: 'warehouses' } })
    )
    const block = result?.[0]
    if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
    expect(block.fields[0].optional_when).toBeUndefined()
  })

  it('a plain static `in` rule behaves exactly as before', async () => {
    const { result } = await evaluateLines(
      lineTables,
      entry({ field: 'warehouses', in: [5], placeholder: 'Auto (x)' })
    )
    expect(result).toBeNull()
  })
})

describe('evaluateTransitionRequirements — review_when', () => {
  const filled = {
    nivaro_fields: [{ field: 'sales_order_id', label: 'Sales Order ID', type: 'string' }],
    nivaro_relations: LINE_RELATIONS,
    order_lines: [{ id: 1, sales_order_id: 'SO-1' }],
    // the transitioning record (fakeDb keys by table; the record collection is 'orders')
    orders: [{ id: 'order-1', push_status: 'error' }]
  }
  const entry = (over: Record<string, unknown>) => ({
    fields: ['sales_order_id'],
    review_when: { field: 'push_status', in: ['error'] },
    ...over
  })
  const evaluate = async (
    tables: Record<string, Array<Record<string, unknown>>>,
    e: Record<string, unknown>,
    opts?: { reviewed?: boolean }
  ) => {
    const dbMock = fakeDb(tables)
    const logger = makeLogger()
    const result = await evaluateTransitionRequirements(
      dbMock as unknown as Parameters<typeof evaluateTransitionRequirements>[0],
      JSON.stringify([
        { type: 'child_fields', collection: 'order_lines', fk_field: 'order', ...e }
      ]),
      'order-1',
      logger,
      'orders',
      opts
    )
    return { result, logger }
  }

  it('brings every (filled) row back for review when the record matches', async () => {
    const { result } = await evaluate(filled, entry({}))
    const block = result?.[0]
    if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
    expect(block.review).toBe(true)
    expect(block.review_message).toMatch(/not accepted/)
    expect(block.rows).toHaveLength(1)
    expect(block.rows[0].complete).toBe(true)
  })

  it("uses the entry's own review_message when given", async () => {
    const { result } = await evaluate(
      filled,
      entry({ review_message: 'Fusion said no — fix the lines.' })
    )
    const block = result?.[0]
    if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
    expect(block.review_message).toBe('Fusion said no — fix the lines.')
  })

  it('does not ask again once the caller says the rows were reviewed', async () => {
    const { result } = await evaluate(filled, entry({}), { reviewed: true })
    expect(result).toBeNull()
  })

  it('still blocks on an incomplete row even when reviewed', async () => {
    const { result } = await evaluate(
      { ...filled, order_lines: [{ id: 1, sales_order_id: null }] },
      entry({}),
      { reviewed: true }
    )
    const block = result?.[0]
    if (block?.type !== 'child_fields') throw new Error('expected a child_fields block')
    expect(block.review).toBeUndefined()
    expect(block.rows[0].complete).toBe(false)
  })

  it('passes when the record does not match, and accepts a list of rules', async () => {
    const ok = await evaluate(
      { ...filled, orders: [{ id: 'order-1', push_status: 'requested' }] },
      entry({})
    )
    expect(ok.result).toBeNull()
    const list = await evaluate(
      { ...filled, orders: [{ id: 'order-1', push_status: null, other_status: 'error' }] },
      entry({
        review_when: [
          { field: 'push_status', in: ['error'] },
          { field: 'other_status', in: ['error'] }
        ]
      })
    )
    expect(list.result?.[0]).toMatchObject({ review: true })
  })

  it('ignores a malformed rule and a record query failure — never blocks on bad config', async () => {
    const bad = await evaluate(filled, entry({ review_when: { field: 'a b', in: ['x'] } }))
    expect(bad.result).toBeNull()
    const noCollection = await evaluate(filled, entry({}))
    expect(noCollection.result?.[0]).toMatchObject({ review: true })
  })
})
