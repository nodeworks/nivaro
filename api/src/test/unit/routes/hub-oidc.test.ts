import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: the Hub's OpenID provider (/api/hub/oidc). Real SQLite hub tables, real
// clients/keys/tokens, an in-memory Redis and a cookie-keyed session store whose destroy is the
// real store's (it leaves sess:revoked:<sid>). The abuse cases of Review Focus 1–3 and 5 that
// this task owns: issuer spoofing, redirect_uri near-misses, PKCE, replay, cross-client
// redemption, expiry, client authentication and its limiter, the inert access token, sign-out.

vi.hoisted(() => {
  process.env.PUBLIC_URL = 'https://hub.example.com/some/path'
  process.env.OIDC_CLIENT_ID = 'hub-entra-client-id'
  process.env.OIDC_ISSUER =
    'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0'
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  process.env.NODE_ENV = 'test'
})

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
// revokeSessions tells sockets and the sessions list on the side; nothing to tell here.
vi.mock('../../../services/socket-access.js', () => ({ endSessionSockets: vi.fn() }))
vi.mock('../../../services/sessions-live.js', () => ({ noteSessionsChanged: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/traffic-breaker.js', () => ({
  entityBreakerHook: vi.fn(async () => false),
  startBreakerSync: vi.fn()
}))
// Task 5 fix round (P7-9): a switcher write that never answers must not hold the token answer.
const signinHang = vi.hoisted(() => ({ on: false }))
vi.mock('../../../services/hub/signins.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/hub/signins.js')>()
  return {
    ...real,
    recordSignin: (input: Parameters<typeof real.recordSignin>[0]) =>
      signinHang.on ? new Promise<never>(() => {}) : real.recordSignin(input)
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up550 } = await import('../../../db/migrations/550_hub_oidc.js')
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const { hubOidcRoutes } = await import('../../../routes/hub-oidc.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { buildRedisStore, REVOKED_PREFIX } = await import('../../../auth/session.js')
const { createClient, setClientActive } = await import('../../../services/hub/oidc/clients.js')
const { _resetHubKeysForTests, hubIssuer, sidHash } = await import(
  '../../../services/hub/oidc/keys.js'
)
const { verifyHubIdToken } = await import('../../../services/hub/oidc/tokens.js')
const { captureEvidence } = await import('../../../services/hub/oidc/evidence.js')
const { authenticate } = await import('../../../middleware/authenticate.js')
const { bustSessionPolicy } = await import('../../../services/session-policy.js')
const { resetAccessPendingCache } = await import('../../../services/access-pending.js')

const ISSUER = 'https://hub.example.com/api/hub/oidc'
const BASE = '/api/hub/oidc'
const USER = 'AAAAAAAA-0000-4000-8000-000000000001'
const TID = '11111111-2222-3333-4444-555555555555'
const OID = '99999999-8888-7777-6666-555555555555'
const CB_A = 'https://app-a.example.com/api/auth/callback'
const CB_B = 'https://app-b.example.com/api/auth/callback'
const LOGOUT_A = 'https://app-a.example.com/login'
const VERIFIER = 'v'.repeat(50)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

// ─── Fakes ────────────────────────────────────────────────────────────────────

function fakeRedis() {
  const kv = new Map<string, string>()
  const r = {
    kv,
    /** 'up' | 'down' (ping throws) | 'hang' (ping never answers) */
    pingMode: 'up' as 'up' | 'down' | 'hang',
    ping: async () => {
      if (r.pingMode === 'down') throw new Error('redis down')
      if (r.pingMode === 'hang') return new Promise<never>(() => {})
      return 'PONG'
    },
    get: async (k: string) => kv.get(k) ?? null,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    set: async (k: string, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    setex: async (k: string, _t: number, v: string) => {
      kv.set(k, v)
      return 'OK'
    },
    getdel: async (k: string) => {
      const v = kv.get(k) ?? null
      kv.delete(k)
      return v
    },
    del: async (...ks: string[]) => ks.filter((k) => kv.delete(k)).length,
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
    multi: () => {
      const ops: Array<() => Promise<unknown>> = []
      const m = {
        del(k: string) {
          ops.push(() => r.del(k))
          return m
        },
        setex(k: string, t: number, v: string) {
          ops.push(() => r.setex(k, t, v))
          return m
        },
        incr(k: string) {
          ops.push(async () => {
            const n = Number(kv.get(k) ?? 0) + 1
            kv.set(k, String(n))
            return n
          })
          return m
        },
        expire(_k: string, _s: number) {
          ops.push(async () => 1)
          return m
        },
        exec: async () => Promise.all(ops.map((o) => o()))
      }
      return m
    }
  }
  return r
}
const redis = fakeRedis()
const store = buildRedisStore(redis as never)

type Sess = Record<string, unknown> & {
  sessionId: string
  userId?: string
  destroy: () => Promise<void>
}
const sessions = new Map<string, Sess>()
let destroyCalls = 0

/** A session that lives under cookie `nivaro_session=<sid>`; destroy goes through the store. */
function newSession(sid: string, init: Record<string, unknown> = {}): Sess {
  const s: Sess = {
    ...init,
    sessionId: sid,
    destroy: async () => {
      destroyCalls++
      sessions.delete(sid)
      for (const k of Object.keys(s)) if (k !== 'sessionId' && k !== 'destroy') delete s[k]
      await new Promise<void>((res, rej) => store.destroy(sid, (e) => (e ? rej(e) : res())))
    }
  }
  sessions.set(sid, s)
  return s
}

// ─── App ──────────────────────────────────────────────────────────────────────

let app: FastifyInstance

beforeAll(async () => {
  await up542(db)
  await up550(db)
  await up551(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('email')
    t.string('first_name')
    t.string('last_name')
    t.string('status')
    t.boolean('is_redacted').defaultTo(false)
    t.string('static_token')
    t.string('role')
  })
  // The session policy (#665) lives on nivaro_settings row 1.
  await db.schema.createTable('nivaro_settings', (t) => {
    t.integer('id').primary()
    t.text('session_policy')
  })
  await db('nivaro_settings').insert({ id: 1, session_policy: null })
  app = Fastify({ trustProxy: true })
  app.decorate('redis', redis as never)
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    const m = /(?:^|;\s*)nivaro_session=([^;]+)/.exec(String(req.headers.cookie ?? ''))
    // As the real store reads it: a revoked id is no session (auth/session.ts buildRedisStore).
    const revoked = m ? redis.kv.has(`${REVOKED_PREFIX}${m[1]}`) : false
    const found = m && !revoked ? sessions.get(m[1]) : undefined
    ;(req as unknown as { session: Sess }).session = found ?? {
      sessionId: `anon-${Math.random()}`,
      destroy: async () => {}
    }
  })
  await app.register(
    async (api) => {
      await api.register(hubRoutes, { prefix: '/hub' })
      await api.register(hubOidcRoutes, { prefix: '/hub/oidc' })
      // What /api/mcp authenticates with before anything else (routes/mcp.ts authenticateMcp).
      api.post('/mcp', { preHandler: authenticate }, async () => ({ ok: true }))
    },
    { prefix: '/api' }
  )
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
})

