import { randomBytes, scryptSync } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Security audit 2026-10-27, sign-in hardening:
 *  - M17: no form-encoded bodies except the SAML POST binding (login CSRF);
 *  - M12: failed password / token / setup attempts are limited (429 + Retry-After);
 *  - M13: every sign-in gets a new session id;
 *  - H9:  five wrong TOTP codes end the pending sign-in; a code works once;
 *  - H6:  /me never carries the static token, password hash, TOTP secret or IdP subject;
 *  - /setup is a cloud step (self-hosted: AUTH_SETUP=on);
 *  - no View-as started from inside a View-as.
 */

const state = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  totpValid: true
}))

vi.mock('../config.js', () => ({
  config: {
    ADMIN_URL: 'http://localhost:3056',
    PUBLIC_URL: 'http://localhost:3055',
    APP_URLS: '',
    SESSION_TTL: 3600,
    SESSION_SECRET: 'auth-hardening-test-secret-0123456789abcdef',
    OIDC_ENABLED: true
  }
}))
vi.mock('../db/index.js', () => {
  const chain = () => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull', 'whereNotNull', 'orderBy', 'select', 'join'])
      c[m] = () => c
    c.first = async () => state.user
    c.update = async () => 1
    c.catch = () => c
    return c
  }
  return { db: vi.fn(() => chain()) }
})
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../services/security.js', () => ({ recordLogin: vi.fn(async () => undefined) }))
vi.mock('../auth/role-sign-in.js', () => ({ signInAllowedByRole: vi.fn(async () => true) }))
vi.mock('otplib', () => ({ verify: vi.fn(async () => ({ valid: state.totpValid })) }))
vi.mock('../middleware/authenticate.js', async (orig) => ({
  ...(await orig<typeof import('../middleware/authenticate.js')>()),
  authenticate: vi.fn(async (req: Record<string, any>) => {
    if (!state.user) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = state.user
    req.isAdmin = true
    req.authMethod = req.headers['x-auth-method'] ?? 'session'
    if (req.headers['x-masq-admin']) req.masqueradeAdminId = req.headers['x-masq-admin']
  }),
  requireAuth: vi.fn(async () => undefined),
  requireAdmin: vi.fn(async (req: Record<string, any>) => {
    req.user = state.user
    req.isAdmin = true
    req.authMethod = req.headers['x-auth-method'] ?? 'session'
    if (req.headers['x-masq-admin']) req.masqueradeAdminId = req.headers['x-masq-admin']
  })
}))

import { authRoutes, formBodyAllowed, TOTP_MAX_FAILURES } from './auth.js'

function memRedis() {
  const kv = new Map<string, string>()
  const ttls = new Map<string, number>()
  const r = {
    kv,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    get: async (k: string) => kv.get(k) ?? null,
    incr: async (k: string) => {
      const n = Number(kv.get(k) ?? 0) + 1
      kv.set(k, String(n))
      return n
    },
    ttl: async (k: string) => (kv.has(k) ? (ttls.get(k) ?? -1) : -2),
    expire: async (k: string, s: number) => {
      ttls.set(k, s)
      return 1
    },
    del: async (...ks: string[]) => ks.filter((k) => kv.delete(k)).length,
    set: async (k: string, v: string, ...opts: unknown[]) => {
      if (opts.includes('NX') && kv.has(k)) return null
      kv.set(k, v)
      return 'OK'
    },
    setex: async (k: string, _s: number, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    multi: () => {
      const ops: Array<() => Promise<unknown>> = []
      const m = {
        del: (k: string) => {
          ops.push(() => r.del(k))
          return m
        },
        setex: (k: string, s: number, v: string) => {
          ops.push(() => r.setex(k, s, v))
          return m
        },
        exec: async () => Promise.all(ops.map((o) => o()))
      }
      return m
    }
  }
  return r
}

type FakeSession = Record<string, unknown> & {
  sessionId: string
  regenerate: (keys?: string[]) => Promise<void>
  destroy: () => Promise<void>
}

function fakeSession(init: Record<string, unknown> = {}): FakeSession {
  let n = 0
  const s = {
    ...init,
    sessionId: 'sid-original',
    async regenerate(keys: string[] = []) {
      const keep = Object.fromEntries(keys.map((k) => [k, s[k]]))
      for (const k of Object.keys(s)) if (!['regenerate', 'destroy'].includes(k)) delete s[k]
      Object.assign(s, keep, { sessionId: `sid-new-${++n}` })
    },
    async destroy() {}
  } as FakeSession
  return s
}

async function build(session: FakeSession, redis = memRedis()) {
  const app = Fastify({ logger: false })
  app.decorate('redis', redis as never)
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: FakeSession }).session = session
  })
  await app.register(authRoutes)
  await app.ready()
  return { app, redis }
}

function hashed(password: string): string {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

const json = (url: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url,
  headers: { 'content-type': 'application/json', ...headers },
  payload: JSON.stringify(body)
})

beforeEach(() => {
  state.user = null
  state.totpValid = true
  delete process.env.AUTH_SETUP
  delete process.env.CLOUD_META_DB_URL
})
afterEach(() => vi.clearAllMocks())

describe('M17 — form bodies (login CSRF)', () => {
  it('only the SAML callback takes a form-encoded body', async () => {
    expect(formBodyAllowed('/saml/callback')).toBe(true)
    expect(formBodyAllowed('/api/auth/saml/callback?x=1')).toBe(true)
    expect(formBodyAllowed('/login/password')).toBe(false)
    const { app } = await build(fakeSession())
    const res = await app.inject({
      method: 'POST',
      url: '/login/password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a%40b.c&password=x'
    })
    expect(res.statusCode).toBe(415)
  })
})

