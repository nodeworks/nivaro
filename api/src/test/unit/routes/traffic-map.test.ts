import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'test-admin' }
  })
}))
vi.mock('../../../plugins/socketio.js', () => ({
  getRealtimeStats: () => ({
    sockets: [{ user: { id: 'u1' } }, { user: { id: 'u1' } }, { user: null }],
    rooms: []
  })
}))
vi.mock('../../../services/event-journal.js', () => ({ currentSeq: vi.fn(async () => 1234) }))
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: () => null,
  currentTraceMeta: () => null,
  listTraces: () => [
    {
      id: 't1',
      method: 'PATCH',
      route: '/api/items/:collection/:id',
      url: '/api/items/workflows/5?x=1',
      status: 500,
      user: null,
      total_ms: 15000,
      spans: [],
      ts: 'now',
      queries: 0,
      sql_ms: 0
    },
    {
      id: 't2',
      method: 'GET',
      route: '/api/items/:collection',
      url: '/api/items/other',
      status: 200,
      user: null,
      total_ms: 9000,
      spans: [],
      ts: 'now',
      queries: 0,
      sql_ms: 0
    }
  ]
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRoutes: new Map([
    ['efp-ops', [{ method: 'GET', url: '/api/efp/x/:id', gate: 'admin' }]]
  ]),
  loadedExtensionLabels: () => ({ 'efp-ops': 'EFP Operations' })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { resetTrafficCatalog, trafficMapRoutes } from '../../../routes/traffic-map.js'
import {
  advanceTo,
  noteOutbound,
  noteRequest,
  resetTrafficMap
} from '../../../services/traffic-map.js'

const T0 = 1_800_000_000
function tableMock(rows: Record<string, Array<Record<string, unknown>>>) {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
    const data = rows[table] ?? []
    const chain: Record<string, unknown> = {}
    for (const m of [
      'where',
      'whereIn',
      'whereNull',
      'whereNot',
      'orWhereRaw',
      'orderBy',
      'limit',
      'select'
    ])
      chain[m] = vi.fn((a?: unknown) => {
        if (typeof a === 'function') (a as (b: unknown) => void)(chain)
        return chain
      })
    chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(data).catch(fn)
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    chain.then = (res: (v: unknown) => void) => res(data)
    return chain
  })
}
function buildApp() {
  const app = Fastify({ logger: false })
  app.register(trafficMapRoutes, { prefix: '/traffic-map' })
  return app
}
const req = (over: Record<string, unknown>) => ({
  method: 'GET',
  path: '/api/items/workflows',
  status: 200,
  latencyMs: 9,
  authMethod: 'api_key',
  apiKeyId: 7,
  userId: null,
  graphqlOperation: null,
  graphqlKind: null,
  cacheHit: false,
  at: T0 * 1000,
  ...over
})
beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
  delete process.env.CLOUD_META_DB_URL
})
afterEach(() => {
  vi.clearAllMocks()
  delete process.env.CLOUD_META_DB_URL
})

describe('GET /traffic-map/snapshot', () => {
  it('returns the ring snapshot with node scope and socket counts', async () => {
    noteRequest(req({ latencyMs: 90 }) as never)
    const res = await buildApp().inject({ method: 'GET', url: '/traffic-map/snapshot?window=300' })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.window_s).toBe(300)
    expect(body.instance).toBe('test-node')
    expect(body.node_scope).toMatch(/this API process only/)
    expect(body.sockets).toEqual({ count: 3, users: 1 })
    expect(body.journal_seq).toBe(1234)
    expect(body.entities[0]).toMatchObject({ key: 'items/workflows', req: 1 })
    expect(body.lanes.map((l: { id: string }) => l.id)).toContain('items')
  })
  it('rejects a window outside 60/300/900', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/traffic-map/snapshot?window=42' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WINDOW_INVALID')
  })
  it('answers 404 in cloud mode', async () => {
    process.env.CLOUD_META_DB_URL = 'x'
    const res = await buildApp().inject({ method: 'GET', url: '/traffic-map/snapshot' })
    expect(res.statusCode).toBe(404)
    const cat = await buildApp().inject({ method: 'GET', url: '/traffic-map/catalog' })
    expect(cat.statusCode).toBe(404)
  })
})