let clientA: { client_id: string; client_secret: string }
let clientB: { client_id: string; client_secret: string }
let envA: number

async function seedApp(key: string, base: string): Promise<number> {
  const [appId] = await db('nivaro_hub_apps').insert({
    key,
    name: key.toUpperCase(),
    signin_mode: 'hub',
    adopted: false,
    extensions: '[]'
  })
  const [envId] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'production',
    position: 0,
    status: 'active',
    base_url: base,
    hostnames: JSON.stringify([])
  })
  return Number(envId)
}

beforeEach(async () => {
  for (const t of [
    'nivaro_hub_oidc_clients',
    'nivaro_hub_oidc_keys',
    'nivaro_hub_environments',
    'nivaro_hub_apps',
    'nivaro_users'
  ])
    await db(t).del()
  redis.kv.clear()
  redis.pingMode = 'up'
  sessions.clear()
  destroyCalls = 0
  _resetHubKeysForTests()
  await db('nivaro_settings').update({ session_policy: null })
  bustSessionPolicy()
  await db('nivaro_users').insert({
    id: USER,
    email: 'pat@hub.example.com',
    first_name: 'HubFirst',
    last_name: 'HubLast',
    status: 'active',
    is_redacted: false
  })
  envA = await seedApp('appa', 'https://app-a.example.com')
  const envB = await seedApp('appb', 'https://app-b.example.com')
  clientA = await createClient(envA, USER)
  clientB = await createClient(envB, USER)
})
afterEach(() => {
  vi.useRealTimers()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** An Entra ID token as the primary callback hands it over (signature not checked here). */
function entraIdToken(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  return [
    b64({ alg: 'RS256', typ: 'JWT', kid: 'entra' }),
    b64({
      iss: `https://login.microsoftonline.com/${TID}/v2.0`,
      aud: 'hub-entra-client-id',
      oid: OID,
      tid: TID,
      iat: now,
      exp: now + 3600,
      email: 'pat@entra.example.com',
      name: 'Pat Entra',
      given_name: 'Pat',
      family_name: 'Entra',
      ...claims
    }),
    'sig'
  ].join('.')
}

/** A Hub session signed in through the primary Entra sign-in (evidence attached). */
function signedInSession(sid = 'sid-hub-1', claims: Record<string, unknown> = {}): Sess {
  const evidence = captureEvidence({ id_token: entraIdToken(claims) }, USER)
  if (!evidence) throw new Error('test evidence was refused')
  return newSession(sid, { userId: USER, hubIdpEvidence: evidence })
}

const cookie = (sid: string) => ({ cookie: `nivaro_session=${sid}` })

function authorizeQuery(over: Record<string, string | undefined> = {}, client = clientA) {
  const q: Record<string, string> = {}
  const base: Record<string, string | undefined> = {
    client_id: client.client_id,
    redirect_uri: client === clientA ? CB_A : CB_B,
    response_type: 'code',
    scope: 'openid email profile',
    state: 'st-1',
    nonce: 'nonce-1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...over
  }
  for (const [k, v] of Object.entries(base)) if (v !== undefined) q[k] = v
  return new URLSearchParams(q).toString()
}

const authorize = (qs: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `${BASE}/authorize?${qs}`, headers })

async function getCode(sid = 'sid-hub-1', over: Record<string, string> = {}) {
  if (!sessions.has(sid)) signedInSession(sid)
  const res = await authorize(authorizeQuery(over), cookie(sid))
  expect(res.statusCode).toBe(302)
  const loc = new URL(String(res.headers.location))
  const code = loc.searchParams.get('code')
  expect(code).toBeTruthy()
  return code as string
}

const basic = (c: { client_id: string; client_secret: string }) =>
  `Basic ${Buffer.from(`${encodeURIComponent(c.client_id)}:${encodeURIComponent(c.client_secret)}`).toString('base64')}`

function token(
  fields: Record<string, string>,
  opts: { auth?: string; ip?: string } = {}
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded'
  }
  if (opts.auth) headers.authorization = opts.auth
  return app.inject({
    method: 'POST',
    url: `${BASE}/token`,
    headers,
    remoteAddress: opts.ip ?? '10.0.0.1',
    payload: new URLSearchParams(fields).toString()
  })
}

const redeem = (code: string, over: Record<string, string> = {}, auth = basic(clientA)) =>
  token(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CB_A,
      code_verifier: VERIFIER,
      ...over
    },
    { auth }
  )

function expectSecurityHeaders(res: LightMyRequestResponse) {
  expect(res.headers['cache-control']).toBe('no-store')
  expect(res.headers['referrer-policy']).toBe('no-referrer')
  expect(res.headers['x-frame-options']).toBe('DENY')
  expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
}

// ─── Discovery / JWKS / ping ─────────────────────────────────────────────────

