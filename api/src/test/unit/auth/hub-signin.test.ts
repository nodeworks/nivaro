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

// Nivaro Hub phase 7, Task 6: the app side of signing in through the Hub. A fake Hub (discovery,
// JWKS, token endpoint) and a fake Entra (JWKS) on one loopback Fastify; the Hub's ID tokens are
// ES256, the Entra evidence RS256, both signed here with jose.

const fake = vi.hoisted(() => ({
  entraIssuer: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
  entraJwksUri: ''
}))

vi.mock('../../../auth/oidc.js', async (orig) => ({
  ...(await orig<typeof import('../../../auth/oidc.js')>()),
  getOIDCConfig: async () => ({
    serverMetadata: () => ({ issuer: fake.entraIssuer, jwks_uri: fake.entraJwksUri })
  })
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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const {
  _resetHubSigninForTests,
  _setHubRequestTimeoutForTests,
  buildHubLoginUrl,
  handleHubCallback,
  HUB_JWKS_MAX_AGE_MS,
  HubAccountLinkError,
  HubSigninError,
  hubLogoutUrl,
  isNetworkError,
  linkHubProfile,
  verifyIdpEvidence
} = await import('../../../auth/hub-signin.js')
const { namespacedSub } = await import('../../../services/users.js')
type Cfg = import('../../../services/hub-signin/config.js').HubSigninConfig

const TID = '11111111-2222-3333-4444-555555555555'
const OID = '99999999-8888-7777-6666-555555555555'
const IDP_AUD = 'hub-entra-client'
const CLIENT = 'hubc_0123456789abcdef01234567'
const SECRET = `hubs_${'s'.repeat(43)}`
const NONCE = 'nonce-abcdefghijklmnopqrstuvwxyz0123456789'
const STATE = 'state-0123456789'
const VERIFIER = 'v'.repeat(50)
const HUB_USER = 'AAAAAAAA-0000-4000-8000-000000000001'
const SID = 'f'.repeat(64)

let server: FastifyInstance
let base = ''
let cfg: Cfg

const keys = {} as {
  hub: { kid: string; priv: CryptoKey; pub: JWK }
  hub2: { kid: string; priv: CryptoKey; pub: JWK }
  entra: { kid: string; priv: CryptoKey; pub: JWK }
  evil: { kid: string; priv: CryptoKey; pub: JWK }
}

const hub = {
  published: [] as JWK[],
  jwksHits: 0,
  discoveryHits: 0,
  tokenHits: 0,
  tokenEndpoint: '' as string,
  token: async (): Promise<{ status: number; body: unknown }> => ({ status: 500, body: {} })
}

async function pair(alg: 'ES256' | 'RS256', kid: string) {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true })
  return { kid, priv: privateKey, pub: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } }
}

beforeAll(async () => {
  keys.hub = await pair('ES256', 'hub-k1')
  keys.hub2 = await pair('ES256', 'hub-k2')
  keys.entra = await pair('RS256', 'entra-k1')
  keys.evil = await pair('RS256', 'evil-k1')

  server = Fastify()
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body))))
  )
  server.get('/api/hub/oidc/.well-known/openid-configuration', async () => {
    hub.discoveryHits++
    const iss = `${base}/api/hub/oidc`
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: hub.tokenEndpoint || `${iss}/token`,
      jwks_uri: `${iss}/jwks`,
      end_session_endpoint: `${iss}/logout`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      authorization_response_iss_parameter_supported: true
    }
  })
  server.get('/api/hub/oidc/jwks', async (_req, reply) => {
    hub.jwksHits++
    return reply.header('cache-control', 'no-store').send({ keys: hub.published })
  })
  server.post('/api/hub/oidc/token', async (_req, reply) => {
    hub.tokenHits++
    const { status, body } = await hub.token()
    return reply.code(status).header('cache-control', 'no-store').send(body)
  })
  server.get('/entra/keys', async () => ({ keys: [keys.entra.pub] }))
  await server.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
  fake.entraJwksUri = `${base}/entra/keys`
  cfg = {
    hubUrl: base,
    issuer: `${base}/api/hub/oidc`,
    clientId: CLIENT,
    clientSecret: SECRET,
    idpAudience: IDP_AUD,
    allowInsecure: true
  }

  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('email')
    t.string('external_id')
    t.string('entra_oid')
    t.string('entra_tid')
    t.string('status')
  })
})