describe('GET /traffic-map/catalog', () => {
  it('labels the entities and callers seen', async () => {
    noteRequest(req({}) as never)
    noteRequest(req({ authMethod: 'session', apiKeyId: null, userId: 'AAAA' }) as never)
    noteOutbound({ apiId: 3, apiName: 'MDSi', status: 200, durationMs: 10, at: T0 * 1000 })
    tableMock({
      nivaro_collections: [{ collection: 'workflows', display_name: 'Workflows' }],
      nivaro_widgets: [{ id: 1, name: 'Project Budgets' }],
      nivaro_pages: [{ slug: 'budget-overview', name: 'Budget & Spend' }],
      nivaro_custom_queries: [{ slug: 'rpt-budget-health', name: 'Budget health' }],
      nivaro_inbound_mappings: [{ key: 'mwf-shipments', label: 'MWF shipments' }],
      nivaro_external_apis: [{ id: 3, name: 'MDSi' }],
      nivaro_api_keys: [{ id: 7, name: 'Fusion IIP — shipment updates' }],
      nivaro_users: [
        {
          id: 'AAAA',
          first_name: 'Robert',
          last_name: 'Lee',
          email: 'rob@example.com',
          account_kind: null
        }
      ]
    })
    const res = await buildApp().inject({ method: 'GET', url: '/traffic-map/catalog' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.collections.workflows).toEqual({ label: 'Workflows', system: false })
    expect(d.widgets['1']).toBe('Project Budgets')
    expect(d.pages['budget-overview']).toBe('Budget & Spend')
    expect(d.queries['rpt-budget-health']).toBe('Budget health')
    expect(d.inbound['mwf-shipments']).toBe('MWF shipments')
    expect(d.partners['3']).toBe('MDSi')
    expect(d.extensions['efp-ops']).toBe('EFP Operations')
    expect(d.callers.k7).toEqual({ label: 'Fusion IIP — shipment updates', kind: 'key' })
    expect(d.callers.uAAAA).toEqual({ label: 'Robert Lee', kind: 'person' })
    expect(d.callers.cron).toEqual({ label: 'Crons & flows', kind: 'cron' })
    expect(d.down).toEqual({ db: 'SQL Server', redis: 'Redis', store: 'File storage' })
    expect(JSON.stringify(d)).not.toContain('rob@example.com')
  })
})

describe('GET /traffic-map/entity/:lane/:entity', () => {
  it('rolls nivaro_api_logs up for the entity and attaches open issues and slow traces', async () => {
    const at = new Date(Date.now() - 120_000)
    tableMock({
      nivaro_api_logs: [
        {
          method: 'GET',
          path: '/api/items/workflows',
          status: 200,
          latency_ms: 80,
          auth: 'session',
          api_key_id: null,
          user: 'U1',
          graphql_operation: null,
          graphql_kind: null,
          created_at: at
        },
        {
          method: 'PATCH',
          path: '/api/items/workflows/5',
          status: 500,
          latency_ms: 15000,
          auth: 'token',
          api_key_id: null,
          user: 'U2',
          graphql_operation: null,
          graphql_kind: null,
          created_at: at
        }
      ],
      nivaro_issues: [
        {
          id: 9,
          title: '[server] PATCH /api/items/:collection/:id: KnexTimeoutError',
          severity: 'high',
          status: 'open',
          occurrence_count: 4,
          last_seen_at: at
        }
      ]
    })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/traffic-map/entity/items/workflows?hours=1'
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.key).toBe('items/workflows')
    expect(d.totals).toMatchObject({ req: 2, error: 1, write_requests: 1 })
    expect(d.issues[0]).toMatchObject({ id: 9, severity: 'high' })
    expect(d.slow_traces).toHaveLength(1)
    expect(d.slow_traces[0].id).toBe('t1')
    expect(JSON.stringify(d)).not.toContain('user_agent')
  })
  it('extension lane with no registered routes answers empty without a query', async () => {
    tableMock({})
    const res = await buildApp().inject({
      method: 'GET',
      url: '/traffic-map/entity/extension/ghost?hours=1'
    })
    expect(res.json().data.totals.req).toBe(0)
  })
  it('refuses a bad lane, a bad hours value and an entity that is not a name', async () => {
    expect(
      (await buildApp().inject({ method: 'GET', url: '/traffic-map/entity/nope/x' })).statusCode
    ).toBe(400)
    expect(
      (
        await buildApp().inject({
          method: 'GET',
          url: '/traffic-map/entity/items/workflows?hours=3'
        })
      ).statusCode
    ).toBe(400)
    expect(
      (await buildApp().inject({ method: 'GET', url: '/traffic-map/entity/items/..%2F..' }))
        .statusCode
    ).toBe(400)
  })
})

describe('GET /traffic-map/down/:id', () => {
  it('partner nodes read nivaro_outbound_log; stores answer with a note', async () => {
    const at = new Date(Date.now() - 60_000)
    tableMock({
      nivaro_outbound_log: [
        {
          method: 'POST',
          path: '/deploymentRequests',
          status: 200,
          ok: true,
          duration_ms: 1800,
          created_at: at
        },
        {
          method: 'POST',
          path: '/deploymentRequests',
          status: null,
          ok: false,
          duration_ms: 30000,
          created_at: at
        }
      ]
    })
    const d = (
      await buildApp().inject({ method: 'GET', url: '/traffic-map/down/ext:3?hours=1' })
    ).json().data
    expect(d.key).toBe('ext:3')
    expect(d.totals).toEqual({ req: 2, error: 1 })
    expect(d.top_paths[0]).toEqual({ path: 'POST /deploymentRequests', n: 2 })
    const db2 = (await buildApp().inject({ method: 'GET', url: '/traffic-map/down/db' })).json()
      .data
    expect(db2.note).toMatch(/DB Health/)
    expect(
      (await buildApp().inject({ method: 'GET', url: '/traffic-map/down/ext:abc' })).statusCode
    ).toBe(400)
  })
})

describe('catalog caching', () => {
  it('does not cache a build where a source query failed, and single-flights cold builds', async () => {
    resetTrafficCatalog()
    let calls = 0
    let fail = true
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['where', 'whereIn', 'select']) chain[m] = vi.fn(() => chain)
      // biome-ignore lint/suspicious/noThenProperty: thenable builder
      chain.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
        if (table === 'nivaro_widgets') {
          calls++
          if (fail) return rej(new Error('boom'))
        }
        return res([])
      }
      return chain
    })
    const app = buildApp()
    await Promise.all([
      app.inject({ method: 'GET', url: '/traffic-map/catalog' }),
      app.inject({ method: 'GET', url: '/traffic-map/catalog' })
    ])
    expect(calls).toBe(1)
    fail = false
    await app.inject({ method: 'GET', url: '/traffic-map/catalog' })
    expect(calls).toBe(2) // failed build was not cached
    await app.inject({ method: 'GET', url: '/traffic-map/catalog' })
    expect(calls).toBe(2) // good build now cached
  })
})
