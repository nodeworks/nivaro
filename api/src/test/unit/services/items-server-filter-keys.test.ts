import { beforeEach, describe, expect, it, vi } from 'vitest'

// REVIEW-R5 M1 / M3 (2026-11-06).
// M1: a filter key the SERVER builds to fetch related rows (the FK a to-many
// expansion names) was judged against the caller's field list, so a child
// policy that left the FK out made the whole PARENT read answer 403. The
// caller's own filter on that FK must still be refused.
// M3 (narrow): through a hop into a business collection the caller has NO
// read policy on, a calculated field (rollup / read formula) is refused.

const COLS: Record<string, string[]> = {
  vendors: ['id', 'name', 'secret_note'],
  vendor_notes: ['id', 'vendor', 'note'],
  workflows: ['id', 'name', 'vendor']
}
const COMPUTED: Record<string, unknown[]> = {
  vendors: [
    {
      field: 'po_total',
      computed_type: 'rollup',
      computed_formula: JSON.stringify({
        related_collection: 'workflows',
        fk_field: 'vendor',
        aggregate: 'count'
      }),
      computed_store: false
    }
  ]
}
const RELS = [
  {
    many_collection: 'vendor_notes',
    many_field: 'vendor',
    one_collection: 'vendors',
    one_field: 'notes',
    junction_field: null
  },
  {
    many_collection: 'workflows',
    many_field: 'vendor',
    one_collection: 'vendors',
    one_field: null,
    junction_field: null
  }
]

const rec = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, unknown>>> }))

vi.mock('../../../db/index.js', () => {
  // Awaiting a chain answers its table's rows, projected to the selected
  // columns (so a column outside the caller's list is really absent).
  type St = { computedFor?: string | null; cols?: string[] }
  const project = (rows: Array<Record<string, unknown>>, cols?: string[]) => {
    if (!cols || cols.length === 0 || cols.some((c) => c === '*' || c.endsWith('.*'))) return rows
    const keep = cols.map((c) => c.split(' as ').pop()!.split('.').pop()!.trim())
    return rows.map((r) => Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]])))
  }
  const chain = (table: string, st: St = {}): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(
              table === 'nivaro_fields'
                ? (COMPUTED[st.computedFor ?? ''] ?? [])
                : project(
                    (rec.rows[table] ?? []).map((r) => ({ ...r })),
                    st.cols
                  )
            ).then(res, rej)
        if (prop === 'columnInfo')
          return async () => Object.fromEntries((COLS[table] ?? []).map((c) => [c, {}]))
        if (prop === 'first') return () => Promise.resolve((rec.rows[table] ?? [])[0])
        if (prop === 'where')
          return (w: unknown) => {
            const c = (w as { collection?: string })?.collection
            if (table === 'nivaro_fields' && typeof c === 'string')
              return chain(table, { ...st, computedFor: c })
            return chain(table, st)
          }
        if (prop === 'select')
          return (...cols: unknown[]) =>
            chain(table, {
              ...st,
              cols: [...(st.cols ?? []), ...cols.flat().filter((c) => typeof c === 'string')]
            })
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

const perm = vi.hoisted(() => ({
  admin: false,
  // undefined = a `*` policy (null), [] = no read policy at all
  byCollection: {} as Record<string, string[] | null>
}))
vi.mock('../../../services/permissions.js', async (orig) => {
  const real = await orig<typeof import('../../../services/permissions.js')>()
  return {
    ...real,
    isAdminRole: vi.fn(async () => perm.admin),
    can: vi.fn(async () => true),
    getAllowedFields: vi.fn(async (_u: unknown, _a: string, c: string) =>
      perm.admin ? null : c in perm.byCollection ? perm.byCollection[c] : null
    ),
    getRowFilter: vi.fn(async () => null)
  }
})

vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<object>()),
  applyUserScopesToQuery: vi.fn(async () => {})
}))

vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => (COLS[c] ? { collection: c } : undefined)),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async (c: string) =>
    RELS.filter((r) => r.many_collection === c || r.one_collection === c)
  )
}))

import { readItems, readOne, serverBuiltFilter } from '../../../services/items.js'

const someone = { id: 'U-1', role: 'NARROW' } as never
const rowsOf = (r: unknown) => (r as { data: Array<Record<string, unknown>> }).data

beforeEach(() => {
  perm.admin = false
  perm.byCollection = {}
  rec.rows = {
    vendors: [{ id: 1, name: 'ACME', secret_note: 's' }],
    vendor_notes: [{ id: 10, vendor: 1, note: 'hello' }],
    workflows: [{ id: 5, name: 'W', vendor: 1 }]
  }
})

