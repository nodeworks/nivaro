import Fastify, { type FastifyInstance } from 'fastify'
import {
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT
} from 'jose'
import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7, Task 6: routes/auth.ts branches for signing in through the Hub —
// /providers, /login (Hub up / down / direct=1), /callback (the same tail as direct sign-in,
// availability fallback once, security failures filed), /totp, /logout. A fake Hub + fake Entra
// key set on one loopback Fastify; the app's users table is SQLite in memory.

const TID = '11111111-2222-3333-4444-555555555555'
const OID = '99999999-8888-7777-6666-555555555555'
const h = vi.hoisted(() => ({
  entraIssuer: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
  entraJwksUri: '',
  roleAllows: true,
  totpValid: true,
  directProfile: null as null | Record<string, unknown>,
  dynamicProfile: null as null | Record<string, unknown>
}))

vi.hoisted(() => {
  process.env.NODE_ENV = 'test'
  process.env.OIDC_ISSUER =
    'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0'
  process.env.OIDC_CLIENT_ID = 'app-entra-client'
  process.env.HUB_CLIENT_ID = 'hubc_0123456789abcdef01234567'
  process.env.HUB_CLIENT_SECRET = `hubs_${'s'.repeat(43)}`
  process.env.HUB_IDP_AUDIENCE = 'hub-entra-client'
  delete process.env.HUB
  delete process.env.HUB_SIGNIN
  delete process.env.CLOUD_META_DB_URL
})

