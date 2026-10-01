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
  listTraces: () => []
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRoutes: new Map([['efp-ops', []]]),
  loadedExtensionLabels: () => ({ 'efp-ops': 'EFP Operations' })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { trafficMapRoutes } from '../../../routes/traffic-map.js'
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
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'limit', 'select'])
      chain[m] = vi.fn(() => chain)
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
