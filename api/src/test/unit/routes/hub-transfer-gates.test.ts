import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 10 fix round 1 (review ⚠️): the gates in front of the file transfer, with the
// REAL transfer + hub-link routes behind them.
//  - A shared deployment's tenant hook (middleware/tenant.ts) frees /api/hub-transfer: a source
//    app in maintenance (the delta copy runs inside it) still hands over its files, on its own
//    host or the deployment's link address.
//  - A dedicated app's retire gate and maintenance freeze (services/maintenance-freeze.ts) let
//    /api/hub-transfer/* and /api/hub-link/files/* through, while every other path is refused.

const { root } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-hub-transfer-gates-')) }
})
const st = vi.hoisted(() => ({
  store: new Map<string, string>(),
  caller: null as null | { isAdmin?: boolean; authMethod?: string },
  files: new Map<string, Array<{ id: string; filename_disk: string; type: string }>>()
}))

const redis = {
  get: async (k: string) => st.store.get(k) ?? null,
  set: async (k: string, v: string) => {
    st.store.set(k, v)
    return 'OK'
  },
  del: async (...keys: string[]) => keys.filter((k) => st.store.delete(k)).length
}

vi.mock('../../../config.js', () => ({
  config: { STORAGE_LOCAL_ROOT: root, NODE_ENV: 'production', OIDC_ISSUER: '' }
}))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<object>()),
  getOrCreateTenantPool: (conn: string) => ({ __conn: conn })
}))
vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const db = (table: string) => {
    const conn = (tc.getTenantDb() as unknown as { __conn?: string } | undefined)?.__conn ?? ''
    const chain = {
      where: (_c: unknown, id?: string) => ({
        ...chain,
        first: async () =>
          table === 'nivaro_files'
            ? (st.files.get(conn) ?? []).find((f) => f.id === id)
            : { maintenance_mode: false, maintenance_message: null }
      }),
      first: async () => ({ maintenance_mode: false, maintenance_message: null }),
      catch: () => chain
    }
    return chain
  }
  return { db, _backgroundDb: null, _staticDb: null, resolveDb: () => db }
})
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({ redis, cron: { startLeaderElection: () => {} } }),
  getIo: () => null
}))
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => ({ name: 'local' }),
  readOwnStoredObject: async () => {
    throw new Error('ENOENT')
  }
}))
vi.mock('../../../services/hub-transfer/pull.js', () => ({
  PullError: class PullError extends Error {},
  errorShape: () => ({}),
  startPull: vi.fn(async () => ({ run_id: 'run-1' })),
  pullStatus: () => null,
  readPullStatus: vi.fn(async () => ({
    state: 'running',
    total: 1,
    copied: 0,
    skipped: 0,
    failed: 0,
    missing: [],
    bytes: 0,
    error: null
  }))
}))
vi.mock('../../../services/record-events.js', () => ({ announceToTenant: () => {} }))
vi.mock('../../../routes/preflight.js', () => ({
  runPreflight: async () => ({ status: 'ok', checks: [] })
}))
vi.mock('../../../services/readiness.js', () => ({
  readReadiness: async () => ({ score: 90 }),
  registerReadinessCheck: () => {}
}))
vi.mock('../../../services/pool-attribution.js', () => ({ poolCounters: () => null }))
vi.mock('../../../services/instance-key.js', () => ({ instanceKey: () => 'production' }))
vi.mock('../../../services/help-video-render.js', () => ({ resumeRendersAfterRetire: () => {} }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: FastifyRequest) => {
    const c = st.caller
    if (!c) return
    req.user = { id: 'U1', role: 'R', account_kind: null } as never
    req.isAdmin = c.isAdmin ?? false
    req.authMethod = c.authMethod as never
  })
}))

