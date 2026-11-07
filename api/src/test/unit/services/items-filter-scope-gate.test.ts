import knexFactory from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 6 H12 (b15 filter oracle): a to-many relation sub-filter on a readable parent ran
// against an out-of-scope record's real columns. David Jarosz (User Scope Zone 1-3) recovered
// National workflow 372955's requisition_amount to the cent with
// `vendors?filter={"workflows":{"_some":{"id":{"_eq":372955},"requisition_amount":{"_gt":274000}}}}`.
// Every EXISTS a filter or condition compiles into another collection now carries that
// collection's row filter and the caller's User Scopes.

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
  // projects ↔ divisions through projects_divisions
  {
    many_collection: 'projects_divisions',
    many_field: 'projects_id',
    one_collection: 'projects',
    one_field: 'divisions',
    junction_field: 'divisions_id'
  },
  {
    many_collection: 'projects_divisions',
    many_field: 'divisions_id',
    one_collection: 'divisions',
    one_field: null,
    junction_field: 'projects_id'
  }
])

const COLS: Record<string, string[]> = {
  vendors: ['id', 'name'],
  workflows: ['id', 'vendor', 'project', 'requisition_amount', 'region'],
  projects: ['id', 'name', 'region'],
  projects_divisions: ['id', 'projects_id', 'divisions_id'],
  divisions: ['id', 'short_name']
}

