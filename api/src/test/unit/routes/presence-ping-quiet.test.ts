import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Army 10: during a page reload POST /api/presence/ping answered 503 once. A heartbeat is
// best-effort (the next beat records it), so nothing that stops one being recorded — Redis,
// the database fast-503, the session store's AUTH_BACKEND_TIMEOUT, a busy pool — may answer
// it with a server error: it is a quiet 204 with `x-presence-recorded: 0`.

vi.mock('../../../db/index.js', () => {
  const b = { first: () => Promise.resolve(null) }
  return { db: () => b }
})

const auth = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'refused' | 'unavailable',
  user: { id: 'U1', email: 'u1@example.test', first_name: 'Una', last_name: 'One' }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown }) => {
    if (auth.mode === 'refused') throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    if (auth.mode === 'unavailable')
      throw Object.assign(new Error('Signing in is unavailable'), { statusCode: 503 })
    req.user = auth.user
  }),
  requireAdmin: vi.fn(),
  requireAuth: vi.fn()
}))

import {
  buildScript,
  PRESENCE_RECORDED_HEADER,
  presencePublicRoutes,
  sessionKeyPrefix
} from '../../../routes/presence.js'

function fakeRedis() {
  const store = new Map<string, string>()
  const fail = { get: false, setex: false }
  return {
    store,
    fail,
    get: async (k: string) => {
      if (fail.get) throw new Error('Connection is closed.')
      return store.get(k) ?? null
    },
    setex: async (k: string, _ttl: number, v: string) => {
      if (fail.setex) throw new Error('Connection is closed.')
      store.set(k, v)
    },
    del: async (k: string) => {
      store.delete(k)
    },
    scan: async () => ['0', [] as string[]],
    mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)
  }
}

let app: FastifyInstance
async function build(
  redis: ReturnType<typeof fakeRedis> | null,
  rootHook?: (app: FastifyInstance) => void
) {
  app = Fastify()
  app.decorate('redis', redis as never)
  rootHook?.(app)
  await app.register(presencePublicRoutes, { prefix: '/api/presence' })
  await app.ready()
  return app
}

const ping = (headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/presence/ping',
    headers,
    payload: { sessionId: 'tab-1', pageUrl: 'https://portal.test/records/workflows/1' }
  })

afterEach(async () => {
  auth.mode = 'ok'
  await app?.close()
})

describe('presence heartbeats never answer with a server error', () => {
  it('records a normal ping', async () => {
    const redis = fakeRedis()
    await build(redis)
    const res = await ping({ cookie: 'sid=x' })
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBeUndefined()
    expect(JSON.parse(redis.store.get(`${sessionKeyPrefix()}tab-1`) ?? '{}').userId).toBe('U1')
  })

  it('answers "not recorded" when Redis is missing or refuses', async () => {
    await build(null)
    let res = await ping()
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBe('0')
    await app.close()

    const redis = fakeRedis()
    redis.fail.get = true
    await build(redis)
    res = await ping()
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBe('0')
    redis.fail.get = false
    redis.fail.setex = true
    res = await ping()
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBe('0')
  })

  it('turns a 503 sent above the handler (database fast-503) into a quiet 204', async () => {
    await build(fakeRedis(), (a) =>
      a.addHook('onRequest', async (_req, reply) =>
        reply.code(503).send({ error: 'The database is unreachable', code: 'DB_UNAVAILABLE' })
      )
    )
    const res = await ping()
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBe('0')
    expect(res.body).toBe('')
    expect(res.headers['content-type']).toBeUndefined()
  })

  it('turns a 503 thrown above the handler (session store timeout) into a quiet 204', async () => {
    await build(fakeRedis(), (a) =>
      a.addHook('onRequest', async () => {
        throw Object.assign(new Error('Signing in is unavailable right now'), {
          statusCode: 503,
          code: 'AUTH_BACKEND_TIMEOUT'
        })
      })
    )
    const res = await ping()
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBe('0')
  })

  it('keeps 4xx answers (a bad body is still the caller’s mistake)', async () => {
    await build(fakeRedis())
    const res = await app.inject({ method: 'POST', url: '/api/presence/ping', payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('never rewrites a signed-in session as anonymous when sign-in cannot be checked', async () => {
    const redis = fakeRedis()
    await build(redis)
    expect((await ping({ cookie: 'sid=x' })).statusCode).toBe(204)
    const key = `${sessionKeyPrefix()}tab-1`
    const before = redis.store.get(key)

    auth.mode = 'unavailable'
    const res = await ping({ cookie: 'sid=x' })
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBe('0')
    expect(redis.store.get(key)).toBe(before)
  })

  it('still records a refused credential as an anonymous visitor', async () => {
    const redis = fakeRedis()
    await build(redis)
    auth.mode = 'refused'
    const res = await ping({ cookie: 'sid=stale' })
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBeUndefined()
    expect(JSON.parse(redis.store.get(`${sessionKeyPrefix()}tab-1`) ?? '{}').userId).toBe(null)
  })

  it('the embeddable tracker retries a failed ping once and still parses', () => {
    const script = buildScript()
    expect(() => new Function(script)).not.toThrow()
    expect(script).toMatch(/r\.status >= 500\) retry\(\)/)
  })

  it('disconnect answers 204 when Redis refuses', async () => {
    const redis = fakeRedis()
    redis.fail.get = true
    await build(redis)
    const res = await app.inject({
      method: 'POST',
      url: '/api/presence/disconnect',
      payload: { sessionId: 'tab-1' }
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers[PRESENCE_RECORDED_HEADER]).toBe('0')
  })
})