afterAll(async () => {
  await server.close()
  await db.destroy()
})

beforeEach(() => {
  _resetHubSigninForTests()
  hub.published = [keys.hub.pub]
  hub.jwksHits = 0
  hub.discoveryHits = 0
  hub.tokenHits = 0
  hub.tokenEndpoint = ''
})
afterEach(() => vi.restoreAllMocks())

// ─── Token helpers ───────────────────────────────────────────────────────────

async function evidence(
  over: Record<string, unknown> = {},
  opts: { key?: { kid: string; priv: CryptoKey }; iss?: string; aud?: string; exp?: number } = {}
): Promise<string> {
  const k = opts.key ?? keys.entra
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    oid: OID,
    tid: TID,
    email: 'ana@example.com',
    name: 'Ana Lima',
    given_name: 'Ana',
    family_name: 'Lima',
    groups: ['g-1', 'g-2'],
    ver: '2.0',
    ...over
  })
    .setProtectedHeader({ alg: 'RS256', kid: k.kid, typ: 'JWT' })
    .setIssuer(opts.iss ?? fake.entraIssuer)
    .setAudience(opts.aud ?? IDP_AUD)
    .setSubject('entra-pairwise-sub')
    .setIssuedAt(now - 60)
    .setExpirationTime(opts.exp ?? now + 3600)
    .sign(k.priv)
}

async function hubToken(
  over: Record<string, unknown> = {},
  opts: { key?: { kid: string; priv: CryptoKey }; iss?: string; aud?: string } = {}
): Promise<string> {
  const k = opts.key ?? keys.hub
  const claims: JWTPayload = {
    auth_time: Math.floor(Date.now() / 1000) - 60,
    nonce: NONCE,
    sid: SID,
    oid: OID,
    tid: TID,
    email: 'someone-else@example.com',
    idp_id_token: await evidence(),
    ...over
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: k.kid, typ: 'JWT' })
    .setIssuer(opts.iss ?? cfg.issuer)
    .setAudience(opts.aud ?? CLIENT)
    .setSubject(HUB_USER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti('jti-1')
    .sign(k.priv)
}