describe('discovery', () => {
  it('names the configured issuer whatever Host / X-Forwarded-Host say', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/.well-known/openid-configuration`,
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' }
    })
    expect(res.statusCode).toBe(200)
    expectSecurityHeaders(res)
    const doc = res.json()
    expect(doc.issuer).toBe(hubIssuer())
    expect(doc.issuer).toBe(ISSUER)
    expect(JSON.stringify(doc)).not.toContain('evil.example')
    expect(doc).toMatchObject({
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      end_session_endpoint: `${ISSUER}/logout`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      authorization_response_iss_parameter_supported: true
    })
  })

  it('JWKS has public keys only', async () => {
    await getCode()
    await redeem(await getCode('sid-2'))
    const jwks = (await app.inject({ method: 'GET', url: `${BASE}/jwks` })).json()
    expect(jwks.keys.length).toBe(1)
    expect(JSON.stringify(jwks)).not.toMatch(/"d"/)
  })

  it('ping authenticates the client (Basic) and is true only for a usable client, never cached', async () => {
    const ping = (auth?: string, q = `client_id=${clientA.client_id}`) =>
      app.inject({
        method: 'GET',
        url: `${BASE}/ping?${q}`,
        remoteAddress: '10.7.7.7',
        headers: auth ? { authorization: auth } : {}
      })
    const ok = await ping(basic(clientA))
    expect(ok.json()).toEqual({ ok: true })
    expect(ok.headers['cache-control']).toBe('no-store')
    // the client id may also be left out of the query
    expect((await ping(basic(clientA), '')).json()).toEqual({ ok: true })
    await setClientActive(envA, false)
    expect((await ping(basic(clientA))).json()).toEqual({ ok: false, reason: 'CLIENT_INACTIVE' })
    for (const res of [
      await ping(), // no credentials
      await ping(basic({ ...clientA, client_secret: 'hubs_wrong' })),
      await ping(basic({ client_id: 'hubc_nope', client_secret: clientA.client_secret })),
      await ping(basic(clientB)) // the query names another client than the credentials
    ]) {
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ ok: false, reason: 'CLIENT_AUTH_FAILED' })
    }
  })
})

describe('ping: ok only when a sign-in can finish (P7-16)', () => {
  const ping = () =>
    app.inject({
      method: 'GET',
      url: `${BASE}/ping`,
      remoteAddress: '10.6.6.6',
      headers: { authorization: basic(clientA) }
    })

  it('Redis down → REDIS_UNAVAILABLE', async () => {
    redis.pingMode = 'down'
    expect((await ping()).json()).toEqual({ ok: false, reason: 'REDIS_UNAVAILABLE' })
  })

  it('Redis not answering → REDIS_UNAVAILABLE within the probe budget', async () => {
    redis.pingMode = 'hang'
    const started = Date.now()
    expect((await ping()).json()).toEqual({ ok: false, reason: 'REDIS_UNAVAILABLE' })
    expect(Date.now() - started).toBeLessThan(1_400)
  })

  it('no usable ENCRYPTION_KEY → 503 NO_ENCRYPTION_KEY, never a failed authentication', async () => {
    const key = process.env.ENCRYPTION_KEY
    try {
      for (const k of [undefined, 'not-hex']) {
        if (k === undefined) delete process.env.ENCRYPTION_KEY
        else process.env.ENCRYPTION_KEY = k
        // more often than the failed-client brake allows: none of them counts
        for (let i = 0; i < 21; i++) {
          const res = await ping()
          expect(res.statusCode).toBe(503)
          expect(res.json()).toEqual({ ok: false, reason: 'NO_ENCRYPTION_KEY' })
        }
      }
      process.env.ENCRYPTION_KEY = key
      expect((await ping()).json()).toEqual({ ok: true })
    } finally {
      process.env.ENCRYPTION_KEY = key
    }
  })

  it('a primary issuer that is not tenant-specific, or no client id → NO_TENANT_ISSUER', async () => {
    const { config } = await import('../../../config.js')
    const saved = { iss: config.OIDC_ISSUER, id: config.OIDC_CLIENT_ID }
    try {
      for (const iss of [
        'https://login.microsoftonline.com/common/v2.0',
        'https://login.microsoftonline.com/organizations/v2.0',
        'http://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
        ''
      ]) {
        ;(config as { OIDC_ISSUER: string }).OIDC_ISSUER = iss
        expect((await ping()).json(), iss).toEqual({ ok: false, reason: 'NO_TENANT_ISSUER' })
      }
      ;(config as { OIDC_ISSUER: string }).OIDC_ISSUER = saved.iss
      ;(config as { OIDC_CLIENT_ID: string }).OIDC_CLIENT_ID = ''
      expect((await ping()).json()).toEqual({ ok: false, reason: 'NO_TENANT_ISSUER' })
    } finally {
      ;(config as { OIDC_ISSUER: string }).OIDC_ISSUER = saved.iss
      ;(config as { OIDC_CLIENT_ID: string }).OIDC_CLIENT_ID = saved.id
    }
  })

  it('primary sign-in turned off at the Hub → PRIMARY_SIGNIN_OFF', async () => {
    const { config } = await import('../../../config.js')
    const saved = config.OIDC_ENABLED
    await db.schema.createTable('nivaro_sso_providers', (t) => {
      t.increments('id')
      t.boolean('is_active')
    })
    try {
      await db('nivaro_sso_providers').insert({ is_active: true })
      ;(config as { OIDC_ENABLED: boolean }).OIDC_ENABLED = false
      expect((await ping()).json()).toEqual({ ok: false, reason: 'PRIMARY_SIGNIN_OFF' })
    } finally {
      ;(config as { OIDC_ENABLED: boolean }).OIDC_ENABLED = saved
      await db.schema.dropTable('nivaro_sso_providers')
    }
    expect((await ping()).json()).toEqual({ ok: true })
  })
})

// ─── The anonymous per-address limiter (ruling P7-15) ───────────────────────

describe('anonymous limiter: app servers calling the Hub', () => {
  let limited: FastifyInstance
  const ANON = 3
  const ip = '198.51.100.20'

  beforeAll(async () => {
    const saved = process.env.RATE_LIMIT_ANON_PER_MINUTE
    process.env.RATE_LIMIT_ANON_PER_MINUTE = String(ANON)
    const { callerRateLimitPlugin } = await import('../../../plugins/rate-limit.js')
    limited = Fastify({ trustProxy: true })
    limited.decorate('redis', redis as never)
    limited.decorateRequest('session', null as never)
    limited.addHook('onRequest', async (req) => {
      ;(req as unknown as { session: Sess }).session = {
        sessionId: `anon-${Math.random()}`,
        destroy: async () => {}
      }
    })
    await limited.register(callerRateLimitPlugin)
    await limited.register(
      async (api) => {
        await api.register(hubOidcRoutes, { prefix: '/hub/oidc' })
      },
      { prefix: '/api' }
    )
    await limited.ready()
    if (saved === undefined) delete process.env.RATE_LIMIT_ANON_PER_MINUTE
    else process.env.RATE_LIMIT_ANON_PER_MINUTE = saved
  })
  afterAll(async () => {
    await limited.close()
  })

  const redeemAt = (code: string, auth?: string, fields: Record<string, string> = {}) => {
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CB_A,
      code_verifier: VERIFIER,
      ...fields
    }
    return limited.inject({
      method: 'POST',
      url: `${BASE}/token`,
      remoteAddress: ip,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(auth ? { authorization: auth } : {})
      },
      payload: new URLSearchParams(body).toString()
    })
  }

  it('successful token calls and pings never spend the budget: N+1 all succeed', async () => {
    for (let i = 0; i < ANON + 2; i++) {
      // client_secret_post (no Authorization header) and Basic alike
      const post = i % 2 === 0
      const res = await redeemAt(
        await getCode(`sid-lim-${i}`),
        post ? undefined : basic(clientA),
        post ? { client_id: clientA.client_id, client_secret: clientA.client_secret } : {}
      )
      expect(res.statusCode).toBe(200)
      expect(typeof res.json().id_token).toBe('string')
      const ping = await limited.inject({
        method: 'GET',
        url: `${BASE}/ping?client_id=${clientA.client_id}`,
        remoteAddress: ip,
        headers: { authorization: basic(clientA) }
      })
      expect(ping.json()).toEqual({ ok: true })
    }
    expect([...redis.kv.keys()].filter((k) => k.startsWith('rl:anon:'))).toEqual([])
  })

  it('failed client authentication spends it: 429 once past the budget, also for a good secret', async () => {
    const wrong = basic({ ...clientA, client_secret: 'hubs_wrong' })
    const codes: number[] = []
    for (let i = 0; i < ANON + 1; i++) codes.push((await redeemAt('nope', wrong)).statusCode)
    expect(codes).toEqual([401, 401, 401, 429])
    const blocked = await redeemAt('nope', wrong)
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('RATE_LIMITED')
    // the ping is throttled the same way
    const ping = await limited.inject({
      method: 'GET',
      url: `${BASE}/ping`,
      remoteAddress: ip,
      headers: { authorization: wrong }
    })
    expect(ping.statusCode).toBe(429)
  })

  it('discovery and the key set are public reads: never counted, never refused', async () => {
    for (let i = 0; i < ANON + 3; i++) {
      for (const url of [`${BASE}/.well-known/openid-configuration`, `${BASE}/jwks`]) {
        const res = await limited.inject({ method: 'GET', url, remoteAddress: '198.51.100.21' })
        expect(res.statusCode).toBe(200)
      }
    }
    expect([...redis.kv.keys()].filter((k) => k.startsWith('rl:anon:'))).toEqual([])
  })
})

// ─── Authorize ───────────────────────────────────────────────────────────────

describe('authorize: client and redirect_uri', () => {
  it.each([
    ['unregistered', 'https://elsewhere.example.com/api/auth/callback'],
    ['traversal', `${CB_A}/../x`],
    ['suffix', `${CB_A}.evil`],
    ['other host with the name as prefix', 'https://app-a.example.com.evil.com/api/auth/callback'],
    ['other port', 'https://app-a.example.com:8443/api/auth/callback'],
    ['trailing slash', `${CB_A}/`],
    ['trailing path', `${CB_A}/x`],
    ['http of an https host', 'http://app-a.example.com/api/auth/callback'],
    ['path case', 'https://app-a.example.com/api/AUTH/callback'],
    ['host case', 'https://App-A.example.com/api/auth/callback'],
    ['userinfo', 'https://evil@app-a.example.com/api/auth/callback'],
    ['encoded characters', 'https://app-a.example.com/api/auth/c%61llback'],
    ['encoded slash', 'https://app-a.example.com/api%2Fauth/callback'],
    ["another client's callback", CB_B]
  ])('near-miss redirect_uri (%s) → 400 page, no redirect', async (_why, uri) => {
    signedInSession()
    const res = await authorize(authorizeQuery({ redirect_uri: uri }), cookie('sid-hub-1'))
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
    expect(String(res.headers['content-type'])).toMatch(/text\/html/)
    expectSecurityHeaders(res)
    expect(res.body).not.toContain('evil')
  })

  it('a repeated redirect_uri → page', async () => {
    signedInSession()
    const qs = `${authorizeQuery()}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`
    const res = await authorize(qs, cookie('sid-hub-1'))
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('unknown client → page', async () => {
    signedInSession()
    const res = await authorize(
      authorizeQuery({ client_id: `hubc_${'f'.repeat(24)}` }),
      cookie('sid-hub-1')
    )
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('valid client + bad PKCE method → redirect with invalid_request, state and iss', async () => {
    signedInSession()
    for (const over of [
      { code_challenge_method: 'plain' },
      { code_challenge_method: undefined },
      { code_challenge: undefined }
    ]) {
      const res = await authorize(authorizeQuery(over), cookie('sid-hub-1'))
      expect(res.statusCode).toBe(302)
      const loc = new URL(String(res.headers.location))
      expect(`${loc.origin}${loc.pathname}`).toBe(CB_A)
      expect(loc.searchParams.get('error')).toBe('invalid_request')
      expect(loc.searchParams.get('state')).toBe('st-1')
      expect(loc.searchParams.get('iss')).toBe(ISSUER)
      expect(loc.searchParams.get('code')).toBeNull()
    }
  })
})

describe('authorize: the Hub session', () => {
  it('a session without evidence (password sign-in) → Entra sign-in, back to this URL', async () => {
    newSession('sid-pw', { userId: USER })
    const qs = authorizeQuery()
    const res = await authorize(qs, {
      ...cookie('sid-pw'),
      host: 'evil.example',
      'x-forwarded-host': 'evil.example'
    })
    expect(res.statusCode).toBe(302)
    const loc = new URL(String(res.headers.location))
    expect(`${loc.origin}${loc.pathname}`).toBe('https://hub.example.com/api/auth/login')
    expect(loc.searchParams.get('returnTo')).toBe(`https://hub.example.com${BASE}/authorize?${qs}`)
  })

  it('prompt=none without a usable sign-in → login_required to the app', async () => {
    newSession('sid-pw', { userId: USER })
    const res = await authorize(authorizeQuery({ prompt: 'none' }), cookie('sid-pw'))
    const loc = new URL(String(res.headers.location))
    expect(`${loc.origin}${loc.pathname}`).toBe(CB_A)
    expect(loc.searchParams.get('error')).toBe('login_required')
    expect(loc.searchParams.get('state')).toBe('st-1')
    const none = await authorize(authorizeQuery({ prompt: 'none' }))
    expect(new URL(String(none.headers.location)).searchParams.get('error')).toBe('login_required')
  })

  it('a View-as / bearer header with no cookie is no session', async () => {
    signedInSession() // exists, but this request does not carry its cookie
    const res = await authorize(authorizeQuery(), { authorization: 'Bearer nvm_someviewastoken' })
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toMatch(/^https:\/\/hub\.example\.com\/api\/auth\/login\?/)
    expect(String(res.headers.location)).not.toContain('code=')
  })

  it('evidence captured for another person is not used', async () => {
    const ev = captureEvidence({ id_token: entraIdToken() }, 'SOMEONE-ELSE')
    newSession('sid-x', { userId: USER, hubIdpEvidence: ev })
    const res = await authorize(authorizeQuery(), cookie('sid-x'))
    expect(String(res.headers.location)).toMatch(/\/api\/auth\/login\?/)
  })

  it('stale evidence: sign in again; just captured and already stale → temporarily_unavailable to the app (P7-16)', async () => {
    const soon = Math.floor(Date.now() / 1000) + 60 // under the 2-minute floor
    const s = signedInSession('sid-stale', { exp: soon })
    const loop = await authorize(authorizeQuery(), cookie('sid-stale'))
    expect(loop.statusCode).toBe(302)
    const back = new URL(String(loop.headers.location))
    expect(`${back.origin}${back.pathname}`).toBe(CB_A)
    expect(back.searchParams.get('error')).toBe('temporarily_unavailable')
    expect(back.searchParams.get('state')).toBe('st-1')
    expect(back.searchParams.get('iss')).toBe(ISSUER)
    expect(back.searchParams.get('code')).toBeNull()
    ;(s.hubIdpEvidence as { captured_at: number }).captured_at = Date.now() - 61_000
    const again = await authorize(authorizeQuery(), cookie('sid-stale'))
    expect(again.statusCode).toBe(302)
    expect(String(again.headers.location)).toMatch(/\/api\/auth\/login\?/)
  })

  it('a session that signed in moments ago with no evidence → temporarily_unavailable, never sign-in again (P7-16)', async () => {
    // e.g. a non-Entra primary, or an Entra token without oid/tid: the evidence was never captured.
    const s = newSession('sid-fresh', { userId: USER, authAt: Date.now() - 5_000 })
    const res = await authorize(authorizeQuery(), cookie('sid-fresh'))
    expect(res.statusCode).toBe(302)
    const back = new URL(String(res.headers.location))
    expect(`${back.origin}${back.pathname}`).toBe(CB_A)
    expect(back.searchParams.get('error')).toBe('temporarily_unavailable')
    expect(back.searchParams.get('state')).toBe('st-1')
    // A session that signed in over a minute ago is sent through sign-in (it may capture it now).
    s.authAt = Date.now() - 61_000
    const later = await authorize(authorizeQuery(), cookie('sid-fresh'))
    expect(String(later.headers.location)).toMatch(
      /^https:\/\/hub\.example\.com\/api\/auth\/login\?/
    )
  })

  const setPolicy = async (policy: Record<string, unknown>) => {
    await db('nivaro_settings').update({ session_policy: JSON.stringify(policy) })
    bustSessionPolicy()
  }

  it('an idle-expired session is ended and sent to sign in (prompt=none → login_required)', async () => {
    await setPolicy({ idle_minutes: 5 })
    const s = signedInSession('sid-idle')
    s.loginAt = Date.now() - 60_000
    s.lastSeenAt = Date.now() - 10 * 60_000
    const res = await authorize(authorizeQuery(), cookie('sid-idle'))
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toMatch(/^https:\/\/hub\.example\.com\/api\/auth\/login\?/)
    expect(destroyCalls).toBe(1)
    expect(redis.kv.get(`${REVOKED_PREFIX}sid-idle`)).toBe('1')

    const s2 = signedInSession('sid-idle-2')
    s2.lastSeenAt = Date.now() - 10 * 60_000
    const none = await authorize(authorizeQuery({ prompt: 'none' }), cookie('sid-idle-2'))
    const loc = new URL(String(none.headers.location))
    expect(loc.searchParams.get('error')).toBe('login_required')
    expect(loc.searchParams.get('code')).toBeNull()
    expect(destroyCalls).toBe(2)
  })

  it('a session past its max age is ended and sent to sign in', async () => {
    await setPolicy({ max_age_hours: 1 })
    const s = signedInSession('sid-old')
    s.loginAt = Date.now() - 2 * 3_600_000
    s.lastSeenAt = Date.now() - 1_000
    const res = await authorize(authorizeQuery(), cookie('sid-old'))
    expect(String(res.headers.location)).toMatch(/\/api\/auth\/login\?/)
    expect(String(res.headers.location)).not.toContain('code=')
    expect(destroyCalls).toBe(1)
    expect(sessions.has('sid-old')).toBe(false)
  })

  it('authorize counts as activity: lastSeenAt (and loginAt once) are stamped', async () => {
    await setPolicy({ idle_minutes: 5 })
    const s = signedInSession('sid-active')
    const login = Date.now() - 60_000
    s.loginAt = login
    s.lastSeenAt = Date.now() - 4 * 60_000
    const before = Date.now()
    const res = await authorize(authorizeQuery(), cookie('sid-active'))
    expect(new URL(String(res.headers.location)).searchParams.get('code')).toBeTruthy()
    expect(Number(s.lastSeenAt)).toBeGreaterThanOrEqual(before)
    expect(s.loginAt).toBe(login)
    const fresh = signedInSession('sid-unstamped')
    await authorize(authorizeQuery(), cookie('sid-unstamped'))
    expect(Number(fresh.loginAt)).toBeGreaterThanOrEqual(before)
  })

  it('a revoked session id is no session', async () => {
    signedInSession('sid-revoked')
    redis.kv.set(`${REVOKED_PREFIX}sid-revoked`, '1')
    const res = await authorize(authorizeQuery(), cookie('sid-revoked'))
    expect(String(res.headers.location)).toMatch(/\/api\/auth\/login\?/)
    expect(String(res.headers.location)).not.toContain('code=')
  })

  it('a suspended or redacted Hub account → access_denied', async () => {
    signedInSession()
    await db('nivaro_users').where({ id: USER }).update({ status: 'suspended' })
    const res = await authorize(authorizeQuery(), cookie('sid-hub-1'))
    const loc = new URL(String(res.headers.location))
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('code')).toBeNull()
    await db('nivaro_users').where({ id: USER }).update({ status: 'active', is_redacted: true })
    signedInSession('sid-hub-2')
    const red = await authorize(authorizeQuery(), cookie('sid-hub-2'))
    expect(new URL(String(red.headers.location)).searchParams.get('error')).toBe('access_denied')
  })

  it('a client that cannot be used → unauthorized_client', async () => {
    signedInSession()
    await db('nivaro_hub_apps').update({ signin_mode: 'direct' })
    const res = await authorize(authorizeQuery(), cookie('sid-hub-1'))
    expect(new URL(String(res.headers.location)).searchParams.get('error')).toBe(
      'unauthorized_client'
    )
  })

  it('a good request → code + state + iss on the registered callback, even under a spoofed Host', async () => {
    signedInSession()
    const res = await authorize(authorizeQuery(), {
      ...cookie('sid-hub-1'),
      host: 'evil.example',
      'x-forwarded-host': 'evil.example'
    })
    expect(res.statusCode).toBe(302)
    expectSecurityHeaders(res)
    const loc = new URL(String(res.headers.location))
    expect(`${loc.origin}${loc.pathname}`).toBe(CB_A)
    expect(loc.searchParams.get('state')).toBe('st-1')
    expect(loc.searchParams.get('iss')).toBe(ISSUER)
    expect(loc.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // Stored by hash only, single key, 60 s.
    const keys = [...redis.kv.keys()].filter((k) => k.startsWith('nvr:hub-oidc:code:'))
    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toContain(String(loc.searchParams.get('code')))
    // The record (evidence + Hub session id) is sealed: the Redis key browser shows ciphertext.
    const stored = String(redis.kv.get(keys[0]))
    expect(stored).not.toContain('sid-hub-1')
    expect(stored).not.toContain(OID)
    expect(stored).not.toContain('nonce-1')
  })

  it('a code that cannot be stored (no ENCRYPTION_KEY) → server_error to the app', async () => {
    signedInSession()
    const prev = process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    try {
      const res = await authorize(authorizeQuery(), cookie('sid-hub-1'))
      const loc = new URL(String(res.headers.location))
      expect(`${loc.origin}${loc.pathname}`).toBe(CB_A)
      expect(loc.searchParams.get('error')).toBe('server_error')
      expect(loc.searchParams.get('state')).toBe('st-1')
      expect(loc.searchParams.get('code')).toBeNull()
    } finally {
      process.env.ENCRYPTION_KEY = prev
    }
  })
})

