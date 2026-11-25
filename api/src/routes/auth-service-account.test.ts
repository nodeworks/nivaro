import { randomBytes, scryptSync } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A SERVICE account (account_kind 'service', e.g. the Hub smoke identity) never signs in
 * interactively: password, static-token sign-in, password setup, View-as, an existing session,
 * SCIM. It acts only through the API key its own code mints (roleAllowsSignIn still lets a
 * machine account authenticate with its own credential).
 */

const state = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }))

vi.mock('../config.js', () => ({
  config: {
    ADMIN_URL: 'http://localhost:3056',
    PUBLIC_URL: 'http://localhost:3055',
    APP_URLS: '',
    SESSION_TTL: 3600,
    SESSION_SECRET: 'auth-service-account-test-secret-0123456789',
    OIDC_ENABLED: true
  }
}))
vi.mock('../db/index.js', () => {
  const chain = () => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull', 'whereNotNull', 'orderBy', 'select', 'join', 'whereRaw'])
      c[m] = () => c
    c.first = async () => state.user
    c.update = vi.fn(async () => 1)
    c.catch = () => c
    return c
  }
  return { db: vi.fn(() => chain()) }
})
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../services/security.js', () => ({ recordLogin: vi.fn(async () => undefined) }))
vi.mock('../middleware/authenticate.js', async (orig) => ({
  ...(await orig<typeof import('../middleware/authenticate.js')>()),
  authenticate: vi.fn(async (req: Record<string, any>) => {
    req.user = { id: 'ADMIN', status: 'active' }
    req.isAdmin = true
    req.authMethod = req.headers['x-auth-method'] ?? 'session'
    req.apiKeyScopes = [{ collection: 'scim', actions: ['*'] }]
  }),
  requireAuth: vi.fn(async () => undefined),
  requireAdmin: vi.fn(async (req: Record<string, any>) => {
    req.user = { id: 'ADMIN', status: 'active' }
    req.isAdmin = true
    req.authMethod = 'session'
  })
}))
// The identity provider answers for the service account (OIDC and SAML alike).
vi.mock('../auth/oidc.js', async (orig) => ({
  ...(await orig<typeof import('../auth/oidc.js')>()),
  oidcConfigured: () => true,
  handleCallback: async () => ({ sub: 'sub-svc', email: 'hub-smoke-ab12cd34@nivaro.local' })
}))
vi.mock('../auth/saml.js', async (orig) => ({
  ...(await orig<typeof import('../auth/saml.js')>()),
  samlEnabled: () => true,
  getSaml: () => ({
    validatePostResponseAsync: async () => ({ profile: { ID: 'a1' }, loggedOut: false })
  }),
  consumeAssertionId: async () => true,
  extractSamlIdentity: () => ({ sub: 'sub-svc', email: 'hub-smoke-ab12cd34@nivaro.local' })
}))
vi.mock('../services/users.js', async (orig) => ({
  ...(await orig<typeof import('../services/users.js')>()),
  findOrCreateFromOIDC: async () => state.user
}))

import { isServiceAccount, roleAllowsSignIn, signInAllowedByRole } from '../auth/role-sign-in.js'
import { sessionPrincipal } from '../middleware/authenticate.js'
import { authRoutes } from './auth.js'
import { scimRoutes } from './scim.js'