function unsigned(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ alg: 'none', typ: 'JWT' })}.${b(claims)}.`
}

function answer(idToken: string) {
  hub.token = async () => ({
    status: 200,
    body: {
      access_token: 'nvh_opaque',
      token_type: 'Bearer',
      expires_in: 300,
      scope: 'openid email profile',
      id_token: idToken
    }
  })
}

function callbackUrl(extra: Record<string, string> = { code: 'code-1' }): URL {
  const u = new URL('https://app.example.com/api/auth/callback')
  for (const [k, v] of Object.entries({ ...extra, state: STATE, iss: cfg.issuer }))
    u.searchParams.set(k, v)
  return u
}

const args = { state: STATE, codeVerifier: VERIFIER, nonce: NONCE }

async function codeOf(p: Promise<unknown>): Promise<{ code: string; availability: boolean }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(HubSigninError)
    const e = err as InstanceType<typeof HubSigninError>
    return { code: e.code, availability: e.availability }
  }
  throw new Error('expected a HubSigninError')
}

async function errOf(p: Promise<unknown>): Promise<InstanceType<typeof HubSigninError>> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(HubSigninError)
    return err as InstanceType<typeof HubSigninError>
  }
  throw new Error('expected a HubSigninError')
}

// ─── buildHubLoginUrl ────────────────────────────────────────────────────────

describe('isNetworkError', () => {
  it('system codes with underscores count: EAI_AGAIN (DNS try again) is the network', () => {
    for (const code of ['EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(isNetworkError(Object.assign(new Error('x'), { code }))).toBe(true)
      expect(isNetworkError(new TypeError('other', { cause: { code } }))).toBe(true)
    }
  })

  it('a refusal or a malformed answer is not the network', () => {
    for (const code of ['ERR_JWT_EXPIRED', 'OAUTH_INVALID_RESPONSE', 'Eai_again', 'E1'])
      expect(isNetworkError(Object.assign(new Error('x'), { code }))).toBe(false)
    expect(isNetworkError(new TypeError('bad answer'))).toBe(false)
  })
})

describe('buildHubLoginUrl', () => {
  it('sends the person to the Hub authorize endpoint with PKCE S256, state and nonce', async () => {
    const url = await buildHubLoginUrl(cfg, {
      ...args,
      redirectUri: 'https://app.example.com/api/auth/callback'
    })
    expect(`${url.origin}${url.pathname}`).toBe(`${cfg.issuer}/authorize`)
    const q = url.searchParams
    expect(q.get('client_id')).toBe(CLIENT)
    expect(q.get('redirect_uri')).toBe('https://app.example.com/api/auth/callback')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe('openid email profile')
    expect(q.get('state')).toBe(STATE)
    expect(q.get('nonce')).toBe(NONCE)
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toHaveLength(43)
    // The secret never rides the browser redirect.
    expect(url.href).not.toContain(SECRET)
  })

  it('caches discovery per issuer + client (5 min)', async () => {
    const a = { ...args, redirectUri: 'https://app.example.com/api/auth/callback' }
    await buildHubLoginUrl(cfg, a)
    await buildHubLoginUrl(cfg, a)
    expect(hub.discoveryHits).toBe(1)
    await buildHubLoginUrl({ ...cfg, clientId: 'hubc_other' }, a)
    expect(hub.discoveryHits).toBe(2)
  })

  it('throws when the Hub cannot be reached', async () => {
    const down = { ...cfg, hubUrl: 'http://127.0.0.1:9', issuer: 'http://127.0.0.1:9/api/hub/oidc' }
    await expect(
      buildHubLoginUrl(down, { ...args, redirectUri: 'https://app.example.com/api/auth/callback' })
    ).rejects.toThrow()
  })
})

// ─── verifyIdpEvidence ───────────────────────────────────────────────────────

describe('verifyIdpEvidence', () => {
  const who = { oid: OID, tid: TID }

  it('answers the identity from the evidence', async () => {
    const out = await verifyIdpEvidence(await evidence(), cfg, who)
    expect(out).toEqual({
      sub: 'entra-pairwise-sub',
      email: 'ana@example.com',
      given_name: 'Ana',
      family_name: 'Lima',
      name: 'Ana Lima',
      oid: OID,
      tid: TID,
      groups: ['g-1', 'g-2']
    })
  })

  it('compares oid / tid case-insensitively', async () => {
    const out = await verifyIdpEvidence(await evidence(), cfg, {
      oid: OID.toUpperCase(),
      tid: TID.toUpperCase()
    })
    expect(out.oid).toBe(OID)
  })

  it('missing → EVIDENCE_MISSING', async () => {
    for (const ev of [undefined, null, '', 42, {}]) {
      expect((await codeOf(verifyIdpEvidence(ev, cfg, who))).code).toBe('EVIDENCE_MISSING')
    }
  })

  it('signed by another key → EVIDENCE_INVALID', async () => {
    const ev = await evidence({}, { key: keys.evil })
    expect((await codeOf(verifyIdpEvidence(ev, cfg, who))).code).toBe('EVIDENCE_INVALID')
    // Even when it claims the right kid.
    const forged = await evidence({}, { key: { kid: 'entra-k1', priv: keys.evil.priv } })
    expect((await codeOf(verifyIdpEvidence(forged, cfg, who))).code).toBe('EVIDENCE_INVALID')
  })

  it('aud = another Entra client → EVIDENCE_INVALID', async () => {
    const ev = await evidence({}, { aud: 'some-other-app-in-the-tenant' })
    expect((await codeOf(verifyIdpEvidence(ev, cfg, who))).code).toBe('EVIDENCE_INVALID')
  })

  it('another tenant iss → EVIDENCE_INVALID', async () => {
    const ev = await evidence(
      { tid: '00000000-0000-0000-0000-000000000000' },
      { iss: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0' }
    )
    const out = await codeOf(
      verifyIdpEvidence(ev, cfg, { oid: OID, tid: '00000000-0000-0000-0000-000000000000' })
    )
    expect(out.code).toBe('EVIDENCE_INVALID')
  })

  it('expired (past the 60 s tolerance) → EVIDENCE_INVALID; within it → accepted', async () => {
    const now = Math.floor(Date.now() / 1000)
    const old = await evidence({}, { exp: now - 120 })
    expect((await codeOf(verifyIdpEvidence(old, cfg, who))).code).toBe('EVIDENCE_INVALID')
    const justNow = await evidence({}, { exp: now - 30 })
    await expect(verifyIdpEvidence(justNow, cfg, who)).resolves.toBeTruthy()
  })

  it('an HS256 or alg:none evidence → EVIDENCE_INVALID', async () => {
    const hs = await new SignJWT({ oid: OID, tid: TID })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(fake.entraIssuer)
      .setAudience(IDP_AUD)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('x'.repeat(32)))
    expect((await codeOf(verifyIdpEvidence(hs, cfg, who))).code).toBe('EVIDENCE_INVALID')
    const none = unsigned({
      iss: fake.entraIssuer,
      aud: IDP_AUD,
      oid: OID,
      tid: TID,
      exp: Math.floor(Date.now() / 1000) + 600
    })
    expect((await codeOf(verifyIdpEvidence(none, cfg, who))).code).toBe('EVIDENCE_INVALID')
  })

  it('oid or tid differing from the Hub claims → EVIDENCE_MISMATCH', async () => {
    const ev = await evidence()
    expect(
      (
        await codeOf(
          verifyIdpEvidence(ev, cfg, { oid: 'aaaaaaaa-0000-0000-0000-000000000000', tid: TID })
        )
      ).code
    ).toBe('EVIDENCE_MISMATCH')
    expect(
      (
        await codeOf(
          verifyIdpEvidence(ev, cfg, { oid: OID, tid: 'bbbbbbbb-0000-0000-0000-000000000000' })
        )
      ).code
    ).toBe('EVIDENCE_MISMATCH')
    expect((await codeOf(verifyIdpEvidence(ev, cfg, { oid: null, tid: TID }))).code).toBe(
      'EVIDENCE_MISMATCH'
    )
  })

  it('evidence without oid / tid → EVIDENCE_INVALID', async () => {
    const ev = await evidence({ oid: undefined })
    expect((await codeOf(verifyIdpEvidence(ev, cfg, who))).code).toBe('EVIDENCE_INVALID')
  })

  it('email marked unverified is dropped; upn fills a missing email', async () => {
    const a = await verifyIdpEvidence(await evidence({ email_verified: false }), cfg, who)
    expect(a.email).toBeNull()
    const b = await verifyIdpEvidence(
      await evidence({ email: undefined, upn: 'ana.upn@example.com' }),
      cfg,
      who
    )
    expect(b.email).toBe('ana.upn@example.com')
  })
})

// ─── handleHubCallback ───────────────────────────────────────────────────────

describe('handleHubCallback', () => {
  it('valid tokens → the profile from the evidence, sub namespaced under the Hub issuer', async () => {
    answer(await hubToken())
    const p = await handleHubCallback(cfg, callbackUrl(), args)
    expect(p).toEqual({
      sub: namespacedSub(cfg.issuer, HUB_USER),
      email: 'ana@example.com',
      name: 'Ana Lima',
      given_name: 'Ana',
      family_name: 'Lima',
      groups: ['g-1', 'g-2'],
      title: null,
      company: null,
      department: null,
      phone: null,
      office_location: null,
      city: null,
      state: null,
      country: null,
      employee_id: null,
      preferred_language: null,
      avatar: null,
      entraOid: OID,
      entraTid: TID,
      hubSid: SID
    })
    expect(hub.tokenHits).toBe(1)
  })

  it('Hub token with the wrong aud → TOKEN_INVALID', async () => {
    answer(await hubToken({}, { aud: 'hubc_another_app_000000000' }))
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
  })

  it('Hub token with the wrong iss → TOKEN_INVALID', async () => {
    answer(await hubToken({}, { iss: 'https://evil.example/api/hub/oidc' }))
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
  })

  it('Hub token signed by a key the JWKS does not publish (unknown kid) → TOKEN_INVALID', async () => {
    answer(await hubToken({}, { key: keys.hub2 }))
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
  })

  it('Hub token signed by another key under a published kid → TOKEN_INVALID', async () => {
    answer(await hubToken({}, { key: { kid: 'hub-k1', priv: keys.hub2.priv } }))
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
  })

  it('alg: none → TOKEN_INVALID', async () => {
    const now = Math.floor(Date.now() / 1000)
    answer(
      unsigned({
        iss: cfg.issuer,
        aud: CLIENT,
        sub: HUB_USER,
        iat: now,
        exp: now + 300,
        nonce: NONCE,
        sid: SID,
        oid: OID,
        tid: TID,
        idp_id_token: await evidence()
      })
    )
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
  })

  it('wrong nonce → TOKEN_INVALID', async () => {
    answer(await hubToken({ nonce: 'another-nonce-0123456789' }))
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
  })

  it('a token without evidence (stolen Hub key) signs nobody in → EVIDENCE_MISSING', async () => {
    answer(await hubToken({ idp_id_token: undefined }))
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe(
      'EVIDENCE_MISSING'
    )
  })

  it('evidence naming another person → EVIDENCE_MISMATCH', async () => {
    answer(await hubToken({ oid: 'aaaaaaaa-0000-0000-0000-000000000000' }))
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe(
      'EVIDENCE_MISMATCH'
    )
  })

  it('the Hub redirecting back server_error / temporarily_unavailable → availability', async () => {
    for (const error of ['server_error', 'temporarily_unavailable']) {
      const out = await codeOf(handleHubCallback(cfg, callbackUrl({ error }), args))
      expect(out).toEqual({ code: 'HUB_REFUSED', availability: true })
      const e = await errOf(handleHubCallback(cfg, callbackUrl({ error }), args))
      expect(e.markHubDown).toBe(false)
    }
    expect(hub.tokenHits).toBe(0)
  })

  it('the Hub refusing (access_denied, e.g. a pending account) → HUB_REFUSED, not availability', async () => {
    const out = await codeOf(handleHubCallback(cfg, callbackUrl({ error: 'access_denied' }), args))
    expect(out).toEqual({ code: 'HUB_REFUSED', availability: false })
  })

  it('token endpoint unreachable → HUB_UNREACHABLE (availability)', async () => {
    hub.tokenEndpoint = 'http://127.0.0.1:9/token'
    const out = await codeOf(handleHubCallback(cfg, callbackUrl(), args))
    expect(out).toEqual({ code: 'HUB_UNREACHABLE', availability: true })
    // The server saw it: the Hub is marked down (P7-11).
    hub.tokenEndpoint = 'http://127.0.0.1:9/token'
    _resetHubSigninForTests()
    expect((await errOf(handleHubCallback(cfg, callbackUrl(), args))).markHubDown).toBe(true)
  })

  it('a browser-delivered server_error marks nothing down (P7-11)', async () => {
    const e = await errOf(handleHubCallback(cfg, callbackUrl({ error: 'server_error' }), args))
    expect(e.availability).toBe(true)
    expect(e.markHubDown).toBe(false)
  })

  it('a malformed Hub token response → TOKEN_INVALID, never a network failure', async () => {
    const bodies: Array<{ status: number; body: unknown }> = [
      { status: 200, body: { access_token: 'nvh_x', token_type: 'Bearer', id_token: 42 } },
      { status: 200, body: { token_type: 'Bearer', id_token: 'x' } },
      { status: 200, body: { access_token: 7, token_type: 'Bearer' } },
      { status: 200, body: { access_token: 'nvh_x', token_type: 'Bearer', id_token: 'a.b.c' } },
      { status: 200, body: '<html>not json</html>' }
    ]
    for (const b of bodies) {
      hub.token = async () => b
      const e = await errOf(handleHubCallback(cfg, callbackUrl(), args))
      expect({ body: b.body, code: e.code, down: e.markHubDown }).toEqual({
        body: b.body,
        code: 'TOKEN_INVALID',
        down: false
      })
    }
  })

  it('this app’s Entra keys unreachable → IDP_UNREACHABLE: hop to direct, Hub NOT marked down', async () => {
    answer(await hubToken())
    const keysAt = fake.entraJwksUri
    fake.entraJwksUri = 'http://127.0.0.1:9/keys'
    try {
      const e = await errOf(handleHubCallback(cfg, callbackUrl(), args))
      expect(e.code).toBe('IDP_UNREACHABLE')
      expect(e.availability).toBe(true)
      expect(e.markHubDown).toBe(false)
    } finally {
      fake.entraJwksUri = keysAt
    }
  })

  it('token endpoint answering 503 → HUB_UNREACHABLE; 400 invalid_grant → HUB_REFUSED', async () => {
    hub.token = async () => ({ status: 503, body: { error: 'temporarily_unavailable' } })
    expect(await codeOf(handleHubCallback(cfg, callbackUrl(), args))).toEqual({
      code: 'HUB_UNREACHABLE',
      availability: true
    })
    hub.token = async () => ({ status: 400, body: { error: 'invalid_grant' } })
    expect(await codeOf(handleHubCallback(cfg, callbackUrl(), args))).toEqual({
      code: 'HUB_REFUSED',
      availability: false
    })
  })

  it('token endpoint answering 429 (the Hub limiter or its failed-client brake) → Hub unavailable, marked down (P7-15)', async () => {
    const bodies: Array<{ status: number; body: unknown }> = [
      // plugins/rate-limit.ts tooMany()
      {
        status: 429,
        body: {
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Too many requests from this address without signing in.',
          code: 'RATE_LIMITED',
          retry_after: 30
        }
      },
      // routes/hub-oidc.ts clientFailures brake
      {
        status: 429,
        body: { error: 'invalid_client', error_description: 'Too many failed attempts.' }
      },
      { status: 429, body: '<html>busy</html>' },
      { status: 503, body: { statusCode: 503, error: 'Service Unavailable' } }
    ]
    for (const b of bodies) {
      hub.token = async () => b
      _resetHubSigninForTests()
      const e = await errOf(handleHubCallback(cfg, callbackUrl(), args))
      expect({
        body: b.body,
        code: e.code,
        availability: e.availability,
        down: e.markHubDown
      }).toEqual({
        body: b.body,
        code: 'HUB_UNREACHABLE',
        availability: true,
        down: true
      })
    }
  })

  it('a token exchange that times out → Hub unavailable (P7-15)', async () => {
    _setHubRequestTimeoutForTests(0.3)
    hub.token = () =>
      new Promise((resolve) => setTimeout(() => resolve({ status: 500, body: {} }), 1500))
    try {
      const e = await errOf(handleHubCallback(cfg, callbackUrl(), args))
      expect({ code: e.code, availability: e.availability, down: e.markHubDown }).toEqual({
        code: 'HUB_UNREACHABLE',
        availability: true,
        down: true
      })
    } finally {
      _setHubRequestTimeoutForTests()
    }
  })

  it('a callback whose state differs → TOKEN_INVALID', async () => {
    answer(await hubToken())
    const out = await codeOf(
      handleHubCallback(cfg, callbackUrl(), { ...args, state: 'another-state' })
    )
    expect(out.code).toBe('TOKEN_INVALID')
  })
})

// ─── JWKS cache honours key retirement ───────────────────────────────────────

describe('Hub JWKS cache', () => {
  it('a retired kid stops verifying once the cache max-age has passed', async () => {
    answer(await hubToken())
    await handleHubCallback(cfg, callbackUrl(), args)
    // The Hub retires hub-k1 (it leaves the JWKS after its 24 h grace).
    hub.published = [keys.hub2.pub]
    answer(await hubToken())
    // Still cached: verifies.
    await expect(handleHubCallback(cfg, callbackUrl(), args)).resolves.toBeTruthy()
    const real = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(real + HUB_JWKS_MAX_AGE_MS + 1_000)
    answer(await hubToken())
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
  })

  it('an unknown kid refetches the JWKS at most once per 30 s', async () => {
    answer(await hubToken())
    await handleHubCallback(cfg, callbackUrl(), args)
    expect(hub.jwksHits).toBe(1)
    // A new key appears at the Hub; a token signed with it is refused until the cooldown passes.
    answer(await hubToken({}, { key: keys.hub2 }))
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
    expect((await codeOf(handleHubCallback(cfg, callbackUrl(), args))).code).toBe('TOKEN_INVALID')
    expect(hub.jwksHits).toBe(1)
    hub.published = [keys.hub.pub, keys.hub2.pub]
    const real = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(real + 31_000)
    await expect(handleHubCallback(cfg, callbackUrl(), args)).resolves.toBeTruthy()
    expect(hub.jwksHits).toBe(2)
  })
})

// ─── hubLogoutUrl ────────────────────────────────────────────────────────────

describe('hubLogoutUrl', () => {
  it('names the client, the registered post-logout URI and the sid hash — no secret', () => {
    const url = new URL(
      hubLogoutUrl(cfg, { sid: SID, postLogoutRedirectUri: 'https://app.example.com/login' })
    )
    expect(`${url.origin}${url.pathname}`).toBe(`${cfg.issuer}/logout`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      post_logout_redirect_uri: 'https://app.example.com/login',
      logout_hint: SID
    })
    expect(url.href).not.toContain(SECRET)
  })

  it('no post-logout address for an origin the Hub has not registered (P7-17)', () => {
    const url = new URL(hubLogoutUrl(cfg, { sid: SID, postLogoutRedirectUri: null }))
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: CLIENT, logout_hint: SID })
  })
})

// ─── linkHubProfile: link only by Entra oid/tid, never by email ──────────────

describe('linkHubProfile', () => {
  const profile = () => ({
    sub: namespacedSub(cfg.issuer, HUB_USER),
    email: 'ana@example.com',
    name: 'Ana Lima',
    given_name: 'Ana',
    family_name: 'Lima',
    groups: [],
    title: null,
    company: null,
    department: null,
    phone: null,
    office_location: null,
    city: null,
    state: null,
    country: null,
    employee_id: null,
    preferred_language: null,
    avatar: null,
    entraOid: OID,
    entraTid: TID,
    hubSid: SID
  })

  beforeEach(async () => {
    await db('nivaro_users').del()
  })

  it('an account holding the same entra_oid keeps its subject', async () => {
    await db('nivaro_users').insert({
      id: 'u1',
      email: 'ana.old@example.com',
      external_id: 'primary-entra-sub',
      entra_oid: OID,
      entra_tid: TID,
      status: 'active'
    })
    const out = await linkHubProfile(profile())
    expect(out.sub).toBe('primary-entra-sub')
    expect(out.entraOid).toBe(OID)
  })

  it('matches a stored upper-case oid too', async () => {
    await db('nivaro_users').insert({
      id: 'u1',
      email: 'x@example.com',
      external_id: 'primary-entra-sub',
      entra_oid: OID.toUpperCase(),
      entra_tid: TID,
      status: 'active'
    })
    expect((await linkHubProfile({ ...profile(), entraOid: OID })).sub).toBe('primary-entra-sub')
  })

  it('an oid-linked account with no subject yet gets the Hub subject stamped', async () => {
    await db('nivaro_users').insert({
      id: 'u1',
      email: 'ana@example.com',
      external_id: null,
      entra_oid: OID,
      entra_tid: TID,
      status: 'active'
    })
    const out = await linkHubProfile(profile())
    expect(out.sub).toBe(namespacedSub(cfg.issuer, HUB_USER))
    expect((await db('nivaro_users').where({ id: 'u1' }).first()).external_id).toBe(out.sub)
  })

  it('an account with the same oid in another tenant → refused', async () => {
    await db('nivaro_users').insert({
      id: 'u1',
      email: 'ana@example.com',
      external_id: 'primary-entra-sub',
      entra_oid: OID,
      entra_tid: '00000000-0000-0000-0000-000000000000',
      status: 'active'
    })
    await expect(linkHubProfile(profile())).rejects.toMatchObject({
      name: 'HubAccountLinkError',
      kind: 'conflict',
      userId: 'u1'
    })
  })

  it('an account matching only by email is NEVER linked', async () => {
    await db('nivaro_users').insert({
      id: 'u1',
      email: 'ANA@example.com',
      external_id: 'primary-entra-sub',
      entra_oid: null,
      status: 'active'
    })
    const needsDirect = { name: 'HubAccountLinkError', kind: 'needs_direct', userId: 'u1' }
    await expect(linkHubProfile(profile())).rejects.toMatchObject(needsDirect)
    // A pre-provisioned row (no subject) is not taken by email either.
    await db('nivaro_users').update({ external_id: null })
    await expect(linkHubProfile(profile())).rejects.toMatchObject(needsDirect)
    expect((await db('nivaro_users').where({ id: 'u1' }).first()).external_id).toBeNull()
  })

  it('an account matching the Hub subject but holding another oid → refused', async () => {
    await db('nivaro_users').insert({
      id: 'u1',
      email: 'z@example.com',
      external_id: namespacedSub(cfg.issuer, HUB_USER),
      entra_oid: 'aaaaaaaa-0000-0000-0000-000000000000',
      status: 'active'
    })
    await expect(linkHubProfile(profile())).rejects.toBeInstanceOf(HubAccountLinkError)
    await expect(linkHubProfile(profile())).rejects.toMatchObject({ kind: 'conflict' })
  })

  it('an oid holder without a subject while another account holds the Hub subject → conflict', async () => {
    await db('nivaro_users').insert([
      { id: 'u1', email: 'a@example.com', external_id: null, entra_oid: OID, status: 'active' },
      {
        id: 'u2',
        email: 'b@example.com',
        external_id: namespacedSub(cfg.issuer, HUB_USER),
        entra_oid: null,
        status: 'active'
      }
    ])
    await expect(linkHubProfile(profile())).rejects.toMatchObject({
      kind: 'conflict',
      userId: 'u2'
    })
  })

  it('a lookup that fails (no entra_oid column) refuses the sign-in, never a new account', async () => {
    await db.schema.alterTable('nivaro_users', (t) => t.dropColumn('entra_oid'))
    try {
      await expect(linkHubProfile(profile())).rejects.toThrow()
    } finally {
      await db.schema.alterTable('nivaro_users', (t) => t.string('entra_oid'))
    }
  })

  it('nobody yet → the profile as is (a new account)', async () => {
    const p = profile()
    expect(await linkHubProfile(p)).toEqual(p)
  })

  it('evidence without oid/tid is never linked', async () => {
    await expect(linkHubProfile({ ...profile(), entraOid: null })).rejects.toMatchObject({
      code: 'EVIDENCE_INVALID'
    })
  })
})