// ─── Token ───────────────────────────────────────────────────────────────────

describe('token', () => {
  it('happy path: an ID token for this client, nonce echoed, the session evidence inside', async () => {
    const s = signedInSession()
    const code = await getCode()
    const res = await redeem(code)
    expect(res.statusCode).toBe(200)
    expectSecurityHeaders(res)
    const body = res.json()
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 300,
      scope: 'openid email profile'
    })
    expect(body.access_token).toMatch(/^nvh_/)
    const jwks = (await app.inject({ method: 'GET', url: `${BASE}/jwks` })).json()
    const claims = await verifyHubIdToken(body.id_token, jwks, {
      audience: clientA.client_id,
      issuer: ISSUER
    })
    expect(claims.aud).toBe(clientA.client_id)
    expect(claims.nonce).toBe('nonce-1')
    expect(claims.sub).toBe(USER)
    expect(claims.sid).toBe(sidHash(s.sessionId))
    expect(claims.idp_id_token).toBe((s.hubIdpEvidence as { id_token: string }).id_token)
    expect(claims).toMatchObject({
      oid: OID,
      tid: TID,
      email: 'pat@entra.example.com',
      name: 'Pat Entra',
      given_name: 'Pat',
      family_name: 'Entra'
    })
    // Never the Hub row's own names.
    expect(JSON.stringify(claims)).not.toContain('HubFirst')
    // Another client's audience refuses it.
    await expect(
      verifyHubIdToken(body.id_token, jwks, { audience: clientB.client_id, issuer: ISSUER })
    ).rejects.toThrow()
  })

  it('client_secret_post works too', async () => {
    const code = await getCode()
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CB_A,
      code_verifier: VERIFIER,
      client_id: clientA.client_id,
      client_secret: clientA.client_secret
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().id_token).toBeTruthy()
  })

  it('replay: the second redemption → invalid_grant', async () => {
    const code = await getCode()
    expect((await redeem(code)).statusCode).toBe(200)
    const again = await redeem(code)
    expect(again.statusCode).toBe(400)
    expect(again.json().error).toBe('invalid_grant')
  })

  it('a wrong verifier burns the code: the correct retry fails too', async () => {
    const code = await getCode()
    const wrong = await redeem(code, { code_verifier: 'w'.repeat(50) })
    expect(wrong.json().error).toBe('invalid_grant')
    expect((await redeem(code)).json().error).toBe('invalid_grant')
  })

  it('a missing verifier → invalid_grant (and burned)', async () => {
    const code = await getCode()
    const res = await token(
      { grant_type: 'authorization_code', code, redirect_uri: CB_A },
      { auth: basic(clientA) }
    )
    expect(res.json().error).toBe('invalid_grant')
    expect((await redeem(code)).json().error).toBe('invalid_grant')
  })

  it("client B's credentials with client A's code → invalid_grant, and A cannot use it after", async () => {
    const code = await getCode()
    const res = await redeem(code, { redirect_uri: CB_A }, basic(clientB))
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_grant')
    expect((await redeem(code)).json().error).toBe('invalid_grant')
  })

  it("client B's credentials with A's code → invalid_grant even when B could use A's callback", async () => {
    // Only the code's client binding stops this one: B's environment answers on A's name too.
    await db('nivaro_hub_environments')
      .whereNot({ id: envA })
      .update({ hostnames: JSON.stringify(['app-a.example.com']) })
    const code = await getCode()
    const res = await redeem(code, { redirect_uri: CB_A }, basic(clientB))
    expect(res.json().error).toBe('invalid_grant')
    expect((await redeem(code)).json().error).toBe('invalid_grant')
  })

  it.each([
    ['other callback', CB_B],
    ['trailing slash', `${CB_A}/`],
    ['case', CB_A.toUpperCase()],
    ['missing', '']
  ])('a redirect_uri differing at the token endpoint (%s) → invalid_grant', async (_w, uri) => {
    const code = await getCode()
    const res = await redeem(code, { redirect_uri: uri })
    expect(res.json().error).toBe('invalid_grant')
  })

  it('client deactivated between authorize and token → invalid_grant', async () => {
    const code = await getCode()
    await setClientActive(envA, false)
    expect((await redeem(code)).json().error).toBe('invalid_grant')
  })

  it('person suspended between authorize and token → invalid_grant', async () => {
    const code = await getCode()
    await db('nivaro_users').where({ id: USER }).update({ status: 'suspended' })
    expect((await redeem(code)).json().error).toBe('invalid_grant')
  })

  it('the Hub session signed out between authorize and token → invalid_grant', async () => {
    const s = signedInSession('sid-gone')
    const code = await getCode('sid-gone')
    await s.destroy()
    expect((await redeem(code)).json().error).toBe('invalid_grant')
  })

  it('two redemptions of one code at the same moment → exactly one 200', async () => {
    const code = await getCode()
    const [a, b] = await Promise.all([redeem(code), redeem(code)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400])
    expect([a, b].find((r) => r.statusCode === 400)?.json().error).toBe('invalid_grant')
  })

  it('Redis or the database down → 500 with a bare server_error', async () => {
    const code = await getCode()
    const getdel = redis.getdel
    redis.getdel = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379 secret-ish detail'), {
        code: 'ECONNREFUSED'
      })
    }
    try {
      const res = await redeem(code)
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'server_error' })
    } finally {
      redis.getdel = getdel
    }
    await db.schema.renameTable('nivaro_hub_oidc_clients', 'nivaro_hub_oidc_clients_away')
    try {
      const res = await redeem(code)
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'server_error' })
    } finally {
      await db.schema.renameTable('nivaro_hub_oidc_clients_away', 'nivaro_hub_oidc_clients')
    }
  })

  it('an oversized body → invalid_request, no text from the parser', async () => {
    const res = await token({ grant_type: 'authorization_code', code: 'x'.repeat(20_000) })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'invalid_request' })
  })

  it('an expired code (over 60 s) → invalid_grant', async () => {
    const code = await getCode()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    expect((await redeem(code)).json().error).toBe('invalid_grant')
  })

  it('an unknown code and an over-long code → invalid_grant', async () => {
    expect((await redeem('nope')).json().error).toBe('invalid_grant')
    expect((await redeem('x'.repeat(5000))).json().error).toBe('invalid_grant')
  })

  it('grant types: missing → invalid_request, other → unsupported_grant_type', async () => {
    const none = await token({ code: 'x' }, { auth: basic(clientA) })
    expect(none.json().error).toBe('invalid_request')
    const other = await token({ grant_type: 'refresh_token' }, { auth: basic(clientA) })
    expect(other.json().error).toBe('unsupported_grant_type')
  })

  it('two client authentication methods at once → invalid_request', async () => {
    const code = await getCode()
    const res = await token(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CB_A,
        code_verifier: VERIFIER,
        client_secret: clientA.client_secret
      },
      { auth: basic(clientA) }
    )
    expect(res.json().error).toBe('invalid_request')
  })

  it('a wrong client secret → 401 invalid_client, the code untouched, no secret echoed', async () => {
    const code = await getCode()
    const wrongSecret = `hubs_${'Z'.repeat(43)}`
    const res = await redeem(code, {}, basic({ ...clientA, client_secret: wrongSecret }))
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('invalid_client')
    expect(res.headers['www-authenticate']).toMatch(/^Basic/)
    expect(res.body).not.toContain(wrongSecret)
    expect(res.body).not.toContain('ZZZZ')
    expect(res.body).not.toContain(clientA.client_secret)
    // The real client can still redeem: a failed client authentication never burns the code.
    expect((await redeem(code)).statusCode).toBe(200)
    // Unknown client / no credentials at all.
    expect(
      (await redeem('x', {}, basic({ client_id: `hubc_${'0'.repeat(24)}`, client_secret: 's' })))
        .statusCode
    ).toBe(401)
    expect((await token({ grant_type: 'authorization_code', code: 'x' })).statusCode).toBe(401)
  })

  it('invalid_client 21 times from one address → 429; other addresses unaffected', async () => {
    const bad = basic({ ...clientA, client_secret: 'hubs_wrong' })
    for (let i = 0; i < 20; i++) {
      const r = await token(
        { grant_type: 'authorization_code', code: 'x' },
        { auth: bad, ip: '10.9.9.9' }
      )
      expect(r.statusCode).toBe(401)
      expect(r.body).not.toContain('hubs_wrong')
    }
    const blocked = await token(
      { grant_type: 'authorization_code', code: 'x' },
      { auth: basic(clientA), ip: '10.9.9.9' }
    )
    expect(blocked.statusCode).toBe(429)
    expect(blocked.body).not.toContain(clientA.client_secret)
    const code = await getCode()
    const elsewhere = await token(
      { grant_type: 'authorization_code', code, redirect_uri: CB_A, code_verifier: VERIFIER },
      { auth: basic(clientA), ip: '10.1.1.1' }
    )
    expect(elsewhere.statusCode).toBe(200)
  })

  it('a signing key problem → server_error with no text', async () => {
    const code = await getCode()
    await db('nivaro_hub_oidc_keys').insert({
      kid: 'damaged',
      alg: 'ES256',
      public_jwk: '{}',
      private_jwk: 'not-a-sealed-key'
    })
    _resetHubKeysForTests()
    const res = await redeem(code)
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'server_error' })
  })

  it('the nvh_ access token opens nothing: 401 on /api/hub/apps and /api/mcp', async () => {
    const code = await getCode()
    const access = (await redeem(code)).json().access_token as string
    expect(access).toMatch(/^nvh_/)
    const apps = await app.inject({
      method: 'GET',
      url: '/api/hub/apps',
      headers: { authorization: `Bearer ${access}` }
    })
    expect(apps.statusCode).toBe(401)
    const mcp = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      payload: '{}'
    })
    expect(mcp.statusCode).toBe(401)
    expect(JSON.stringify([...redis.kv.entries()])).not.toContain(access)
  })
})