const { tenantHook } = await import('../../../middleware/tenant.js')
const { hubTransferRoutes } = await import('../../../routes/hub-transfer.js')
const { hubLinkRoutes } = await import('../../../routes/hub-link.js')
const { maintenanceFreezeHook } = await import('../../../services/maintenance-freeze.js')
const security = await import('../../../services/security.js')
const retire = await import('../../../services/hub-link/retire.js')
const { mintTransferTicket } = await import('../../../services/hub-transfer/tickets.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord
type TenantRegistry = import('../../../services/tenancy/types.js').TenantRegistry

const FILE = '11111111-2222-4333-8444-555555555555'
const HUB_TOKEN = 'k'.repeat(40)
const hubAuth = { authorization: `Bearer ${HUB_TOKEN}` }
const saved = { ...process.env }
let app: FastifyInstance | null = null

const rec = (over: Partial<TenantRecord>): TenantRecord => ({
  id: 'app-a-e1',
  slug: 'app-a',
  name: 'App A',
  status: 'maintenance',
  dbClient: 'pg',
  dbConnection: 'postgres://a@127.0.0.1:1/app_a',
  poolMax: 1,
  hostnames: ['a.example.com'],
  ...over
})
const TENANTS = [rec({})]
const registry: TenantRegistry = {
  source: 'hub',
  async resolve(host) {
    const t = TENANTS.find((x) => x.hostnames.includes(host.split(':')[0]))
    return t ? { tenant: t, origin: `https://${host}` } : null
  },
  listActive: async () => TENANTS,
  byId: async (id) => TENANTS.find((t) => t.id === id) ?? null,
  listAll: async () => TENANTS,
  status: () => ({
    source: 'hub',
    count: 1,
    loadedAt: '2026-11-22T00:00:00.000Z',
    stale: false,
    lastError: null
  })
}

beforeAll(() => {
  mkdirSync(join(root, 'ab'), { recursive: true })
  writeFileSync(join(root, 'ab/report.pdf'), '%PDF-dedicated')
  mkdirSync(join(root, 'apps/app-a-e1/ab'), { recursive: true })
  writeFileSync(join(root, 'apps/app-a-e1/ab/report.pdf'), '%PDF-app-a')
  const row = { id: FILE, filename_disk: 'ab/report.pdf', type: 'application/pdf' }
  st.files.set('', [row])
  st.files.set('postgres://a@127.0.0.1:1/app_a', [row])
})

beforeEach(() => {
  process.env = { ...saved }
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB
  st.store.clear()
  st.caller = null
  retire._resetRetiredForTests('no')
})

afterEach(async () => {
  await app?.close()
  app = null
  process.env = { ...saved }
  setTenantRegistryForTests(null)
  retire._resetRetiredForTests('no')
})

describe('shared deployment: the tenant hook frees /api/hub-transfer', () => {
  async function build() {
    const a = Fastify()
    a.addHook('onRequest', tenantHook)
    await a.register(
      async (f) => {
        await f.register(hubTransferRoutes, { prefix: '/hub-transfer' })
        f.get('/items/x', async () => ({ data: [] }))
      },
      { prefix: '/api' }
    )
    await a.ready()
    app = a
    return a
  }

  beforeEach(() => {
    delete process.env.HUB_TOKEN
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 'd'.repeat(40)
    setTenantRegistryForTests(registry)
  })

  it('an app in maintenance still hands over its files, on its host or the link address', async () => {
    const a = await build()
    // control: the app itself is closed (the Hub is moving it)
    const closed = await a.inject({ url: '/api/items/x', headers: { host: 'a.example.com' } })
    expect(closed.statusCode).toBe(503)
    expect(closed.json().code).toBe('APP_MAINTENANCE')
    const { ticket } = await mintTransferTicket('app-a-e1')
    for (const host of ['a.example.com', '10.0.0.5:3000']) {
      const res = await a.inject({
        url: `/api/hub-transfer/files/${FILE}`,
        headers: { host, authorization: `Transfer ${ticket}` }
      })
      expect(res.statusCode, host).toBe(200)
      expect(res.body).toBe('%PDF-app-a')
    }
    // the hook frees the path, it does not open it: no ticket is still 401
    const none = await a.inject({
      url: `/api/hub-transfer/files/${FILE}`,
      headers: { host: 'a.example.com' }
    })
    expect(none.statusCode).toBe(401)
  })
})

describe('dedicated app: retire and the maintenance freeze let the transfer through', () => {
  async function build() {
    const a = Fastify()
    a.addHook('preHandler', maintenanceFreezeHook)
    await a.register(
      async (f) => {
        await f.register(hubTransferRoutes, { prefix: '/hub-transfer' })
        await f.register(hubLinkRoutes, { prefix: '/hub-link' })
        f.get('/items/:c', async () => ({ data: [] }))
        f.patch('/items/:c/:id', async () => ({ ok: true }))
      },
      { prefix: '/api' }
    )
    await a.ready()
    app = a
    return a
  }

  beforeEach(() => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    process.env.HUB_TOKEN = HUB_TOKEN
  })

  async function transferCallsPass(a: FastifyInstance) {
    const t = await a.inject({
      method: 'POST',
      url: '/api/hub-link/files/ticket',
      headers: hubAuth
    })
    expect(t.statusCode).toBe(200)
    const { ticket } = t.json() as { ticket: string }
    const file = await a.inject({
      url: `/api/hub-transfer/files/${FILE}`,
      headers: { authorization: `Transfer ${ticket}` }
    })
    expect(file.statusCode).toBe(200)
    expect(file.body).toBe('%PDF-dedicated')
    const pull = await a.inject({
      method: 'POST',
      url: '/api/hub-link/files/pull',
      headers: hubAuth,
      payload: {
        source: 'https://old.example.com/api/hub-transfer/files',
        ticket,
        mode: 'delta'
      }
    })
    expect(pull.statusCode).toBe(202)
    const status = await a.inject({ url: '/api/hub-link/files/pull/run-1', headers: hubAuth })
    expect(status.statusCode).toBe(200)
    const revoke = await a.inject({
      method: 'DELETE',
      url: '/api/hub-link/files/ticket',
      headers: hubAuth,
      payload: { ticket }
    })
    expect(revoke.statusCode).toBe(200)
    expect(revoke.json()).toEqual({ revoked: true })
  }

  it('retired: every other path answers APP_MOVED, the transfer and the file calls answer', async () => {
    const a = await build()
    retire._resetRetiredForTests('yes')
    const read = await a.inject({ url: '/api/items/x' })
    expect(read.statusCode).toBe(503)
    expect(read.json().code).toBe('APP_MOVED')
    await transferCallsPass(a)
  })

  it('strict maintenance: an admin write is frozen, the transfer and the file calls answer', async () => {
    const a = await build()
    await security.setHubMaintenance({ on: true, message: null, moveId: 4 })
    st.caller = { isAdmin: true, authMethod: 'session' }
    const write = await a.inject({ method: 'PATCH', url: '/api/items/x/1', payload: {} })
    expect(write.statusCode).toBe(503)
    st.caller = null
    await transferCallsPass(a)
  })
})
