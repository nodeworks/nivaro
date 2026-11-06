import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 5 b10 / b15 (2026-11-06). A role whose read policy on `vendors` lists
// only `id,name` got every calculated field on a `*` read (virtual rollups
// po_total…, a read formula `test` on divisions) and could sort / filter by
// them. And an M2O expansion (`workflows_divisions?fields=workflows_id.*`)
// read its target without the caller's User Scopes.

const COLS: Record<string, string[]> = {
  vendors: ['id', 'name', 'short_code', 'secret_note'],
  workflows_divisions: ['id', 'workflows_id', 'divisions_id'],
  workflows: ['id', 'name', 'requisition_amount']
}
const COMPUTED = [
  {
    field: 'po_total',
    computed_type: 'rollup',
    computed_formula: JSON.stringify({
      related_collection: 'purchase_orders',
      fk_field: 'vendor',
      aggregate: 'sum',
      value_field: 'amount'
    }),
    computed_store: false
  },
  {
    field: 'test',
    computed_type: 'read',
    computed_formula: 'concat(item.name, " - ", item.short_code)',
    computed_store: false
  }
]

const rec = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  selects: [] as Array<{ table: string; cols: unknown[] }>
}))
vi.mock('../../../db/index.js', () => {
  // Awaiting a chain answers rows for its table; nivaro_fields answers the
  // calculated fields only when asked for them (whereNotNull computed_formula).
  const chain = (table: string, st: { computed?: boolean } = {}): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(
              table === 'nivaro_fields'
                ? st.computed
                  ? COMPUTED.filter(() => (rec.rows.__computed_for ?? []).length > 0)
                  : []
                : (rec.rows[table] ?? [])
            ).then(res, rej)
        if (prop === 'columnInfo')
          return async () => Object.fromEntries((COLS[table] ?? []).map((c) => [c, {}]))
        if (prop === 'first') return () => Promise.resolve((rec.rows[table] ?? [])[0])
        if (prop === 'whereNotNull')
          return (col: string) =>
            chain(table, { ...st, computed: st.computed || col === 'computed_formula' })
        if (prop === 'where')
          return (w: unknown) => {
            // getComputedFields asks per collection
            const c = (w as { collection?: string })?.collection
            if (table === 'nivaro_fields' && c && !(rec.rows.__computed_for ?? []).includes(c))
              return chain('__none')
            return chain(table, st)
          }
        if (prop === 'select')
          return (...cols: unknown[]) => {
            rec.selects.push({ table, cols: cols.flat() })
            return chain(table, st)
          }
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table, st)
      },
      apply: () => chain(table, st)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw')
        return (sql: string, bindings?: unknown[]) =>
          /information_schema\.columns/i.test(sql) && typeof bindings?.[0] === 'string'
            ? (COLS[bindings[0] as string] ?? []).map((c) => ({
                c,
                t: 'nvarchar',
                l: 255,
                COLUMN_NAME: c
              }))
            : { sql, toString: () => sql }
      if (prop === 'transaction') return async (fn: (t: unknown) => unknown) => fn(db)
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})

const perm = vi.hoisted(() => ({ admin: false, limited: null as string[] | null }))
vi.mock('../../../services/permissions.js', async (orig) => {
  const real = await orig<typeof import('../../../services/permissions.js')>()
  return {
    ...real,
    isAdminRole: vi.fn(async () => perm.admin),
    can: vi.fn(async () => true),
    getAllowedFields: vi.fn(async () => (perm.admin ? null : perm.limited)),
    getRowFilter: vi.fn(async () => null)
  }
})

const scoped = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<object>()),
  applyUserScopesToQuery: vi.fn(async (_q: unknown, c: string) => {
    scoped.calls.push(c)
  })
}))

vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => (COLS[c] ? { collection: c } : undefined)),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async (c: string) =>
    c === 'workflows_divisions'
      ? [
          {
            many_collection: 'workflows_divisions',
            many_field: 'workflows_id',
            one_collection: 'workflows',
            one_field: null,
            junction_field: 'divisions_id'
          }
        ]
      : []
  )
}))

import { readItems, readOne } from '../../../services/items.js'

const someone = { id: 'U-1', role: 'FIRST-ACCESS' } as never

const vendorSelect = () =>
  rec.selects.filter((s) => s.table === 'vendors').flatMap((s) => s.cols.map(String))

beforeEach(() => {
  perm.admin = false
  perm.limited = ['id', 'name']
  rec.selects = []
  rec.rows = { __computed_for: ['vendors'], vendors: [{ id: 1, name: 'ACME', short_code: 'AC' }] }
  scoped.calls = []
})