describe('M1: a child policy that leaves its FK out', () => {
  beforeEach(() => {
    perm.byCollection = { vendor_notes: ['id', 'note'] }
  })

  it('the parent list read is 200 and the to-many list comes back empty', async () => {
    const res = await readItems(someone, 'vendors', { fields: ['id', 'name', 'notes.note'] })
    const row = rowsOf(res)[0]
    expect(row.name).toBe('ACME')
    expect(row.notes).toEqual([])
  })

  it('the parent record read (readOne) is 200 too', async () => {
    const row = (await readOne(someone, 'vendors', 1, undefined, ['id', 'notes.note'])) as Record<
      string,
      unknown
    >
    expect(row).toBeTruthy()
    expect(row.notes).toEqual([])
  })

  it("the caller's own filter or sort on that FK is still refused", async () => {
    for (const q of [
      { filter: { vendor: { _eq: 1 } } },
      { filter: { _and: [{ vendor: { _in: [1] } }] } },
      { sort: ['vendor'] }
    ]) {
      await expect(readItems(someone, 'vendor_notes', q as never)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FIELD_NOT_READABLE'
      })
    }
  })

  it('only the server-built node is trusted: a caller key beside it is still judged', async () => {
    const filter = { _and: [serverBuiltFilter({ id: { _in: [10] } }), { vendor: { _eq: 1 } }] }
    await expect(readItems(someone, 'vendor_notes', { filter })).rejects.toMatchObject({
      code: 'FIELD_NOT_READABLE'
    })
    // A plain object that merely looks like the server's is not trusted.
    await expect(
      readItems(someone, 'vendor_notes', { filter: { vendor: { _in: [1] } } })
    ).rejects.toMatchObject({ code: 'FIELD_NOT_READABLE' })
  })
})

describe('M1: a normal role and an admin keep the children', () => {
  it('a * child policy attaches the child rows', async () => {
    const res = await readItems(someone, 'vendors', { fields: ['id', 'notes.note'] })
    expect(rowsOf(res)[0].notes).toEqual([expect.objectContaining({ note: 'hello' })])
  })

  it('a child policy listing the FK attaches the child rows', async () => {
    perm.byCollection = { vendor_notes: ['id', 'vendor', 'note'] }
    const res = await readItems(someone, 'vendors', { fields: ['id', 'notes.note'] })
    expect(rowsOf(res)[0].notes).toEqual([expect.objectContaining({ note: 'hello' })])
    await expect(
      readItems(someone, 'vendor_notes', { filter: { vendor: { _eq: 1 } } })
    ).resolves.toBeTruthy()
  })

  it('an admin attaches the child rows and filters by the FK', async () => {
    perm.admin = true
    const res = await readItems(someone, 'vendors', { fields: ['id', 'notes.note'] })
    expect(rowsOf(res)[0].notes).toEqual([expect.objectContaining({ note: 'hello' })])
    await expect(
      readItems(someone, 'vendor_notes', { filter: { vendor: { _eq: 1 } } })
    ).resolves.toBeTruthy()
  })
})

describe('M3: a hop into a collection the role has no read policy on', () => {
  beforeEach(() => {
    perm.byCollection = { workflows: null, vendors: [] }
  })

  it('refuses a calculated field there (filter and sort)', async () => {
    for (const q of [
      { filter: { vendor: { po_total: { _gt: 1000000 } } } },
      { filter: { 'vendor.po_total': { _gt: 1 } } },
      { sort: ['-vendor.po_total'] }
    ]) {
      await expect(readItems(someone, 'workflows', q as never)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FIELD_NOT_READABLE'
      })
    }
  })

  it('keeps plain columns there as before', async () => {
    await expect(
      readItems(someone, 'workflows', { filter: { vendor: { name: { _eq: 'ACME' } } } })
    ).resolves.toBeTruthy()
  })

  it('a role that reads vendors (* policy) and an admin may filter by it', async () => {
    perm.byCollection = { workflows: null, vendors: null }
    await expect(
      readItems(someone, 'workflows', { filter: { vendor: { po_total: { _gt: 1 } } } })
    ).resolves.toBeTruthy()
    perm.admin = true
    perm.byCollection = { workflows: null, vendors: [] }
    await expect(
      readItems(someone, 'workflows', { filter: { vendor: { po_total: { _gt: 1 } } } })
    ).resolves.toBeTruthy()
  })
})

describe('b16-N8: a relation path whose last segment the target lacks', () => {
  it('is a 400 naming the path, for a narrowed role, a * role and an admin', async () => {
    for (const setup of [
      () => {
        perm.byCollection = { workflows: ['id', 'name', 'vendor'] }
      },
      () => {
        perm.byCollection = {}
      },
      () => {
        perm.admin = true
      }
    ]) {
      setup()
      for (const q of [
        { filter: { vendor: { division: { _eq: 1 } } } },
        { filter: { 'vendor.division': { _eq: 1 } } },
        { filter: { _and: [{ vendor: { division: { _null: true } } }] } },
        { sort: ['-vendor.division'] }
      ]) {
        await expect(readItems(someone, 'workflows', q as never)).rejects.toMatchObject({
          statusCode: 400,
          code: 'UNKNOWN_FIELD',
          message: 'Unknown field vendor.division'
        })
      }
    }
  })

  it('a path to a real field still reads', async () => {
    await expect(
      readItems(someone, 'workflows', {
        filter: { vendor: { name: { _eq: 'ACME' } } },
        sort: ['vendor.name']
      })
    ).resolves.toBeTruthy()
  })
})
