import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 7 b15 [MEDIUM]: `GET /api/items/workflows?sort=vendor.name` (any `<m2o>.<field>` sort)
// answered 500 "Ambiguous column name 'id'." for every caller — applySorts LEFT JOINed the
// related table while the page's own select and sort stayed unqualified. Fixed, the same sort
// must not become an ordering oracle: `workflows_divisions?sort=workflows_id.requisition_amount`
// over junction rows of out-of-scope workflows would rank them by a hidden amount. The related
// value is now one correlated subquery per hop, read through the caller's gates (a hidden
// related row sorts as NULL), and a hop the caller cannot read at all is refused.

const RELS = vi.hoisted(() => [
  // workflows.vendor → vendors (O2M alias vendors.workflows)
  {
    many_collection: 'workflows',
    many_field: 'vendor',
    one_collection: 'vendors',
    one_field: 'workflows',
    junction_field: null
  },
  // workflows.project → projects
  {
    many_collection: 'workflows',
    many_field: 'project',
    one_collection: 'projects',
    one_field: null,
    junction_field: null
  },
  // forecasts.workflow → workflows
  {
    many_collection: 'forecasts',
    many_field: 'workflow',
    one_collection: 'workflows',
    one_field: null,
    junction_field: null
  },
  // workflows ↔ divisions through workflows_divisions
  {
    many_collection: 'workflows_divisions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'divisions',
    junction_field: 'divisions_id'
  },
  {
    many_collection: 'workflows_divisions',
    many_field: 'divisions_id',
    one_collection: 'divisions',
    one_field: null,
    junction_field: 'workflows_id'
  }
])

vi.mock('../../../db/index.js', async (orig) => {
  const { default: knexFactory } = await import('knex')
  const k = knexFactory({ client: 'mssql' })
  const cols = (table: unknown) =>
    (
      ({
        vendors: ['id', 'name'],
        workflows: ['id', 'vendor', 'project', 'requisition_amount', 'region'],
        projects: ['id', 'name', 'project_id', 'region'],
        forecasts: ['id', 'workflow', 'amount'],
        workflows_divisions: ['id', 'workflows_id', 'divisions_id'],
        divisions: ['id', 'short_name']
      }) as Record<string, string[]>
    )[String(table)] ?? []
  ;(k.client as unknown as { runner: unknown }).runner = (builder: {
    toSQL(): { sql: string; bindings: unknown[] }
  }) => ({
    run: async () => {
      const { sql, bindings } = builder.toSQL()
      ;(globalThis as { __sortSql?: string[] }).__sortSql?.push(sql)
      if (/information_schema\.columns/i.test(sql))
        return cols(bindings[0]).map((c) => ({ COLUMN_NAME: c, column_name: c, DATA_TYPE: 'int' }))
      return []
    }
  })
  return { ...(await orig<object>()), db: k, dbRead: k }
})
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({ collection: c })),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async () => RELS)
}))
vi.mock('../../../services/physical-tables.js', async (orig) => ({
  ...(await orig<object>()),
  tableIsMissing: vi.fn(async () => false),
  liveRelations: vi.fn(async (r: unknown) => r)
}))
vi.mock('../../../services/computed-fields.js', async (orig) => ({
  ...(await orig<object>()),
  getComputedFields: vi.fn(async () => [])
}))

// The caller: User Scope Zone 1-3 on workflows (by region) unless `scoped` is off; `admin`
// skips every gate; `unreadable` lists collections the role has no read on; `fields` gives a
// collection a read field list.
const who = vi.hoisted(() => ({
  scoped: true,
  admin: false,
  unreadable: new Set<string>(),
  fields: {} as Record<string, string[]>
}))
vi.mock('../../../services/user-scopes.js', async (orig) => {
  const real = await orig<typeof import('../../../services/user-scopes.js')>()
  return {
    ...real,
    getUserScopeEnforcement: vi.fn(async (_u: unknown, c: string) => {
      if (who.admin || !who.scoped || c !== 'workflows') return { filters: [], deny: false }
      return {
        filters: [{ hops: [{ kind: 'm2o', fk: 'region', to: 'regions' }], ids: [1, 2, 3] }],
        deny: false
      }
    })
  }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => who.admin),
  can: vi.fn(async (_u: unknown, _a: string, c: string) => who.admin || !who.unreadable.has(c)),
  getAllowedFields: vi.fn(async (_u: unknown, _a: string, c: string) =>
    who.admin ? null : (who.fields[c] ?? null)
  ),
  getRowFilter: vi.fn(async () => null)
}))

