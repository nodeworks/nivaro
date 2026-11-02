import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'
// Two more configured addresses of this instance (APP_URLS): a phone signing in on one of them
// gets that origin as its issuer.
process.env.APP_URLS = 'https://tenant-a.example,https://tenant-b.example'

vi.mock('../db/index.js', () => {
  const users: Record<string, { id: string; status: string }> = {
    U1: { id: 'U1', status: 'active' }
  }
  const db = () => {
    let where: Record<string, unknown> = {}
    const q = {
      where: (w: Record<string, unknown>) => {
        where = w
        return q
      },
      first: async () => {
        const u = users[String(where.id)]
        return u && (where.status == null || u.status === where.status) ? u : undefined
      }
    }
    return q
  }
  return { db }
})
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
const policy = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }))
vi.mock('../services/session-policy.js', async (orig) => ({
  ...(await orig<object>()),
  getSessionPolicy: vi.fn(async () => policy.value)
}))
vi.mock('../admin-base.js', async (orig) => ({
  ...(await orig<object>()),
  servesAdminSpa: false
}))
vi.mock('../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async () => {}),
  authenticate: vi.fn(
    async (req: { session?: { userId?: string }; authMethod?: string; user?: unknown }) => {
      const id = req.session?.userId
      if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      req.authMethod = 'session'
      req.user = { id, status: 'active', first_name: 'Pat', last_name: 'Lee' }
    }
  )
}))

const { oauthPublicRoutes } = await import('./oauth.js')
const { resolveAccessToken, listGrants } = await import('../services/oauth-store.js')
const { logActivity } = await import('../services/activity.js')

/** Just enough Redis for the store (as in the MCP OAuth flow test). */
function fakeRedis() {
  const kv = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const put = async (k: string, v: string) => {
    kv.set(k, v)
    return 'OK'
  }
  const r = {
    kv,
    get: async (k: string) => kv.get(k) ?? null,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    set: put,
    setex: async (k: string, _t: number, v: string) => put(k, v),
    getdel: async (k: string) => {
      const v = kv.get(k) ?? null
      kv.delete(k)
      return v
    },
    del: async (...ks: string[]) => ks.filter((k) => kv.delete(k)).length,
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
    expire: async () => 1,
    incr: async (k: string) => {
      const n = Number(kv.get(k) ?? 0) + 1
      kv.set(k, String(n))
      return n
    },
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    sadd: async (k: string, m: string) => {
      const s = sets.get(k) ?? new Set()
      s.add(m)
      sets.set(k, s)
      return 1
    },
    srem: async (k: string, m: string) => (sets.get(k)?.delete(m) ? 1 : 0),
    multi: () => {
      const ops: Array<() => Promise<unknown>> = []
      const m = {
        set(k: string, v: string) {
          ops.push(() => r.set(k, v))
          return m
        },
        setex(k: string, t: number, v: string) {
          ops.push(() => r.setex(k, t, v))
          return m
        },
        sadd(k: string, v: string) {
          ops.push(() => r.sadd(k, v))
          return m
        },
        srem(k: string, v: string) {
          ops.push(() => r.srem(k, v))
          return m
        },
        del(k: string) {
          ops.push(() => r.del(k))
          return m
        },
        exec: async () => Promise.all(ops.map((o) => o()))
      }
      return m
    }
  }
  return r
}

const session: { userId?: string; oauthCsrf?: string; authAt?: number } = {}
let app: FastifyInstance
const redis = fakeRedis()

beforeAll(async () => {
  app = Fastify()
  app.decorate('redis', redis as never)
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: typeof session }).session = session
  })
  await app.register(oauthPublicRoutes)
  await app.ready()
})
afterAll(() => app.close())
afterEach(() => {
  policy.value = null
  delete process.env.MOBILE_SIGNIN
  delete process.env.MCP_OAUTH
})