// A real knex compiler; awaited statements answer from fixtures (column lists) instead of a
// database, so the compiled SQL is exactly what the API would send.
vi.mock('../../../db/index.js', async (orig) => {
  const { default: knexFactory } = await import('knex')
  const k = knexFactory({ client: 'mssql' })
  const cols = (table: unknown) =>
    (
      ({
        vendors: ['id', 'name'],
        workflows: ['id', 'vendor', 'project', 'requisition_amount', 'region'],
        projects: ['id', 'name', 'region'],
        projects_divisions: ['id', 'projects_id', 'divisions_id'],
        divisions: ['id', 'short_name']
      }) as Record<string, string[]>
    )[String(table)] ?? []
  ;(k.client as unknown as { runner: unknown }).runner = (builder: {
    toSQL(): { sql: string; bindings: unknown[] }
  }) => ({
    run: async () => {
      const { sql, bindings } = builder.toSQL()
      ;(globalThis as { __gateSql?: string[] }).__gateSql?.push(sql)
      if (
        /nivaro_relations/i.test(sql) &&
        bindings.includes('workflows') &&
        bindings.includes('project')
      )
        // `.first()` reads one row (this runner skips knex's response shaping).
        return { many_collection: 'workflows', many_field: 'project', one_collection: 'projects' }
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

// Scope: Zone 1-3 restricts workflows (by region) and divisions (own id); projects carry a
// row filter. Vendors are unrestricted.
const scopes = vi.hoisted(() => ({
  on: true
}))
vi.mock('../../../services/user-scopes.js', async (orig) => {
  const real = await orig<typeof import('../../../services/user-scopes.js')>()
  return {
    ...real,
    getUserScopeEnforcement: vi.fn(async (_u: unknown, c: string) => {
      if (!scopes.on) return { filters: [], deny: false }
      if (c === 'workflows')
        return {
          filters: [{ hops: [{ kind: 'm2o', fk: 'region', to: 'regions' }], ids: [1, 2, 3] }],
          deny: false
        }
      if (c === 'divisions') return { filters: [{ hops: [], ids: [1, 2, 3] }], deny: false }
      return { filters: [], deny: false }
    })
  }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => false),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async (_u: unknown, _a: string, c: string) =>
    scopes.on && c === 'projects' ? [{ field: 'region', op: 'eq', value: 7 }] : null
  )
}))

import { createFilterScopeGate, createRecordingGate } from '../../../services/filter-scope-gate.js'
import { applyConditions, applyFilterToQuery, readItems } from '../../../services/items.js'

const knex = knexFactory({ client: 'mssql' })
const USER = { id: 'U-DJ', role: 'R-CREATOR' } as never

async function compile(collection: string, filter: Record<string, unknown>, user = USER) {
  const q = knex(collection).select('id')
  await applyFilterToQuery(q as never, filter, collection, { user })
  return q.toSQL()
}

beforeEach(() => {
  scopes.on = true
})

describe('relation sub-filters are judged as the caller (H12)', () => {
  it('O2M _some on an out-of-scope child carries the child collection User Scope', async () => {
    const { sql, bindings } = await compile('vendors', {
      workflows: { _some: { id: { _eq: 372955 }, requisition_amount: { _gt: 274000 } } }
    })
    expect(sql).toMatch(/exists \(select 1 from \[workflows\]/i)
    // the scope hop on the child: workflows.region IN the caller's zones
    expect(sql).toMatch(/\[workflows\]\.\[region\]/)
    expect(bindings).toEqual(expect.arrayContaining([1, 2, 3, 372955, 274000]))
  })

  it('a bare id operator on the O2M alias is gated too (membership is a read)', async () => {
    const { sql } = await compile('vendors', { workflows: { _eq: 372955 } })
    expect(sql).toMatch(/\[workflows\]\.\[region\]/)
  })

  it('M2O nested filter carries the target row filter', async () => {
    const { sql, bindings } = await compile('workflows', { project: { name: { _eq: 'Fayette' } } })
    expect(sql).toMatch(/exists \(select 1 from \[projects\]/i)
    expect(sql).toMatch(/\[region\] = \?/)
    expect(bindings).toEqual(expect.arrayContaining(['Fayette', 7]))
  })

  it('M2M _some gates the far collection', async () => {
    const { sql, bindings } = await compile('projects', {
      divisions: { _some: { short_name: { _eq: 'National' } } }
    })
    expect(sql).toMatch(/\[divisions\]\.\[id\] in/i)
    expect(bindings).toEqual(expect.arrayContaining(['National', 1, 2, 3]))
  })

  it('M2M bare operator adds a far-row EXISTS only when the far collection narrows', async () => {
    const gated = await compile('projects', { divisions: { _eq: 9 } })
    expect(gated.sql).toMatch(/\[divisions\]\.\[id\] in/i)
    scopes.on = false
    const open = await compile('projects', { divisions: { _eq: 9 } })
    expect(open.sql).not.toMatch(/from \[divisions\]/i)
  })

  it('a caller with no scope or row filter gets the old SQL (no extra predicates)', async () => {
    scopes.on = false
    const { sql, bindings } = await compile('vendors', {
      workflows: { _some: { requisition_amount: { _gt: 0 } } }
    })
    expect(sql).not.toMatch(/\[region\]/)
    expect(bindings).toEqual([0])
  })

  it('without a caller (server-side compile) nothing is added', async () => {
    const q = knex('vendors').select('id')
    await applyFilterToQuery(q as never, { workflows: { _some: { id: { _eq: 5 } } } }, 'vendors')
    expect(q.toSQL().sql).not.toMatch(/\[region\]/)
  })
})

describe('the list read and conditions use the gate (H12 end to end)', () => {
  it('readItems compiles the scope into the to-many sub-filter, count included', async () => {
    const seen: string[] = []
    ;(globalThis as { __gateSql?: string[] }).__gateSql = seen
    await readItems(USER, 'vendors', {
      filter: {
        workflows: { _some: { id: { _eq: 372955 }, requisition_amount: { _gt: 274000 } } }
      },
      limit: 10
    }).catch(() => undefined)
    delete (globalThis as { __gateSql?: string[] }).__gateSql
    const reads = seen.filter((s) => /from \[vendors\]/i.test(s) && /exists/i.test(s))
    expect(reads.length).toBeGreaterThanOrEqual(2)
    for (const s of reads) expect(s).toMatch(/\[workflows\]\.\[region\] in/i)
  })

  it('a relational condition hop carries the target collection gates', async () => {
    const q = knex('workflows').select('id')
    const { createFilterScopeGate: make } = await import('../../../services/filter-scope-gate.js')
    const gate = make(USER, {
      scope: async () => ({ filters: [], deny: false }),
      rowFilter: async (_u, c) =>
        c === 'projects' ? [{ field: 'region', op: 'eq', value: 7 }] : null
    })
    await applyConditions(
      q as never,
      [{ path: ['project', 'name'], op: '_eq', value: 'X' }] as never,
      'workflows',
      null,
      gate
    )
    const { sql, bindings } = q.toSQL()
    expect(sql).toMatch(/exists \(select 1 from \[projects\]/i)
    expect(sql).toMatch(/\[region\] = \?/)
    expect(bindings).toEqual(expect.arrayContaining([7, 'X']))
  })
})

describe('createFilterScopeGate', () => {
  it('denies a collection it was never primed for (fails closed)', () => {
    const gate = createFilterScopeGate(USER, {
      scope: async () => ({ filters: [], deny: false }),
      rowFilter: async () => null
    })
    const q = knex('x').select('id')
    gate.apply(q as never, 'never_primed')
    expect(q.toSQL().sql).toMatch(/1 = 0/)
  })

  it('a deny enforcement matches nothing; an open one adds nothing', async () => {
    const gate = createFilterScopeGate(USER, {
      scope: async (_u, c) => ({ filters: [], deny: c === 'closed' }),
      rowFilter: async () => null
    })
    await gate.prime(['closed', 'open'])
    const a = knex('closed').select('id')
    gate.apply(a as never, 'closed')
    expect(a.toSQL().sql).toMatch(/1 = 0/)
    const b = knex('open').select('id')
    gate.apply(b as never, 'open')
    expect(b.toSQL().sql).toBe('select [id] from [open]')
    expect(gate.isOpen('open')).toBe(true)
    expect(gate.isOpen('closed')).toBe(false)
  })

  it('the recording gate names every collection asked about', () => {
    const rec = createRecordingGate()
    rec.apply(knex('a') as never, 'a')
    rec.isOpen('b')
    expect([...rec.seen].sort()).toEqual(['a', 'b'])
  })
})

void COLS