vi.mock('../../../config.js', () => ({
  config: {
    ADMIN_URL: 'http://localhost:3056',
    PUBLIC_URL: 'http://localhost:3055',
    APP_URLS: '',
    SESSION_TTL: 3600,
    SESSION_SECRET: 'auth-hub-signin-test-secret-0123456789abcdef',
    OIDC_ENABLED: true,
    OIDC_ISSUER: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
    OIDC_CLIENT_ID: 'app-entra-client'
  }
}))
vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
vi.mock('../../../auth/oidc.js', async (orig) => ({
  ...(await orig<typeof import('../../../auth/oidc.js')>()),
  oidcConfigured: () => true,
  getOIDCConfig: async () => ({
    serverMetadata: () => ({ issuer: h.entraIssuer, jwks_uri: h.entraJwksUri })
  }),
  buildLoginUrl: async (state: string) =>
    new URL(
      `https://login.microsoftonline.com/${TID}/oauth2/v2.0/authorize?state=${encodeURIComponent(state)}`
    ),
  handleCallback: async () => {
    if (!h.directProfile) throw new Error('no direct profile')
    return h.directProfile
  },
  buildDynamicLoginUrl: async (_p: unknown, state: string) =>
    new URL(`https://okta.example.com/authorize?state=${encodeURIComponent(state)}`),
  handleDynamicCallback: async () => {
    if (!h.dynamicProfile) throw new Error('no provider profile')
    return h.dynamicProfile
  }
}))
vi.mock('../../../auth/role-sign-in.js', () => ({
  signInAllowedByRole: vi.fn(async () => h.roleAllows)
}))
vi.mock('otplib', () => ({ verify: vi.fn(async () => ({ valid: h.totpValid })) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/security.js', () => ({ recordLogin: vi.fn(async () => undefined) }))
vi.mock('../../../services/sign-in-troubleshooter.js', () => ({
  noteSignInApp: vi.fn(async () => undefined),
  noteSignInFailure: vi.fn(async () => undefined),
  matchAttemptedIdentity: vi.fn(async () => null)
}))
vi.mock('../../../services/microsoft.js', () => ({ resolveRoleFromAdGroups: async () => null }))
vi.mock('../../../services/hub-signin/link-client.js', () => ({
  pushSignInEvent: vi.fn(async () => undefined)
}))
vi.mock('../../../services/people-live.js', () => ({
  notePeopleChanged: vi.fn(),
  signInChangedDirectory: () => false
}))
vi.mock('../../../services/error-tracking.js', () => ({
  trackError: vi.fn(async () => undefined),
  stableIssueKey: (...parts: string[]) => parts.join('|'),
  normalizeIssueText: (s: string) => s
}))
vi.mock('../../../middleware/authenticate.js', async (orig) => ({
  ...(await orig<typeof import('../../../middleware/authenticate.js')>()),
  authenticate: vi.fn(async (req: Record<string, any>) => {
    const uid = req.session?.userId
    if (!uid) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id: uid, status: 'active' }
    req.isAdmin = false
  })
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { authRoutes } = await import('../../../routes/auth.js')
const { _resetHubProbeForTests } = await import('../../../services/hub-signin/probe.js')
const { _resetHubSigninForTests } = await import('../../../auth/hub-signin.js')
const { trackError } = (await import('../../../services/error-tracking.js')) as unknown as {
  trackError: ReturnType<typeof vi.fn>
}
const { noteSignInFailure } = (await import(
  '../../../services/sign-in-troubleshooter.js'
)) as unknown as { noteSignInFailure: ReturnType<typeof vi.fn> }
const { namespacedSub } = await import('../../../services/users.js')
const { pushSignInEvent } = (await import(
  '../../../services/hub-signin/link-client.js'
)) as unknown as { pushSignInEvent: ReturnType<typeof vi.fn> }

const CLIENT = 'hubc_0123456789abcdef01234567'
const SECRET = `hubs_${'s'.repeat(43)}`
const IDP_AUD = 'hub-entra-client'
const STATE = 'state-0123456789'
const NONCE = 'nonce-abcdefghijklmnopqrstuvwxyz0123456789'
const VERIFIER = 'v'.repeat(50)
const HUB_USER = 'AAAAAAAA-0000-4000-8000-000000000001'
const SID = 'e'.repeat(64)
const RETURN_TO = 'http://localhost:3056/records/7'

// ─── Fake Hub + fake Entra ───────────────────────────────────────────────────

let fakeServer: FastifyInstance
let base = ''
let issuer = ''
const keys = {} as Record<'hub' | 'entra' | 'evil', { kid: string; priv: CryptoKey; pub: JWK }>
const hub = {
  ping: { ok: true } as unknown,
  pingHits: 0,
  pingQueries: [] as Array<Record<string, string>>,
  registered: ['http://localhost:3056', 'http://localhost:3055'],
  discoveryHits: 0,
  discoveryStatus: 200,
  tokenHits: 0,
  tokenEndpoint: '',
  token: async (): Promise<{ status: number; body: unknown }> => ({ status: 500, body: {} })
}

async function pair(alg: 'ES256' | 'RS256', kid: string) {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true })
  return { kid, priv: privateKey, pub: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } }
}

beforeAll(async () => {
  keys.hub = await pair('ES256', 'hub-k1')
  keys.entra = await pair('RS256', 'entra-k1')
  keys.evil = await pair('RS256', 'evil-k1')
  fakeServer = Fastify()
  fakeServer.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body))))
  )
  fakeServer.get('/api/hub/oidc/ping', async (req) => {
    hub.pingHits++
    hub.pingQueries.push(req.query as Record<string, string>)
    // Ruling P7-17: like the Hub, refuse addresses of an origin it has not registered.
    const q = req.query as Record<string, string | undefined>
    for (const uri of [q.redirect_uri, q.post_logout_redirect_uri])
      if (uri && !hub.registered.some((o) => uri.startsWith(`${o}/`)))
        return { ok: false, reason: 'REDIRECT_NOT_REGISTERED' }
    return hub.ping
  })
  fakeServer.get('/api/hub/oidc/.well-known/openid-configuration', async (_req, reply) => {
    hub.discoveryHits++
    if (hub.discoveryStatus !== 200) return reply.code(hub.discoveryStatus).send({})
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: hub.tokenEndpoint || `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      authorization_response_iss_parameter_supported: true
    }
  })
  fakeServer.get('/api/hub/oidc/jwks', async () => ({ keys: [keys.hub.pub] }))
  fakeServer.post('/api/hub/oidc/token', async (_req, reply) => {
    hub.tokenHits++
    const { status, body } = await hub.token()
    return reply.code(status).send(body)
  })
  fakeServer.get('/entra/keys', async () => ({ keys: [keys.entra.pub] }))
  await fakeServer.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(fakeServer.server.address() as { port: number }).port}`
  issuer = `${base}/api/hub/oidc`
  h.entraJwksUri = `${base}/entra/keys`
  process.env.HUB_URL = base

  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('email')
    t.string('external_id')
    t.string('entra_oid')
    t.string('entra_tid')
    t.string('status')
    t.boolean('is_redacted')
    t.string('first_name')
    t.string('last_name')
    t.string('role')
    t.boolean('totp_enabled')
    t.string('totp_secret')
    t.datetime('last_access')
    t.datetime('updated_at')
    t.string('static_token')
  })
  await db.schema.createTable('nivaro_sso_providers', (t) => {
    t.increments('id')
    t.string('key')
    t.string('label')
    t.string('issuer')
    t.string('client_id')
    t.string('client_secret')
    t.string('scopes')
    t.string('logo_url')
    t.string('button_color')
    t.integer('sort')
    t.boolean('is_active')
  })
  await db('nivaro_sso_providers').insert({
    key: 'okta',
    label: 'Okta',
    issuer: 'https://okta.example.com',
    client_id: 'okta-client',
    sort: 1,
    is_active: true
  })
  await db.schema.createTable('nivaro_settings', (t) => {
    t.increments('id')
    t.boolean('oidc_primary_disabled')
  })
  await db('nivaro_settings').insert({ oidc_primary_disabled: false })
})

afterAll(async () => {
  await fakeServer.close()
  await db.destroy()
})

beforeEach(async () => {
  _resetHubProbeForTests()
  _resetHubSigninForTests()
  hub.ping = { ok: true }
  hub.pingHits = 0
  hub.pingQueries = []
  hub.registered = ['http://localhost:3056', 'http://localhost:3055']
  hub.discoveryHits = 0
  hub.discoveryStatus = 200
  hub.tokenHits = 0
  hub.tokenEndpoint = ''
  h.roleAllows = true
  h.totpValid = true
  h.directProfile = null
  h.dynamicProfile = null
  process.env.HUB_URL = base
  delete process.env.HUB_SIGNIN
  await db('nivaro_users').del()
})
afterEach(() => vi.clearAllMocks())

// ─── App harness ─────────────────────────────────────────────────────────────

