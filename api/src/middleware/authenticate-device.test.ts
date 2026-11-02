import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

/**
 * Device tokens (nvd_, the phone app) sign the person in like a session: the real
 * `authenticate` against the real token store over a fake Redis, and the real token endpoint
 * judging the session policy on refresh.
 */

const ROLE = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const state = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; status: string; role: string | null }>,
  roles: {} as Record<string, { id: string; admin_access: boolean; app_access: boolean }>,
  /** The users table answers with an error (a database blip). */
  usersDown: false,
  /** Push rows deleted: the ids each delete named. */
  pushDeletes: [] as unknown[][]
}))

vi.mock('../db/index.js', () => {
  const db = (table: string) => {
    let where: Record<string, unknown> = {}
    const q: Record<string, unknown> = {}
    for (const m of ['whereNull', 'orWhere', 'select', 'orderBy']) q[m] = () => q
    q.where = (w: Record<string, unknown>) => {
      if (w && typeof w === 'object') where = { ...where, ...w }
      return q
    }
    q.first = async () => {
      if (table === 'nivaro_users') {
        if (state.usersDown) throw new Error('database unavailable')
        const u = state.users[String(where.id)]
        if (!u || (where.status != null && u.status !== where.status)) return undefined
        return { ...u }
      }
      if (table === 'nivaro_roles') return state.roles[String(where.id)]
      if (table === 'nivaro_api_keys')
        return { id: 7, name: 'Phone test', prefix: 'nvk_abcd', user: 'U1', scopes: '[]' }
      return undefined
    }
    q.update = () => ({ catch: () => undefined })
    q.insert = async () => [7]
    let ids: unknown[] = []
    q.whereIn = (_c: string, v: unknown[]) => {
      ids = v
      return q
    }
    q.del = async () => {
      if (table === 'nivaro_push_subscriptions') state.pushDeletes.push(ids)
      return ids.length
    }
    // The key list (`db('nivaro_api_keys').orderBy(…)`) answers no rows.
    if (table === 'nivaro_api_keys') q.orderBy = async () => []
    return q
  }
  return { db, _staticDb: db, _backgroundDb: null, resolveDb: () => db }
})
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../admin-base.js', async (orig) => ({
  ...(await orig<object>()),
  servesAdminSpa: false
}))
const policy = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../services/session-policy.js', async (orig) => ({
  ...(await orig<object>()),
  getSessionPolicy: async () => policy.value
}))

const { authenticate } = await import('./authenticate.js')
const { deviceRoutes } = await import('../routes/devices.js')
const { oauthPublicRoutes } = await import('../routes/oauth.js')
const { apiKeysRoutes } = await import('../routes/api-keys.js')
const store = await import('../services/oauth-store.js')
const { bindFromRequest } = await import('../services/socket-access.js')
const { isHumanSession } = await import('../services/agent-questions.js')
const { sessionTag, ticketSignInEnded, SIDTAG_PREFIX } = await import('../services/help-videos.js')

/** Just enough Redis for the token store (as in the OAuth flow tests). */
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

