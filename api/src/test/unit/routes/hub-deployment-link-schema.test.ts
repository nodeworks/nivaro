import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 8: the deployment link's GET /status reports each app's real schema state
// (services/tenancy/app-migrations.ts), never a connection or a password in the error.

vi.mock('../../../config.js', () => ({
  config: {
    NODE_ENV: 'production',
    OIDC_ISSUER: 'https://login.microsoftonline.com/1111-tenant/v2.0',
    MIGRATION_LOCK_TIMEOUT_MS: 60_000
  }
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))
vi.mock('../../../services/pool-attribution.js', () => ({ poolCounters: () => null }))
vi.mock('../../../extensions/loader.js', () => ({ extensionRegistry: new Map() }))

const { getTenantId } = await import('../../../db/tenant-context.js')
const { hubDeploymentLinkRoutes } = await import('../../../routes/hub-deployment-link.js')
const migrations = await import('../../../services/tenancy/app-migrations.js')
const { deploymentLinkBearer } = await import('../../../services/tenancy/hub-contract.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const { NIVARO_VERSION } = await import('../../../version.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord

const TOKEN = `dep-${'t'.repeat(40)}`
const rec = (id: string): TenantRecord => ({
  id,
  slug: id,
  name: id,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://${id}:Pw-${id}@127.0.0.1:1/${id}`,
  poolMax: 2,
  hostnames: [`${id}.example.com`]
})
const TENANTS = [rec('app-a-e1'), rec('app-b-e2'), rec('app-c-e3')]

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = TOKEN
  migrations._resetAppMigrationsForTests()
  setTenantRegistryForTests({
    source: 'hub',
    resolve: async () => null,
    listActive: async () => TENANTS,
    listAll: async () => TENANTS,
    status: () => ({
      source: 'hub',
      count: TENANTS.length,
      loadedAt: '2026-11-22T00:00:00.000Z',
      stale: false,
      lastError: null
    })
  })
})
afterEach(() => {
  migrations._resetAppMigrationsForTests()
  setTenantRegistryForTests(null)
  process.env = { ...saved }
})

describe('deployment link: apps[].schema', () => {
  it('ok / failed (scrubbed) / pending per app', async () => {
    const deps = {
      migrate: async () => {
        if (getTenantId() === 'app-b-e2')
          throw new Error('password authentication failed: postgres://app-b-e2:Pw-app-b-e2@x/y')
        return [1, []] as [number, string[]]
      },
      schemaSteps: async () => ({ applied: [], skipped: [], failed: [] }),
      workspace: async () => {}
    }
    await migrations.ensureAppSchema(TENANTS[0], deps)
    await migrations.ensureAppSchema(TENANTS[1], deps)
    const a = Fastify()
    await a.register(hubDeploymentLinkRoutes, { prefix: '/api/hub-deployment' })
    try {
      const res = await a.inject({
        method: 'GET',
        url: '/api/hub-deployment/status',
        headers: { authorization: `Bearer ${deploymentLinkBearer(TOKEN)}` }
      })
      expect(res.statusCode).toBe(200)
      const apps = res.json().apps as Array<{ id: string; schema: Record<string, unknown> }>
      expect(apps[0].schema).toEqual({ state: 'ok', version: NIVARO_VERSION, error: null })
      expect(apps[1].schema.state).toBe('failed')
      expect(String(apps[1].schema.error)).toContain('password authentication failed')
      expect(res.body).not.toContain('Pw-app-b-e2')
      expect(apps[2].schema).toEqual({ state: 'pending', version: null, error: null })
    } finally {
      await a.close()
    }
  })
})