// ─── Logout ──────────────────────────────────────────────────────────────────

describe('logout', () => {
  const logoutQs = (over: Record<string, string | undefined> = {}) => {
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries({
      client_id: clientA.client_id,
      post_logout_redirect_uri: LOGOUT_A,
      state: 'ls-1',
      ...over
    }))
      if (v !== undefined) q[k] = v
    return new URLSearchParams(q).toString()
  }

  it('a logout_hint naming this session → session revoked + back to the registered URI', async () => {
    const s = signedInSession('sid-out')
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/logout?${logoutQs({ logout_hint: sidHash(s.sessionId) })}`,
      headers: cookie('sid-out')
    })
    expect(res.statusCode).toBe(302)
    const loc = new URL(String(res.headers.location))
    expect(`${loc.origin}${loc.pathname}`).toBe(LOGOUT_A)
    expect(loc.searchParams.get('state')).toBe('ls-1')
    expect(destroyCalls).toBe(1)
    expect(redis.kv.get(`${REVOKED_PREFIX}sid-out`)).toBe('1')
    expect(sessions.has('sid-out')).toBe(false)
  })

  it('a hint for another session → confirm page, session alive; its POST signs out', async () => {
    signedInSession('sid-keep')
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/logout?${logoutQs({ logout_hint: sidHash('some-other-session') })}`,
      headers: cookie('sid-keep')
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Sign out of the Hub too?')
    expect(destroyCalls).toBe(0)
    expect(sessions.get('sid-keep')?.userId).toBe(USER)
    expect(redis.kv.has(`${REVOKED_PREFIX}sid-keep`)).toBe(false)
    expect(String(res.headers['content-security-policy'])).toContain(
      "form-action 'self' https://app-a.example.com"
    )

    // A forged POST without the page's value does nothing.
    const forged = await app.inject({
      method: 'POST',
      url: `${BASE}/logout`,
      headers: { ...cookie('sid-keep'), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ confirm: 'yes', client_id: clientA.client_id }).toString()
    })
    expect(forged.statusCode).toBe(200)
    expect(destroyCalls).toBe(0)

    // The page's own form (fresh value from the confirm page just shown).
    const page = await app.inject({
      method: 'GET',
      url: `${BASE}/logout?${logoutQs()}`,
      headers: cookie('sid-keep')
    })
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    expect(csrf).toBeTruthy()
    const yes = await app.inject({
      method: 'POST',
      url: `${BASE}/logout`,
      headers: { ...cookie('sid-keep'), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        csrf,
        confirm: 'yes',
        client_id: clientA.client_id,
        post_logout_redirect_uri: LOGOUT_A,
        state: 'ls-1'
      }).toString()
    })
    expect(yes.statusCode).toBe(302)
    expect(destroyCalls).toBe(1)
    expect(redis.kv.get(`${REVOKED_PREFIX}sid-keep`)).toBe('1')
  })

  it('"Stay signed in" keeps the session and returns to the app', async () => {
    signedInSession('sid-stay')
    const page = await app.inject({
      method: 'GET',
      url: `${BASE}/logout?${logoutQs()}`,
      headers: cookie('sid-stay')
    })
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    const no = await app.inject({
      method: 'POST',
      url: `${BASE}/logout`,
      headers: { ...cookie('sid-stay'), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        csrf,
        confirm: 'no',
        client_id: clientA.client_id,
        post_logout_redirect_uri: LOGOUT_A
      }).toString()
    })
    expect(no.statusCode).toBe(302)
    expect(destroyCalls).toBe(0)
    expect(sessions.get('sid-stay')?.userId).toBe(USER)
  })

  it.each([
    ['foreign', 'https://evil.example/login'],
    ["another app's", 'https://app-b.example.com/login'],
    ['near miss', `${LOGOUT_A}/`],
    ['prefix host', 'https://app-a.example.com.evil.com/login']
  ])('%s post_logout_redirect_uri → error page, nothing ended', async (_w, uri) => {
    const s = signedInSession('sid-pl')
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/logout?${logoutQs({ post_logout_redirect_uri: uri, logout_hint: sidHash(s.sessionId) })}`,
      headers: cookie('sid-pl')
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
    expect(destroyCalls).toBe(0)
  })

  it('a post_logout_redirect_uri without a client → error page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/logout?${logoutQs({ client_id: undefined })}`
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('not signed in to the Hub → straight back to the app', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/logout?${logoutQs()}` })
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toBe(`${LOGOUT_A}?state=ls-1`)
  })
})

describe('mounting', () => {
  it('nothing is mounted with HUB off', async () => {
    const prev = process.env.HUB
    process.env.HUB = 'off'
    const off = Fastify()
    await off.register(hubOidcRoutes, { prefix: '/api/hub/oidc' })
    await off.ready()
    const res = await off.inject({
      method: 'GET',
      url: '/api/hub/oidc/.well-known/openid-configuration'
    })
    expect(res.statusCode).toBe(404)
    await off.close()
    process.env.HUB = prev
  })

  it('nothing is mounted in cloud mode', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://cloud'
    const off = Fastify()
    await off.register(hubOidcRoutes, { prefix: '/api/hub/oidc' })
    await off.ready()
    const res = await off.inject({ method: 'GET', url: '/api/hub/oidc/jwks' })
    expect(res.statusCode).toBe(404)
    await off.close()
    delete process.env.CLOUD_META_DB_URL
  })
})

describe('task 5: the switcher row and the new-user gate', () => {
  const ROLE_START = 'R0000000-0000-4000-8000-00000000000A'
  const ROLE_REVIEW = 'R0000000-0000-4000-8000-00000000000B'
  const ROLE_ADMIN = 'R0000000-0000-4000-8000-00000000000C'

  beforeAll(async () => {
    await db.schema.alterTable('nivaro_settings', (t) => {
      t.string('new_user_role')
      t.string('access_request_role')
    })
    await db.schema.createTable('nivaro_roles', (t) => {
      t.string('id').primary()
      t.boolean('admin_access').defaultTo(false)
    })
    await db('nivaro_roles').insert([
      { id: ROLE_START, admin_access: false },
      { id: ROLE_REVIEW, admin_access: false },
      { id: ROLE_ADMIN, admin_access: true }
    ])
  })
  beforeEach(async () => {
    await db('nivaro_hub_signins').del()
    await db('nivaro_settings').update({
      new_user_role: ROLE_START,
      access_request_role: ROLE_REVIEW
    })
    resetAccessPendingCache()
  })
  afterEach(async () => {
    await db.raw('DROP TRIGGER IF EXISTS hub_signin_fail_ins')
    await db('nivaro_settings').update({ new_user_role: null, access_request_role: null })
    resetAccessPendingCache()
  })

  it('a redeemed code writes one hub row per identity key for the client’s environment', async () => {
    const res = await redeem(await getCode())
    expect(res.statusCode).toBe(200)
    const rows = await db('nivaro_hub_signins').orderBy('identity_key')
    expect(rows.map((r) => r.identity_key)).toEqual([
      `email:pat@entra.example.com`,
      `entra:${TID}:${OID}`
    ])
    for (const r of rows) {
      expect(r.environment_id).toBe(envA)
      expect(r.via).toBe('hub')
      expect(String(r.hub_user_id)).toBe(USER)
    }
  })

  it('P7-9: a sign-in record that never answers delays the token answer by at most 1 s', async () => {
    signinHang.on = true
    try {
      const code = await getCode()
      const started = Date.now()
      const res = await redeem(code)
      const took = Date.now() - started
      expect(res.statusCode).toBe(200)
      expect(res.json().id_token).toBeTruthy()
      expect(took).toBeGreaterThanOrEqual(900)
      expect(took).toBeLessThan(2000)
    } finally {
      signinHang.on = false
    }
  })

  it('a failed sign-in record never fails the token response', async () => {
    await db.raw(
      "CREATE TRIGGER hub_signin_fail_ins BEFORE INSERT ON nivaro_hub_signins BEGIN SELECT RAISE(ABORT, 'disk on fire'); END"
    )
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await redeem(await getCode())
      expect(res.statusCode).toBe(200)
      expect(res.json().id_token).toBeTruthy()
      expect(await db('nivaro_hub_signins').count({ n: '*' }).first()).toMatchObject({ n: 0 })
    } finally {
      spy.mockRestore()
    }
  })

  it('P7-7: a Hub account in First Access or Needs Authorization gets access_denied, no code', async () => {
    for (const role of [ROLE_START, ROLE_REVIEW]) {
      await db('nivaro_users').where({ id: USER }).update({ role })
      sessions.clear()
      signedInSession('sid-pending')
      const res = await authorize(authorizeQuery(), cookie('sid-pending'))
      expect(res.statusCode, role).toBe(302)
      const loc = new URL(String(res.headers.location))
      expect(`${loc.origin}${loc.pathname}`).toBe(CB_A)
      expect(loc.searchParams.get('error')).toBe('access_denied')
      expect(loc.searchParams.get('code')).toBeNull()
      expect(loc.searchParams.get('state')).toBe('st-1')
    }
    expect([...redis.kv.keys()].some((k) => k.startsWith('nvr:hub-oidc:code:'))).toBe(false)
  })

  it('P7-7: a role granting admin access (even the start role) or no role is not pending', async () => {
    // The start role set to an admin role: the gate exempts admins, as accessPendingGate does.
    await db('nivaro_settings').update({ new_user_role: ROLE_ADMIN })
    resetAccessPendingCache()
    for (const role of [ROLE_ADMIN, null]) {
      await db('nivaro_users').where({ id: USER }).update({ role })
      sessions.clear()
      signedInSession('sid-ok')
      const res = await authorize(authorizeQuery(), cookie('sid-ok'))
      expect(res.statusCode).toBe(302)
      expect(new URL(String(res.headers.location)).searchParams.get('code')).toBeTruthy()
    }
  })
})
