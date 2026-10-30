import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * recordIdsInRegion / userIdsInRegion over a tiny in-memory "database": the detection reads the
 * metadata tables, then each path runs its narrowing query. Every name below is test data.
 */
type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {
  nivaro_collections: [
    { collection: 'sites', display_name: 'Sites', display_template: null },
    { collection: 'territories', display_name: null, display_template: null },
    { collection: 'site_territories', display_name: null, display_template: null },
    { collection: 'tickets', display_name: null, display_template: null },
    { collection: 'orders', display_name: null, display_template: null }
  ],
  nivaro_fields: [
    { collection: 'sites', field: 'latitude', type: 'decimal', db_column: null },
    { collection: 'sites', field: 'longitude', type: 'decimal', db_column: null },
    { collection: 'territories', field: 'name', type: 'string', db_column: null }
  ],
  nivaro_relations: [
    {
      many_collection: 'site_territories',
      many_field: 'site',
      one_collection: 'sites',
      junction_field: 'territory'
    },
    {
      many_collection: 'site_territories',
      many_field: 'territory',
      one_collection: 'territories',
      junction_field: 'site'
    },
    {
      many_collection: 'tickets',
      many_field: 'site',
      one_collection: 'sites',
      junction_field: null
    },
    {
      many_collection: 'orders',
      many_field: 'territory',
      one_collection: 'territories',
      junction_field: null
    }
  ],
  site_territories: [
    { site: 1, territory: 7 },
    { site: 2, territory: 7 },
    { site: 3, territory: 8 }
  ],
  tickets: [
    { id: 100, site: 1 },
    { id: 101, site: 3 },
    { id: 102, site: 2 }
  ],
  orders: [
    { id: 5, territory: 7 },
    { id: 6, territory: 8 }
  ],
  nivaro_user_scopes: [
    { user: 'aaaa-1', dimension: 'territory', values: '[7]' },
    { user: 'bbbb-2', dimension: 'territory', values: '["8"]' },
    { user: 'cccc-3', dimension: 'other', values: '[7]' }
  ]
}

function builder(table: string) {
  let rows = [...(tables[table] ?? [])]
  let cols: string[] | null = null
  const run = () => rows.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r))
  const b: Record<string, unknown> = {
    select(...c: unknown[]) {
      const flat = c.flat() as string[]
      cols = flat.length ? flat : null
      return b
    },
    where(c: string | Row, v?: unknown) {
      if (typeof c === 'object')
        rows = rows.filter((r) => Object.entries(c).every(([k, x]) => String(r[k]) === String(x)))
      else rows = rows.filter((r) => String(r[c]) === String(v))
      return b
    },
    whereNotNull(c: string) {
      rows = rows.filter((r) => r[c] != null)
      return b
    },
    whereIn(c: string, sub: { __rows: () => Row[] }) {
      const vals = new Set(sub.__rows().map((r) => String(Object.values(r)[0])))
      rows = rows.filter((r) => vals.has(String(r[c])))
      return b
    },
    limit() {
      return Promise.resolve(run())
    },
    __rows: run,
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then(res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(res, rej)
    }
  }
  return b
}

vi.mock('../../db/index.js', () => ({ db: (t: string) => builder(t) }))
vi.mock('../user-scopes.js', () => ({
  listScopeDimensions: async () => [
    {
      name: 'territory',
      label: 'Territory',
      target_collection: 'territories',
      display_field: 'name',
      is_active: true
    }
  ]
}))
vi.mock('./config.js', () => ({
  readCcConfig: async () => ({
    geo_collections: [],
    region: null,
    stuck_days: 7,
    role_defaults: {}
  })
}))

import { bustRegionCaches, recordIdsInRegion, userIdsInRegion } from './regions.js'

describe('recordIdsInRegion (detected source)', () => {
  beforeEach(() => bustRegionCaches())

  it('geo records through the junction', async () => {
    expect([...((await recordIdsInRegion('sites', '7')) ?? [])].sort()).toEqual(['1', '2'])
  })
  it('records that link to a geo record in the region', async () => {
    expect([...((await recordIdsInRegion('tickets', '7')) ?? [])].sort()).toEqual(['100', '102'])
  })
  it('records with a direct link to the region', async () => {
    expect([...((await recordIdsInRegion('orders', '8')) ?? [])]).toEqual(['6'])
  })
  it('the region itself', async () => {
    expect([...((await recordIdsInRegion('territories', '8')) ?? [])]).toEqual(['8'])
  })
  it('null for a collection that cannot be placed, and for system tables', async () => {
    expect(await recordIdsInRegion('invoices', '7')).toBeNull()
    expect(await recordIdsInRegion('nivaro_users', '7')).toBeNull()
  })
})

describe('userIdsInRegion', () => {
  beforeEach(() => bustRegionCaches())
  it('people whose region scope names the region (other dimensions ignored)', async () => {
    expect([...((await userIdsInRegion('7')) ?? [])]).toEqual(['AAAA-1'])
    expect([...((await userIdsInRegion('8')) ?? [])]).toEqual(['BBBB-2'])
  })
})
