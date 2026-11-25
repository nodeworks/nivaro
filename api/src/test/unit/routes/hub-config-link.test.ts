import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub config promotion (idea 30), app side over the links: every call needs the link's bearer
// (checked per request, never by URL), a PromoteError is answered as {code, message, …}, and on a
// shared deployment each call runs inside THAT app (its tenant context).

const seen = vi.hoisted(() => ({
  tenants: [] as Array<string | undefined>,
  bodies: [] as unknown[]
}))

vi.mock('../../../services/hub-link/config-promote.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  class PromoteError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly extra: Record<string, unknown> = {}
    ) {
      super(message)
    }
  }
  const note = (b: unknown) => {
    seen.tenants.push(tc.getTenantId())
    seen.bodies.push(b)
  }
  return {
    PromoteError,
    readPromotionSnapshot: vi.fn(async (t: unknown) => {
      note(t)
      return { version: '0.3.215', environment: 'staging', snapshot: { format: 1, tables: {} } }
    }),
    planPromotion: vi.fn(async (b: unknown) => {
      note(b)
      return { preview: { plan_hash: 'a'.repeat(64) } }
    }),
    applyPromotion: vi.fn(async (b: unknown) => {
      note(b)
      throw new PromoteError(409, 'PROD_ONLY_CHANGES', '1 change made here', {
        items: [{ id: 'x' }]
      })
    }),
    undoPromotion: vi.fn(async (b: unknown) => {
      note(b)
      throw new Error('boom: SELECT * FROM secret')
    })
  }
})

import { hubConfigDeploymentRoutes, hubConfigLinkRoutes } from '../../../routes/hub-config-link.js'
import { deploymentLinkBearer } from '../../../services/tenancy/hub-contract.js'
import { setTenantRegistryForTests } from '../../../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../../../services/tenancy/types.js'

const HUB_TOKEN = `hub-${'h'.repeat(40)}`
const DEP_TOKEN = `dep-${'t'.repeat(40)}`
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
  delete process.env.HUB_SHARED_DEPLOYMENT
  seen.tenants.length = 0
  seen.bodies.length = 0
})
afterEach(async () => {
  await app?.close()
  app = null
  process.env = { ...saved }
  setTenantRegistryForTests(null)
})

describe('dedicated app (/api/hub-link/config/*)', () => {
  async function build() {
    process.env.HUB_TOKEN = HUB_TOKEN
    const a = Fastify()
    await a.register(hubConfigLinkRoutes, { prefix: '/api/hub-link' })
    await a.ready()
    app = a
    return a
  }
  const auth = { authorization: `Bearer ${HUB_TOKEN}` }

  it('every call needs the hub token', async () => {
    const a = await build()
    for (const name of ['snapshot', 'plan', 'apply', 'undo']) {
      const r = await a.inject({ method: 'POST', url: `/api/hub-link/config/${name}`, payload: {} })
      expect(r.statusCode, name).toBe(401)
      const odd = await a.inject({
        method: 'POST',
        url: `/api/hub-link/config/${name}?x=/status`,
        headers: { authorization: 'Bearer nope' },
        payload: {}
      })
      expect(odd.statusCode, name).toBe(401)
    }
    expect(seen.bodies).toEqual([])
  })

  it('answers the snapshot and the plan; a refusal keeps its code and items', async () => {
    const a = await build()
    const s = await a.inject({
      method: 'POST',
      url: '/api/hub-link/config/snapshot',
      headers: auth,
      payload: { tables: ['nivaro_roles'] }
    })
    expect(s.statusCode).toBe(200)
    expect(s.headers['cache-control']).toBe('no-store')
    expect(seen.bodies[0]).toEqual(['nivaro_roles'])
    const p = await a.inject({
      method: 'POST',
      url: '/api/hub-link/config/plan',
      headers: auth,
      payload: { tables: ['nivaro_roles'] }
    })
    expect(p.json().preview.plan_hash).toHaveLength(64)
    const ap = await a.inject({
      method: 'POST',
      url: '/api/hub-link/config/apply',
      headers: auth,
      payload: {}
    })
    expect(ap.statusCode).toBe(409)
    expect(ap.json()).toMatchObject({ code: 'PROD_ONLY_CHANGES', items: [{ id: 'x' }] })
  })

  it('an unexpected failure never echoes its text', async () => {
    const a = await build()
    const r = await a.inject({
      method: 'POST',
      url: '/api/hub-link/config/undo',
      headers: auth,
      payload: {}
    })
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain('SELECT')
    expect(r.json().code).toBe('CONFIG_PROMOTE_FAILED')
  })

  it('is not mounted on a deployment that serves many apps', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    const a = await build()
    const r = await a.inject({
      method: 'POST',
      url: '/api/hub-link/config/plan',
      headers: auth,
      payload: {}
    })
    expect(r.statusCode).toBe(404)
  })
})

describe('shared deployment (/api/hub-deployment/config/apps/:id/*)', () => {
  async function build() {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = DEP_TOKEN
    setTenantRegistryForTests(registry)
    const a = Fastify()
    await a.register(hubConfigDeploymentRoutes, { prefix: '/api/hub-deployment' })
    await a.ready()
    app = a
    return a
  }
  const auth = { authorization: `Bearer ${deploymentLinkBearer(DEP_TOKEN)}` }

  it('runs inside that app, refuses unknown apps and the raw token', async () => {
    const a = await build()
    const raw = await a.inject({
      method: 'POST',
      url: `/api/hub-deployment/config/apps/${A.id}/plan`,
      headers: { authorization: `Bearer ${DEP_TOKEN}` },
      payload: {}
    })
    expect(raw.statusCode).toBe(401)
    const none = await a.inject({
      method: 'POST',
      url: '/api/hub-deployment/config/apps/zz-e9/plan',
      headers: auth,
      payload: {}
    })
    expect(none.statusCode).toBe(404)
    expect(none.json().code).toBe('UNKNOWN_APP')
    const ok = await a.inject({
      method: 'POST',
      url: `/api/hub-deployment/config/apps/${A.id}/plan`,
      headers: auth,
      payload: { tables: ['nivaro_roles'] }
    })
    expect(ok.statusCode).toBe(200)
    expect(seen.tenants).toEqual([A.id])
  })
})
