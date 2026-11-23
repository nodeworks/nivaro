import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 parked wave (ruling M17): a retired app answers 503 APP_MOVED from a ROOT onRequest
// (server.ts), so a path with no route and a route whose own onRequest answers first (a bearer
// check → 401) are refused too — the root preHandler alone never ran for either.

vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => ({
    on: false,
    message: null,
    display: 'banner',
    until: null,
    source: 'settings'
  }),
  MAINTENANCE_EXPLAINER: 'Changes are paused.',
  MAINTENANCE_DEFAULT_MESSAGE: 'Maintenance.'
}))
vi.mock('../../../middleware/authenticate.js', () => ({ authenticate: vi.fn(async () => {}) }))

const { maintenanceFreezeHook, retiredRequestHook } = await import(
  '../../../services/maintenance-freeze.js'
)
const retire = await import('../../../services/hub-link/retire.js')

/** The server.ts order: the root onRequest, the root preHandler, then the routes. */
async function build(withOnRequest: boolean): Promise<FastifyInstance> {
  const app = Fastify()
  if (withOnRequest) app.addHook('onRequest', retiredRequestHook)
  app.addHook('preHandler', maintenanceFreezeHook)
  // A route that answers from its own onRequest (as the bearer-checked internal routes do).
  app.get(
    '/api/internal/thing',
    {
      onRequest: async (_req, reply) => {
        await reply.code(401).send({ error: 'Unauthorized' })
      }
    },
    async () => ({ reached: true })
  )
  app.get('/api/items/x', async () => ({ ok: true }))
  app.get('/api/version', async () => ({ version: 'v' }))
  app.get('/api/hub-link/status', async () => ({ link: true }))
  app.post('/api/hub-link/first-admin', async () => ({ created: true }))
  await app.ready()
  return app
}

let app: FastifyInstance | null = null
beforeEach(() => retire._resetRetiredForTests('yes'))
afterEach(async () => {
  retire._resetRetiredForTests('no')
  await app?.close()
  app = null
})

describe('retire as a root onRequest (M17)', () => {
  it('an unrouted path answers APP_MOVED, not 404', async () => {
    app = await build(true)
    const r = await app.inject({ url: '/no/such/page' })
    expect(r.statusCode).toBe(503)
    expect(r.json()).toMatchObject({ code: 'APP_MOVED' })
    expect(r.headers['retry-after']).toBe('60')
  })

  it('a route whose own onRequest answers first still answers APP_MOVED (never reaches its 401)', async () => {
    app = await build(true)
    const r = await app.inject({ url: '/api/internal/thing' })
    expect(r.statusCode).toBe(503)
    expect(r.json()).toMatchObject({ code: 'APP_MOVED' })
  })

  it('without the onRequest (the old preHandler-only gate) a route-level onRequest answers first — the bite', async () => {
    app = await build(false)
    expect((await app.inject({ url: '/api/internal/thing' })).statusCode).toBe(401)
    // (the 404 handler already ran the root preHandler: T9 review probe; still covered)
    expect((await app.inject({ url: '/no/such/page' })).statusCode).toBe(503)
  })

  it('the exempt paths still answer; first-admin stays refused; OPTIONS passes', async () => {
    app = await build(true)
    expect((await app.inject({ url: '/api/version' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/hub-link/status' })).statusCode).toBe(200)
    const fa = await app.inject({ method: 'POST', url: '/api/hub-link/first-admin' })
    expect(fa.statusCode).toBe(503)
    expect(fa.json()).toMatchObject({ code: 'APP_MOVED' })
    const fa2 = await app.inject({ method: 'POST', url: '/api/hub-link/first%2Dadmin' })
    expect(fa2.statusCode).toBe(503)
    expect((await app.inject({ method: 'OPTIONS', url: '/api/items/x' })).statusCode).not.toBe(503)
  })

  it('a process that is not retired answers as before', async () => {
    retire._resetRetiredForTests('no')
    app = await build(true)
    expect((await app.inject({ url: '/no/such/page' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/internal/thing' })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/items/x' })).json()).toEqual({ ok: true })
  })

  it('unknown state (Redis never answered) refuses with APP_STATE_UNKNOWN', async () => {
    retire._resetRetiredForTests('unknown')
    app = await build(true)
    const r = await app.inject({ url: '/no/such/page' })
    expect(r.statusCode).toBe(503)
    expect(r.json()).toMatchObject({ code: 'APP_STATE_UNKNOWN' })
  })
})

describe('server.ts wiring', () => {
  const src = readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8')
  it('registers the retire hook as a root onRequest before any route plugin', () => {
    const hook = src.indexOf("app.addHook('onRequest', retiredRequestHook)")
    expect(hook).toBeGreaterThan(0)
    expect(hook).toBeLessThan(src.indexOf('await app.register(registerRoutes'))
    expect(hook).toBeLessThan(src.indexOf("app.addHook('preHandler', maintenanceFreezeHook)"))
  })
})
