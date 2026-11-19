import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// GET /api/ops-db/pool-holders — Database → Connections. Administrators only.

const h = vi.hoisted(() => ({ checks: [] as Array<{ id: string }> }))

vi.mock('../../../middleware/authenticate.js', () => {
  const admin = async (req: { headers: Record<string, string | undefined> }) => {
    if (!req.headers['x-user']) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    if (req.headers['x-admin'] !== '1')
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
  }
  return { requireAdmin: vi.fn(admin) }
})
vi.mock('../../../services/readiness.js', () => ({
  registerReadinessCheck: (c: { id: string }) => h.checks.push(c)
}))
vi.mock('../../../services/pool-holders.js', () => ({
  HOG_MS: 30_000,
  HOG_SHARE: 0.5,
  recentHogs: async () => [],
  clusterPoolHolders: async () => ({ available: true, partial: false, by_person: [] })
}))

import { poolHoldersRoutes } from '../../../routes/pool-holders.js'

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(poolHoldersRoutes, { prefix: '/api/ops-db/pool-holders' })
  await app.ready()
})
afterAll(() => app.close())

describe('GET /api/ops-db/pool-holders', () => {
  it('refuses a signed-out caller and a non-admin', async () => {
    expect((await app.inject({ url: '/api/ops-db/pool-holders' })).statusCode).toBe(401)
    const r = await app.inject({ url: '/api/ops-db/pool-holders', headers: { 'x-user': 'u1' } })
    expect(r.statusCode).toBe(403)
  })

  it('answers an admin, never cached', async () => {
    const r = await app.inject({
      url: '/api/ops-db/pool-holders',
      headers: { 'x-user': 'u1', 'x-admin': '1' }
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.json().data).toMatchObject({ available: true, partial: false })
  })

  it('registers the pool-hogs readiness check once', () => {
    expect(h.checks.map((c) => c.id)).toEqual(['pool-hogs'])
  })
})
