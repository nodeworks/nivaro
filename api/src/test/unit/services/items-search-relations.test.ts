import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 6 L2 (Rob, 2026-11-07): the Project picker must find projects by their region's name
// ("2026 Central"). `browser_config.search_relations` lets a list search reach a related
// record's text field — judged as the caller hop by hop, never widening what they may read.

const RELS = vi.hoisted(() => [
  // projects ↔ divisions through projects_divisions (M2M alias projects.divisions)
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
  },
  // projects.owner → nivaro_users (a system table: never searched through)
  {
    many_collection: 'projects',
    many_field: 'owner',
    one_collection: 'nivaro_users',
    one_field: null,
    junction_field: null
  },
  // projects.program → programs (M2O)
  {
    many_collection: 'projects',
    many_field: 'program',
    one_collection: 'programs',
    one_field: null,
    junction_field: null
  }
])

const COLS: Record<string, Record<string, string>> = vi.hoisted(() => ({
  projects: { id: 'int', name: 'varchar', program: 'int', owner: 'uniqueidentifier' },
  projects_divisions: { id: 'int', projects_id: 'int', divisions_id: 'int' },
  divisions: { id: 'int', short_name: 'varchar', budget: 'decimal' },
  programs: { id: 'int', title: 'varchar' },
  nivaro_users: { id: 'uniqueidentifier', last_name: 'nvarchar' }
}))

const META: Record<string, Array<{ field: string; type: string }>> = vi.hoisted(() => ({
  projects: [
    { field: 'id', type: 'integer' },
    { field: 'name', type: 'string' },
    { field: 'program', type: 'integer' },
    { field: 'owner', type: 'uuid' },
    { field: 'divisions', type: 'alias' }
  ],
  divisions: [
    { field: 'id', type: 'integer' },
    { field: 'short_name', type: 'string' },
    { field: 'budget', type: 'decimal' }
  ],
  programs: [
    { field: 'id', type: 'integer' },
    { field: 'title', type: 'string' }
  ],
  nivaro_users: [{ field: 'last_name', type: 'string' }]
}))

const state = vi.hoisted(() => ({
  config: { search_relations: ['divisions.short_name'] } as Record<string, unknown> | null,
  allowed: {} as Record<string, string[] | null>,
  readable: new Set<string>(),
  scopeOn: true,
  /** Rows the up-front related read answers (resolveRelationSearch); > 2000 = EXISTS fallback. */
  farRows: 1
}))

vi.mock('../../../db/index.js', async (orig) => {
  const { default: knexFactory } = await import('knex')
  const k = knexFactory({ client: 'mssql' })
  ;(k.client as unknown as { runner: unknown }).runner = (builder: {
    toSQL(): { sql: string; bindings: unknown[] }
  }) => ({
    run: async () => {
      const { sql, bindings } = builder.toSQL()
      ;(globalThis as { __searchSql?: string[] }).__searchSql?.push(sql)
      if (/information_schema\.columns/i.test(sql)) {
        const t = COLS[String(bindings[0])] ?? {}
        return Object.entries(t).map(([c, ty]) => ({
          COLUMN_NAME: c,
          column_name: c,
          DATA_TYPE: ty
        }))
      }
      // resolveRelationSearch: the far side's ids, then the junction's root ids
      if (/^select top \(\?\) \[(divisions|programs)\]\.\[id\] as \[?id\]?/i.test(sql))
        return Array.from({ length: state.farRows }, (_, i) => ({ id: i + 1 }))
      if (/^select distinct .*from \[projects_divisions\]/i.test(sql)) return [{ id: 42 }]
      return []
    }
  })
  return { ...(await orig<object>()), db: k, dbRead: k }
})
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) => ({
    collection: c,
    browser_config: c === 'projects' && state.config ? JSON.stringify(state.config) : null
  })),
  getFields: vi.fn(async (c: string) => META[c] ?? []),
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
vi.mock('../../../services/search-synonyms.js', async (orig) => ({
  ...(await orig<object>()),
  // One reading per word, no synonyms (the synonym store is not under test here).
  searchVariants: vi.fn(async (s: string) => [s.split(/\s+/).map((w) => [w])])
}))
// The caller's User Scope narrows divisions to their own (1, 2, 3).
vi.mock('../../../services/user-scopes.js', async (orig) => {
  const real = await orig<typeof import('../../../services/user-scopes.js')>()
  return {
    ...real,
    getUserScopeEnforcement: vi.fn(async (_u: unknown, c: string) =>
      state.scopeOn && c === 'divisions'
        ? { filters: [{ hops: [], ids: [1, 2, 3] }], deny: false }
        : { filters: [], deny: false }
    )
  }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => false),
  can: vi.fn(async (_u: unknown, _a: string, c: string) => state.readable.has(c)),
  getAllowedFields: vi.fn(async (_u: unknown, _a: string, c: string) =>
    c in state.allowed ? state.allowed[c] : null
  ),
  getRowFilter: vi.fn(async () => null)
}))

