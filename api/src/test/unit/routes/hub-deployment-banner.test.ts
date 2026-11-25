import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The shared-deployment side of the Hub incident banner (routes/hub-link-banner.ts
// hubDeploymentBannerRoutes): bearer = deploymentLinkBearer(HUB_DEPLOYMENT_TOKEN), inside the
// named app only, the Redis key carries that app, an app this deployment does not serve is 404.

const TOKEN = 'd'.repeat(40)
let tenant: string | undefined
vi.mock('../../../services/deployment-mode.js', () => ({
  tenantSource: () => 'hub',
  hubSharedConfig: () => ({ token: TOKEN, deployment: 'shared-a' }),
  isMultiTenant: () => true
}))
vi.mock('../../../services/tenancy/registry.js', () => ({
  getTenantRegistry: () => ({
    byId: async (id: string) =>
      id === 'efp' || id === 'pole' ? { id, origin: `https://${id}` } : null
  })
}))
vi.mock('../../../db/tenant-context.js', () => ({
  withTenant: async (t: { id: string }, fn: () => Promise<unknown>) => {
    tenant = t.id
    try {
      return await fn()
    } finally {
      tenant = undefined
    }
  },
  getTenantId: () => tenant
}))
const announced: Array<string | undefined> = []
vi.mock('../../../services/record-events.js', () => ({
  announceToTenant: () => announced.push(tenant)
}))

class FakeRedis {
  store = new Map<string, string>()
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async set(k: string, v: string) {
    this.store.set(k, v)
    return 'OK'
  }
  async del(k: string) {
    this.store.delete(k)
    return 1
  }
}
const redis = new FakeRedis()
let app: FastifyInstance
let bearer: string

beforeAll(async () => {
  const { hubDeploymentBannerRoutes } = await import('../../../routes/hub-link-banner.js')
  const { deploymentLinkBearer } = await import('../../../services/tenancy/hub-contract.js')
  bearer = deploymentLinkBearer(TOKEN)
  app = Fastify()
  app.decorate('redis', redis as never)
  await app.register(hubDeploymentBannerRoutes, { prefix: '/hub-deployment' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
})
beforeEach(() => {
  redis.store.clear()
  announced.length = 0
})

describe('PUT / DELETE /api/hub-deployment/apps/:id/status-banner', () => {
  const put = (id: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'PUT',
      url: `/hub-deployment/apps/${id}/status-banner`,
      headers,
      payload: { text: 'Orders are slow', tone: 'warn', incident_id: 5 }
    })

  it('needs the deployment bearer (the raw token is refused too)', async () => {
    expect((await put('efp')).statusCode).toBe(401)
    expect((await put('efp', { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(401)
    expect(redis.store.size).toBe(0)
  })

  it('writes inside the named app only, keyed by that app', async () => {
    const auth = { authorization: `Bearer ${bearer}` }
    const r = await put('efp', auth)
    expect(r.statusCode).toBe(200)
    expect(r.json().banner).toMatchObject({ text: 'Orders are slow', incident: 5 })
    expect([...redis.store.keys()]).toEqual(['nvr:hub-banner:efp'])
    expect(announced).toEqual(['efp'])
    await put('pole', auth)
    expect([...redis.store.keys()].sort()).toEqual(['nvr:hub-banner:efp', 'nvr:hub-banner:pole'])
    const del = await app.inject({
      method: 'DELETE',
      url: '/hub-deployment/apps/efp/status-banner',
      headers: auth,
      payload: { incident_id: 5 }
    })
    expect(del.json().banner).toBeNull()
    expect([...redis.store.keys()]).toEqual(['nvr:hub-banner:pole'])
  })

  it('an app this deployment does not serve is 404', async () => {
    const r = await put('shop', { authorization: `Bearer ${bearer}` })
    expect(r.statusCode).toBe(404)
    expect(r.json().code).toBe('UNKNOWN_APP')
  })
})