function memRedis() {
  const kv = new Map<string, string>()
  const r = {
    kv,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    get: async (k: string) => kv.get(k) ?? null,
    incr: async (k: string) => {
      const n = Number(kv.get(k) ?? 0) + 1
      kv.set(k, String(n))
      return n
    },
    ttl: async (k: string) => (kv.has(k) ? -1 : -2),
    expire: async () => 1,
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

type Sess = Record<string, any> & {
  sessionId: string
  regenerate: (keys?: string[]) => Promise<void>
  destroy: () => Promise<void>
}

function fakeSession(init: Record<string, unknown> = {}): Sess {
  let n = 0
  const s = {
    ...init,
    sessionId: 'sid-original',
    async regenerate(keep: string[] = []) {
      const kept = Object.fromEntries(keep.map((k) => [k, s[k]]))
      for (const k of Object.keys(s)) if (!['regenerate', 'destroy'].includes(k)) delete s[k]
      Object.assign(s, kept, { sessionId: `sid-new-${++n}` })
    },
    async destroy() {
      for (const k of Object.keys(s)) if (!['regenerate', 'destroy'].includes(k)) delete s[k]
    }
  } as Sess
  return s
}

async function build(session: Sess) {
  const app = Fastify({ logger: false })
  app.decorate('redis', memRedis() as never)
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: Sess }).session = session
  })
  await app.register(authRoutes)
  await app.ready()
  return app
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

async function evidence(
  over: Record<string, unknown> = {},
  opts: { key?: { kid: string; priv: CryptoKey }; iss?: string; aud?: string; exp?: number } = {}
) {
  const k = opts.key ?? keys.entra
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    oid: OID,
    tid: TID,
    email: 'ana@example.com',
    given_name: 'Ana',
    family_name: 'Lima',
    name: 'Ana Lima',
    ...over
  })
    .setProtectedHeader({ alg: 'RS256', kid: k.kid, typ: 'JWT' })
    .setIssuer(opts.iss ?? h.entraIssuer)
    .setAudience(opts.aud ?? IDP_AUD)
    .setSubject('entra-pairwise-sub')
    .setIssuedAt(now - 60)
    .setExpirationTime(opts.exp ?? now + 3600)
    .sign(k.priv)
}