import { readItems } from '../../../services/items.js'

const USER = { id: 'U-1', role: 'R-PLANNER' } as never

async function allSql(search: string, extra: Record<string, unknown> = {}) {
  const seen: string[] = []
  ;(globalThis as { __searchSql?: string[] }).__searchSql = seen
  await readItems(USER, 'projects', { search, limit: 10, ...extra } as never).catch(() => undefined)
  delete (globalThis as { __searchSql?: string[] }).__searchSql
  return seen
}

async function searchSql(search: string, extra: Record<string, unknown> = {}) {
  return (await allSql(search, extra)).filter(
    (s) => /from \[projects\]/i.test(s) && /like/i.test(s)
  )
}

/** The up-front related reads (resolveRelationSearch) against `table`. */
async function farReads(search: string, table: string) {
  const re = new RegExp(`^select top \\(\\?\\) \\[${table}\\]\\.\\[id\\] as \\[?id\\]?`, 'i')
  return (await allSql(search)).filter((s) => re.test(s))
}

beforeEach(() => {
  state.config = { search_relations: ['divisions.short_name'] }
  state.allowed = {}
  state.readable = new Set(['projects', 'divisions', 'programs', 'nivaro_users'])
  state.scopeOn = true
  state.farRows = 1
})

describe('list search through search_relations', () => {
  it('reads the related matches up front, gated by the far User Scope, then searches id IN', async () => {
    const far = await farReads('2026 Central', 'divisions')
    // one up-front read per word
    expect(far).toHaveLength(2)
    for (const s of far) {
      expect(s).toMatch(/\[divisions\]\.\[id\] in/i)
      expect(s).toMatch(/\[divisions\]\.\[short_name\] LIKE CAST\(\? AS varchar\(4000\)\)/)
    }
    const reads = await searchSql('2026 Central')
    expect(reads.length).toBeGreaterThanOrEqual(1)
    for (const s of reads) {
      expect(s).not.toMatch(/exists/i)
      // each word: own columns OR the root ids the related read found
      expect((s.match(/\[projects\]\.\[id\] in \(\?\)/gi) ?? []).length).toBe(2)
    }
  })

  it('a word no related record matches adds no relation predicate', async () => {
    state.farRows = 0
    for (const s of await searchSql('Central')) {
      expect(s).not.toMatch(/divisions|\[projects\]\.\[id\] in/i)
    }
  })

  it('more matches than one up-front read takes: each word also matches the related label, gated by the far User Scope (probe, page, count)', async () => {
    state.farRows = 2001
    const reads = await searchSql('2026 Central')
    // the search probe (a clone of the gated count query) runs first
    expect(reads.length).toBeGreaterThanOrEqual(1)
    for (const s of reads) {
      expect(s).toMatch(/exists \(select 1 from \[projects_divisions\]/i)
      expect(s).toMatch(
        /from \[divisions\] where \[divisions\]\.\[id\] = \[projects_divisions\]\.\[divisions_id\] (and \[divisions\]\.\[id\] in \([?, ]+\) )?and \(\[divisions\]\.\[short_name\] LIKE CAST\(\? AS varchar\(4000\)\)\)/
      )
      // the caller's User Scope on the far collection rides inside the EXISTS
      expect(s).toMatch(/\[divisions\]\.\[id\] in/i)
      // one EXISTS per word: both words stay ANDed
      expect((s.match(/from \[projects_divisions\]/gi) ?? []).length).toBe(2)
    }
  })

  it('a caller with no scope on the far collection gets no extra predicate', async () => {
    state.scopeOn = false
    for (const s of await farReads('Central', 'divisions'))
      expect(s).not.toMatch(/\[divisions\]\.\[id\] in/i)
    state.farRows = 2001
    const reads = await searchSql('Central')
    for (const s of reads) {
      expect(s).toMatch(
        /from \[divisions\] where \[divisions\]\.\[id\] = \[projects_divisions\]\.\[divisions_id\] (and \[divisions\]\.\[id\] in \([?, ]+\) )?and \(\[divisions\]\.\[short_name\] LIKE CAST\(\? AS varchar\(4000\)\)\)/
      )
      expect(s).not.toMatch(/\[divisions\]\.\[id\] in/i)
    }
  })

  it('no config = the search as before (own columns only)', async () => {
    state.config = null
    const reads = await searchSql('Central')
    expect(reads.length).toBeGreaterThan(0)
    for (const s of reads) expect(s).not.toMatch(/divisions/i)
  })

  it('never through a field the caller cannot read on the related collection', async () => {
    state.allowed = { divisions: ['id', 'budget'] }
    for (const s of await searchSql('Central')) expect(s).not.toMatch(/divisions/i)
  })

  it('never through a collection with no read policy for the caller', async () => {
    state.allowed = { divisions: [] }
    for (const s of await searchSql('Central')) expect(s).not.toMatch(/divisions/i)
  })

  it('never through a collection the caller may not read (role or API key scope)', async () => {
    state.readable.delete('divisions')
    for (const s of await searchSql('Central')) expect(s).not.toMatch(/divisions/i)
  })

  it('never through an alias the caller cannot read on the root', async () => {
    state.allowed = { projects: ['id', 'name'] }
    for (const s of await searchSql('Central')) expect(s).not.toMatch(/divisions/i)
  })

  it('never into a system table, nor to a non-text field, nor through an unknown hop', async () => {
    state.config = {
      search_relations: ['owner.last_name', 'divisions.budget', 'nothing.name', 'name.x']
    }
    for (const s of await searchSql('Central')) {
      expect(s).not.toMatch(/nivaro_users|divisions|nothing/i)
    }
  })

  it('an M2O path matches the FK against the related ids read up front', async () => {
    state.config = { search_relations: ['program.title'] }
    state.farRows = 3
    for (const s of await searchSql('Central')) {
      expect(s).toMatch(/\[projects\]\.\[program\] in \(\?, \?, \?\)/i)
      expect(s).not.toMatch(/exists/i)
    }
  })

  it('an M2O path past the up-front cap compiles to an EXISTS on the related row', async () => {
    state.config = { search_relations: ['program.title'] }
    state.farRows = 2001
    const reads = await searchSql('Central')
    for (const s of reads) {
      expect(s).toMatch(
        /exists \(select 1 from \[programs\] where \[programs\]\.\[id\] = \[projects\]\.\[program\] and \(\[programs\]\.\[title\] LIKE CAST\(\? AS varchar\(4000\)\)\)\)/
      )
    }
  })

  it('a request that narrows its own search_fields searches no relation', async () => {
    for (const s of await searchSql('Central', { search_fields: ['name'] }))
      expect(s).not.toMatch(/divisions/i)
  })
})