const verifier = 'v'.repeat(50)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const REDIRECT = 'dev.nivaro.app:/oauth/callback'
const form = (o: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(o).toString()
})
const params = (over: Record<string, string> = {}) => ({
  client_id: 'nivaro-mobile',
  redirect_uri: REDIRECT,
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'st-m',
  device_name: "Pat's iPhone",
  platform: 'ios',
  ...over
})
const codeKeys = () => [...redis.kv.keys()].filter((k) => k.startsWith('nvr:oauth:code:'))
const signIn = () => {
  session.userId = 'U1'
  session.authAt = Date.now()
}

/** Consent → Allow (or `decision`) → the redirect the app gets back, on `host` if given. */
async function signInCode(p: Record<string, string>, host?: string, decision = 'allow') {
  const headers = host ? { host } : {}
  await app.inject({ url: `/oauth/authorize?${new URLSearchParams(p)}`, headers })
  const f = form({ ...p, csrf: session.oauthCsrf as string, decision })
  const allow = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    ...f,
    headers: { ...f.headers, ...headers }
  })
  expect(allow.statusCode).toBe(302)
  return allow
}
const codeOf = (allow: { headers: Record<string, unknown> }) =>
  new URL(String(allow.headers.location)).searchParams.get('code') as string

/** POST /oauth/token authorization_code for the phone app (override any field). */
const exchange = (code: string, over: Record<string, string> = {}, host?: string) =>
  app.inject({
    method: 'POST',
    url: '/oauth/token',
    ...formOn(host, {
      grant_type: 'authorization_code',
      code,
      client_id: 'nivaro-mobile',
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      ...over
    })
  })
/** form(), sent on `host` when given. */
function formOn(host: string | undefined, o: Record<string, string>) {
  const f = form(o)
  return host ? { ...f, headers: { ...f.headers, host } } : f
}
const deviceGrants = async () =>
  (await listGrants(redis as never, 'U1')).filter((g) => g.kind === 'device')

