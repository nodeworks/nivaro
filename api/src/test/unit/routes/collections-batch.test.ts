import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Batched collection metadata (`GET /collections?names=`) must answer exactly
// what the single read (`GET /collections/:collection`) answers for each
// name, to the same caller — same hooks, same payload builder.

const authState = { isAdmin: false }
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'viewer', role: 'user' }
    req.isAdmin = authState.isAdmin
  })
}))
vi.mock('../../../middleware/workspace.js', () => ({
  resolveWorkspace: vi.fn(async (req: { workspaceId?: string }) => {
    req.workspaceId = 'ws-1'
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../hooks/activity.js', () => ({ clearAccountabilityCache: vi.fn() }))
vi.mock('../../../services/items.js', () => ({
  sqlFilterableVirtualFields: vi.fn(async (c: string) =>
    c === 'workflows' ? [{ field: 'age_days', kind: 'number' }] : []
  )
}))

const rawMock = vi.fn()
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(vi.fn(), { raw: (...a: unknown[]) => rawMock(...a) })
}))

const COLLECTIONS: Record<string, Record<string, unknown>> = {
  workflows: {
    collection: 'workflows',
    display_template: '{{name}}',
    browser_config: '{"record_tabs":true}',
    summary_mode_rules: null,
    url_alias_fields: '["number"]',
    read_mode_toggle: 1
  },
  org_codes: { collection: 'org_codes', browser_config: 'not json' },
  // Registered but no nivaro_fields rows — synthesized from the allowlist.
  nivaro_users: { collection: 'nivaro_users' },
  broken: { collection: 'broken' }
}

vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async (c: string) => COLLECTIONS[c] ?? null),
  getFields: vi.fn(async (c: string) => {
    if (c === 'broken') throw new Error('boom')
    if (c === 'workflows')
      return [
        { field: 'name', type: 'string' },
        { field: 'age_days', type: 'alias' }
      ]
    if (c === 'org_codes') return [{ field: 'code', type: 'string' }]
    return []
  }),
  getRelations: vi.fn(async (c: string) =>
    c === 'workflows'
      ? [{ many_collection: 'workflows', many_field: 'org', one_collection: 'org_codes' }]
      : []
  ),
  listCollections: vi.fn(async () => [{ collection: 'workflows' }]),
  listTableCollections: vi.fn(async () => [])
}))

import {
  COLLECTION_BATCH_LIMIT,
  collectionsRoutes,
  parseCollectionNames
} from '../../../routes/collections.js'
import * as svc from '../../../services/collections.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(collectionsRoutes, { prefix: '/collections' })
  return app
}

afterEach(() => {
  vi.clearAllMocks()
  authState.isAdmin = false
})

rawMock.mockImplementation(async () => [
  { COLUMN_NAME: 'id', DATA_TYPE: 'uniqueidentifier', ORDINAL_POSITION: 1 },
  { COLUMN_NAME: 'email', DATA_TYPE: 'nvarchar', ORDINAL_POSITION: 2 },
  { COLUMN_NAME: 'password', DATA_TYPE: 'nvarchar', ORDINAL_POSITION: 3 },
  { COLUMN_NAME: 'static_token', DATA_TYPE: 'nvarchar', ORDINAL_POSITION: 4 }
])

describe('GET /collections?names= (batched metadata)', () => {
  it('a non-admin gets, per name, exactly what the single read returns', async () => {
    const app = buildApp()
    const names = ['workflows', 'org_codes', 'nivaro_users']
    const batch = await app.inject({ method: 'GET', url: `/collections?names=${names.join(',')}` })
    expect(batch.statusCode).toBe(200)
    const body = batch.json() as {
      data: Record<string, unknown>
      missing: string[]
      errors: Record<string, string>
    }
    expect(Array.isArray(body.data)).toBe(false)
    expect(body.missing).toEqual([])
    expect(body.errors).toEqual({})
    for (const name of names) {
      const single = await app.inject({ method: 'GET', url: `/collections/${name}` })
      expect(single.statusCode).toBe(200)
      expect(body.data[name]).toEqual((single.json() as { data: unknown }).data)
    }
    // The system table only ever surfaces its allowlisted columns — through both reads.
    const users = body.data.nivaro_users as { fields: Array<{ field: string }> }
    expect(users.fields.map((f) => f.field)).toEqual(['id', 'email'])
    const wf = body.data.workflows as Record<string, unknown>
    expect(wf.browser_config).toEqual({ record_tabs: true })
    expect(wf.read_mode_toggle).toBe(true)
    expect(wf.url_alias_fields).toEqual(['number'])
    expect(
      (wf.fields as Array<{ field: string; sql_filterable?: boolean }>)[1].sql_filterable
    ).toBe(true)
    expect((body.data.org_codes as Record<string, unknown>).browser_config).toBeNull()
  })

  it('unregistered names go to missing (the single read 404s them)', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/collections?names=workflows,nope' })
    const body = res.json() as { data: Record<string, unknown>; missing: string[] }
    expect(Object.keys(body.data)).toEqual(['workflows'])
    expect(body.missing).toEqual(['nope'])
    const single = await app.inject({ method: 'GET', url: '/collections/nope' })
    expect(single.statusCode).toBe(404)
  })

  it('one failing name does not fail the rest', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/collections?names=broken,org_codes' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: Record<string, unknown>; errors: Record<string, string> }
    expect(Object.keys(body.data)).toEqual(['org_codes'])
    expect(Object.keys(body.errors)).toEqual(['broken'])
    expect(body.errors.broken).not.toContain('boom')
  })

  it('dedupes names and reads each once', async () => {
    const app = buildApp()
    await app.inject({ method: 'GET', url: '/collections?names=org_codes,org_codes,%20org_codes' })
    expect(vi.mocked(svc.getCollection)).toHaveBeenCalledTimes(1)
  })

  it('refuses bad names and oversized lists with 400', async () => {
    const app = buildApp()
    const bad = await app.inject({
      method: 'GET',
      url: `/collections?names=${encodeURIComponent("workflows,x'; drop table y--")}`
    })
    expect(bad.statusCode).toBe(400)
    const many = Array.from({ length: COLLECTION_BATCH_LIMIT + 1 }, (_, i) => `c${i}`).join(',')
    const big = await app.inject({ method: 'GET', url: `/collections?names=${many}` })
    expect(big.statusCode).toBe(400)
    const empty = await app.inject({ method: 'GET', url: '/collections?names=' })
    expect(empty.statusCode).toBe(400)
    expect(vi.mocked(svc.getCollection)).not.toHaveBeenCalled()
  })

  it('without names the list route is unchanged', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/collections' })
    expect(res.json()).toEqual({ data: [{ collection: 'workflows' }] })
    expect(vi.mocked(svc.listCollections)).toHaveBeenCalledWith('ws-1')
  })
})

describe('parseCollectionNames', () => {
  it('trims, dedupes and accepts table-shaped names', () => {
    expect(parseCollectionNames(' a_b , c-d,a_b,,')).toEqual({ names: ['a_b', 'c-d'] })
  })
  it('rejects non-strings, dots, slashes and leading digits', () => {
    expect('error' in parseCollectionNames(undefined)).toBe(true)
    expect('error' in parseCollectionNames(['a'])).toBe(true)
    expect('error' in parseCollectionNames('a.b')).toBe(true)
    expect('error' in parseCollectionNames('a/b')).toBe(true)
    expect('error' in parseCollectionNames('1abc')).toBe(true)
  })
})
