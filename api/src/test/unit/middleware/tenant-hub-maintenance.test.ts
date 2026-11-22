import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 7: maintenance on a Hub shared deployment (the "being updated" page, JSON
// APP_MAINTENANCE), the deployment link's free paths, and /api/version (ruling B3).

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<object>()),
  getOrCreateTenantPool: () => ({})
}))

import { tenantHook } from '../../../middleware/tenant.js'
import { healthRoutes } from '../../../routes/health.js'
import { blockedPage } from '../../../services/tenancy/blocked-page.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../../../services/tenancy/types.js'

const rec = (over: Partial<TenantRecord>): TenantRecord => ({
  id: 'app-a-e1',
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
  'moving.example.com': rec({
    id: 'moving-e2',
    slug: 'moving',
    name: 'Moving <b>App</b>',
    status: 'maintenance'
  }),
  'new.example.com': rec({ id: 'new-e3', slug: 'new', name: 'New', status: 'provisioning' }),
  'paused.example.com': rec({ id: 'paused-e4', slug: 'paused', name: 'P', status: 'suspended' })
}

const fakeRegistry: TenantRegistry = {
  source: 'hub',
  async resolve(host) {
    const t = TENANTS[host.split(':')[0]]
    return t ? { tenant: t, origin: `https://${host}` } : null
  },
  async listActive() {
    return Object.values(TENANTS)
  },
  status: () => ({
    source: 'hub',
    count: 4,
    loadedAt: '2026-11-22T00:00:00.000Z',
    stale: false,
    lastError: null
  })
}

const savedEnv = { ...process.env }

async function build(withHook = true) {
  const app = Fastify()
  if (withHook) app.addHook('onRequest', tenantHook)
  app.get('/', async () => 'home')
  app.get('/api/items/x', async () => ({ ok: true }))
  app.get('/api/hub-deployment/status', async () => ({ link: true }))
  app.get('/api/hub-transfer/files/1', async () => ({ transfer: true }))
  await app.register(healthRoutes, { prefix: '/api' })
  return app
}

function sharedEnv() {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
}

describe('blockedPage maintenance', () => {
  it('says the app is being updated, escapes the name and checks again by itself', () => {
    const html = blockedPage('A <b>x</b>', 'maintenance')
    expect(html).toContain('is being updated')
    expect(html).toContain('A &lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('http-equiv="refresh"')
    expect(html).not.toMatch(/nivaro/i)
  })
})

describe('tenantHook: Hub maintenance', () => {
  let app: Awaited<ReturnType<typeof build>>
  beforeAll(async () => {
    app = await build()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    sharedEnv()
    setTenantRegistryForTests(fakeRegistry)
  })
  afterEach(() => {
    process.env = { ...savedEnv }
    setTenantRegistryForTests(null)
  })

  it('a maintenance app answers 503 with the "being updated" page in a browser', async () => {
    const res = await app.inject({
      url: '/',
      headers: { host: 'moving.example.com', accept: 'text/html' }
    })
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toContain('is being updated')
    expect(res.body).toContain('Moving &lt;b&gt;App&lt;/b&gt;')
    expect(res.body).not.toContain('suspended')
  })

  it('a maintenance app answers 503 APP_MAINTENANCE as JSON', async () => {
    const res = await app.inject({ url: '/api/items/x', headers: { host: 'moving.example.com' } })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ statusCode: 503, code: 'APP_MAINTENANCE' })
  })

  it('a suspended app still answers "suspended" (unchanged)', async () => {
    const res = await app.inject({ url: '/api/items/x', headers: { host: 'paused.example.com' } })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: 'Account suspended' })
  })

  it('the deployment link and file transfer paths are free on an unknown host (not 404)', async () => {
    const link = await app.inject({
      url: '/api/hub-deployment/status',
      headers: { host: '10.0.0.5:3000' }
    })
    expect(link.statusCode).toBe(200)
    expect(link.json()).toEqual({ link: true })
    const transfer = await app.inject({
      url: '/api/hub-transfer/files/1',
      headers: { host: 'nope.example.com' }
    })
    expect(transfer.statusCode).toBe(200)
  })

  it('/api/version names the deployment and the app it resolved to', async () => {
    const res = await app.inject({ url: '/api/version', headers: { host: 'a.example.com' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ shared_deployment: 'shared-a', tenant: 'app-a-e1' })
  })

  it('B3: /api/version still answers for an app in maintenance or not ready, inside that app', async () => {
    for (const [host, id] of [
      ['moving.example.com', 'moving-e2'],
      ['new.example.com', 'new-e3']
    ]) {
      const res = await app.inject({ url: '/api/version', headers: { host } })
      expect(res.statusCode, host).toBe(200)
      expect(res.json()).toMatchObject({ shared_deployment: 'shared-a', tenant: id })
    }
    // every other path of those apps stays 503
    const other = await app.inject({ url: '/api/items/x', headers: { host: 'new.example.com' } })
    expect(other.statusCode).toBe(503)
    // a suspended app answers nothing, /api/version included
    const paused = await app.inject({
      url: '/api/version',
      headers: { host: 'paused.example.com' }
    })
    expect(paused.statusCode).toBe(503)
  })
})

describe('/api/version off a shared deployment', () => {
  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('self-hosted has no shared_deployment or tenant field', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    delete process.env.CLOUD_META_DB_URL
    const app = await build(false)
    const res = await app.inject({ url: '/api/version' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).not.toHaveProperty('shared_deployment')
    expect(res.json()).not.toHaveProperty('tenant')
    await app.close()
  })

  it('Nivaro Cloud has neither (even with HUB_SHARED_DEPLOYMENT set by mistake)', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.CLOUD_META_DB_URL = 'postgres://meta@127.0.0.1:1/meta'
    const app = await build(false)
    const res = await app.inject({ url: '/api/version' })
    expect(res.json()).not.toHaveProperty('shared_deployment')
    await app.close()
  })
})
