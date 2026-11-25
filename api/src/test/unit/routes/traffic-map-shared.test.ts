import Fastify from 'fastify'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Traffic Map per app on a Hub shared deployment: inside an app, the map answers from that
// app's own store and counts only that app's sockets and people; the daily digest preview reads
// the app's own request log (a route opted in with `trafficAppAware`, which Nivaro Cloud still
// refuses). Outside any app every route answers 404.

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'test-admin' }
  })
}))
vi.mock('../../../plugins/socketio.js', () => ({
  getRealtimeStats: () => ({
    sockets: [
      { user: { id: 'a1' }, tenant: 'A' },
      { user: { id: 'a1' }, tenant: 'A' },
      { user: { id: 'a2' }, tenant: 'A' },
      { user: { id: 'b1' }, tenant: 'B' },
      { user: null, tenant: null }
    ],
    rooms: []
  })
}))
vi.mock('../../../services/event-journal.js', () => ({ currentSeq: vi.fn(async () => 1) }))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRoutes: new Map(),
  loadedExtensionLabels: () => ({})
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/traffic-digest.js', () => ({
  registerTrafficDigest: vi.fn(async () => {}),
  buildTrafficDigestSection: vi.fn(async () => ({ title: 'Traffic in the last day', lines: [] }))
}))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { trafficMapRoutes } = await import('../../../routes/traffic-map.js')

const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example.test',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
}
const KEYS = ['CLOUD_META_DB_URL', ...Object.keys(SHARED)]
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const apps: Array<ReturnType<typeof Fastify>> = []
/** A server whose requests run inside app `tenant` (as the tenant middleware does), or none. */
function build(tenant: string | null) {
  const app = Fastify({ logger: false })
  if (tenant)
    app.addHook('onRequest', (req, _reply, done) => {
      ;(req as unknown as { nvrTenantId?: string }).nvrTenantId = tenant
      runWithTenantDb({} as Knex, tenant.toLowerCase(), done, tenant)
    })
  app.register(trafficMapRoutes, { prefix: '/traffic-map' })
  apps.push(app)
  return app
}

describe('Traffic Map on a Hub shared deployment', () => {
  it("inside an app: the snapshot counts that app's sockets and people only", async () => {
    Object.assign(process.env, SHARED)
    const res = await build('A').inject({ method: 'GET', url: '/traffic-map/snapshot' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.sockets).toEqual({ count: 3, users: 2 })
    const b = await build('B').inject({ method: 'GET', url: '/traffic-map/snapshot' })
    expect(b.json().data.sockets).toEqual({ count: 1, users: 1 })
  })

  it("the digest preview answers inside an app (the app's own request log)", async () => {
    Object.assign(process.env, SHARED)
    const res = await build('A').inject({ method: 'GET', url: '/traffic-map/digest/preview' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.title).toBe('Traffic in the last day')
  })

  it('outside any app every route answers 404', async () => {
    Object.assign(process.env, SHARED)
    const app = build(null)
    for (const url of ['/traffic-map/snapshot', '/traffic-map/digest/preview'])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
  })

  it('Nivaro Cloud: the map works per tenant, the digest preview still answers 404', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta.example.test/meta'
    const app = build('A')
    const snap = await app.inject({ method: 'GET', url: '/traffic-map/snapshot' })
    expect(snap.statusCode).toBe(200)
    expect(snap.json().data.sockets).toEqual({ count: 3, users: 2 })
    const preview = await app.inject({ method: 'GET', url: '/traffic-map/digest/preview' })
    expect(preview.statusCode).toBe(404)
  })

  it('self-hosted: every socket counts (no app key)', async () => {
    const res = await build(null).inject({ method: 'GET', url: '/traffic-map/snapshot' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.sockets).toEqual({ count: 5, users: 3 })
  })
})