describe('password sign-in', () => {
  it('signs in on a NEW session id, keeping only returnTo (M13)', async () => {
    state.user = {
      id: 'U1',
      email: 'ana@example.com',
      status: 'active',
      password_hash: hashed('right-password')
    }
    const session = fakeSession({ returnTo: 'http://localhost:3056/x', planted: 'by-attacker' })
    const { app, redis } = await build(session)
    const res = await app.inject(
      json('/login/password', { email: 'ana@example.com', password: 'right-password' })
    )
    expect(res.statusCode).toBe(200)
    expect(session.sessionId).not.toBe('sid-original')
    expect(session.userId).toBe('U1')
    expect(session.returnTo).toBe('http://localhost:3056/x')
    expect(session.planted).toBeUndefined()
    // The pre-sign-in id is revoked.
    expect(redis.kv.get('sess:revoked:sid-original')).toBe('1')
  })

  it('limits failed attempts per account (M12)', async () => {
    state.user = {
      id: 'U1',
      email: 'ana@example.com',
      status: 'active',
      password_hash: hashed('right-password')
    }
    const { app } = await build(fakeSession())
    let last = 0
    for (let i = 0; i < 11; i++) {
      const res = await app.inject(
        json('/login/password', { email: 'ana@example.com', password: `wrong-${i}` })
      )
      last = res.statusCode
      if (res.statusCode === 429) {
        expect(res.headers['retry-after']).toBeTruthy()
        expect(JSON.parse(res.body).code).toBe('TOO_MANY_ATTEMPTS')
        break
      }
    }
    expect(last).toBe(429)
    // Even the right password waits out the window.
    const blocked = await app.inject(
      json('/login/password', { email: 'ana@example.com', password: 'right-password' })
    )
    expect(blocked.statusCode).toBe(429)
  })

  it('an unknown email answers like a wrong password', async () => {
    const { app } = await build(fakeSession())
    const res = await app.inject(json('/login/password', { email: 'no@x.com', password: 'p' }))
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('Invalid email or password')
  })
})

describe('H9 — TOTP', () => {
  const pendingUser = () => ({
    id: 'U2',
    status: 'active',
    totp_enabled: true,
    totp_secret: 'SECRET'
  })

  it(`${TOTP_MAX_FAILURES} wrong codes end the pending sign-in`, async () => {
    state.user = pendingUser()
    state.totpValid = false
    const session = fakeSession({ pendingTotpUserId: 'U2' })
    const { app } = await build(session)
    for (let i = 1; i < TOTP_MAX_FAILURES; i++) {
      const res = await app.inject(json('/totp', { token: '000000' }))
      expect(res.statusCode).toBe(401)
      expect(session.pendingTotpUserId).toBe('U2')
    }
    const last = await app.inject(json('/totp', { token: '000000' }))
    expect(JSON.parse(last.body).code).toBe('TOTP_RESTART')
    expect(session.pendingTotpUserId).toBeUndefined()
    const after = await app.inject(json('/totp', { token: '000000' }))
    expect(after.statusCode).toBe(400)
  })

  it('a code works once, and success signs in on a new session id', async () => {
    state.user = pendingUser()
    const redis = memRedis()
    const first = fakeSession({ pendingTotpUserId: 'U2' })
    const ok = await (await build(first, redis)).app.inject(json('/totp', { token: '123456' }))
    expect(ok.statusCode).toBe(200)
    expect(first.userId).toBe('U2')
    expect(first.sessionId).not.toBe('sid-original')

    const replay = fakeSession({ pendingTotpUserId: 'U2' })
    const again = await (await build(replay, redis)).app.inject(json('/totp', { token: '123456' }))
    expect(again.statusCode).toBe(401)
    expect(replay.userId).toBeUndefined()
  })
})

describe('/setup', () => {
  it('is not offered on a self-hosted instance unless AUTH_SETUP=on', async () => {
    const { app } = await build(fakeSession())
    const res = await app.inject(json('/setup', { token: 'abcdefgh', password: 'longenough' }))
    expect(res.statusCode).toBe(404)
    process.env.AUTH_SETUP = 'on'
    const offered = await app.inject(json('/setup', { token: 'abcdefgh', password: 'longenough' }))
    expect(offered.statusCode).toBe(401) // no such token
  })
})

describe('H6 — GET /me', () => {
  it('never sends credentials, says whether a token exists', async () => {
    state.user = {
      id: 'U3',
      email: 'a@b.c',
      status: 'active',
      static_token: 'tok-123',
      password_hash: 'salt:hash',
      totp_secret: 'TOTP',
      external_id: 'sub-1',
      preferences: '{"theme":"dark"}'
    }
    const { app } = await build(fakeSession())
    const res = await app.inject({ method: 'GET', url: '/me' })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    for (const f of ['static_token', 'password_hash', 'totp_secret', 'external_id'])
      expect(data).not.toHaveProperty(f)
    expect(res.body).not.toContain('tok-123')
    expect(data.has_static_token).toBe(true)
    expect(data.preferences).toEqual({ theme: 'dark' })
  })
})

describe('View-as', () => {
  it('cannot be started from inside a View-as', async () => {
    state.user = { id: 'ADMIN-TARGET', status: 'active' }
    const { app } = await build(fakeSession())
    const res = await app.inject(
      json(
        '/masquerade',
        { user_id: 'someone' },
        { 'x-auth-method': 'masquerade', 'x-masq-admin': 'REAL-ADMIN' }
      )
    )
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).code).toBe('NOT_WHILE_MASQUERADING')
  })
})
