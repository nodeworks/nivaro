import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 parked wave (T7): the phone app's /api/app-info probe on a Hub shared deployment's
// app in maintenance (the Hub is updating or moving it) says `maintenance`, not `suspended`.
// Nivaro Cloud is byte-identical: a tenant row in any non-active status still reads `suspended`
// there, and a suspended / provisioning app reads as before on both.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))
vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<object>()),
  getOrCreateTenantPool: () => ({})
}))

import { tenantHook } from '../../../middleware/tenant.js'
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
  'moving.example.com': rec({ id: 'm-e2', slug: 'moving', name: 'Moving', status: 'maintenance' }),
  'new.example.com': rec({ id: 'n-e3', slug: 'new', name: 'New', status: 'provisioning' }),
  'paused.example.com': rec({ id: 'p-e4', slug: 'paused', name: 'Paused', status: 'suspended' })
}

function registry(source: 'hub' | 'cloud-meta'): TenantRegistry {
  return {
    source,
    async resolve(host) {
      const t = TENANTS[host.split(':')[0]]
      return t ? { tenant: t, origin: `https://${host}` } : null
    },
    async listActive() {
      return Object.values(TENANTS)
    },
    status: () => ({
      source,
      count: 3,
      loadedAt: '2026-11-22T00:00:00.000Z',
      stale: false,
      lastError: null
    })
  }
}

const savedEnv = { ...process.env }
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  app.addHook('onRequest', tenantHook)
  app.get('/api/app-info', async (req: FastifyRequest) => ({ block: req.nvrTenantBlock ?? null }))
  await app.ready()
})
afterAll(() => app.close())
afterEach(() => {
  process.env = { ...savedEnv }
  setTenantRegistryForTests(null)
})

const probe = async (host: string) =>
  (await app.inject({ url: '/api/app-info', headers: { host } })).json().block

describe('app-info probe on a Hub shared deployment', () => {
  beforeEach(() => {
    delete process.env.CLOUD_META_DB_URL
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
    setTenantRegistryForTests(registry('hub'))
  })

  it('an app in Hub maintenance reads maintenance (was: suspended)', async () => {
    expect(await probe('moving.example.com')).toEqual({
      kind: 'maintenance',
      name: 'Moving',
      origin: 'https://moving.example.com'
    })
  })

  it('suspended and provisioning apps read as before', async () => {
    expect((await probe('paused.example.com')).kind).toBe('suspended')
    expect((await probe('new.example.com')).kind).toBe('provisioning')
  })
})

describe('app-info probe in Nivaro Cloud (unchanged)', () => {
  beforeEach(() => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    delete process.env.EDGE_AUTH_SECRET
    process.env.CLOUD_META_DB_URL = 'postgres://meta@127.0.0.1:1/meta'
    setTenantRegistryForTests(registry('cloud-meta'))
  })

  it('a tenant row in maintenance status still reads suspended', async () => {
    expect((await probe('moving.example.com')).kind).toBe('suspended')
  })

  it('suspended and provisioning read as before', async () => {
    expect((await probe('paused.example.com')).kind).toBe('suspended')
    expect((await probe('new.example.com')).kind).toBe('provisioning')
  })
})
