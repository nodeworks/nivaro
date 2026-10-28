import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// M15 (security audit 2026-10-27): an always-on anonymous per-IP limit keyed after the
// session plugin; signed-in traffic never spends it, credentials that do not check out do.

vi.mock('../../../services/traffic-breaker.js', () => ({
  entityBreakerHook: vi.fn(async () => false),
  startBreakerSync: vi.fn()
}))

import {
  callerRateLimitPlugin,
  carriesCredential,
  clientKey,
  exemptFromLimits,
  resolveAnonLimit,
  resolveLimit
} from '../../../plugins/rate-limit.js'

function fakeRedis() {
  const store = new Map<string, number>()
  return {
    store,
    async get(k: string) {
      return store.has(k) ? String(store.get(k)) : null
    },
    multi() {
      const ops: Array<() => unknown> = []
      const chain = {
        incr(k: string) {
          ops.push(() => {
            const v = (store.get(k) ?? 0) + 1
            store.set(k, v)
            return v
          })
          return chain
        },
        expire() {
          ops.push(() => 1)
          return chain
        },
        async exec() {
          return ops.map((op) => [null, op()] as [null, unknown])
        }
      }
      return chain
    }
  }
}

async function build(env: Record<string, string>) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  const app = Fastify()
  const redis = fakeRedis()
  app.decorate('redis', redis as never)
  // stands in for @fastify/session: a VERIFIED session only when the test says so
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    const sid = req.headers['x-test-session']
    ;(req as any).session = sid ? { userId: String(sid) } : null
  })
  await app.register(callerRateLimitPlugin)
  // stands in for a route's authenticate: a good bearer token signs the caller in
  app.addHook('preHandler', async (req) => {
    if (req.headers.authorization === 'Bearer good') (req as any).user = { id: 'U-KEY' }
  })
  app.get('/api/thing', async () => ({ ok: true }))
  app.get('/api/health', async () => ({ ok: true }))
  await app.ready()
  process.env = saved
  return { app, redis }
}

const remote = { remoteAddress: '203.0.113.7' }

afterEach(() => {
  delete process.env.RATE_LIMIT_ANON_PER_MINUTE
  delete process.env.RATE_LIMIT_PER_MINUTE
})

describe('rate limit settings', () => {
  it('anonymous limit defaults on (300) only behind a trusted proxy; per-caller off', () => {
    expect(resolveAnonLimit({})).toBe(0)
    expect(resolveAnonLimit({ TRUST_PROXY: 'false' })).toBe(0)
    expect(resolveAnonLimit({ TRUST_PROXY: '1' })).toBe(300)
    expect(resolveAnonLimit({ TRUST_PROXY: '10.0.0.0/8' })).toBe(300)
    expect(resolveAnonLimit({ RATE_LIMIT_ANON_PER_MINUTE: '50' })).toBe(50)
    expect(resolveAnonLimit({ RATE_LIMIT_ANON_PER_MINUTE: '0', TRUST_PROXY: '1' })).toBe(0)
    expect(resolveLimit({})).toBe(0)
    expect(resolveLimit({ RATE_LIMIT_PER_MINUTE: '600' })).toBe(600)
  })

  it('keys a verified session by its user, never by a cookie alone', () => {
    expect(clientKey({ headers: {}, ip: '1.2.3.4', session: { userId: 'abc' } })).toBe('u:ABC')
    expect(clientKey({ headers: { cookie: 'nivaro_session=x' }, ip: '1.2.3.4' })).toBe('ip:1.2.3.4')
  })

  it('never exempts by a client-set header; exempts loopback without a proxy hop', () => {
    const base = { raw: { url: '/api/thing' } }
    expect(
      exemptFromLimits({
        ...base,
        headers: { 'user-agent': 'lightMyRequest', 'x-forwarded-for': '9.9.9.9' },
        socket: { remoteAddress: '127.0.0.1' }
      })
    ).toBe(false)
    expect(exemptFromLimits({ ...base, headers: {}, socket: { remoteAddress: '127.0.0.1' } })).toBe(
      true
    )
    expect(exemptFromLimits({ raw: { url: '/api/ready' }, headers: {} })).toBe(true)
  })
})

describe('anonymous limit', () => {
  it('refuses an address after N anonymous requests', async () => {
    const { app } = await build({ RATE_LIMIT_ANON_PER_MINUTE: '3' })
    const codes: number[] = []
    for (let i = 0; i < 5; i++)
      codes.push((await app.inject({ url: '/api/thing', ...remote })).statusCode)
    expect(codes).toEqual([200, 200, 200, 429, 429])
    await app.close()
  })

  it('bad bearer tokens spend the budget but a credentialed request is never refused (A1)', async () => {
    const { app, redis } = await build({ RATE_LIMIT_ANON_PER_MINUTE: '2' })
    const bad = { ...remote, headers: { authorization: 'Bearer guess' } }
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ url: '/api/thing', ...bad })).statusCode).toBe(200)
    }
    expect([...redis.store.values()].reduce((a, b) => a + b, 0)).toBe(3)
    // the bucket is full: a plain anonymous request waits, a valid key still gets through
    expect((await app.inject({ url: '/api/thing', ...remote })).statusCode).toBe(429)
    const good = { ...remote, headers: { authorization: 'Bearer good' } }
    expect((await app.inject({ url: '/api/thing', ...good })).statusCode).toBe(200)
    // so does a request carrying the session cookie
    const cookie = { ...remote, headers: { cookie: 'a=1; nivaro_session=abc' } }
    expect((await app.inject({ url: '/api/thing', ...cookie })).statusCode).toBe(200)
    await app.close()
  })

  it('recognises the session cookie among others', () => {
    expect(carriesCredential({ headers: { cookie: 'x=1; nivaro_session=s' } })).toBe(true)
    expect(carriesCredential({ headers: { cookie: 'x=1; other_session=s' } })).toBe(false)
    expect(carriesCredential({ headers: { authorization: 'Bearer t' } })).toBe(true)
    expect(carriesCredential({ headers: {} })).toBe(false)
  })

  it('signed-in traffic never counts and is never refused', async () => {
    const { app, redis } = await build({ RATE_LIMIT_ANON_PER_MINUTE: '1' })
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        url: '/api/thing',
        ...remote,
        headers: { 'x-test-session': 'U1' }
      })
      expect(res.statusCode).toBe(200)
    }
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        url: '/api/thing',
        ...remote,
        headers: { authorization: 'Bearer good' }
      })
      expect(res.statusCode).toBe(200)
    }
    expect([...redis.store.values()].reduce((a, b) => a + b, 0)).toBe(0)
    await app.close()
  })

  it('health probes are exempt', async () => {
    const { app } = await build({ RATE_LIMIT_ANON_PER_MINUTE: '1' })
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ url: '/api/health', ...remote })).statusCode).toBe(200)
    }
    await app.close()
  })
})

describe('per-caller limit', () => {
  it('counts a verified session user across addresses', async () => {
    const { app } = await build({ RATE_LIMIT_PER_MINUTE: '2', RATE_LIMIT_ANON_PER_MINUTE: '0' })
    const as = (ip: string) => ({
      url: '/api/thing',
      remoteAddress: ip,
      headers: { 'x-test-session': 'U1' }
    })
    expect((await app.inject(as('203.0.113.1'))).statusCode).toBe(200)
    expect((await app.inject(as('203.0.113.2'))).statusCode).toBe(200)
    const third = await app.inject(as('203.0.113.3'))
    expect(third.statusCode).toBe(429)
    expect(third.json().code).toBe('RATE_LIMITED')
    await app.close()
  })
})
