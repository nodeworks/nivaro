import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancements 10 + 20 on a Hub shared deployment: GET /api/hub-deployment/ops/apps/:id/*
// reads inside THAT app (its tenant context and database), behind the deployment bearer.

const seen = vi.hoisted(() => ({
  tenants: [] as Array<string | undefined>,
  ownDb: [] as boolean[]
}))

vi.mock('../../../services/hub-link/ops-report.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const note = (k: unknown) => {
    seen.tenants.push(tc.getTenantId())
    seen.ownDb.push(k !== undefined && k === tc.getTenantDb())
  }
  return {
    issueRollup: vi.fn(async (_o: unknown, k: unknown) => {
      note(k)
      return { groups: [], truncated: false, window_days: 30 }
    }),
    filesUsage: vi.fn(async (k: unknown) => {
      note(k)
      return { files: 2, bytes: 10, by_storage: [] }
    })
  }
})

import { hubOpsDeploymentRoutes } from '../../../routes/hub-ops-link.js'
import { deploymentLinkBearer } from '../../../services/tenancy/hub-contract.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../../../services/tenancy/types.js'

const TOKEN = `dep-${'t'.repeat(40)}`
const auth = { authorization: `Bearer ${deploymentLinkBearer(TOKEN)}` }
const A: TenantRecord = {
  id: 'app-a-e1',
  slug: 'app-a',
  name: 'App A',
  status: 'active',
  dbClient: 'pg',
  dbConnection: 'postgres://a:a@127.0.0.1:1/a',
  poolMax: 1,
  hostnames: ['a.example.com']
}
const registry: TenantRegistry = {
  source: 'hub',
  resolve: async () => null,
  listActive: async () => [A],
  byId: async (id) => (id === A.id ? A : null),
  status: () => ({ source: 'hub', count: 1, loadedAt: null, stale: false, lastError: null })
}
const saved = { ...process.env }
let app: FastifyInstance | null = null

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  process.env.HUB_URL = 'https://hub.example'
  process.env.HUB_DEPLOYMENT_TOKEN = TOKEN
  setTenantRegistryForTests(registry)
  seen.tenants.length = 0
  seen.ownDb.length = 0
})
afterEach(async () => {
  await app?.close()
  app = null
  process.env = { ...saved }
  setTenantRegistryForTests(null)
})

async function build() {
  const a = Fastify()
  await a.register(hubOpsDeploymentRoutes, { prefix: '/api/hub-deployment' })
  await a.ready()
  app = a
  return a
}

describe('GET /api/hub-deployment/ops/apps/:id/*', () => {
  it('refuses without the deployment bearer (the token itself is not the bearer)', async () => {
    const a = await build()
    for (const authorization of [undefined, `Bearer ${TOKEN}`]) {
      const res = await a.inject({
        method: 'GET',
        url: '/api/hub-deployment/ops/apps/app-a-e1/files',
        headers: authorization ? { authorization } : {}
      })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('DEPLOYMENT_LINK_REFUSED')
    }
  })

  it('reads inside the app, with its own database', async () => {
    const a = await build()
    const files = await a.inject({
      method: 'GET',
      url: '/api/hub-deployment/ops/apps/app-a-e1/files',
      headers: auth
    })
    expect(files.statusCode).toBe(200)
    expect(files.json().files).toBe(2)
    const issues = await a.inject({
      method: 'GET',
      url: '/api/hub-deployment/ops/apps/app-a-e1/issues?days=5',
      headers: auth
    })
    expect(issues.statusCode).toBe(200)
    expect(seen.tenants).toEqual(['app-a-e1', 'app-a-e1'])
    expect(seen.ownDb).toEqual([true, true])
  })

  it('an app this deployment does not serve is 404 UNKNOWN_APP', async () => {
    const a = await build()
    const res = await a.inject({
      method: 'GET',
      url: '/api/hub-deployment/ops/apps/other-e9/issues',
      headers: auth
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('UNKNOWN_APP')
  })
})
