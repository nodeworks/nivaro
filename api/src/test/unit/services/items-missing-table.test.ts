import { describe, expect, it, vi } from 'vitest'

// nivaro_relations / nivaro_collections are claims, not truth: forecasts_regions
// is registered (and a junction of forecasts ↔ regions) but has no table. Its
// own list answers a coded 404, and a read of forecasts that names the M2M
// does not fail on the junction.

const rec = vi.hoisted(() => ({
  tables: [] as string[],
  raw: [] as Array<{ sql: string; b: unknown[] }>
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
            rec.tables.push(table)
            return (
              table === 'forecasts_regions'
                ? Promise.reject(new Error("Invalid object name 'forecasts_regions'."))
                : Promise.resolve(table === 'forecasts' ? [{ id: 1, amount: 5 }] : [])
            ).then(res, rej)
          }
        if (prop === 'columnInfo') return async () => ({ id: {}, amount: {} })
        if (prop === 'first') return () => Promise.resolve(undefined)
        if (prop === 'toSQL') return () => ({ sql: '', bindings: [] })
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw')
        return (sql: string, b: unknown[] = []) => {
          rec.raw.push({ sql, b })
          return /sys\.objects/i.test(sql)
            ? [
                { s: 'dbo', name: 'forecasts', d: 1 },
                { s: 'dbo', name: 'regions', d: 1 }
              ]
            : /information_schema\.columns/i.test(sql)
              ? [{ COLUMN_NAME: 'id' }, { COLUMN_NAME: 'amount' }]
              : { sql, toString: () => sql }
        }
      if (prop === 'transaction') return async (fn: (t: unknown) => unknown) => fn(db)
      return () => chain('raw')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  isAdminRole: vi.fn(async () => true),
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null),
  getRowFilter: vi.fn(async () => null)
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  getCollection: vi.fn(async (c: string) =>
    ['forecasts', 'forecasts_regions', 'regions'].includes(c) ? { collection: c } : undefined
  ),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async (c: string) =>
    c === 'forecasts'
      ? [
          {
            many_collection: 'forecasts_regions',
            many_field: 'forecasts_id',
            one_collection: 'forecasts',
            one_field: 'regions',
            junction_field: 'regions_id'
          },
          {
            many_collection: 'forecasts_regions',
            many_field: 'regions_id',
            one_collection: 'regions',
            junction_field: 'forecasts_id'
          }
        ]
      : []
  )
}))

import { columnShapes, readItems, readOne } from '../../../services/items.js'

const someone = { id: 'U-1', role: 'R' } as never

describe('a registered collection with no table', () => {
  it('answers a coded 404, never the driver error', async () => {
    await expect(readItems(someone, 'forecasts_regions', { limit: 5 })).rejects.toMatchObject({
      statusCode: 404,
      code: 'COLLECTION_TABLE_MISSING'
    })
    await expect(readOne(someone, 'forecasts_regions', 1)).rejects.toMatchObject({
      code: 'COLLECTION_TABLE_MISSING'
    })
  })

  it('does not take a read of a related collection down through its missing junction', async () => {
    rec.tables = []
    const res = (await readItems(someone, 'forecasts', {
      fields: ['id', 'amount', 'regions.*'],
      limit: 5
    })) as { data: Array<Record<string, unknown>> }
    expect(res.data[0]?.id).toBe(1)
    expect(rec.tables).not.toContain('forecasts_regions')
  })

  it('reads column types from the schema a bare name resolves to: default first, then dbo', async () => {
    rec.raw = []
    await columnShapes('forecasts_only_for_shapes')
    const q = rec.raw.find((r) => /NUMERIC_PRECISION/.test(r.sql))
    expect(q?.sql).toMatch(/TABLE_SCHEMA IN \(SCHEMA_NAME\(\), 'dbo'\)/)
    expect(q?.b).toEqual(['forecasts_only_for_shapes', null, 'forecasts_only_for_shapes'])
    rec.raw = []
    await columnShapes('staging.loads')
    expect(rec.raw.find((r) => /NUMERIC_PRECISION/.test(r.sql))?.b).toEqual([
      'loads',
      'staging',
      'loads'
    ])
  })
})
