import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 7 blocker — raw SQL a restricted person runs must carry scope_params
// for every dimension they are restricted on that reaches a table the SQL
// reads. Otherwise the query is refused (QUERY_NOT_SCOPED), never run.

const state = vi.hoisted(() => ({
  scopes: [] as Array<{ mode: string; dimension: string; values: unknown[] }>,
  tables: ['workflows'] as string[],
  reach: new Set<string>(['zone|workflows', 'zone|divisions'])
}))

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const c: Record<string, unknown> = {}
    c.pluck = vi.fn(async () =>
      table === 'nivaro_collections' ? ['workflows', 'divisions', 'vendors'] : []
    )
    c.whereIn = vi.fn(() => c)
    c.select = vi.fn(async () => [{ name: 'Zone 1' }])
    return c
  })
}))
vi.mock('../../../services/query-freshness.js', () => ({
  tablesReadBy: vi.fn(async () => state.tables)
}))
vi.mock('../../../services/user-scopes.js', () => ({
  getUserScopes: vi.fn(async () => state.scopes),
  listScopeDimensions: vi.fn(async () => [
    { name: 'zone', label: 'Zone', target_collection: 'divisions', display_field: 'name' }
  ]),
  scopeHopsFor: vi.fn(async (dim: { name: string }, table: string) =>
    state.reach.has(`${dim.name}|${table}`) ? [] : null
  )
}))

const { applyScopeParams, QueryNotScopedError } = await import(
  '../../../services/custom-query-scope.js'
)

let n = 0
// A fresh SQL text per test keeps the reach memo out of the way.
const sql = (body: string) => `${body} /* t${++n} */`

describe('custom-query scope gate', () => {
  beforeEach(() => {
    state.scopes = [{ mode: 'restrict', dimension: 'zone', values: [1] }]
    state.tables = ['workflows']
  })

  it('refuses a restricted person when the SQL reads a zone-scoped table without zone scope_params', async () => {
    const params: Record<string, unknown> = {}
    await expect(
      applyScopeParams(null, params, 'u1', false, {
        slug: 'project-workflows',
        sqlText: sql('SELECT * FROM workflows')
      })
    ).rejects.toBeInstanceOf(QueryNotScopedError)
    await expect(
      applyScopeParams(null, params, 'u1', false, {
        slug: 'project-workflows',
        sqlText: sql('SELECT * FROM workflows')
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'QUERY_NOT_SCOPED', dimensions: ['Zone'] })
  })

  it('runs when scope_params carry the dimension, and injects the allowance', async () => {
    const params: Record<string, unknown> = {}
    await applyScopeParams(
      JSON.stringify({ divisions: { dimension: 'zone', translate: 'display' } }),
      params,
      'u1',
      false,
      { slug: 'q', sqlText: sql('SELECT * FROM workflows') }
    )
    expect(params.divisions).toBe('Zone 1')
  })

  it('refuses a restricted administrator like anyone (2026-11-08)', async () => {
    await expect(
      applyScopeParams(null, {}, 'admin', true, { sqlText: sql('SELECT * FROM workflows') })
    ).rejects.toMatchObject({ code: 'QUERY_NOT_SCOPED' })
  })

  it('never refuses unrestricted people, administrators included', async () => {
    state.scopes = []
    await applyScopeParams(null, {}, 'admin', true, { sqlText: sql('SELECT * FROM workflows') })
    await applyScopeParams(null, {}, 'u2', false, { sqlText: sql('SELECT * FROM workflows') })
    state.scopes = [{ mode: 'default', dimension: 'zone', values: [1] }]
    await applyScopeParams(null, {}, 'u3', false, { sqlText: sql('SELECT * FROM workflows') })
  })

  it('lets through SQL that reads no table the dimension reaches', async () => {
    state.tables = ['vendors']
    await applyScopeParams(null, {}, 'u1', false, { sqlText: sql('SELECT * FROM vendors') })
  })

  it('honours an administrator $not_scoped declaration', async () => {
    await applyScopeParams(
      JSON.stringify({ $not_scoped: { reason: 'zone picker' } }),
      {},
      'u1',
      false,
      { sqlText: sql('SELECT name FROM divisions') }
    )
  })

  it('fails closed when the tables cannot be worked out', async () => {
    const qf = await import('../../../services/query-freshness.js')
    vi.mocked(qf.tablesReadBy).mockRejectedValueOnce(new Error('boom'))
    await expect(
      applyScopeParams(null, {}, 'u1', false, { sqlText: sql('EXEC dbo.anything') })
    ).rejects.toBeInstanceOf(QueryNotScopedError)
  })

  it('keeps the old behaviour for callers that pass no SQL', async () => {
    await applyScopeParams(null, {}, 'u1', false)
  })
})
