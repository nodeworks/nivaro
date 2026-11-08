import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 6 (2026-11-06):
// N2  — `GET /items/workflows/372962?fields=id,project.division.short_name` answered 500 with
//       "Invalid column name 'division'": a deep fields path whose middle segment is not a
//       relation reached SQL as a column.
// M16 — a paged list read without `sort` compiled ORDER BY (SELECT NULL): pages overlapped
//       (613 duplicates and 613 missing rows over inventory_item_transactions project 7618).
// M3  — a row created without `changed` got the column's GETDATE default (Eastern written as
//       UTC), 5 h behind `created`.

const rec = vi.hoisted(() => ({ sql: [] as string[] }))

vi.mock('../../../db/index.js', async (orig) => {
  const { default: knexFactory } = await import('knex')
  const k = knexFactory({ client: 'mssql' })
  const cols = (table: unknown) =>
    (
      ({
        workflows: ['id', 'workflow_id', 'project', 'name'],
        projects: ['id', 'name', 'region'],
        regions: ['id', 'name'],
        inventory_item_transactions: ['id', 'project', 'amount'],
        legacy_view: ['code', 'amount']
      }) as Record<string, string[]>
    )[String(table)] ?? []
  ;(k.client as unknown as { runner: unknown }).runner = (builder: {
    toSQL(): { sql: string; bindings: unknown[] } | Array<{ sql: string }>
  }) => ({
    run: async () => {
      const compiled = builder.toSQL()
      const { sql, bindings } = (Array.isArray(compiled) ? compiled[0] : compiled) as {
        sql: string
        bindings: unknown[]
      }
      rec.sql.push(sql)
      if (/information_schema\.columns/i.test(sql))
        return cols(bindings[0]).map((c) => ({ COLUMN_NAME: c, column_name: c, DATA_TYPE: 'int' }))
      if (/count\(\*\)/i.test(sql)) return [{ count: 0 }]
      return []
    }
  })
  return { ...(await orig<object>()), db: k, dbRead: k }
})

const RELS = vi.hoisted(() => [
  {
    many_collection: 'workflows',
    many_field: 'project',
    one_collection: 'projects',
    one_field: null,
    junction_field: null
  },
  {
    many_collection: 'projects',
    many_field: 'region',
    one_collection: 'regions',
    one_field: null,
    junction_field: null
  }
])
const FIELDS = vi.hoisted(() => ({
  rows: [] as Array<{ field: string; special?: string[] | null }>
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c })),
  getFields: vi.fn(async () => FIELDS.rows),
  getRelations: vi.fn(async () => RELS)
}))
vi.mock('../../../services/physical-tables.js', async (orig) => ({
  ...(await orig<object>()),
  tableIsMissing: vi.fn(async () => false),
  liveRelations: vi.fn(async (r: unknown) => r)
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => true),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/user-scopes.js', async (orig) => ({
  ...(await orig<object>()),
  getUserScopeEnforcement: vi.fn(async () => ({ filters: [], deny: false }))
}))

import { applyAuditSpecials, assertFieldPathsExist, readItems } from '../../../services/items.js'

const ADMIN = { id: 'U-1', role: 'ADMIN' } as never

beforeEach(() => {
  rec.sql = []
  FIELDS.rows = []
})

describe('deep fields= paths (N2)', () => {
  it('a middle segment that is neither a relation nor a column is a 400 naming the path', async () => {
    await expect(
      assertFieldPathsExist('workflows', ['id', 'project.division.short_name'])
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNKNOWN_FIELD',
      message: 'Unknown field project.division'
    })
  })

  it('a path through real many-to-one hops passes', async () => {
    await expect(
      assertFieldPathsExist('workflows', ['project.region.name', 'project.*', 'name'])
    ).resolves.toBeUndefined()
  })

  it('army9 b10: a caller with a field list gets the same answer for a made-up and a hidden name', async () => {
    const readable = async () => ['id', 'name']
    // Both dropped by the projection later — neither is judged here.
    await expect(
      assertFieldPathsExist('workflows', ['id', 'zzz_nope.*', 'zzz_nope.x'], readable)
    ).resolves.toBeUndefined()
    await expect(
      assertFieldPathsExist('workflows', ['id', 'project.division.short_name'], readable)
    ).resolves.toBeUndefined()
    // A caller who may read everything still learns the name is wrong.
    await expect(
      assertFieldPathsExist('workflows', ['project.division.short_name'], async () => null)
    ).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' })
  })

  it('a plain column as the middle segment is left to the expansion (no new refusal)', async () => {
    await expect(assertFieldPathsExist('workflows', ['name.x'])).resolves.toBeUndefined()
  })
})

describe('paged reads without a sort (M16)', () => {
  it('order by the primary key, never (SELECT NULL)', async () => {
    await readItems(ADMIN, 'inventory_item_transactions', {
      filter: { project: { _eq: 7618 } },
      limit: 500,
      offset: 500
    }).catch(() => undefined)
    const page = rec.sql.find(
      (s) => /from \[inventory_item_transactions\]/i.test(s) && /offset/i.test(s)
    )
    expect(page).toBeDefined()
    expect(page).toMatch(/order by \[inventory_item_transactions\]\.\[id\] asc/i)
    expect(page).not.toMatch(/\(SELECT NULL\)/i)
  })

  it('a caller sort is kept as given', async () => {
    await readItems(ADMIN, 'inventory_item_transactions', {
      sort: ['-amount'],
      limit: 50
    }).catch(() => undefined)
    const page = rec.sql.find(
      (s) => /from \[inventory_item_transactions\]/i.test(s) && /top|offset/i.test(s)
    )
    expect(page).toMatch(/order by .*\[amount\] desc/i)
  })
})

describe('audit specials on create (M3)', () => {
  it('stamps date-updated with the same UTC instant as date-created', async () => {
    FIELDS.rows = [
      { field: 'created', special: ['date-created'] },
      { field: 'changed', special: ['date-updated'] },
      { field: 'user_created', special: ['user-created'] }
    ]
    const payload: Record<string, unknown> = {}
    await applyAuditSpecials('workflow_line_items', payload, ADMIN, 'create', new Set())
    expect(payload.created).toBeInstanceOf(Date)
    expect(payload.changed).toBe(payload.created)
    expect(payload.user_created).toBe('U-1')
  })

  it('keeps a changed value the payload already carries', async () => {
    FIELDS.rows = [{ field: 'changed', special: ['date-updated'] }]
    const given = new Date('2026-01-01T00:00:00Z')
    const payload: Record<string, unknown> = { changed: given }
    await applyAuditSpecials('workflow_line_items', payload, ADMIN, 'create', new Set())
    expect(payload.changed).toBe(given)
  })
})