import { readItems } from '../../../services/items.js'

const USER = { id: 'U-DJ', role: 'R-CREATOR' } as never

/** The list read's own statement (the page, not the count or the metadata reads). */
async function listSql(collection: string, sort: string[]): Promise<string> {
  const seen: string[] = []
  ;(globalThis as { __sortSql?: string[] }).__sortSql = seen
  try {
    await readItems(USER, collection, { sort, limit: 5 })
  } finally {
    delete (globalThis as { __sortSql?: string[] }).__sortSql
  }
  const page = seen.find((s) => new RegExp(`from \\[${collection}\\].*order by`, 'i').test(s))
  if (!page) throw new Error(`no list statement for ${collection}: ${seen.join('\n')}`)
  return page
}

async function refusal(collection: string, sort: string[]) {
  return readItems(USER, collection, { sort, limit: 5 }).then(
    () => null,
    (err: { statusCode?: number; code?: string; message?: string }) => err
  )
}

beforeEach(() => {
  who.scoped = true
  who.admin = false
  who.unreadable = new Set()
  who.fields = {}
})

describe('relation-path sort compiles to valid, unambiguous SQL', () => {
  it('sort=vendor.name orders by a correlated lookup, never a JOIN on the page', async () => {
    who.admin = true
    const sql = await listSql('workflows', ['vendor.name'])
    expect(sql).not.toMatch(/\bjoin\b/i)
    expect(sql).toMatch(
      /order by \(\(select \[_nvr_sort0\]\.\[name\] from \[vendors\] as \[_nvr_sort0\] where \[_nvr_sort0\]\.\[id\] = \[workflows\]\.\[vendor\]\)\) asc/i
    )
  })

  it('a descending sort and a two-hop path nest one lookup per hop', async () => {
    who.admin = true
    const sql = await listSql('forecasts', ['-workflow.project.project_id'])
    expect(sql).toMatch(/\[_nvr_sort0\]\.\[id\] = \[forecasts\]\.\[workflow\]/)
    expect(sql).toMatch(/\[_nvr_sort1\]\.\[id\] = \[_nvr_sort0\]\.\[project\]/)
    expect(sql).toMatch(/select \[_nvr_sort1\]\.\[project_id\]/)
    expect(sql).toMatch(/\) desc/i)
  })

  it('a self-qualified column (`workflows.id`) stays a plain sort on the root', async () => {
    who.admin = true
    const sql = await listSql('workflows', ['workflows.id'])
    expect(sql).toMatch(/order by \[workflows\]\.\[id\] asc/i)
  })
})

describe('the related hop is judged as the caller', () => {
  it('a scoped caller sorts out-of-scope related rows as NULL (no oracle on hidden amounts)', async () => {
    const sql = await listSql('workflows_divisions', ['workflows_id.requisition_amount'])
    // The workflow is looked up through a derived table carrying the caller's User Scope.
    expect(sql).toMatch(
      /from \(select \* from \[workflows\] where .*\[workflows\]\.\[region\].*\) as \[_nvr_sort0\]/i
    )
    expect(sql).toMatch(/\[_nvr_sort0\]\.\[id\] = \[workflows_divisions\]\.\[workflows_id\]/)
  })

  it('a caller the related collection does not narrow gets the plain lookup', async () => {
    who.scoped = false
    const sql = await listSql('forecasts', ['workflow.requisition_amount'])
    expect(sql).toMatch(/from \[workflows\] as \[_nvr_sort0\]/i)
    expect(sql).not.toMatch(/\[region\]/)
  })

  it('a related field outside the caller read field list is refused (403, coded)', async () => {
    who.fields = { workflows: ['id', 'vendor'], vendors: ['id'] }
    const err = await refusal('workflows', ['vendor.name'])
    expect(err).toMatchObject({ statusCode: 403, code: 'FIELD_NOT_READABLE' })
    expect(err?.message).not.toMatch(/select|\[|column name/i)
  })

  it('a related collection the caller cannot read at all is refused', async () => {
    who.unreadable = new Set(['vendors'])
    const err = await refusal('workflows', ['-vendor.name'])
    expect(err).toMatchObject({ statusCode: 403, code: 'FIELD_NOT_READABLE' })
  })
})

describe('sorts that cannot be compiled are a coded 400, never SQL', () => {
  it('a sort through a list of related records (to-many) is refused', async () => {
    who.admin = true
    const err = await refusal('vendors', ['workflows.requisition_amount'])
    expect(err).toMatchObject({ statusCode: 400, code: 'FIELD_NOT_FILTERABLE' })
  })
})