const redis = fakeRedis()
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  app.decorate('redis', redis as never)
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: unknown }).session = {
      // A browser session for U1, when the test asks for one.
      userId: req.headers['x-test-session'] ? 'U1' : undefined,
      destroy: async () => {}
    }
  })
  const who = async (req: import('fastify').FastifyRequest) => ({
    id: req.user?.id,
    method: req.authMethod,
    grant: req.deviceGrantId ?? null,
    device: req.deviceName ?? null,
    oauth_client: req.oauthClientId ?? null
  })
  app.get('/api/auth/me', { preHandler: authenticate }, who)
  await app.register(apiKeysRoutes, { prefix: '/api/api-keys' })
  app.post('/api/mcp', { preHandler: authenticate }, who)
  app.get('/api/chat/rooms', { preHandler: authenticate }, who)
  // As routes/auth.ts GET /ws-token: what signed the request in, or 403 WS_UNBINDABLE.
  app.get('/api/auth/ws-token', { preHandler: authenticate }, async (req, reply) => {
    const bind = bindFromRequest(req)
    if (!bind) return reply.code(403).send({ code: 'WS_UNBINDABLE' })
    return { bind }
  })
  app.get('/api/agent-questions/answerer', { preHandler: authenticate }, async (req) => ({
    human: isHumanSession(req)
  }))
  app.get('/api/help-videos/tag', { preHandler: authenticate }, async (req) => ({
    tag: sessionTag(req)
  }))
  await app.register(oauthPublicRoutes)
  await app.register(deviceRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  state.users = { U1: { id: 'U1', status: 'active', role: ROLE } }
  state.roles = { [ROLE]: { id: ROLE, admin_access: true, app_access: true } }
  state.usersDown = false
  state.pushDeletes = []
  policy.value = null
})
afterEach(() => {
  delete process.env.MOBILE_SIGNIN
  delete process.env.MCP_OAUTH
})

/** A phone signed in as U1: its grant and first token pair, as the code exchange makes them. */
async function phone(deviceName = "Pat's iPhone") {
  const grant = await store.createDeviceGrant(
    redis as never,
    'U1',
    { client_id: 'nivaro-mobile', client_name: 'Nivaro' },
    { device_name: deviceName, platform: 'ios' }
  )
  const tokens = await store.issueTokens(
    redis as never,
    {
      grant_id: grant.id,
      user_id: 'U1',
      client_id: 'nivaro-mobile',
      resource: null,
      device_name: deviceName,
      platform: 'ios'
    },
    'device'
  )
  return { grant, ...tokens }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('device tokens act as the person', () => {
  it('signs the person in on any route, like a session — never as an OAuth MCP token', async () => {
    const { grant, access_token } = await phone()
    expect(access_token.startsWith('nvd_')).toBe(true)
    const me = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({
      id: 'U1',
      method: 'device',
      grant: grant.id,
      device: "Pat's iPhone",
      oauth_client: null
    })
    // An administrator's phone reaches administration (an MCP token is refused here: below).
    const keys = await app.inject({ url: '/api/api-keys', headers: bearer(access_token) })
    expect(keys.statusCode).toBe(200)
    // Chat needs no OAuth chat scope.
    const chat = await app.inject({ url: '/api/chat/rooms', headers: bearer(access_token) })
    expect(chat.statusCode).toBe(200)
    // On /api/mcp the person, not a connected app.
    const mcp = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: bearer(access_token),
      payload: {}
    })
    expect(mcp.statusCode).toBe(200)
    expect(mcp.json()).toMatchObject({ method: 'device', oauth_client: null })
  })

  it('an MCP token stays held to /api/mcp (the gate device tokens skip)', async () => {
    const grant = await store.upsertGrant(
      redis as never,
      'U1',
      { client_id: 'nvc_test', client_name: 'Assistant' },
      'nivaro'
    )
    const { access_token } = await store.issueTokens(redis as never, {
      grant_id: grant.id,
      user_id: 'U1',
      client_id: 'nvc_test',
      resource: null
    })
    const keys = await app.inject({ url: '/api/api-keys', headers: bearer(access_token) })
    expect(keys.statusCode).toBe(403)
    expect(keys.json().code).toBe('OAUTH_TOKEN_AUDIENCE')
  })

  it('a person suspended after sign-in is refused on the next call', async () => {
    const { access_token } = await phone()
    state.users.U1.status = 'suspended'
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('ACCOUNT_NOT_ACTIVE')
  })

  it('a revoked phone is refused on the next call', async () => {
    const { grant, access_token } = await phone()
    expect(
      (await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })).statusCode
    ).toBe(200)
    await store.revokeGrant(redis as never, 'U1', grant.id)
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('TOKEN_INVALID')
  })

  it('a role with sign-in turned off keeps the phone out', async () => {
    const { access_token } = await phone()
    state.roles[ROLE].app_access = false
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('SIGN_IN_DISABLED')
  })

  it('MOBILE_SIGNIN=off refuses every device token', async () => {
    const { access_token } = await phone()
    process.env.MOBILE_SIGNIN = 'off'
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('TOKEN_INVALID')
  })

  it('MCP_OAUTH=off does not stop phones', async () => {
    const { access_token } = await phone()
    process.env.MCP_OAUTH = 'off'
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.statusCode).toBe(200)
  })

  it('a device token never resolves as an MCP token, nor a refresh token as access', async () => {
    const { access_token, refresh_token } = await phone()
    expect(await store.resolveAccessToken(redis as never, access_token)).toBeNull()
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(refresh_token) })
    expect(res.statusCode).toBe(401)
  })
})

