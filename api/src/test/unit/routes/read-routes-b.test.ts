import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army v3 (fix-reads-b): route-level gates — page-builder widgets, semantic
// search, virtual collections, push subscriptions, picker batch-status.
// Each gate: one refused caller, one allowed caller.

const m = vi.hoisted(() => ({
  admin: false,
  can: true,
  allowed: null as string[] | null,
  scopes: [] as Array<{ mode: string; values: unknown[] }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  raw: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; patch: unknown }>,
  inserts: [] as Array<{ table: string; row: unknown }>,
  whereIns: [] as Array<{ table: string; n: number }>,
  readItems: vi.fn(),
  aggregateItems: vi.fn()
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'r-approver' }
    req.isAdmin = m.admin
  }
  return { authenticate: vi.fn(sign), requireAuth: vi.fn(sign), requireAdmin: vi.fn(sign) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => m.can),
  getAllowedFields: vi.fn(async () => m.allowed)
}))
vi.mock('../../../services/user-scopes.js', () => ({ getUserScopes: vi.fn(async () => m.scopes) }))
vi.mock('../../../services/items.js', () => ({
  readItems: m.readItems,
  aggregateItems: m.aggregateItems
}))
vi.mock('../../../services/sla-visibility.js', () => ({
  visibleRecordIds: vi.fn(async () => new Set<string>())
}))
vi.mock('../../../services/embeddings.js', () => ({
  embedText: vi.fn(async () => [0.1]),
  getEmbeddableFields: vi.fn(async () => []),
  searchEmbeddings: vi.fn(async () => [
    { item: '1', field: 'description', score: 0.9 },
    { item: '2', field: 'secret_notes', score: 0.8 }
  ]),
  upsertItemEmbedding: vi.fn()
}))
vi.mock('../../../services/embedding-freshness.js', () => ({
  bustFreshnessCache: vi.fn(),
  embeddingFreshness: vi.fn()
}))
vi.mock('../../../services/web-push.js', () => ({
  endpointHash: (e: string) => `h:${e}`,
  getVapidKeys: vi.fn(async () => ({ publicKey: 'pk' })),
  sendWebPush: vi.fn()
}))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const preds: Array<(r: Record<string, unknown>) => boolean> = []
    const hits = () => (m.tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
    const api: Record<string, unknown> = {
      where: (w: Record<string, unknown>) => {
        if (w && typeof w === 'object')
          preds.push((r) => Object.entries(w).every(([k, v]) => String(r[k]) === String(v)))
        return api
      },
      whereIn: (col: string, vals: unknown[]) => {
        m.whereIns.push({ table, n: vals.length })
        preds.push((r) => vals.map(String).includes(String(r[col])))
        return api
      },
      select: () => api,
      orderBy: () => api,
      limit: () => api,
      first: async () => hits()[0],
      update: async (patch: unknown) => {
        m.updates.push({ table, patch })
        return 1
      },
      insert: async (row: unknown) => {
        m.inserts.push({ table, row })
        return [1]
      },
      // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaitable
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(hits()).then(res, rej)
    }
    return api
  }
  return { db: Object.assign((t: string) => chain(t), { raw: vi.fn(async () => [m.raw]) }) }
})

const { pagesRoutes } = await import('../../../routes/pages.js')
const { semanticSearchRoutes } = await import('../../../routes/semantic-search.js')
const { virtualCollectionsRoutes } = await import('../../../routes/virtual-collections.js')
const { pushRoutes } = await import('../../../routes/push.js')
const { pickerExclusionRoutes, BATCH_STATUS_MAX } = await import(
  '../../../routes/picker-exclusions.js'
)

async function build() {
  const app = Fastify()
  await app.register(pagesRoutes, { prefix: '/pages' })
  await app.register(semanticSearchRoutes, { prefix: '/search' })
  await app.register(virtualCollectionsRoutes, { prefix: '/virtual-collections' })
  await app.register(pushRoutes, { prefix: '/push' })
  await app.register(pickerExclusionRoutes, { prefix: '/picker-exclusions' })
  await app.ready()
  return app
}

beforeEach(() => {
  m.admin = false
  m.can = true
  m.allowed = null
  m.scopes = []
  m.tables = {}
  m.raw = []
  m.updates = []
  m.inserts = []
  m.whereIns = []
  m.readItems.mockReset()
  m.aggregateItems.mockReset()
})

const page = (widgets: unknown[]) => ({
  id: 1,
  slug: 'p',
  is_shared: 1,
  created_by: 'OTHER',
  layout: JSON.stringify({ columns: 12, widgets })
})