async function hubToken(over: Record<string, unknown> = {}) {
  const claims: JWTPayload = {
    auth_time: Math.floor(Date.now() / 1000) - 60,
    nonce: NONCE,
    sid: SID,
    oid: OID,
    tid: TID,
    idp_id_token: await evidence(),
    ...over
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: keys.hub.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(CLIENT)
    .setSubject(HUB_USER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.hub.priv)
}

function answer(idToken: string) {
  hub.token = async () => ({
    status: 200,
    body: { access_token: 'nvh_x', token_type: 'Bearer', expires_in: 300, id_token: idToken }
  })
}

const hubSession = (extra: Record<string, unknown> = {}) =>
  fakeSession({
    hubSignIn: true,
    hubNonce: NONCE,
    oidcState: STATE,
    codeVerifier: VERIFIER,
    oidcRedirectUri: 'http://localhost:3056/api/auth/callback',
    returnTo: RETURN_TO,
    ...extra
  })

const directSession = () =>
  fakeSession({
    oidcState: STATE,
    codeVerifier: VERIFIER,
    oidcRedirectUri: 'http://localhost:3056/api/auth/callback',
    returnTo: RETURN_TO
  })

function cbUrl(extra: Record<string, string> = { code: 'code-1' }) {
  const q = new URLSearchParams({ ...extra, state: STATE, iss: issuer })
  return `/callback?${q.toString()}`
}

async function seedUser(over: Record<string, unknown> = {}) {
  await db('nivaro_users').insert({
    id: 'u1',
    email: 'ana.old@example.com',
    external_id: 'primary-entra-sub',
    entra_oid: OID,
    entra_tid: TID,
    status: 'active',
    is_redacted: false,
    first_name: 'Old',
    last_name: 'Name',
    totp_enabled: false,
    totp_secret: null,
    ...over
  })
}

const PATHS = ['hub', 'direct'] as const
type Path = (typeof PATHS)[number]

async function signInVia(path: Path) {
  if (path === 'hub') {
    answer(await hubToken())
    const session = hubSession()
    const app = await build(session)
    return { session, app, res: await app.inject({ method: 'GET', url: cbUrl() }) }
  }
  h.directProfile = {
    sub: 'primary-entra-sub',
    email: 'ana@example.com',
    name: 'Ana Lima',
    given_name: 'Ana',
    family_name: 'Lima',
    groups: [],
    entraOid: OID,
    entraTid: TID,
    tokens: {}
  }
  const session = directSession()
  const app = await build(session)
  return { session, app, res: await app.inject({ method: 'GET', url: cbUrl() }) }
}

// ─── /providers ──────────────────────────────────────────────────────────────

describe('GET /providers', () => {
  it('says whether Hub sign-in is configured and up', async () => {
    const app = await build(fakeSession())
    const res = await app.inject({ method: 'GET', url: '/providers' })
    expect(res.json().data.hub).toEqual({ configured: true, up: true })
  })

  it('up:false when the Hub answers anything but { ok: true }', async () => {
    hub.ping = { ok: false }
    const app = await build(fakeSession())
    const res = await app.inject({ method: 'GET', url: '/providers' })
    expect(res.json().data.hub).toEqual({ configured: true, up: false })
  })

  it('configured:false when the primary sign-in is turned off (the evidence needs it)', async () => {
    await db('nivaro_settings').update({ oidc_primary_disabled: true })
    try {
      const app = await build(fakeSession())
      const res = await app.inject({ method: 'GET', url: '/providers' })
      expect(res.json().data.oidc.enabled).toBe(false)
      expect(res.json().data.hub).toEqual({ configured: false, up: false })
      expect(hub.pingHits).toBe(0)
    } finally {
      await db('nivaro_settings').update({ oidc_primary_disabled: false })
    }
  })

  it('configured:false, up:false when not configured — the Hub is never asked', async () => {
    process.env.HUB_SIGNIN = 'off'
    const app = await build(fakeSession())
    const res = await app.inject({ method: 'GET', url: '/providers' })
    expect(res.json().data.hub).toEqual({ configured: false, up: false })
    expect(hub.pingHits).toBe(0)
  })
})

// ─── /login ──────────────────────────────────────────────────────────────────

describe('GET /login', () => {
  it('Hub up → the Hub authorize URL, with this session’s state and a fresh nonce', async () => {
    const session = fakeSession()
    const app = await build(session)
    const res = await app.inject({
      method: 'GET',
      url: `/login?returnTo=${encodeURIComponent(RETURN_TO)}`
    })
    expect(res.statusCode).toBe(302)
    const to = new URL(res.headers.location as string)
    expect(`${to.origin}${to.pathname}`).toBe(`${issuer}/authorize`)
    expect(to.searchParams.get('client_id')).toBe(CLIENT)
    expect(to.searchParams.get('redirect_uri')).toBe('http://localhost:3056/api/auth/callback')
    expect(to.searchParams.get('state')).toBe(session.oidcState)
    expect(to.searchParams.get('nonce')).toBe(session.hubNonce)
    expect(session.hubSignIn).toBe(true)
    expect(session.hubNonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.codeVerifier).toBeTruthy()
    expect(res.headers.location).not.toContain(SECRET)
  })

  it('the probe names the addresses of the origin the sign-in starts on (P7-17)', async () => {
    const app = await build(fakeSession())
    await app.inject({ method: 'GET', url: `/login?returnTo=${encodeURIComponent(RETURN_TO)}` })
    expect(hub.pingQueries.at(-1)).toMatchObject({
      client_id: CLIENT,
      redirect_uri: 'http://localhost:3056/api/auth/callback',
      post_logout_redirect_uri: 'http://localhost:3056/login'
    })
  })

  it('an origin the Hub has not registered signs in directly; a registered one still uses the Hub (P7-17)', async () => {
    hub.registered = ['http://localhost:3056']
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = fakeSession()
    const app = await build(session)
    const other = await app.inject({
      method: 'GET',
      url: `/login?returnTo=${encodeURIComponent('http://localhost:3055/x')}`
    })
    expect(other.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//)
    expect(session.hubSignIn).toBeUndefined()
    expect(hub.discoveryHits).toBe(0)
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('REDIRECT_NOT_REGISTERED')
    const known = await app.inject({
      method: 'GET',
      url: `/login?returnTo=${encodeURIComponent(RETURN_TO)}`
    })
    expect(known.headers.location).toContain(`${issuer}/authorize`)
    expect(session.hubSignIn).toBe(true)
    // /providers judges the origin the page is on.
    const page = (origin: string) =>
      app.inject({ method: 'GET', url: '/providers', headers: { referer: `${origin}/login` } })
    expect((await page('http://localhost:3056')).json().data.hub.up).toBe(true)
    expect((await page('http://localhost:3055')).json().data.hub.up).toBe(false)
  })

  it('Hub down → the primary Entra authorize URL in the same response', async () => {
    hub.ping = '<html>captive portal</html>'
    const session = fakeSession()
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: '/login' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//)
    expect(session.hubSignIn).toBeUndefined()
    expect(hub.discoveryHits).toBe(0)
  })

  it('Hub up but discovery failing → direct in the same response, then down for 60 s', async () => {
    hub.discoveryStatus = 500
    const app = await build(fakeSession())
    const res = await app.inject({ method: 'GET', url: '/login' })
    expect(res.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//)
    const pings = hub.pingHits
    const again = await app.inject({ method: 'GET', url: '/login' })
    expect(again.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//)
    expect(hub.pingHits).toBe(pings)
  })

  it('?direct=1 with the Hub up never touches the Hub', async () => {
    const session = fakeSession({ hubSignIn: true, hubNonce: 'stale' })
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: '/login?direct=1' })
    expect(res.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//)
    expect(hub.pingHits).toBe(0)
    expect(hub.discoveryHits).toBe(0)
    // A stale Hub attempt in this session no longer steers the callback.
    expect(session.hubSignIn).toBeUndefined()
    expect(session.hubNonce).toBeUndefined()
  })

  it('a new attempt (/login without direct=1) clears the one-hop guard; ?direct=1 keeps it', async () => {
    const session = fakeSession({ hubFellBack: true })
    const app = await build(session)
    await app.inject({ method: 'GET', url: '/login?direct=1' })
    expect(session.hubFellBack).toBe(true)
    await app.inject({ method: 'GET', url: '/login' })
    expect(session.hubFellBack).toBeUndefined()
  })

  it('a provider sign-in (?provider=) never goes to the Hub', async () => {
    const app = await build(fakeSession())
    const res = await app.inject({ method: 'GET', url: '/login?provider=no-such-provider' })
    expect(res.headers.location).toMatch(/error=provider_unavailable/)
    expect(hub.pingHits).toBe(0)
  })
})

// ─── /callback: success and linking ─────────────────────────────────────────

describe('sign-in reports (Task 7)', () => {
  it('a static-token sign-in is never reported to the Hub', async () => {
    await seedUser({ static_token: 'static-token-0123456789' })
    pushSignInEvent.mockClear()
    const session = fakeSession()
    const app = await build(session)
    const res = await app.inject({
      method: 'POST',
      url: '/login/token',
      payload: { token: 'static-token-0123456789' }
    })
    expect(res.statusCode).toBe(200)
    expect(session.userId).toBe('u1')
    expect(pushSignInEvent).not.toHaveBeenCalled()
  })
})

describe('GET /callback through the Hub', () => {
  it('valid tokens sign in and link the account holding the same entra_oid (subject kept)', async () => {
    await seedUser()
    pushSignInEvent.mockClear()
    answer(await hubToken())
    const session = hubSession()
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: cbUrl() })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(RETURN_TO)
    expect(session.userId).toBe('u1')
    expect(session.signedInVia).toBe('hub')
    expect(session.hubSid).toBe(SID)
    expect(session.sessionId).not.toBe('sid-original')
    for (const k of ['hubSignIn', 'hubNonce', 'hubFellBack', 'oidcState', 'codeVerifier'])
      expect(session[k]).toBeUndefined()
    // Task 7 fix round 1: a Hub sign-in is not reported back; the Hub recorded it itself.
    expect(pushSignInEvent).not.toHaveBeenCalled()
    const row = await db('nivaro_users').where({ id: 'u1' }).first()
    expect(row.external_id).toBe('primary-entra-sub')
    // Names come from the evidence.
    expect(row.first_name).toBe('Ana')
    expect(trackError).not.toHaveBeenCalled()
  })

  it('an account matching only by email → ONE hop to direct, Hub not marked down (P7-10)', async () => {
    await seedUser({ email: 'ana@example.com', entra_oid: null, entra_tid: null })
    answer(await hubToken())
    const session = hubSession()
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: cbUrl() })
    expect(res.headers.location).toBe(
      `/api/auth/login?direct=1&returnTo=${encodeURIComponent(RETURN_TO)}`
    )
    expect(session.userId).toBeUndefined()
    expect(session.hubFellBack).toBe(true)
    expect(trackError).not.toHaveBeenCalled()
    expect(noteSignInFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: 'account_link', code: 'HUB_NEEDS_DIRECT', userId: 'u1' })
    )
    // The Hub is still up: a plain /login goes to it (a new attempt: the guard is cleared).
    const login = await app.inject({ method: 'GET', url: '/login' })
    expect(login.headers.location).toContain(`${issuer}/authorize`)
    expect(session.hubFellBack).toBeUndefined()

    // The same again in an attempt that already fell back: stops at account_link.
    Object.assign(session, {
      hubFellBack: true,
      hubSignIn: true,
      hubNonce: NONCE,
      oidcState: STATE,
      codeVerifier: VERIFIER,
      returnTo: RETURN_TO
    })
    const again = await app.inject({ method: 'GET', url: cbUrl() })
    expect(again.headers.location).toBe('http://localhost:3056/login?error=account_link')
    expect(session.userId).toBeUndefined()
  })

  it('the oid holder names another tenant → hub_account_conflict + a medium issue', async () => {
    await seedUser({ entra_tid: '00000000-0000-0000-0000-000000000000' })
    answer(await hubToken())
    const session = hubSession()
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: cbUrl() })
    expect(res.headers.location).toBe('http://localhost:3056/login?error=hub_account_conflict')
    expect(session.userId).toBeUndefined()
    expect(session.hubFellBack).toBeUndefined()
    expect(trackError).toHaveBeenCalledTimes(1)
    expect(trackError.mock.calls[0][0]).toMatchObject({
      severity: 'medium',
      fingerprint: 'hub-signin|ACCOUNT_CONFLICT'
    })
  })

  it('the Hub subject held by another account → hub_account_conflict + a medium issue', async () => {
    await seedUser({
      id: 'u9',
      email: 'someone@example.com',
      external_id: namespacedSub(issuer, HUB_USER),
      entra_oid: 'aaaaaaaa-0000-0000-0000-000000000000'
    })
    answer(await hubToken())
    const session = hubSession()
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: cbUrl() })
    expect(res.headers.location).toBe('http://localhost:3056/login?error=hub_account_conflict')
    expect(session.userId).toBeUndefined()
    expect(trackError).toHaveBeenCalledTimes(1)
    expect(trackError.mock.calls[0][0]).toMatchObject({ severity: 'medium' })
  })

  const refusals: Array<[string, () => Promise<Record<string, unknown>>, string]> = [
    ['evidence missing', async () => ({ idp_id_token: undefined }), 'EVIDENCE_MISSING'],
    [
      'evidence signed by another key',
      async () => ({ idp_id_token: await evidence({}, { key: keys.evil }) }),
      'EVIDENCE_INVALID'
    ],
    [
      'evidence for another Entra client',
      async () => ({ idp_id_token: await evidence({}, { aud: 'other-entra-app' }) }),
      'EVIDENCE_INVALID'
    ],
    [
      'evidence from another tenant',
      async () => ({
        idp_id_token: await evidence(
          {},
          { iss: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0' }
        )
      }),
      'EVIDENCE_INVALID'
    ],
    [
      'evidence expired',
      async () => ({
        idp_id_token: await evidence({}, { exp: Math.floor(Date.now() / 1000) - 300 })
      }),
      'EVIDENCE_INVALID'
    ],
    [
      'evidence naming another person (oid differs)',
      async () => ({
        idp_id_token: await evidence({ oid: 'aaaaaaaa-0000-0000-0000-000000000000' })
      }),
      'EVIDENCE_MISMATCH'
    ],
    ['wrong nonce', async () => ({ nonce: 'another-nonce-000000000000' }), 'TOKEN_INVALID']
  ]

  for (const [name, over, code] of refusals) {
    it(`${name} → hub_auth_failed, NO session, one issue (${code})`, async () => {
      await seedUser()
      answer(await hubToken(await over()))
      const session = hubSession()
      const app = await build(session)
      const res = await app.inject({ method: 'GET', url: cbUrl() })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('http://localhost:3056/login?error=hub_auth_failed')
      expect(session.userId).toBeUndefined()
      expect(session.pendingTotpUserId).toBeUndefined()
      expect(session.signedInVia).toBeUndefined()
      expect(session.hubFellBack).toBeUndefined()
      expect(session.hubSignIn).toBeUndefined()
      expect(trackError).toHaveBeenCalledTimes(1)
      const issue = trackError.mock.calls[0][0] as Record<string, unknown>
      expect(issue.severity).toBe('high')
      expect(issue.fingerprint).toBe(`hub-signin|${code}`)
      // No token text in the issue.
      expect(JSON.stringify(issue)).not.toMatch(/eyJ/)
      // The sign-in troubleshooter hears of it, as on the direct path.
      expect(noteSignInFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ reason: 'auth_failed', method: 'oidc', code })
      )
    })
  }

  it('the Hub refusing a pending account (access_denied) → hub_access_denied, no fallback, no issue', async () => {
    const session = hubSession()
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: cbUrl({ error: 'access_denied' }) })
    expect(res.headers.location).toBe('http://localhost:3056/login?error=hub_access_denied')
    expect(session.hubFellBack).toBeUndefined()
    expect(session.userId).toBeUndefined()
    expect(trackError).not.toHaveBeenCalled()
    expect(noteSignInFailure).toHaveBeenCalledTimes(1)
  })

  it('invalid_grant at the token endpoint → hub_auth_failed, a MEDIUM issue', async () => {
    hub.token = async () => ({ status: 400, body: { error: 'invalid_grant' } })
    const session = hubSession()
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: cbUrl() })
    expect(res.headers.location).toBe('http://localhost:3056/login?error=hub_auth_failed')
    expect(trackError).toHaveBeenCalledTimes(1)
    expect(trackError.mock.calls[0][0]).toMatchObject({
      severity: 'medium',
      fingerprint: 'hub-signin|HUB_REFUSED'
    })
  })
})