const rowsOf = (r: unknown) => (r as { data: Array<Record<string, unknown>> }).data

describe('a role whose vendors read policy lists id,name', () => {
  it('a default (*) list read computes no calculated field', async () => {
    const res = await readItems(someone, 'vendors', { limit: 5 })
    for (const row of rowsOf(res)) {
      expect(row).not.toHaveProperty('po_total')
      expect(row).not.toHaveProperty('test')
    }
    expect(vendorSelect()).not.toContain('*')
    expect(vendorSelect()).not.toContain('secret_note')
  })

  it('fields=* and an explicit calculated field (the GraphQL list path) compute nothing hidden', async () => {
    for (const fields of [['*'], ['id', 'name', 'po_total', 'test']]) {
      const res = await readItems(someone, 'vendors', { fields, limit: 5 })
      for (const row of rowsOf(res)) {
        expect(row).not.toHaveProperty('po_total')
        expect(row).not.toHaveProperty('test')
      }
    }
  })

  it('readOne with fields=* or none computes no calculated field', async () => {
    for (const fields of [undefined, ['*']]) {
      const row = (await readOne(someone, 'vendors', 1, undefined, fields)) as Record<
        string,
        unknown
      >
      expect(row).toBeTruthy()
      expect(row).not.toHaveProperty('po_total')
      expect(row).not.toHaveProperty('test')
    }
  })

  it('cannot sort or filter by a hidden (calculated or stored) field', async () => {
    const asks = [
      { sort: ['-po_total'] },
      { sort: ['short_code'] },
      { filter: { po_total: { _gt: 0 } } },
      { filter: { _or: [{ test: { _contains: 'x' } }] } },
      { filter: { secret_note: { _nnull: true } } }
    ]
    for (const q of asks) {
      await expect(readItems(someone, 'vendors', q as never)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FIELD_NOT_READABLE'
      })
    }
  })

  it('cannot aggregate or group by a hidden field', async () => {
    await expect(
      readItems(someone, 'vendors', { aggregate: { sum: ['short_code'] } } as never)
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      readItems(someone, 'vendors', { aggregate: { groupBy: ['secret_note'] } } as never)
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('still sorts and filters by its listed fields', async () => {
    await expect(
      readItems(someone, 'vendors', { sort: ['name', 'id'], filter: { name: { _eq: 'A' } } })
    ).resolves.toBeTruthy()
  })
})

describe('a role with the calculated field in its list, and an admin', () => {
  it('a listed calculated field is still computed', async () => {
    perm.limited = ['id', 'name', 'short_code', 'test']
    const res = await readItems(someone, 'vendors', { limit: 5 })
    expect(rowsOf(res)[0]).toHaveProperty('test', 'ACME - AC')
    expect(rowsOf(res)[0]).not.toHaveProperty('po_total')
  })

  it('a * policy (null and ["*"]) gets every calculated field and sorts by them', async () => {
    for (const limited of [null, ['*']]) {
      perm.limited = limited
      const res = await readItems(someone, 'vendors', { limit: 5 })
      expect(rowsOf(res)[0]).toHaveProperty('test', 'ACME - AC')
      expect(rowsOf(res)[0]).toHaveProperty('po_total')
      await expect(readItems(someone, 'vendors', { sort: ['short_code'] })).resolves.toBeTruthy()
    }
  })

  it('an admin is unaffected', async () => {
    perm.admin = true
    const res = await readItems(someone, 'vendors', { limit: 5 })
    expect(rowsOf(res)[0]).toHaveProperty('test', 'ACME - AC')
    expect(rowsOf(res)[0]).toHaveProperty('po_total')
    await expect(
      readItems(someone, 'vendors', {
        sort: ['-short_code'],
        filter: { secret_note: { _nnull: true } }
      } as never)
    ).resolves.toBeTruthy()
  })
})

describe('M2O expansion (army 5 b15)', () => {
  it('reads the related record under the caller User Scopes', async () => {
    perm.limited = null
    rec.rows = {
      workflows_divisions: [{ id: 7, workflows_id: 324020, divisions_id: 4 }],
      workflows: []
    }
    const res = await readItems(someone, 'workflows_divisions', {
      fields: ['id', 'workflows_id.*']
    })
    expect(scoped.calls).toContain('workflows_divisions')
    expect(scoped.calls).toContain('workflows')
    // The target the scope hid stays a bare id.
    expect(rowsOf(res)[0].workflows_id).toBe(324020)
  })
})
