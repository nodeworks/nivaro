import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 7: the deployment link (/api/hub-deployment/*) on a Hub shared deployment.

const state = vi.hoisted(() => ({
  seededIn: [] as Array<string | undefined>,
  seededWithDb: [] as boolean[],
  maintenance: false
}))

vi.mock('../../../config.js', () => ({
  config: {
    NODE_ENV: 'production',
    OIDC_ISSUER: 'https://login.microsoftonline.com/1111-tenant/v2.0'
  }
}))
vi.mock('../../../routes/preflight.js', () => ({
  runPreflight: async () => ({
    status: 'fail',
    checks: [
      { id: 'database', status: 'ok' },
      { id: 'render', status: 'fail' }
    ]
  })
}))
vi.mock('../../../services/readiness.js', () => ({ readReadiness: async () => ({ score: 88 }) }))
vi.mock('../../../services/pool-attribution.js', () => ({ poolCounters: () => null }))
vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => ({ on: state.maintenance })
}))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRegistry: new Map([
    ['b-ext', { id: 'b-ext', status: 'loaded', enabled: true }],
    ['a-ext', { id: 'a-ext', status: 'loaded', enabled: true }],
    ['off', { id: 'off', status: 'loaded', enabled: false }]
  ])
}))
vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'whereIn', 'whereNull', 'orWhere', 'count', 'sum'])
    chain[m] = () => chain
  chain.first = async () => ({ n: 0, b: 0 })
  const db = Object.assign(() => chain, { schema: { hasTable: async () => false } })
  return { db }
})
vi.mock('../../../services/hub-link/first-admin.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  return {
    seedFirstAdmin: vi.fn(async (_input: unknown, k: unknown) => {
      state.seededIn.push(tc.getTenantId())
      state.seededWithDb.push(k !== undefined && k === tc.getTenantDb())
      return { ok: true, created: true, user_id: 'u-1' }
    })
  }
})

import { hubDeploymentLinkRoutes } from '../../../routes/hub-deployment-link.js'
import { keyFingerprint } from '../../../services/app-key-fingerprint.js'
import { INSTANCE_ID } from '../../../services/instance-roster.js'
import { _resetAppStatusForTests } from '../../../services/tenancy/app-status.js'
import { deploymentLinkBearer } from '../../../services/tenancy/hub-contract.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../../../services/tenancy/types.js'

const TOKEN = `dep-${'t'.repeat(40)}`
const BEARER = deploymentLinkBearer(TOKEN)
const KEY_A = 'ab'.repeat(32)
const CONN_B = 'postgres://app-b:B-Pa55word@127.0.0.1:1/app_b'

const rec = (over: Partial<TenantRecord>): TenantRecord => ({
  id: 'app-a-e1',
  slug: 'app-a',
  name: 'App A',
  status: 'active',
  dbClient: 'pg',
  dbConnection: 'postgres://app-a:A-Pa55word@127.0.0.1:1/app_a',
  poolMax: 1,
  hostnames: ['a.example.com'],
  ...over
})
const TENANTS = [
  rec({ encryptionKey: KEY_A }),
  rec({
    id: 'app-b-e2',
    slug: 'app-b',
    name: 'App B',
    status: 'provisioning',
    dbConnection: CONN_B,
    hostnames: ['b.example.com']
  })
]

const registry: TenantRegistry = {
  source: 'hub',
  resolve: async () => null,
  // the active list leaves out the provisioning app: the link must list every app
  listActive: async () => TENANTS.filter((t) => t.status === 'active'),
  byId: async (id) => TENANTS.find((t) => t.id === id) ?? null,
  listAll: async () => TENANTS,
  status: () => ({
    source: 'hub',
    count: 2,
    loadedAt: '2026-11-22T00:00:00.000Z',
    stale: false,
    lastError: null
  })
}

const saved = { ...process.env }
let app: FastifyInstance | null = null

async function build(redis?: { publish: (c: string, m: string) => Promise<unknown> }) {
  const a = Fastify()
  if (redis) a.decorate('redis', redis as never)
  await a.register(hubDeploymentLinkRoutes, { prefix: '/api/hub-deployment' })
  await a.ready()
  app = a
  return a
}

const auth = { authorization: `Bearer ${BEARER}` }

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_TOKEN
  delete process.env.HUB
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = TOKEN
  process.env.REDIS_CHANNEL_PREFIX = 'pfx:'
  setTenantRegistryForTests(registry)
  _resetAppStatusForTests()
  state.seededIn.length = 0
  state.seededWithDb.length = 0
  state.maintenance = false
})

afterEach(async () => {
  await app?.close()
  app = null
  process.env = { ...saved }
  setTenantRegistryForTests(null)
})

const ROUTES: Array<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'GET', url: '/api/hub-deployment/status' },
  { method: 'GET', url: '/api/hub-deployment/apps/app-a-e1/status' },
  { method: 'POST', url: '/api/hub-deployment/apps/app-a-e1/first-admin' },
  { method: 'POST', url: '/api/hub-deployment/refresh' },
  { method: 'POST', url: '/api/hub-deployment/db-check' }
]

describe('deployment link auth', () => {
  it('refuses every route without a bearer, and refuses the deployment token itself', async () => {
    const a = await build()
    for (const r of ROUTES) {
      const none = await a.inject({ ...r, remoteAddress: '10.0.0.1' })
      expect(none.statusCode, r.url).toBe(401)
      expect(none.json().code).toBe('DEPLOYMENT_LINK_REFUSED')
      expect(none.headers['cache-control']).toBe('no-store')
      // R7: the master token never opens the link (only its HMAC does)
      const master = await a.inject({
        ...r,
        remoteAddress: '10.0.0.2',
        headers: { authorization: `Bearer ${TOKEN}` }
      })
      expect(master.statusCode, r.url).toBe(401)
    }
    expect(state.seededIn).toEqual([])
  })

  it('blocks an address after 20 failures a minute (the 21st is 429)', async () => {
    const a = await build()
    for (let i = 0; i < 20; i++) {
      const res = await a.inject({ method: 'GET', url: '/api/hub-deployment/status' })
      expect(res.statusCode).toBe(401)
    }
    const res = await a.inject({ method: 'GET', url: '/api/hub-deployment/status' })
    expect(res.statusCode).toBe(429)
    // even with the right bearer while blocked
    const ok = await a.inject({ method: 'GET', url: '/api/hub-deployment/status', headers: auth })
    expect(ok.statusCode).toBe(429)
  })
})

describe('GET /status', () => {
  it('lists every app (provisioning included), the process instance, extensions and OIDC', async () => {
    const a = await build()
    const res = await a.inject({ method: 'GET', url: '/api/hub-deployment/status', headers: auth })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json()
    expect(body.apps.map((x: { id: string }) => x.id)).toEqual(['app-a-e1', 'app-b-e2'])
    expect(body.apps[0].schema).toEqual({ state: 'pending', version: null, error: null })
    expect(body.instance).toBe(INSTANCE_ID)
    expect(body.registry).toMatchObject({ count: 2, stale: false, dropped: [], etag: null })
    expect(body.extensions).toEqual(['a-ext', 'b-ext'])
    expect(body.oidc).toEqual({ issuer_host: 'login.microsoftonline.com', tenant: '1111-tenant' })
    expect(res.body).not.toContain('Pa55word')
    expect(res.body).not.toContain(KEY_A)
  })
})

describe('GET /apps/:id/status', () => {
  it('answers 404 UNKNOWN_APP for an app this deployment does not serve', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-deployment/apps/x/status',
      headers: auth
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('UNKNOWN_APP')
  })

  it('reports one app: key fingerprint (never the key), preflight ids, counts', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-deployment/apps/app-a-e1/status',
      headers: auth
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: 'app-a-e1',
      preflight: { status: 'fail', failing: ['render'] },
      readiness_score: 88,
      busy: { imports: 0, exports: 0, renders: 0 },
      files: { count: 0, bytes: 0, local: 0 },
      key_fp: keyFingerprint(KEY_A),
      maintenance: false
    })
    expect(res.body).not.toContain(KEY_A)
  })
})

describe('POST /apps/:id/first-admin', () => {
  it('runs inside that app, on its database', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/apps/app-b-e2/first-admin',
      headers: auth,
      payload: { email: 'first@example.com' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ user_id: 'u-1', created: true })
    expect(state.seededIn).toEqual(['app-b-e2'])
    expect(state.seededWithDb).toEqual([true])
  })

  it('answers 503 MAINTENANCE while the app is frozen, and 404 for an unknown app', async () => {
    const a = await build()
    state.maintenance = true
    const res = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/apps/app-a-e1/first-admin',
      headers: auth,
      payload: { email: 'first@example.com' }
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('MAINTENANCE')
    const unknown = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/apps/nope/first-admin',
      headers: auth,
      payload: { email: 'first@example.com' }
    })
    expect(unknown.statusCode).toBe(404)
    expect(state.seededIn).toEqual([])
  })
})

describe('POST /refresh', () => {
  it('publishes on the prefixed channel and answers 202', async () => {
    const publish = vi.fn(async () => 1)
    const a = await build({ publish })
    const res = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/refresh',
      headers: auth
    })
    expect(res.statusCode).toBe(202)
    expect(publish).toHaveBeenCalledTimes(1)
    expect((publish.mock.calls[0] as unknown[])[0]).toBe('pfx:nvr:tenancy:refresh')
  })
})

describe('POST /db-check', () => {
  it('a database it cannot reach answers reachable:false without the connection in the error', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/db-check',
      headers: auth,
      payload: { client: 'pg', connection: CONN_B }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.reachable).toBe(false)
    expect(body.ledger).toBeNull()
    expect(body.db_identity).toBeNull()
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
    expect(res.body).not.toContain(CONN_B)
    expect(res.body).not.toContain('B-Pa55word')
  }, 30_000)

  it('refuses an unknown client', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/db-check',
      headers: auth,
      payload: { client: 'sqlite3', connection: '/tmp/x.db' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BAD_DB_CLIENT')
  })
})

describe('where it is mounted', () => {
  it('not on a dedicated app with only HUB_TOKEN', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    delete process.env.HUB_DEPLOYMENT_TOKEN
    process.env.HUB_TOKEN = 'h'.repeat(40)
    const a = await build()
    const res = await a.inject({ method: 'GET', url: '/api/hub-deployment/status', headers: auth })
    expect(res.statusCode).toBe(404)
  })

  it('not in Nivaro Cloud', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta@127.0.0.1:1/meta'
    const a = await build()
    const res = await a.inject({ method: 'GET', url: '/api/hub-deployment/status', headers: auth })
    expect(res.statusCode).toBe(404)
  })
})
