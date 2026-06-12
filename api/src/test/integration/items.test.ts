import { afterEach, describe, expect, it, vi } from 'vitest'

const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

vi.mock('../../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    DB_DATABASE: 'testdb',
    DB_HOST: 'localhost',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: null,
  },
}))

vi.mock('../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {}),
  cidrMatch: vi.fn(() => true),
  checkApiKeyScope: vi.fn(() => true),
}))

vi.mock('../../services/activity.js', () => ({
  logActivity: vi.fn().mockResolvedValue(1),
}))

vi.mock('../../services/revisions.js', () => ({
  writeRevision: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../hooks/registry.js', () => ({
  runHooks: vi.fn().mockResolvedValue(undefined),
  hookRegistry: { before: [], after: [] },
}))

import Fastify from 'fastify'
import { db } from '../../db/index.js'
import { makeAdminUser } from '../helpers.js'

function makeDbChain(result: unknown) {
  const chain = {
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    orderByRaw: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    count: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(result),
    first: vi.fn().mockResolvedValue(result),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(1),
    returning: vi.fn().mockResolvedValue([{ id: 1 }]),
    then: vi.fn((cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)),
  }
  return chain
}

async function buildItemsApp() {
  const app = Fastify({ logger: false })
  const adminUser = makeAdminUser()

  app.decorateRequest('user', null)
  app.decorateRequest('userRole', null)
  app.decorateRequest('isAdmin', true)
  app.decorateRequest('workspaceId', null)

  // Inject admin user for every request so permission checks pass
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { user: typeof adminUser }).user = adminUser
    ;(req as unknown as { isAdmin: boolean }).isAdmin = true
  })

  const { itemRoutes } = await import('../../routes/items.js')
  app.register(itemRoutes, { prefix: '/api' })
  await app.ready()
  return app
}

afterEach(() => vi.clearAllMocks())

describe.skipIf(!RUN_INTEGRATION)('Integration: /api/items', () => {
  it('GET /api/items/:collection returns an array', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain([{ id: 1, title: 'Hello' }]) as unknown as ReturnType<typeof db>
    )

    const app = await buildItemsApp()
    const res = await app.inject({ method: 'GET', url: '/api/items/articles' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('GET /api/items/:collection returns empty array when no rows', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain([]) as unknown as ReturnType<typeof db>
    )

    const app = await buildItemsApp()
    const res = await app.inject({ method: 'GET', url: '/api/items/articles' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: unknown[] }
    expect(body.data).toHaveLength(0)
  })

  it('POST /api/items/:collection creates an item', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain({ id: 1, title: 'New Article' }) as unknown as ReturnType<typeof db>
    )

    const app = await buildItemsApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/articles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'New Article' }),
    })

    expect([200, 201]).toContain(res.statusCode)
  })

  it('PATCH /api/items/:collection/:id updates an item', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain({ id: 5, title: 'Updated' }) as unknown as ReturnType<typeof db>
    )

    const app = await buildItemsApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/items/articles/5',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'Updated' }),
    })

    expect([200, 204]).toContain(res.statusCode)
  })

  it('DELETE /api/items/:collection/:id deletes an item', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(
      makeDbChain(1) as unknown as ReturnType<typeof db>
    )

    const app = await buildItemsApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/items/articles/5',
    })

    expect([200, 204]).toContain(res.statusCode)
  })
})