describe('page-builder widgets read as the viewer', () => {
  it('refuses a table widget naming a column the viewer cannot read', async () => {
    m.allowed = ['id', 'name']
    m.tables.nivaro_pages = [
      page([{ id: 'w', type: 'table', config: { collection: 'workflows', columns: ['amount'] } }])
    ]
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/pages/p/widget-data',
      payload: { widget_id: 'w' }
    })
    expect(r.statusCode).toBe(403)
    expect(m.readItems).not.toHaveBeenCalled()
  })
  it('a readable table widget goes through readItems as the caller', async () => {
    m.allowed = ['id', 'name']
    m.readItems.mockResolvedValue({ data: [{ id: 1, name: 'A' }] })
    m.tables.nivaro_pages = [
      page([{ id: 'w', type: 'table', config: { collection: 'workflows', columns: ['name'] } }])
    ]
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/pages/p/widget-data',
      payload: { widget_id: 'w' }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.rows).toEqual([{ id: 1, name: 'A' }])
    expect(m.readItems.mock.calls[0][0]).toMatchObject({ id: 'U1' })
    expect(m.readItems.mock.calls[0][2]).toMatchObject({ fields: ['name'] })
  })
  it('a kpi sums as the viewer through aggregateItems', async () => {
    m.aggregateItems.mockResolvedValue({ data: [{ sum: { amount: 42 } }] })
    m.tables.nivaro_pages = [
      page([
        {
          id: 'k',
          type: 'kpi',
          config: { collection: 'workflows', aggregate: 'sum', field: 'amount' }
        }
      ])
    ]
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/pages/p/widget-data',
      payload: { widget_id: 'k' }
    })
    expect(r.json().data.value).toBe(42)
    expect(m.aggregateItems.mock.calls[0][0]).toMatchObject({ id: 'U1' })
  })
})

describe('semantic search hydrates as the caller', () => {
  it('drops matches on hidden fields and rows the caller cannot read', async () => {
    m.allowed = ['id', 'description']
    m.readItems.mockResolvedValue({ data: [] })
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/search/semantic',
      payload: { collection: 'workflows', query: 'x' }
    })
    expect(r.json().data).toEqual([])
    // Only the readable field's match was hydrated, and as the caller.
    expect(m.readItems.mock.calls[0][2]).toMatchObject({ filter: { id: { _in: ['1'] } } })
  })
  it('returns a readable match', async () => {
    m.readItems.mockResolvedValue({ data: [{ id: 1, description: 'd' }] })
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/search/semantic',
      payload: { collection: 'workflows', query: 'x' }
    })
    expect(r.json().data).toEqual([
      { item: { id: 1, description: 'd' }, score: 0.9, field: 'description' }
    ])
  })
})

describe('virtual collection SQL', () => {
  const vc = { collection: 'v_spend', is_virtual: 1, virtual_sql: 'SELECT 1 AS id, 2 AS secret' }
  it('refuses a role without read, and a User-Scoped person', async () => {
    m.tables.nivaro_collections = [vc]
    const app = await build()
    m.can = false
    expect(
      (await app.inject({ method: 'POST', url: '/virtual-collections/v_spend/query' })).statusCode
    ).toBe(403)
    m.can = true
    m.scopes = [{ mode: 'restrict', values: [1] }]
    expect(
      (await app.inject({ method: 'POST', url: '/virtual-collections/v_spend/query' })).statusCode
    ).toBe(403)
  })
  it('answers a reader with only the columns their policy allows, never SQL text', async () => {
    m.tables.nivaro_collections = [vc]
    m.allowed = ['amount']
    m.raw = [{ id: 1, amount: 5, secret: 2 }]
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/virtual-collections/v_spend/query' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual([{ id: 1, amount: 5 }])
  })
})

describe('push subscriptions', () => {
  const body = { endpoint: 'https://push.example/abc', keys: { p256dh: 'P', auth: 'A' } }
  it("will not re-point another account's endpoint with other keys", async () => {
    m.tables.nivaro_push_subscriptions = [
      { endpoint_hash: `h:${body.endpoint}`, user: 'VICTIM', keys_p256dh: 'X', keys_auth: 'Y' }
    ]
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/push/subscribe', payload: body })
    expect(r.statusCode).toBe(409)
    expect(m.updates).toEqual([])
  })
  it('moves the same browser subscription to whoever signs in on it', async () => {
    m.tables.nivaro_push_subscriptions = [
      { endpoint_hash: `h:${body.endpoint}`, user: 'PREVIOUS', keys_p256dh: 'P', keys_auth: 'A' }
    ]
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/push/subscribe', payload: body })
    expect(r.statusCode).toBe(200)
    expect(m.updates[0]).toMatchObject({ table: 'nivaro_push_subscriptions' })
  })
})

describe('picker batch-status', () => {
  it('refuses more ids than the cap', async () => {
    const app = await build()
    const ids = Array.from({ length: BATCH_STATUS_MAX + 1 }, (_, i) => String(i))
    const r = await app.inject({
      method: 'POST',
      url: '/picker-exclusions/batch-status',
      payload: { collection: 'vendors', ids }
    })
    expect(r.statusCode).toBe(400)
  })
  it('checks a large list in chunks under the parameter cap', async () => {
    m.tables.nivaro_picker_exclusions = [{ collection: 'vendors', item_id: '2500' }]
    const app = await build()
    const ids = Array.from({ length: 3000 }, (_, i) => String(i))
    const r = await app.inject({
      method: 'POST',
      url: '/picker-exclusions/batch-status',
      payload: { collection: 'vendors', ids }
    })
    expect(r.json().data.excluded).toEqual(['2500'])
    expect(Math.max(...m.whereIns.map((w) => w.n))).toBeLessThanOrEqual(1000)
  })
})
