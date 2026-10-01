// Group F routes: tenant-scoped map (#1132), cluster snapshot (#1098), snapshots (#1097),
// window compare (#1160), replay preview (#1159).
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111' }
  })
}))
vi.mock('../../../plugins/socketio.js', () => ({
  getRealtimeStats: () => ({ sockets: [], rooms: [] })
}))
vi.mock('../../../services/event-journal.js', () => ({ currentSeq: vi.fn(async () => 1) }))
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: () => null,
  currentTraceMeta: () => null,
  listTraces: () => []
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRoutes: new Map(),
  loadedExtensionLabels: () => ({})
}))
vi.mock('../../../services/instance-roster.js', () => ({
  INSTANCE_ID: 'node-a',
  listInstances: async () => [{ id: 'node-a' }]
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: vi.fn(() => undefined) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { getTenantId } from '../../../db/tenant-context.js'
import { trafficMapRoutes } from '../../../routes/traffic-map.js'
import { logActivity } from '../../../services/activity.js'
import { advanceTo, noteRequest, resetTrafficMap } from '../../../services/traffic-map.js'

const T0 = 1_800_000_000
const req = (over: Record<string, unknown> = {}) =>
  ({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 9,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'u1',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000,
    ...over
  }) as never

/** A tiny knex-shaped fake over in-memory tables (insert / where / first / del / select). */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((name: string) => {
    const table = name.split(' as ')[0]
    if (!tables[table]) tables[table] = []
    const rows = tables[table]
    const preds: Array<(r: Record<string, unknown>) => boolean> = []
    const strip = (k: string) => k.replace(/^s\./, '')
    const chain: Record<string, unknown> = {
      leftJoin: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      select: () => chain,
      where: (a: unknown, b?: unknown) => {
        if (typeof a === 'object' && a)
          for (const [k, v] of Object.entries(a)) preds.push((r) => r[strip(k)] === v)
        else preds.push((r) => r[strip(String(a))] === b)
        return chain
      },
      insert: async (row: Record<string, unknown>) => {
        rows.push(row)
        return [1]
      },
      first: async () => rows.find((r) => preds.every((p) => p(r))),
      del: async () => {
        const keep = rows.filter((r) => !preds.every((p) => p(r)))
        const n = rows.length - keep.length
        tables[table] = keep
        return n
      },
      catch: (fn: (e: unknown) => unknown) =>
        Promise.resolve(rows.filter((r) => preds.every((p) => p(r)))).catch(fn)
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    chain.then = (res: (v: unknown) => void) => res(rows.filter((r) => preds.every((p) => p(r))))
    return chain
  })
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(trafficMapRoutes, { prefix: '/traffic-map' })
  return app
}
beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
  delete process.env.CLOUD_META_DB_URL
  vi.mocked(getTenantId).mockReturnValue(undefined)
})
afterEach(() => {
  vi.clearAllMocks()
  delete process.env.CLOUD_META_DB_URL
})

describe('cloud mode (#1132)', () => {
  it('answers for the caller tenant only; untagged feature routes stay 404', async () => {
    process.env.CLOUD_META_DB_URL = 'x'
    noteRequest(req({ req: { nvrTenantId: 'acme' } }))
    noteRequest(req({ req: { nvrTenantId: 'globex' }, path: '/api/items/invoices' }))
    vi.mocked(getTenantId).mockReturnValue('acme')
    const app = buildApp()
    const snap = await app.inject({ method: 'GET', url: '/traffic-map/snapshot' })
    expect(snap.statusCode).toBe(200)
    expect(snap.json().data.entities.map((e: { key: string }) => e.key)).toEqual([
      'items/workflows'
    ])
    const cluster = await app.inject({ method: 'GET', url: '/traffic-map/cluster-snapshot' })
    expect(cluster.statusCode).toBe(200)
    const inst = await app.inject({ method: 'GET', url: '/traffic-map/compare/components' })
    expect(inst.statusCode).toBe(404)
    vi.mocked(getTenantId).mockReturnValue(undefined)
    const none = await app.inject({ method: 'GET', url: '/traffic-map/snapshot' })
    expect(none.statusCode).toBe(404)
  })
})

describe('GET /traffic-map/cluster-snapshot (#1098)', () => {
  it('without a relay answers this node alone; an unknown node is a 404', async () => {
    noteRequest(req())
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/traffic-map/cluster-snapshot?window=60' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.self).toBe('node-a')
    expect(body.nodes).toEqual([{ node: 'node-a', instance: 'test-node', req: 1, self: true }])
    expect(body.data.entities[0].req).toBe(1)
    const one = await app.inject({ method: 'GET', url: '/traffic-map/cluster-snapshot?node=zzz' })
    expect(one.statusCode).toBe(404)
    const bad = await app.inject({ method: 'GET', url: '/traffic-map/cluster-snapshot?window=7' })
    expect(bad.json().code).toBe('WINDOW_INVALID')
  })
})

describe('snapshots (#1097)', () => {
  it('freezes the view, opens it by id, notes the incident timeline, deletes', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {}
    fakeDb(tables)
    noteRequest(req())
    const app = buildApp()
    const post = await app.inject({
      method: 'POST',
      url: '/traffic-map/snapshots',
      payload: {
        window: 300,
        name: 'Spike at 10:00',
        note: 'Forecast grid hammered after the import',
        filters: { win: 300 },
        selection: { kind: 'entity', id: 'items/workflows' },
        catalog: { callers: {} }
      }
    })
    expect(post.statusCode).toBe(201)
    const { id, url } = post.json().data
    expect(url).toBe(`/traffic-map?snapshot=${id}`)
    const row = tables.nivaro_traffic_snapshots[0]
    expect(row).toMatchObject({ store: 'default', window_s: 300, scope: 'node', node: 'node-a' })
    expect(JSON.parse(String(row.snapshot)).entities[0].key).toBe('items/workflows')
    expect(vi.mocked(logActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'traffic-snapshot',
        collection: 'nivaro_traffic_snapshots',
        comment: 'Traffic snapshot "Spike at 10:00": Forecast grid hammered after the import'
      })
    )
    const got = await app.inject({ method: 'GET', url: `/traffic-map/snapshots/${id}` })
    expect(got.statusCode).toBe(200)
    expect(got.json().data).toMatchObject({
      name: 'Spike at 10:00',
      window_s: 300,
      selection: { kind: 'entity', id: 'items/workflows' }
    })
    expect(got.json().data.snapshot.entities[0].req).toBe(1)
    const del = await app.inject({ method: 'DELETE', url: `/traffic-map/snapshots/${id}` })
    expect(del.statusCode).toBe(204)
    const gone = await app.inject({ method: 'GET', url: `/traffic-map/snapshots/${id}` })
    expect(gone.statusCode).toBe(404)
  })
  it('a snapshot never opens in another store', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      nivaro_traffic_snapshots: [
        {
          id: '22222222-2222-2222-2222-222222222222',
          store: 't:acme',
          name: 'x',
          window_s: 60,
          snapshot: '{}',
          created_at: new Date()
        }
      ]
    }
    fakeDb(tables)
    const res = await buildApp().inject({
      method: 'GET',
      url: '/traffic-map/snapshots/22222222-2222-2222-2222-222222222222'
    })
    expect(res.statusCode).toBe(404)
  })
  it('no note = no timeline row; a bad window is refused', async () => {
    fakeDb({})
    const app = buildApp()
    const ok = await app.inject({ method: 'POST', url: '/traffic-map/snapshots', payload: {} })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().data.name).toMatch(/^Traffic \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/)
    expect(vi.mocked(logActivity)).not.toHaveBeenCalled()
    const bad = await app.inject({
      method: 'POST',
      url: '/traffic-map/snapshots',
      payload: { window: 5 }
    })
    expect(bad.statusCode).toBe(400)
  })
})

describe('compare windows (#1160) and replay preview (#1159)', () => {
  it('refuses windows it cannot read', async () => {
    const res = await buildApp().inject({
      method: 'GET',
      url: '/traffic-map/compare/windows?a_from=2026-10-01T10:00:00Z&a_to=2026-10-01T09:00:00Z&b_from=x&b_to=y'
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('COMPARE_WINDOW_INVALID')
  })
  it('replay preview exists only in development', async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const res = await buildApp().inject({
        method: 'GET',
        url: '/traffic-map/replay/preview?caller=k1'
      })
      expect(res.statusCode).toBe(404)
    } finally {
      process.env.NODE_ENV = prev
    }
  })
})
