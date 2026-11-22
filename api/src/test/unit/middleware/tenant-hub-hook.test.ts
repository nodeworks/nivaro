import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ ran: [] as string[] }))

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<object>()),
  getOrCreateTenantPool: () => ({}),
  runWithTenantDb: (_db: unknown, slug: string, done: () => void) => {
    state.ran.push(slug)
    done()
  }
}))

import { tenantHook } from '../../../middleware/tenant.js'
import { socketTenant } from '../../../services/socket-tenant.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../../../services/tenancy/types.js'

const rec = (over: Partial<TenantRecord>): TenantRecord => ({
  id: 'app-a-prod',
  slug: 'app-a',
  name: 'App A',
  status: 'active',
  dbClient: 'pg',
  dbConnection: 'postgres://a',
  poolMax: null,
  hostnames: ['a.example.com'],
  ...over
})

const TENANTS: Record<string, TenantRecord> = {
  'a.example.com': rec({}),
  'paused.example.com': rec({
    id: 'paused',
    slug: 'paused',
    name: 'Paused <b>App</b>',
    status: 'suspended'
  }),
  'new.example.com': rec({ id: 'new', slug: 'new', name: 'New App', status: 'provisioning' })
}

const asked: string[] = []
const fakeRegistry: TenantRegistry = {
  source: 'hub',
  async resolve(host) {
    asked.push(host)
    const t = TENANTS[host.split(':')[0]]
    return t ? { tenant: t, origin: `https://${host}` } : null
  },
  async listActive() {
    return Object.values(TENANTS)
  },
  status: () => ({ source: 'hub', count: 3, loadedAt: null, stale: false, lastError: null })
}

const savedEnv = { ...process.env }

async function build() {
  const app = Fastify()
  app.addHook('onRequest', tenantHook)
  app.get('/api/other', async () => ({ ok: true }))
  app.get('/', async () => 'home')
  app.get('/admin/provision', async () => ({ provisioned: true }))
  app.get('/api/ready', async () => ({ ready: true }))
  return app
}

describe('tenantHook on a Hub shared deployment', () => {
  let app: Awaited<ReturnType<typeof build>>
  beforeAll(async () => {
    app = await build()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    delete process.env.CLOUD_META_DB_URL
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
    process.env.CLOUD_MARKETING_URL = 'https://marketing.example'
    delete process.env.EDGE_AUTH_SECRET
    setTenantRegistryForTests(fakeRegistry)
    asked.length = 0
    state.ran.length = 0
  })
  afterEach(() => {
    process.env = { ...savedEnv }
    setTenantRegistryForTests(null)
  })

  it('an unknown host answers 404 JSON, never the marketing redirect', async () => {
    const res = await app.inject({ url: '/api/other', headers: { host: 'nope.example.com' } })
    expect(res.statusCode).toBe(404)
    expect(res.headers.location).toBeUndefined()
    expect(res.json()).toMatchObject({ error: 'Not found' })
    expect(res.body).not.toContain('marketing.example')
  })

  it('an unknown host in a browser gets a plain 404 page', async () => {
    const res = await app.inject({
      url: '/',
      headers: { host: 'nope.example.com', accept: 'text/html' }
    })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers.location).toBeUndefined()
    expect(res.body).not.toContain('nivaro.dev')
  })

  it('a suspended app answers 503 with the neutral page (no billing)', async () => {
    const res = await app.inject({
      url: '/',
      headers: { host: 'paused.example.com', accept: 'text/html' }
    })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('Paused &lt;b&gt;App&lt;/b&gt;')
    expect(res.body.toLowerCase()).not.toContain('billing')
    expect(res.body).not.toContain('nivaro.dev')
    expect(res.body).not.toContain('reactivate')
  })

  it('a provisioning app answers 503 with the neutral page', async () => {
    const res = await app.inject({
      url: '/',
      headers: { host: 'new.example.com', accept: 'text/html' }
    })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('New App is being set up')
    expect(res.body).not.toContain('nivaro.dev')
    const api = await app.inject({ url: '/api/other', headers: { host: 'new.example.com' } })
    expect(api.statusCode).toBe(503)
  })

  it('an active app runs in its tenant context', async () => {
    const res = await app.inject({ url: '/api/other', headers: { host: 'a.example.com' } })
    expect(res.statusCode).toBe(200)
    expect(state.ran).toEqual(['app-a'])
  })

  it('X-Tenant-Host (Nivaro Cloud edge) is not believed', async () => {
    await app.inject({
      url: '/api/other',
      headers: { host: 'nope.example.com', 'x-tenant-host': 'a.example.com' }
    })
    expect(asked).toEqual(['nope.example.com'])
  })

  it('EDGE_AUTH_SECRET (Nivaro Cloud edge) is not enforced', async () => {
    process.env.EDGE_AUTH_SECRET = 'edge-secret'
    const res = await app.inject({ url: '/api/other', headers: { host: 'a.example.com' } })
    expect(res.statusCode).toBe(200)
  })

  it('the cloud operator paths are not tenant-free; the probes are', async () => {
    const op = await app.inject({ url: '/admin/provision', headers: { host: 'nope.example.com' } })
    expect(op.statusCode).toBe(404)
    expect(asked).toEqual(['nope.example.com'])
    const ready = await app.inject({ url: '/api/ready', headers: { host: 'nope.example.com' } })
    expect(ready.statusCode).toBe(200)
  })

  it('a socket is not refused by EDGE_AUTH_SECRET and ignores X-Tenant-Host', async () => {
    process.env.EDGE_AUTH_SECRET = 'edge-secret'
    const t = await socketTenant({ handshake: { headers: { host: 'a.example.com' } } })
    expect(t?.slug).toBe('app-a')
    const spoof = await socketTenant({
      handshake: { headers: { host: 'nope.example.com', 'x-tenant-host': 'a.example.com' } }
    })
    expect(spoof).toBeNull()
  })
})

describe('tenantHook in Nivaro Cloud (unchanged)', () => {
  let app: Awaited<ReturnType<typeof build>>
  beforeAll(async () => {
    app = await build()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    process.env.CLOUD_MARKETING_URL = 'https://marketing.example'
    delete process.env.EDGE_AUTH_SECRET
    setTenantRegistryForTests({ ...fakeRegistry, source: 'cloud-meta' })
    asked.length = 0
  })
  afterEach(() => {
    process.env = { ...savedEnv }
    setTenantRegistryForTests(null)
  })

  it('an unknown host still redirects to the marketing start page', async () => {
    const res = await app.inject({ url: '/api/other', headers: { host: 'nope.example.com' } })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('https://marketing.example/start')
  })

  it('a suspended tenant still gets the cloud page with its reactivate link', async () => {
    const res = await app.inject({
      url: '/',
      headers: { host: 'paused.example.com', accept: 'text/html' }
    })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('/reactivate')
  })

  it('X-Tenant-Host, edge auth and the operator free paths still apply', async () => {
    await app.inject({
      url: '/api/other',
      headers: { host: 'nope.example.com', 'x-tenant-host': 'a.example.com' }
    })
    expect(asked).toEqual(['a.example.com'])
    const op = await app.inject({ url: '/admin/provision', headers: { host: 'nope.example.com' } })
    expect(op.json()).toEqual({ provisioned: true })
    process.env.EDGE_AUTH_SECRET = 'edge-secret'
    const denied = await app.inject({ url: '/api/other', headers: { host: 'a.example.com' } })
    expect(denied.statusCode).toBe(403)
    const sock = await socketTenant({ handshake: { headers: { host: 'a.example.com' } } })
    expect(sock).toBeNull()
  })
})