describe('first-party mobile apps sign in through the OAuth server', () => {
  it('refuses a redirect the app did not register, before any code exists', async () => {
    signIn()
    for (const redirect_uri of ['evil:/cb', 'dev.nivaro.app:/other', `${REDIRECT}#x`]) {
      const res = await app.inject({
        url: `/oauth/authorize?${new URLSearchParams(params({ redirect_uri }))}`
      })
      expect(res.statusCode).toBe(400)
      expect(res.headers.location).toBeUndefined()
      expect(res.body).toContain('did not register')
      // A valid consent post (csrf matches) still stops at the redirect check.
      session.oauthCsrf = 'csrf-ok'
      const post = await app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        ...form({ ...params({ redirect_uri }), csrf: 'csrf-ok', decision: 'allow' })
      })
      expect(post.statusCode).toBe(400)
      expect(post.headers.location).toBeUndefined()
      expect(post.body).toContain('did not register')
    }
    expect(codeKeys()).toHaveLength(0)
  })

  it('shows a sign-in page that names the app and the device', async () => {
    signIn()
    const long = `<b>${'x'.repeat(80)}`
    const res = await app.inject({
      url: `/oauth/authorize?${new URLSearchParams(params({ device_name: long }))}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Sign in to the <strong>Nivaro</strong> app?')
    expect(res.body).toContain('&lt;b&gt;')
    expect(res.body).not.toContain('<b>x')
    // ≤ 60 characters: '<b>' + 57 of the 80 x's.
    expect(res.body).toContain(`&lt;b&gt;${'x'.repeat(57)}"`)
    expect(res.body).not.toContain('x'.repeat(58))
    expect(res.body).toContain('your permissions')
    expect(res.body).not.toContain('name="chat"')
    expect(res.body).toContain('value="allow"')
    expect(res.body).toContain('value="deny"')
    // The page may hand the code to the app's own scheme.
    expect(String(res.headers['content-security-policy'])).toContain('dev.nivaro.app:')
  })

  it('runs consent → code → nvd_/nvdr_ tokens → refresh rotates', async () => {
    signIn()
    vi.mocked(logActivity).mockClear()
    const allow = await signInCode(params())
    const back = String(allow.headers.location)
    expect(back.startsWith(`${REDIRECT}?`)).toBe(true)
    const q = new URL(back).searchParams
    expect(q.get('state')).toBe('st-m')
    // inject's default host is no configured address: MCP_PUBLIC_URL's origin.
    expect(q.get('iss')).toBe('https://nivaro.example')
    // Nothing is connected until the app exchanges the code.
    expect(logActivity).not.toHaveBeenCalled()

    const tok = await exchange(q.get('code') as string)
    expect(tok.statusCode).toBe(200)
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'oauth-connect', comment: "Nivaro on Pat's iPhone" })
    )
    const t = tok.json()
    expect(Object.keys(t).sort()).toEqual(
      ['access_token', 'expires_in', 'refresh_expires_in', 'refresh_token', 'token_type'].sort()
    )
    // A new sign-in: the refresh token's whole life.
    expect(t.refresh_expires_in).toBe(30 * 86_400)
    expect(t.access_token.startsWith('nvd_')).toBe(true)
    expect(t.refresh_token.startsWith('nvdr_')).toBe(true)
    expect(t.expires_in).toBe(3600)
    expect(t.token_type).toBe('Bearer')

    const rec = await resolveAccessToken(redis as never, t.access_token, 'device')
    expect(rec).toMatchObject({
      user_id: 'U1',
      client_id: 'nivaro-mobile',
      kind: 'device',
      device_name: "Pat's iPhone",
      platform: 'ios'
    })
    // A device token is never an MCP token.
    expect(await resolveAccessToken(redis as never, t.access_token)).toBeNull()
    const grant = (await listGrants(redis as never, 'U1')).find((g) => g.id === rec?.grant_id)
    expect(grant).toMatchObject({
      kind: 'device',
      client_id: 'nivaro-mobile',
      client_name: 'Nivaro',
      device_name: "Pat's iPhone",
      platform: 'ios'
    })

    const ref = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: 'nivaro-mobile'
      })
    })
    expect(ref.statusCode).toBe(200)
    const r2 = ref.json()
    expect(r2.access_token.startsWith('nvd_')).toBe(true)
    expect(r2.refresh_token.startsWith('nvdr_')).toBe(true)
    expect(r2.refresh_token).not.toBe(t.refresh_token)
    expect(await resolveAccessToken(redis as never, r2.access_token, 'device')).toMatchObject({
      kind: 'device',
      device_name: "Pat's iPhone"
    })
    // The app lost that answer and retries the same refresh at once: the same pair again, and
    // the sign-in stays (idempotent inside the reuse grace window).
    const reuse = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: 'nivaro-mobile'
      })
    })
    expect(reuse.statusCode).toBe(200)
    expect(reuse.json()).toMatchObject({
      access_token: r2.access_token,
      refresh_token: r2.refresh_token,
      token_type: 'Bearer'
    })
    expect(await resolveAccessToken(redis as never, r2.access_token, 'device')).not.toBeNull()
  })

  it('iss is the configured address the sign-in arrived on; the code is exchanged only there', async () => {
    signIn()
    const allow = await signInCode(params(), 'tenant-a.example')
    const q = new URL(String(allow.headers.location)).searchParams
    expect(q.get('iss')).toBe('https://tenant-a.example')
    const deny = await signInCode(params(), 'tenant-a.example', 'deny')
    const dq = new URL(String(deny.headers.location)).searchParams
    expect(dq.get('error')).toBe('access_denied')
    expect(dq.get('iss')).toBe('https://tenant-a.example')
    // Another host never takes this code (an issuer mix-up): refused, and the code is spent.
    const other = await exchange(q.get('code') as string, {}, 'tenant-b.example')
    expect(other.statusCode).toBe(400)
    expect(other.json().error_description).toMatch(/another address/)
    const again = await signInCode(params(), 'tenant-a.example')
    const ok = await exchange(codeOf(again), {}, 'tenant-a.example')
    expect(ok.statusCode).toBe(200)
  })

  it('behind a proxy nobody trusts, an internal host gets MCP_PUBLIC_URL, never itself', async () => {
    signIn()
    const allow = await signInCode(params(), 'nivaro:3055')
    expect(new URL(String(allow.headers.location)).searchParams.get('iss')).toBe(
      'https://nivaro.example'
    )
    // A forwarded host is not believed without TRUST_PROXY.
    await app.inject({
      url: `/oauth/authorize?${new URLSearchParams(params())}`,
      headers: { host: 'nivaro:3055', 'x-forwarded-host': 'tenant-a.example' }
    })
    const f = form({ ...params(), csrf: session.oauthCsrf as string, decision: 'allow' })
    const fwd = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      ...f,
      headers: { ...f.headers, host: 'nivaro:3055', 'x-forwarded-host': 'tenant-a.example' }
    })
    expect(new URL(String(fwd.headers.location)).searchParams.get('iss')).toBe(
      'https://nivaro.example'
    )
  })

  it('discovery names the same issuer as the authorize answer, per host', async () => {
    signIn()
    for (const host of ['tenant-a.example', 'nivaro:3055', 'nivaro.example']) {
      const doc = (
        await app.inject({ url: '/.well-known/oauth-authorization-server', headers: { host } })
      ).json()
      const allow = await signInCode(params(), host)
      const iss = new URL(String(allow.headers.location)).searchParams.get('iss')
      expect(doc.issuer).toBe(iss)
      expect(doc.token_endpoint).toBe(`${iss}/oauth/token`)
    }
  })

  it('a replayed refresh is bound to the install_id the first refresh sent, and logged', async () => {
    signIn()
    const tok = (await exchange(codeOf(await signInCode(params())))).json()
    const refresh = (extra: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/oauth/token',
        ...form({
          grant_type: 'refresh_token',
          refresh_token: tok.refresh_token,
          client_id: 'nivaro-mobile',
          ...extra
        })
      })
    const first = await refresh({ install_id: 'inst-1' })
    expect(first.statusCode).toBe(200)
    vi.mocked(logActivity).mockClear()
    expect((await refresh()).statusCode).toBe(400)
    expect((await refresh({ install_id: 'inst-2' })).statusCode).toBe(400)
    const again = await refresh({ install_id: 'inst-1' })
    expect(again.statusCode).toBe(200)
    expect(again.json().refresh_token).toBe(first.json().refresh_token)
    const rec = await resolveAccessToken(redis as never, again.json().access_token, 'device')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'oauth-refresh-replayed',
        user: 'U1',
        comment: rec?.grant_id
      })
    )
  })

  it('refresh_expires_in on a refresh is what is left of the sign-in (role max age)', async () => {
    signIn()
    const tok = (await exchange(codeOf(await signInCode(params())))).json()
    expect(tok.refresh_expires_in).toBe(30 * 86_400)
    policy.value = { max_age_hours: 48 }
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: 'nivaro-mobile'
      })
    })
    expect(r.statusCode).toBe(200)
    const left = r.json().refresh_expires_in
    expect(left).toBeLessThanOrEqual(48 * 3600)
    expect(left).toBeGreaterThan(48 * 3600 - 60)
    // No max age: the refresh token's own 30 days.
    policy.value = null
    const r2 = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'refresh_token',
        refresh_token: r.json().refresh_token,
        client_id: 'nivaro-mobile'
      })
    })
    expect(r2.json().refresh_expires_in).toBe(30 * 86_400)
  })

  it('each phone sign-in is its own connection', async () => {
    signIn()
    const before = (await deviceGrants()).length
    for (let i = 0; i < 2; i++) {
      const code = codeOf(await signInCode(params({ device_name: 'Pixel', platform: 'android' })))
      expect((await exchange(code)).statusCode).toBe(200)
    }
    expect((await deviceGrants()).length).toBe(before + 2)
    // An unknown platform is dropped, not stored.
    const code = codeOf(await signInCode(params({ device_name: 'Tab', platform: 'windows' })))
    expect((await exchange(code)).statusCode).toBe(200)
    const tab = (await deviceGrants()).find((g) => g.device_name === 'Tab')
    expect(tab).toBeTruthy()
    expect(tab?.platform).toBeUndefined()
  })

  it('an abandoned or failed sign-in leaves no device grant behind', async () => {
    signIn()
    const before = (await deviceGrants()).length
    // Allowed, never exchanged.
    await signInCode(params({ device_name: 'Abandoned' }))
    expect((await deviceGrants()).length).toBe(before)
    // Wrong verifier: refused, and the code is spent.
    const bad = codeOf(await signInCode(params({ device_name: 'Bad PKCE' })))
    const wrong = await exchange(bad, { code_verifier: 'w'.repeat(50) })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error).toBe('invalid_grant')
    expect((await exchange(bad)).statusCode).toBe(400)
    // A phone code redeemed by another client is refused.
    const other = codeOf(await signInCode(params({ device_name: 'Other client' })))
    const stolen = await exchange(other, {
      client_id: 'nvc_00000000-0000-0000-0000-000000000000'
    })
    expect(stolen.statusCode).toBe(400)
    expect(stolen.json().error).toBe('invalid_grant')
    expect((await deviceGrants()).length).toBe(before)
    // A good code works once: the second exchange is refused and makes no second grant.
    const good = codeOf(await signInCode(params({ device_name: 'Once' })))
    expect((await exchange(good)).statusCode).toBe(200)
    const reused = await exchange(good)
    expect(reused.statusCode).toBe(400)
    expect(reused.json().error).toBe('invalid_grant')
    expect((await deviceGrants()).length).toBe(before + 1)
  })

  it('device fields are for phone apps only; a phone app ignores resource', async () => {
    signIn()
    // A phone app naming another server is not refused — the resource is simply not carried.
    const mobile = await app.inject({
      url: `/oauth/authorize?${new URLSearchParams(params({ resource: 'https://evil.example' }))}`
    })
    expect(mobile.statusCode).toBe(200)
    expect(mobile.body).not.toContain('name="resource"')
    expect(mobile.body).toContain('name="device_name"')
    // An MCP client's device_name / platform are dropped.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }
    })
    const mcp = await app.inject({
      url: `/oauth/authorize?${new URLSearchParams(
        params({ client_id: reg.json().client_id, redirect_uri: 'https://claude.ai/cb' })
      )}`
    })
    expect(mcp.statusCode).toBe(200)
    expect(mcp.body).toContain('Connect <strong>Claude</strong>')
    expect(mcp.body).not.toContain('name="device_name"')
    expect(mcp.body).not.toContain('name="platform"')
  })

  it('MOBILE_SIGNIN=off: authorize and token answer 404 for mobile apps', async () => {
    signIn()
    process.env.MOBILE_SIGNIN = 'off'
    const res = await app.inject({ url: `/oauth/authorize?${new URLSearchParams(params())}` })
    expect(res.statusCode).toBe(404)
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({ grant_type: 'refresh_token', refresh_token: 'nvdr_x', client_id: 'nivaro-mobile' })
    })
    expect(tok.statusCode).toBe(404)
  })

  it('mobile sign-in works with MCP OAuth off; MCP registration does not', async () => {
    signIn()
    process.env.MCP_OAUTH = 'off'
    const res = await app.inject({ url: `/oauth/authorize?${new URLSearchParams(params())}` })
    expect(res.statusCode).toBe(200)
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'X', redirect_uris: ['https://x.example/cb'] }
    })
    expect(reg.statusCode).toBe(404)
    const as = await app.inject({ url: '/.well-known/oauth-authorization-server' })
    expect(as.statusCode).toBe(200)
    expect(as.json().registration_endpoint).toBeUndefined()
    expect(as.json().token_endpoint).toBe('https://nivaro.example/oauth/token')
    expect((await app.inject({ url: '/.well-known/oauth-protected-resource' })).statusCode).toBe(
      404
    )
  })

  it('a dynamic registration can never claim a mobile client id', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        client_id: 'nivaro-mobile',
        client_name: 'Nivaro',
        redirect_uris: ['https://x.example/cb']
      }
    })
    expect(reg.statusCode).toBe(400)
    expect(reg.json().error).toBe('invalid_client_metadata')
  })
})