const refresh = (refresh_token: string, client_id = 'nivaro-mobile') =>
  app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id
    }).toString()
  })

/** Rewrite a stored grant's stamps (as if it was made / last used `ms` ago). */
function ageGrant(id: string, patch: { created_ms?: number; used_ms?: number | null }) {
  const key = `nvr:oauth:grant:${id}`
  const g = JSON.parse(redis.kv.get(key) as string)
  if (patch.created_ms != null) g.created_at = new Date(Date.now() - patch.created_ms).toISOString()
  if (patch.used_ms !== undefined)
    g.last_used_at =
      patch.used_ms == null ? null : new Date(Date.now() - patch.used_ms).toISOString()
  redis.kv.set(key, JSON.stringify(g))
}

const HOUR = 3_600_000

/** The push rows a phone registered from this sign-in (as POST /api/push/phones notes them). */
function withPushIds(id: string, push_ids: number[]) {
  const key = `nvr:oauth:grant:${id}`
  redis.kv.set(key, JSON.stringify({ ...JSON.parse(redis.kv.get(key) as string), push_ids }))
}

describe('Signed-in phones, as the phone itself', () => {
  it('lists this phone as current; signing it out ends the token at once (next call 401)', async () => {
    const { grant, access_token } = await phone()
    const other = await phone('Old phone')
    withPushIds(other.grant.id, [8])
    const list = await app.inject({ url: '/api/auth/devices', headers: bearer(access_token) })
    expect(list.statusCode).toBe(200)
    const rows = list.json().data as Array<{ id: string; current: boolean }>
    expect(rows.find((r) => r.id === grant.id)?.current).toBe(true)
    expect(rows.find((r) => r.id === other.grant.id)?.current).toBe(false)

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/auth/devices/${other.grant.id}`,
      headers: bearer(access_token)
    })
    expect(del.json()).toEqual({ ok: true })
    expect(state.pushDeletes).toEqual([[8]])
    const after = await app.inject({ url: '/api/auth/me', headers: bearer(other.access_token) })
    expect(after.statusCode).toBe(401)
    expect(after.json().code).toBe('TOKEN_INVALID')
    // This phone carries on.
    expect(
      (await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })).statusCode
    ).toBe(200)
  })
})

describe('a phone refresh past the policy', () => {
  it('ends the sign-in with its push rows', async () => {
    policy.value = { max_age_hours: 8 }
    const { grant, refresh_token } = await phone()
    withPushIds(grant.id, [6])
    ageGrant(grant.id, { created_ms: 9 * HOUR, used_ms: 60_000 })
    const res = await refresh(refresh_token)
    expect(res.statusCode).toBe(400)
    expect(await store.getGrant(redis as never, grant.id)).toBeNull()
    expect(state.pushDeletes).toEqual([[6]])
  })
})

describe('a phone is a session everywhere but minting credentials', () => {
  it('opens a live connection bound to its grant (no WS_UNBINDABLE)', async () => {
    const { grant, access_token } = await phone()
    const res = await app.inject({ url: '/api/auth/ws-token', headers: bearer(access_token) })
    expect(res.statusCode).toBe(200)
    expect(res.json().bind).toEqual({ kind: 'device', grant: grant.id })
  })

  it('answers an agent question as the person at the keyboard', async () => {
    const { access_token } = await phone()
    const res = await app.inject({
      url: '/api/agent-questions/answerer',
      headers: bearer(access_token)
    })
    expect(res.json()).toEqual({ human: true })
  })

  it("binds help-video media tickets to the phone's sign-in, which a sign-out ends", async () => {
    const { grant, access_token } = await phone()
    const res = await app.inject({ url: '/api/help-videos/tag', headers: bearer(access_token) })
    const tag = res.json().tag as string
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/)
    await new Promise((r) => setTimeout(r, 0))
    const bound = redis.kv.get(`${SIDTAG_PREFIX}${tag}`) as string
    expect(bound).toBe(`dev:${grant.id}`)
    expect(await ticketSignInEnded(redis as never, bound, 'sess:revoked:', true)).toBe(false)
    await store.revokeGrant(redis as never, 'U1', grant.id)
    expect(await ticketSignInEnded(redis as never, bound, 'sess:revoked:', false)).toBe(true)
  })
})

describe('a phone never mints a credential that would outlive it', () => {
  const asPhone = async () => bearer((await phone()).access_token)
  const asSession = { 'x-test-session': '1' }

  it('refuses creating or changing an API key, or running as one', async () => {
    const headers = await asPhone()
    for (const [method, url] of [
      ['POST', '/api/api-keys'],
      ['PATCH', '/api/api-keys/7'],
      ['POST', '/api/api-keys/7/simulate-token']
    ] as const) {
      const res = await app.inject({ method, url, headers, payload: { name: 'From the phone' } })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().code).toBe('CREDENTIAL_MINT_REFUSED')
      expect(res.json().error).toMatch(/from the web app\.$/)
    }
    const create = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers,
      payload: { name: 'x' }
    })
    expect(create.json().error).toBe('Create API keys from the web app.')
  })

  it('still lists keys, and may revoke one', async () => {
    const headers = await asPhone()
    expect((await app.inject({ url: '/api/api-keys', headers })).statusCode).toBe(200)
    const revoke = await app.inject({ method: 'POST', url: '/api/api-keys/7/revoke', headers })
    expect(revoke.statusCode).not.toBe(403)
  })

  it('a browser session creates a key as before', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: asSession,
      payload: { name: 'From the browser' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.key).toMatch(/^nvk_/)
  })
})

describe('every phone request judges the session policy', () => {
  it('idle past the limit since its last use → 401 SESSION_EXPIRED, and the sign-in ends', async () => {
    policy.value = { idle_minutes: 15 }
    const { grant, access_token } = await phone()
    ageGrant(grant.id, { created_ms: 25 * 60_000, used_ms: 20 * 60_000 })
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('SESSION_EXPIRED')
    expect(await store.getGrant(redis as never, grant.id)).toBeNull()
  })

  it('an ended sign-in takes its push rows with it', async () => {
    policy.value = { idle_minutes: 15 }
    const { grant, access_token } = await phone()
    withPushIds(grant.id, [4, 5])
    ageGrant(grant.id, { created_ms: 25 * 60_000, used_ms: 20 * 60_000 })
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.json().code).toBe('SESSION_EXPIRED')
    expect(state.pushDeletes).toEqual([[4, 5]])
  })

  it('in use inside the idle limit → through', async () => {
    policy.value = { idle_minutes: 15 }
    const { grant, access_token } = await phone()
    ageGrant(grant.id, { created_ms: 2 * HOUR, used_ms: 5 * 60_000 })
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.statusCode).toBe(200)
  })

  it("past the role's max age → 401 SESSION_EXPIRED", async () => {
    policy.value = { roles: { [ROLE.toUpperCase()]: { max_age_hours: 8 } } }
    const { grant, access_token } = await phone()
    ageGrant(grant.id, { created_ms: 9 * HOUR, used_ms: 60_000 })
    const res = await app.inject({ url: '/api/auth/me', headers: bearer(access_token) })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({
      code: 'SESSION_EXPIRED',
      message: 'Your sign-in has expired. Sign in again.'
    })
  })
})

describe('a phone refresh judges the session policy', () => {
  it('refreshes inside the policy and keeps the device kind', async () => {
    policy.value = { max_age_hours: 24 }
    const { refresh_token } = await phone()
    const res = await refresh(refresh_token)
    expect(res.statusCode).toBe(200)
    expect(res.json().access_token.startsWith('nvd_')).toBe(true)
  })

  it("refuses once the role's max age has passed since the phone signed in", async () => {
    policy.value = { max_age_hours: 720, roles: { [ROLE.toUpperCase()]: { max_age_hours: 8 } } }
    const { grant, refresh_token } = await phone()
    ageGrant(grant.id, { created_ms: 9 * HOUR, used_ms: 60_000 })
    const res = await refresh(refresh_token)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Your sign-in has expired. Sign in again.'
    })
    // The phone's sign-in is over: its grant is gone, so its access token stops too.
    expect(await store.getGrant(redis as never, grant.id)).toBeNull()
  })

  it('refuses after the idle limit with no use', async () => {
    policy.value = { idle_minutes: 30 }
    const { grant, refresh_token } = await phone()
    ageGrant(grant.id, { created_ms: 2 * HOUR, used_ms: 2 * HOUR })
    const res = await refresh(refresh_token)
    expect(res.statusCode).toBe(400)
    expect(res.json().error_description).toBe('Your sign-in has expired. Sign in again.')
  })

  it('a grant never used since sign-in counts its idle time from sign-in', async () => {
    policy.value = { idle_minutes: 30 }
    const { grant, refresh_token } = await phone()
    ageGrant(grant.id, { created_ms: 10 * 60_000, used_ms: null })
    expect((await refresh(refresh_token)).statusCode).toBe(200)
  })

  it('no policy: a long-lived phone keeps refreshing', async () => {
    const { grant, refresh_token } = await phone()
    ageGrant(grant.id, { created_ms: 60 * 24 * HOUR, used_ms: 25 * 24 * HOUR })
    expect((await refresh(refresh_token)).statusCode).toBe(200)
  })

  it('a role with sign-in turned off cannot refresh, and the sign-in ends', async () => {
    const { grant, refresh_token } = await phone()
    state.roles[ROLE].app_access = false
    const res = await refresh(refresh_token)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'invalid_grant',
      error_description:
        'Sign-in is turned off for your role. Ask an administrator if you need access.'
    })
    expect(await store.getGrant(redis as never, grant.id)).toBeNull()
  })

  it('a database error during refresh leaves the refresh token usable', async () => {
    const { refresh_token } = await phone()
    state.usersDown = true
    expect((await refresh(refresh_token)).statusCode).toBe(500)
    state.usersDown = false
    expect((await refresh(refresh_token)).statusCode).toBe(200)
  })

  it('a person suspended after sign-in cannot refresh', async () => {
    const { refresh_token } = await phone()
    state.users.U1.status = 'suspended'
    const res = await refresh(refresh_token)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_grant')
  })

  it('MCP connections are not judged by the session policy', async () => {
    policy.value = { max_age_hours: 1 }
    const grant = await store.upsertGrant(
      redis as never,
      'U1',
      { client_id: 'nvc_old', client_name: 'Assistant' },
      'nivaro'
    )
    const { refresh_token } = await store.issueTokens(redis as never, {
      grant_id: grant.id,
      user_id: 'U1',
      client_id: 'nvc_old',
      resource: null
    })
    ageGrant(grant.id, { created_ms: 48 * HOUR })
    expect((await refresh(refresh_token, 'nvc_old')).statusCode).toBe(200)
  })
})