const hashed = (p: string) => {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(p, salt, 64).toString('hex')}`
}

function fakeSession(init: Record<string, unknown> = {}) {
  const s: Record<string, unknown> & { sessionId: string; destroyed: boolean } = {
    ...init,
    sessionId: 'sid-original',
    destroyed: false,
    async regenerate() {
      s.sessionId = 'sid-new'
    },
    async destroy() {
      s.destroyed = true
    }
  }
  return s
}

const SERVICE = {
  id: 'SVC-1',
  email: 'hub-smoke-ab12cd34@nivaro.local',
  status: 'active',
  account_kind: 'service',
  role: null,
  static_token: 'svc-static-token-123',
  password_hash: hashed('right-password')
}

async function build(session = fakeSession()) {
  const app = Fastify({ logger: false })
  const kv = new Map<string, string>()
  app.decorate('redis', {
    get: async (k: string) => kv.get(k) ?? null,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    incr: async () => 1,
    ttl: async () => -1,
    expire: async () => 1,
    del: async () => 1,
    set: async (k: string, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    setex: async (k: string, _s: number, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    multi: () => {
      const m = { del: () => m, setex: () => m, exec: async () => [] }
      return m
    }
  } as never)
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: unknown }).session = session
  })
  await app.register(authRoutes)
  await app.register(scimRoutes, { prefix: '/scim' })
  await app.ready()
  return { app, session }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url,
  headers: { 'content-type': 'application/json', ...headers },
  payload: JSON.stringify(body)
})

beforeEach(() => {
  state.user = { ...SERVICE }
  delete process.env.AUTH_SETUP
})
afterEach(() => vi.clearAllMocks())

describe('a service account never signs in', () => {
  it('the gate: service accounts refused, other machine accounts and people as before', async () => {
    expect(isServiceAccount({ account_kind: 'service' })).toBe(true)
    expect(isServiceAccount({ account_kind: 'integration' })).toBe(false)
    expect(await signInAllowedByRole({ role: null, account_kind: 'service' })).toBe(false)
    expect(await signInAllowedByRole({ role: null, account_kind: null })).toBe(true)
    // Its own API key still authenticates (the role gate lets machine accounts through).
    expect(roleAllowsSignIn({ app_access: false }, { account_kind: 'service' })).toBe(true)
  })

  it('not with a password', async () => {
    const { app, session } = await build()
    const r = await app.inject(
      post('/login/password', { email: SERVICE.email, password: 'right-password' })
    )
    expect(r.statusCode).toBe(403)
    expect(session.userId).toBeUndefined()
  })

  it('not with its static token, and no password setup through it', async () => {
    const { app, session } = await build()
    const r = await app.inject(post('/login/token', { token: SERVICE.static_token }))
    expect(r.statusCode).toBe(403)
    expect(session.userId).toBeUndefined()
    process.env.AUTH_SETUP = 'on'
    state.user = { ...SERVICE, password_hash: null }
    const setup = await app.inject(
      post('/setup', { token: SERVICE.static_token, password: 'longenough' })
    )
    expect(setup.statusCode).toBe(403)
  })

  it('not through the identity provider (OIDC) or SAML', async () => {
    const oidcSession = fakeSession({ oidcState: 's', codeVerifier: 'v' })
    const { app: oidc } = await build(oidcSession)
    const r = await oidc.inject({ method: 'GET', url: '/callback?code=c&state=s' })
    expect(r.statusCode).toBe(302)
    expect(r.headers.location).toContain('sign_in_disabled')
    expect(oidcSession.userId).toBeUndefined()

    const samlSession = fakeSession()
    const { app: saml } = await build(samlSession)
    const s = await saml.inject({
      method: 'POST',
      url: '/saml/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'SAMLResponse=x'
    })
    expect(s.statusCode).toBe(302)
    expect(s.headers.location).toContain('sign_in_disabled')
    expect(samlSession.userId).toBeUndefined()
  })

  it('never viewed as', async () => {
    const { app } = await build()
    const r = await app.inject(post('/masquerade', { user_id: SERVICE.id }))
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('SERVICE_ACCOUNT')
  })

  it('a session naming it is ended', async () => {
    const session = fakeSession({ userId: SERVICE.id })
    const out = await sessionPrincipal({ session } as never)
    expect(out).toEqual({ ok: false, code: 'ACCOUNT_NOT_ACTIVE' })
    expect(session.destroyed).toBe(true)
  })

  it('SCIM cannot activate, change or remove it', async () => {
    const { app } = await build()
    const auth = { authorization: 'Bearer nvk_scimkey' }
    for (const [method, payload] of [
      ['PATCH', { active: true }],
      ['DELETE', undefined]
    ] as const) {
      const r = await app.inject({
        method,
        url: `/scim/Users/${SERVICE.id}`,
        headers: payload ? { ...auth, 'content-type': 'application/json' } : auth,
        ...(payload ? { payload: JSON.stringify(payload) } : {})
      })
      expect([method, r.statusCode]).toEqual([method, 409])
    }
  })
})