// ─── A stale Hub attempt never steers a provider sign-in ─────────────────────

describe('stale hubSignIn and ?provider=', () => {
  const providerSub = () => namespacedSub('https://okta.example.com', 'okta-sub')

  beforeEach(async () => {
    await seedUser({
      id: 'u2',
      email: 'bo@example.com',
      external_id: providerSub(),
      entra_oid: null
    })
    h.dynamicProfile = {
      sub: 'okta-sub',
      email: 'bo@example.com',
      name: 'Bo',
      given_name: 'Bo',
      family_name: null,
      groups: [],
      entraOid: null,
      entraTid: null,
      tokens: {}
    }
  })

  it('Hub /login → ?provider= /login → the provider callback signs in through the provider', async () => {
    const session = fakeSession()
    const app = await build(session)
    const viaHub = await app.inject({ method: 'GET', url: '/login' })
    expect(viaHub.headers.location).toContain(`${issuer}/authorize`)
    expect(session.hubSignIn).toBe(true)

    const viaOkta = await app.inject({ method: 'GET', url: '/login?provider=okta' })
    expect(viaOkta.headers.location).toMatch(/^https:\/\/okta\.example\.com\/authorize/)
    expect(session.hubSignIn).toBeUndefined()
    expect(session.hubNonce).toBeUndefined()

    const tokenHits = hub.tokenHits
    const cb = await app.inject({
      method: 'GET',
      url: `/callback?code=c&state=${encodeURIComponent(session.oidcState)}`
    })
    expect(cb.headers.location).toBe('http://localhost:3056/')
    expect(session.userId).toBe('u2')
    expect(session.signedInVia).toBeUndefined()
    expect(hub.tokenHits).toBe(tokenHits)
    expect(trackError).not.toHaveBeenCalled()
  })

  it('a provider callback with a stale hubSignIn flag still goes through the provider', async () => {
    const session = fakeSession({
      hubSignIn: true,
      hubNonce: NONCE,
      oidcProviderId: 1,
      oidcState: STATE,
      codeVerifier: VERIFIER,
      returnTo: RETURN_TO
    })
    const app = await build(session)
    const cb = await app.inject({ method: 'GET', url: `/callback?code=c&state=${STATE}` })
    expect(cb.headers.location).toBe(RETURN_TO)
    expect(session.userId).toBe('u2')
    expect(trackError).not.toHaveBeenCalled()
  })
})

