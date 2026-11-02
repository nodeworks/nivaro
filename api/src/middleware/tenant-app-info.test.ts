import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  dbReads: 0
}))

// resolveTenant is private; it reads the meta DB through knex, so stub knex itself.
vi.mock('knex', () => ({
  default: () => () => ({
    where: () => ({ first: () => ({ catch: async () => state.row }) })
  })
}))
vi.mock('../db/tenant-context.js', () => ({
  getOrCreateTenantPool: () => ({}),
  runWithTenantDb: (_db: unknown, _slug: string, done: () => void) => done()
}))
vi.mock('../db/index.js', () => ({
  db: () => {
    state.dbReads++
    throw new Error('tenant database must not be read for a blocked tenant')
  }
}))
vi.mock('../services/settings-overrides.js', () => ({ overlaySettings: async (r: unknown) => r }))
vi.mock('../services/security.js', () => ({ maintenanceState: async () => ({ on: false }) }))
vi.mock('../admin-base.js', () => ({ adminBaseUrl: () => 'https://x.test' }))

import { appInfoRoutes } from '../routes/app-info.js'
import { tenantHook } from './tenant.js'

process.env.CLOUD_META_DB_URL = 'postgres://meta'

async function build() {
  const app = Fastify()
  app.addHook('onRequest', tenantHook)
  await app.register(appInfoRoutes, { prefix: '/api' })
  app.get('/api/other', async () => ({ ok: true }))
  return app
}

describe('tenantHook + /api/app-info on a blocked tenant', () => {
  let app: Awaited<ReturnType<typeof build>>
  beforeAll(async () => {
    app = await build()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    state.dbReads = 0
  })

  for (const [status, blocked] of [
    ['suspended', 'suspended'],
    ['provisioning', 'provisioning']
  ] as const) {
    it(`${status}: app-info answers 200 with blocked, no db read, cached 60s`, async () => {
      state.row = { id: 't1', slug: 'acme', name: 'Acme Co', status }
      const res = await app.inject({
        method: 'GET',
        url: '/api/app-info',
        headers: { 'x-tenant-host': 'acme.nivaro.dev' }
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=60')
      expect(res.json()).toMatchObject({ name: 'Acme Co', blocked })
      expect(state.dbReads).toBe(0)
    })

    it(`${status}: any other route still gets 503`, async () => {
      state.row = { id: 't1', slug: 'acme', name: 'Acme Co', status }
      const res = await app.inject({
        method: 'GET',
        url: '/api/other',
        headers: { 'x-tenant-host': 'acme.nivaro.dev' }
      })
      expect(res.statusCode).toBe(503)
    })
  }
})
