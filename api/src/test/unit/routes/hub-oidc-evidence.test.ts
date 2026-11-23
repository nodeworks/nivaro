import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: Entra evidence capture at Hub sign-in (plan Decision 2).
//  - evidenceFromTokens / evidenceFresh: what counts as evidence.
//  - routes/auth.ts: only the PRIMARY OIDC callback stores it, only with HUB=on; a sign-in that
//    still needs TOTP parks it until the code passes; an additional provider and SAML never do.

vi.hoisted(() => {
  process.env.PUBLIC_URL = 'http://localhost:3055'
  process.env.ADMIN_URL = 'http://localhost:3056'
  process.env.OIDC_CLIENT_ID = 'hub-entra-client-id'
  process.env.OIDC_ISSUER =
    'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0'
})

const state = vi.hoisted(() => ({
  idToken: '',
  totp: false
}))

vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull', 'whereNotNull', 'orderBy', 'select']) c[m] = () => c
    // loadSsoProvider: an additional provider row; /totp: the pending person.
    c.first = async () =>
      table === 'nivaro_users'
        ? { id: 'U1', status: 'active', totp_enabled: true, totp_secret: 'SECRET' }
        : {
            id: 5,
            issuer: 'https://idp.other.example',
            client_id: 'other',
            client_secret: null,
            scopes: null
          }
    c.update = async () => 1
    c.catch = () => c
    return c
  }
  return { db: vi.fn((table: string) => chain(table)) }
})
vi.mock('../../../auth/oidc.js', async (orig) => {
  const profile = () => ({
    sub: 'sub-1',
    email: 'pat@entra.example.com',
    name: 'Pat Entra',
    given_name: 'Pat',
    family_name: 'Entra',
    groups: [],
    entraOid: OID,
    entraTid: TID,
    tokens: { id_token: state.idToken }
  })
  return {
    ...(await orig<typeof import('../../../auth/oidc.js')>()),
    handleCallback: vi.fn(async () => profile()),
    handleDynamicCallback: vi.fn(async () => profile())
  }
})
vi.mock('../../../auth/saml.js', async (orig) => ({
  ...(await orig<typeof import('../../../auth/saml.js')>()),
  samlEnabled: () => true,
  getSaml: () => ({
    validatePostResponseAsync: async () => ({ profile: { ID: 'a1' }, loggedOut: false })
  }),
  consumeAssertionId: async () => true,
  // Even a SAML identity that carried an Entra token is never evidence.
  extractSamlIdentity: () => ({
    sub: 'saml:pat',
    email: 'pat@entra.example.com',
    tokens: { id_token: state.idToken }
  })
}))
vi.mock('../../../services/users.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/users.js')>()),
  findOrCreateFromOIDC: vi.fn(async () => ({
    id: 'U1',
    status: 'active',
    totp_enabled: state.totp,
    totp_secret: state.totp ? 'SECRET' : null
  }))
}))
vi.mock('../../../auth/role-sign-in.js', () => ({ signInAllowedByRole: vi.fn(async () => true) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/security.js', () => ({ recordLogin: vi.fn(async () => undefined) }))
vi.mock('../../../services/sessions-live.js', () => ({ noteSessionsChanged: vi.fn() }))
vi.mock('../../../services/sign-in-troubleshooter.js', () => ({
  matchAttemptedIdentity: vi.fn(async () => null),
  noteSignInApp: vi.fn(async () => undefined),
  noteSignInFailure: vi.fn(async () => undefined)
}))
vi.mock('otplib', () => ({ verify: vi.fn(async () => ({ valid: true })) }))

const TID = '11111111-2222-3333-4444-555555555555'
const OID = '99999999-8888-7777-6666-555555555555'
const FOREIGN = '00000000-0000-0000-0000-000000000000'

const { authRoutes } = await import('../../../routes/auth.js')
const { evidenceFromTokens, evidenceFresh, EVIDENCE_MIN_LIFE_MS, _resetEvidenceWarningsForTests } =
  await import('../../../services/hub/oidc/evidence.js')
const { config } = await import('../../../config.js')

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function idToken(claims: Record<string, unknown> = {}, drop: string[] = []): string {
  const now = Math.floor(Date.now() / 1000)
  const c: Record<string, unknown> = {
    iss: `https://login.microsoftonline.com/${TID}/v2.0`,
    aud: 'hub-entra-client-id',
    oid: OID,
    tid: TID,
    iat: now,
    auth_time: now - 5,
    exp: now + 3600,
    email: 'pat@entra.example.com',
    name: 'Pat Entra',
    given_name: 'Pat',
    family_name: 'Entra',
    ...claims
  }
  for (const k of drop) delete c[k]
  return [b64({ alg: 'RS256', typ: 'JWT' }), b64(c), 'sig'].join('.')
}

// ─── evidenceFromTokens / evidenceFresh ──────────────────────────────────────

describe('evidenceFromTokens', () => {
  it('copies the raw token, oid, tid, exp, auth_time, email and the names', () => {
    // Pin the times in the token: reading the clock twice can cross a second boundary.
    const authTime = Math.floor(Date.now() / 1000) - 5
    const t = idToken({ auth_time: authTime })
    const ev = evidenceFromTokens({ id_token: t })
    expect(ev).toMatchObject({
      id_token: t,
      oid: OID,
      tid: TID,
      email: 'pat@entra.example.com',
      name: 'Pat Entra',
      given_name: 'Pat',
      family_name: 'Entra'
    })
    expect(ev?.auth_time).toBe(authTime)
  })

  it('falls back to iat for auth_time and upn for email', () => {
    const iat = Math.floor(Date.now() / 1000)
    const ev = evidenceFromTokens({
      id_token: idToken({ upn: 'pat@upn.example.com', iat }, ['auth_time', 'email'])
    })
    expect(ev?.auth_time).toBe(iat)
    expect(ev?.email).toBe('pat@upn.example.com')
  })

  it.each([
    ['no tokens', null],
    ['no id_token', {}],
    ['not a JWT', { id_token: 'garbage' }],
    ['no oid', { id_token: idToken({}, ['oid']) }],
    ['no tid', { id_token: idToken({}, ['tid']) }],
    ['no exp', { id_token: idToken({}, ['exp']) }],
    ['no auth_time or iat', { id_token: idToken({}, ['auth_time', 'iat']) }],
    [
      'common issuer',
      { id_token: idToken({ iss: 'https://login.microsoftonline.com/common/v2.0' }) }
    ],
    [
      'organizations issuer',
      { id_token: idToken({ iss: 'https://login.microsoftonline.com/organizations/v2.0' }) }
    ],
    [
      "another tenant's issuer",
      {
        id_token: idToken({
          iss: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0'
        })
      }
    ],
    ['http issuer', { id_token: idToken({ iss: `http://login.microsoftonline.com/${TID}/v2.0` }) }],
    [
      'a foreign tenant with its own matching issuer',
      {
        id_token: idToken({
          tid: FOREIGN,
          iss: `https://login.microsoftonline.com/${FOREIGN}/v2.0`
        })
      }
    ],
    ['a foreign host', { id_token: idToken({ iss: `https://login.evil.example/${TID}/v2.0` }) }],
    [
      'the v1 issuer form when the Hub is set up with v2',
      { id_token: idToken({ iss: `https://sts.windows.net/${TID}/` }) }
    ],
    [
      'another issuer path',
      { id_token: idToken({ iss: `https://login.microsoftonline.com/${TID}/v2.1` }) }
    ],
    ['another Entra client as audience', { id_token: idToken({ aud: 'some-other-app' }) }],
    ['several audiences', { id_token: idToken({ aud: ['hub-entra-client-id', 'other'] }) }],
    ['an oversized token', { id_token: `${idToken()}${'x'.repeat(20_000)}` }]
  ])('%s → null', (_why, tokens) => {
    expect(evidenceFromTokens(tokens)).toBeNull()
  })

  it('a trailing slash on either side is ignored', () => {
    expect(
      evidenceFromTokens({
        id_token: idToken({ iss: `https://login.microsoftonline.com/${TID}/v2.0/` })
      })
    ).not.toBeNull()
    const prev = config.OIDC_ISSUER
    config.OIDC_ISSUER = `${prev}/`
    try {
      expect(evidenceFromTokens({ id_token: idToken() })).not.toBeNull()
    } finally {
      config.OIDC_ISSUER = prev
    }
  })

  it('a common / organizations / consumers Hub issuer: no evidence at all, logged once', () => {
    const prev = config.OIDC_ISSUER
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    _resetEvidenceWarningsForTests()
    try {
      for (const tenant of ['common', 'organizations', 'consumers']) {
        config.OIDC_ISSUER = `https://login.microsoftonline.com/${tenant}/v2.0`
        expect(evidenceFromTokens({ id_token: idToken() })).toBeNull()
        expect(
          evidenceFromTokens({
            id_token: idToken({ iss: `https://login.microsoftonline.com/${tenant}/v2.0` })
          })
        ).toBeNull()
      }
      config.OIDC_ISSUER = ''
      expect(evidenceFromTokens({ id_token: idToken() })).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      config.OIDC_ISSUER = prev
      warn.mockRestore()
    }
  })

  it('evidenceFresh needs two minutes left', () => {
    const now = Date.now()
    const ev = evidenceFromTokens({ id_token: idToken() })
    if (!ev) throw new Error('no evidence')
    expect(evidenceFresh({ ...ev, exp: (now + EVIDENCE_MIN_LIFE_MS) / 1000 }, now)).toBe(true)
    expect(evidenceFresh({ ...ev, exp: (now + EVIDENCE_MIN_LIFE_MS - 1000) / 1000 }, now)).toBe(
      false
    )
    expect(evidenceFresh({ ...ev, exp: Number.NaN }, now)).toBe(false)
  })
})

// ─── Capture in routes/auth.ts ───────────────────────────────────────────────

function memRedis() {
  const kv = new Map<string, string>()
  const r = {
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    get: async (k: string) => kv.get(k) ?? null,
    incr: async () => 1,
    ttl: async () => -2,
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

type FakeSession = Record<string, any> & { sessionId: string }

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

async function build(session: FakeSession) {
  const app = Fastify({ logger: false })
  app.decorate('redis', memRedis() as never)
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: FakeSession }).session = session
  })
  await app.register(authRoutes)
  await app.ready()
  return app
}

const callbackSession = (extra: Record<string, unknown> = {}) =>
  fakeSession({
    oidcState: 's',
    codeVerifier: 'v',
    oidcRedirectUri: 'http://localhost:3056/api/auth/callback',
    returnTo: 'http://localhost:3056/',
    ...extra
  })

let prevHub: string | undefined
beforeEach(() => {
  prevHub = process.env.HUB
  state.idToken = idToken()
  state.totp = false
})
afterEach(() => {
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
  vi.clearAllMocks()
})

describe('evidence capture at sign-in', () => {
  it('primary OIDC callback with HUB=on → evidence on the new session, bound to the person', async () => {
    process.env.HUB = 'on'
    const s = callbackSession()
    const res = await (await build(s)).inject({ method: 'GET', url: '/callback?code=c&state=s' })
    expect(res.statusCode).toBe(302)
    expect(s.userId).toBe('U1')
    expect(s.sessionId).not.toBe('sid-original')
    expect(s.hubIdpEvidence).toMatchObject({
      id_token: state.idToken,
      oid: OID,
      tid: TID,
      user_id: 'U1',
      given_name: 'Pat',
      family_name: 'Entra'
    })
    expect(typeof s.hubIdpEvidence.captured_at).toBe('number')
  })

  it('HUB off → no evidence', async () => {
    delete process.env.HUB
    const s = callbackSession()
    await (await build(s)).inject({ method: 'GET', url: '/callback?code=c&state=s' })
    expect(s.userId).toBe('U1')
    expect(s.hubIdpEvidence).toBeUndefined()
  })

  it('an additional provider never sets it', async () => {
    process.env.HUB = 'on'
    const s = callbackSession({ oidcProviderId: 5 })
    await (await build(s)).inject({ method: 'GET', url: '/callback?code=c&state=s' })
    expect(s.userId).toBe('U1')
    expect(s.hubIdpEvidence).toBeUndefined()
    expect(s.pendingHubIdpEvidence).toBeUndefined()
  })

  it('SAML never sets it', async () => {
    process.env.HUB = 'on'
    const s = fakeSession({ returnTo: 'http://localhost:3056/' })
    const res = await (await build(s)).inject({
      method: 'POST',
      url: '/saml/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'SAMLResponse=x'
    })
    expect(res.statusCode).toBe(302)
    expect(s.userId).toBe('U1')
    expect(s.hubIdpEvidence).toBeUndefined()
  })

  it('a token that is not evidence (wrong audience) stores nothing, the sign-in still works', async () => {
    process.env.HUB = 'on'
    state.idToken = idToken({ aud: 'some-other-app' })
    const s = callbackSession()
    await (await build(s)).inject({ method: 'GET', url: '/callback?code=c&state=s' })
    expect(s.userId).toBe('U1')
    expect(s.hubIdpEvidence).toBeUndefined()
  })

  it('TOTP: evidence waits on the pending sign-in and moves over when the code passes', async () => {
    process.env.HUB = 'on'
    state.totp = true
    const s = callbackSession()
    const app = await build(s)
    const cb = await app.inject({ method: 'GET', url: '/callback?code=c&state=s' })
    expect(String(cb.headers.location)).toMatch(/totp=1/)
    expect(s.userId).toBeUndefined()
    expect(s.hubIdpEvidence).toBeUndefined()
    expect(s.pendingHubIdpEvidence).toMatchObject({ oid: OID, user_id: 'U1' })
    const ok = await app.inject({
      method: 'POST',
      url: '/totp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: '123456' })
    })
    expect(ok.statusCode).toBe(200)
    expect(s.userId).toBe('U1')
    expect(s.hubIdpEvidence).toMatchObject({ oid: OID, user_id: 'U1' })
    expect(s.pendingHubIdpEvidence).toBeUndefined()
  })

  it('TOTP after SAML: nothing to carry', async () => {
    process.env.HUB = 'on'
    state.totp = true
    const s = fakeSession({ returnTo: 'http://localhost:3056/' })
    const app = await build(s)
    await app.inject({
      method: 'POST',
      url: '/saml/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'SAMLResponse=x'
    })
    expect(s.pendingHubIdpEvidence).toBeUndefined()
    await app.inject({
      method: 'POST',
      url: '/totp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: '123456' })
    })
    expect(s.userId).toBe('U1')
    expect(s.hubIdpEvidence).toBeUndefined()
  })
})