// ─── /callback: availability fallback ────────────────────────────────────────

describe('GET /callback with the Hub unavailable', () => {
  it('unreachable at token exchange → one hop to ?direct=1; a second failure → hub_unavailable', async () => {
    hub.tokenEndpoint = 'http://127.0.0.1:9/token'
    const session = hubSession()
    const app = await build(session)
    const first = await app.inject({ method: 'GET', url: cbUrl() })
    expect(first.statusCode).toBe(302)
    expect(first.headers.location).toBe(
      `/api/auth/login?direct=1&returnTo=${encodeURIComponent(RETURN_TO)}`
    )
    expect(session.hubFellBack).toBe(true)
    expect(session.userId).toBeUndefined()
    expect(trackError).not.toHaveBeenCalled()

    // The hop itself (?direct=1) keeps the one-hop guard.
    await app.inject({ method: 'GET', url: '/login?direct=1' })
    expect(session.hubFellBack).toBe(true)

    // The Hub is now marked down: a plain /login goes direct without asking it, and as a new
    // attempt it clears the guard.
    const pings = hub.pingHits
    const login = await app.inject({ method: 'GET', url: '/login' })
    expect(login.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//)
    expect(hub.pingHits).toBe(pings)
    expect(session.hubFellBack).toBeUndefined()

    // Another availability failure in the same attempt (after its hop): no second hop.
    Object.assign(session, {
      hubFellBack: true,
      hubSignIn: true,
      hubNonce: NONCE,
      oidcState: STATE,
      codeVerifier: VERIFIER,
      returnTo: RETURN_TO
    })
    const second = await app.inject({ method: 'GET', url: cbUrl({ error: 'server_error' }) })
    expect(second.headers.location).toBe('http://localhost:3056/login?error=hub_unavailable')
    expect(session.userId).toBeUndefined()
  })

  it.each([
    [
      '429 from the Hub limiter',
      429,
      { statusCode: 429, error: 'Too Many Requests', code: 'RATE_LIMITED', retry_after: 9 }
    ],
    ['429 from the failed-client brake', 429, { error: 'invalid_client' }],
    ['503', 503, { error: 'temporarily_unavailable' }]
  ])('token endpoint answering %s → one hop to direct, no issue filed (P7-15)', async (_why, status, body) => {
    hub.token = async () => ({ status, body })
    const session = hubSession()
    const app = await build(session)
    const res = await app.inject({ method: 'GET', url: cbUrl() })
    expect(res.headers.location).toBe(
      `/api/auth/login?direct=1&returnTo=${encodeURIComponent(RETURN_TO)}`
    )
    expect(session.userId).toBeUndefined()
    expect(trackError).not.toHaveBeenCalled()
    // Marked down for everyone: the next /login goes direct without asking the Hub.
    const other = await (await build(fakeSession())).inject({ method: 'GET', url: '/login' })
    expect(other.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//)
  })

  it('a browser-delivered error=temporarily_unavailable hops that person, the probe stays up (P7-11)', async () => {
    const session = hubSession()
    const app = await build(session)
    // The probe is up and cached.
    expect((await app.inject({ method: 'GET', url: '/providers' })).json().data.hub.up).toBe(true)
    const pings = hub.pingHits
    const res = await app.inject({
      method: 'GET',
      url: cbUrl({ error: 'temporarily_unavailable' })
    })
    expect(res.headers.location).toBe(
      `/api/auth/login?direct=1&returnTo=${encodeURIComponent(RETURN_TO)}`
    )
    expect(session.hubFellBack).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/providers' })).json().data.hub.up).toBe(true)
    expect(hub.pingHits).toBe(pings)
    // Someone else's plain /login still goes to the Hub.
    const other = await (await build(fakeSession())).inject({ method: 'GET', url: '/login' })
    expect(other.headers.location).toContain(`${issuer}/authorize`)
  })

  it('this app’s own Entra keys unreachable → IDP_UNREACHABLE hop, Hub not marked down', async () => {
    await seedUser()
    answer(await hubToken())
    const keysAt = h.entraJwksUri
    h.entraJwksUri = 'http://127.0.0.1:9/keys'
    try {
      const session = hubSession()
      const app = await build(session)
      const res = await app.inject({ method: 'GET', url: cbUrl() })
      expect(res.headers.location).toBe(
        `/api/auth/login?direct=1&returnTo=${encodeURIComponent(RETURN_TO)}`
      )
      expect(session.userId).toBeUndefined()
      expect(trackError).not.toHaveBeenCalled()
      const other = await (await build(fakeSession())).inject({ method: 'GET', url: '/login' })
      expect(other.headers.location).toContain(`${issuer}/authorize`)
    } finally {
      h.entraJwksUri = keysAt
    }
  })
})

// ─── Same checks on both paths ───────────────────────────────────────────────

describe.each(PATHS)('the same account checks on the %s path', (path) => {
  it('a suspended account is refused', async () => {
    await seedUser({ status: 'suspended' })
    const { session, res } = await signInVia(path)
    expect(res.headers.location).toBe('http://localhost:3056/login?error=suspended')
    expect(session.userId).toBeUndefined()
  })

  it('a role with sign-in off is refused', async () => {
    await seedUser()
    h.roleAllows = false
    const { session, res } = await signInVia(path)
    expect(res.headers.location).toBe('http://localhost:3056/login?error=sign_in_disabled')
    expect(session.userId).toBeUndefined()
  })

  it('a TOTP account is asked for its code, then signed in', async () => {
    await seedUser({ totp_enabled: true, totp_secret: 'JBSWY3DPEHPK3PXP' })
    pushSignInEvent.mockClear()
    const { session, app, res } = await signInVia(path)
    expect(res.headers.location).toBe('http://localhost:3056/login?totp=1')
    expect(session.userId).toBeUndefined()
    expect(session.pendingTotpUserId).toBe('u1')
    const done = await app.inject({
      method: 'POST',
      url: '/totp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: '123456' })
    })
    expect(done.statusCode).toBe(200)
    expect(session.userId).toBe('u1')
    if (path === 'hub') {
      expect(session.signedInVia).toBe('hub')
      expect(session.hubSid).toBe(SID)
    } else {
      expect(session.signedInVia).toBeUndefined()
      expect(session.hubSid).toBeUndefined()
    }
    expect(session.pendingHubSid).toBeUndefined()
    // Only a direct sign-in is reported to the Hub (once the second factor passes).
    if (path === 'hub') expect(pushSignInEvent).not.toHaveBeenCalled()
    else expect(pushSignInEvent).toHaveBeenCalledWith(expect.anything(), { id: 'u1', email: null })
  })

  it('an active account signs in', async () => {
    await seedUser()
    pushSignInEvent.mockClear()
    const { session, res } = await signInVia(path)
    expect(res.headers.location).toBe(RETURN_TO)
    expect(session.userId).toBe('u1')
    expect(session.signedInVia).toBe(path === 'hub' ? 'hub' : undefined)
    // Only a direct sign-in is reported to the Hub.
    if (path === 'hub') expect(pushSignInEvent).not.toHaveBeenCalled()
    else expect(pushSignInEvent).toHaveBeenCalledWith(expect.anything(), { id: 'u1', email: null })
  })
})

// ─── /logout ─────────────────────────────────────────────────────────────────

describe('POST /logout', () => {
  it('a Hub session answers hub_logout_url with logout_hint = the stored sid and no secret', async () => {
    const session = fakeSession({ userId: 'u1', signedInVia: 'hub', hubSid: SID })
    const app = await build(session)
    const res = await app.inject({ method: 'POST', url: '/logout' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['hub_logout_url', 'ok'])
    const url = new URL(body.hub_logout_url)
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/logout`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      post_logout_redirect_uri: 'http://localhost:3056/login',
      logout_hint: SID
    })
    expect(res.body).not.toContain(SECRET)
    expect(session.userId).toBeUndefined()
  })

  it('post-logout URI follows an allowed returnTo origin', async () => {
    const session = fakeSession({ userId: 'u1', signedInVia: 'hub', hubSid: SID })
    const app = await build(session)
    const res = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ returnTo: 'http://localhost:3055/x' })
    })
    const url = new URL(res.json().hub_logout_url)
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3055/login')
    const evil = await (
      await build(fakeSession({ userId: 'u1', signedInVia: 'hub', hubSid: SID }))
    ).inject({
      method: 'POST',
      url: '/logout',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ returnTo: 'https://evil.example/x' })
    })
    expect(new URL(evil.json().hub_logout_url).searchParams.get('post_logout_redirect_uri')).toBe(
      'http://localhost:3056/login'
    )
  })

  it('an origin the Hub has not registered gets no post-logout address, never a Hub error page (P7-17)', async () => {
    hub.registered = ['http://localhost:3056']
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = fakeSession({ userId: 'u1', signedInVia: 'hub', hubSid: SID })
    const app = await build(session)
    const res = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ returnTo: 'http://localhost:3055/x' })
    })
    const url = new URL(res.json().hub_logout_url)
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: CLIENT, logout_hint: SID })
    expect(session.userId).toBeUndefined()
  })

  it('a direct session answers { ok: true } only', async () => {
    const app = await build(fakeSession({ userId: 'u1' }))
    const res = await app.inject({ method: 'POST', url: '/logout' })
    expect(res.json()).toEqual({ ok: true })
  })

  it('a Hub session on an app whose Hub sign-in is now off answers { ok: true } only', async () => {
    process.env.HUB_SIGNIN = 'off'
    const app = await build(fakeSession({ userId: 'u1', signedInVia: 'hub', hubSid: SID }))
    const res = await app.inject({ method: 'POST', url: '/logout' })
    expect(res.json()).toEqual({ ok: true })
  })
})
