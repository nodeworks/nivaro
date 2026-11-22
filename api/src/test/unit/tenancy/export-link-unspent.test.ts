import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 22 (carried from Task 12): the help-video package link GET /packages/:token,
// end to end through the route. On a Hub shared deployment a link made in app A that reaches
// app B is refused (404) and LEFT UNSPENT — B never burns A's single-use link — while in app A
// it is spent exactly once.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({ authenticate: async () => {} }))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { exportTicketValue, EXPORT_TICKET_PREFIX } = await import(
  '../../../services/help-video-package.js'
)
const { helpVideoMediaRoutes } = await import('../../../routes/help-videos.js')

const A = 'app-a-e1'
const B = 'app-b-e2'
const USER = '11111111-2222-4333-8444-555555555555'
const VIDEO = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TOKEN = 'cccccccc-dddd-4eee-8fff-000000000000'

function inApp<T>(id: string, fn: () => T): T {
  let out!: T
  runWithTenantDb({} as never, id, () => (out = fn()), id)
  return out
}

function fakeRedis() {
  const store = new Map<string, string>()
  const getdel = vi.fn(async (k: string) => {
    const v = store.get(k) ?? null
    store.delete(k)
    return v
  })
  return { store, getdel, get: vi.fn(async (k: string) => store.get(k) ?? null) }
}

/** The routes, every request served as `appOf()` (the context the tenant middleware sets). */
async function server(redis: ReturnType<typeof fakeRedis>, appOf: () => string) {
  const app = Fastify()
  app.decorate('redis', redis as never)
  app.addHook('onRequest', (_req, _reply, done) => {
    runWithTenantDb({} as never, appOf(), () => done(), appOf())
  })
  await app.register(helpVideoMediaRoutes)
  await app.ready()
  return app
}

afterEach(() => {
  delete process.env.HUB_SHARED_DEPLOYMENT
})

describe('help-video package link on a shared deployment', () => {
  it('reaching another app: 404 and the link stays unspent for its own app', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    const redis = fakeRedis()
    const key = `${EXPORT_TICKET_PREFIX}${TOKEN}`
    redis.store.set(
      key,
      inApp(A, () => exportTicketValue(USER, [VIDEO], null))
    )
    const app = await server(redis, () => B)
    const res = await app.inject({ method: 'GET', url: `/packages/${TOKEN}` })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('HELP_VIDEO_PACKAGE_LINK_EXPIRED')
    expect(redis.getdel).not.toHaveBeenCalled()
    expect(redis.store.has(key)).toBe(true)
    await app.close()
  })

  it('in its own app the link is spent (single use)', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    const redis = fakeRedis()
    const key = `${EXPORT_TICKET_PREFIX}${TOKEN}`
    redis.store.set(
      key,
      inApp(A, () => exportTicketValue(USER, [VIDEO], null))
    )
    const app = await server(redis, () => A)
    // The user lookup after the spend is mocked away (db), so the answer is a 404 for the user;
    // what matters here is that the link was spent in its own app.
    await app.inject({ method: 'GET', url: `/packages/${TOKEN}` })
    expect(redis.getdel).toHaveBeenCalledWith(key)
    expect(redis.store.has(key)).toBe(false)
    await app.close()
  })
})
