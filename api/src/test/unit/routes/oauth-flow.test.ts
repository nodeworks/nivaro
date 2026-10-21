import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

vi.mock('../../../db/index.js', () => {
  const users: Record<
    string,
    { id: string; status: string; first_name: string; last_name: string }
  > = {
    U1: { id: 'U1', status: 'active', first_name: 'Pat', last_name: 'Lee' }
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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
// servesAdminSpa follows whether admin/dist exists on disk; pin the API-only
// case so a local admin build doesn't change the sign-in redirect.
vi.mock('../../../admin-base.js', async (orig) => ({
  ...(await orig<object>()),
  servesAdminSpa: false
}))
// The consent page authenticates like every route; here the session's user stands in.
vi.mock('../../../middleware/authenticate.js', () => ({
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

const { oauthPublicRoutes } = await import('../../../routes/oauth.js')
const { resolveAccessToken, listGrants, revokeGrant } = await import(
  '../../../services/oauth-store.js'
)

/** Just enough Redis for the store. */
function fakeRedis() {
  const kv = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const put = async (k: string, v: string) => {
    kv.set(k, v)
    return 'OK'
  }
  const r = {
    get: async (k: string) => kv.get(k) ?? null,
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

const session: {
  userId?: string
  oauthCsrf?: string
  authAt?: number
  destroy?: () => Promise<void>
} = {}
let destroyed = 0
session.destroy = async () => {
  destroyed++
  session.userId = undefined
  session.authAt = undefined
}
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

const verifier = 'v'.repeat(50)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const form = (o: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(o).toString()
})

describe('OAuth for remote MCP clients', () => {
  it('publishes discovery documents at the origin', async () => {
    const pr = (await app.inject({ url: '/.well-known/oauth-protected-resource' })).json()
    expect(pr.resource).toBe('https://nivaro.example/api/mcp')
    expect(pr.authorization_servers).toEqual(['https://nivaro.example'])
    const as = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json()
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
    expect(as.registration_endpoint).toBe('https://nivaro.example/oauth/register')
  })

  it('refuses redirect URIs that are not https or loopback', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'X', redirect_uris: ['http://evil.example/cb'] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_redirect_uri')
  })

  it('runs register → consent → code → token → refresh → revoke', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/cb'] }
    })
    expect(reg.statusCode).toBe(201)
    const clientId = reg.json().client_id as string
    const params = {
      client_id: clientId,
      redirect_uri: 'https://chatgpt.com/cb',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-1',
      scope: 'nivaro',
      resource: 'https://nivaro.example/api/mcp'
    }
    const qs = new URLSearchParams(params).toString()

    // Not signed in → login first, coming back to the same authorize URL.
    session.userId = undefined
    const toLogin = await app.inject({ url: `/oauth/authorize?${qs}` })
    expect(toLogin.statusCode).toBe(302)
    expect(toLogin.headers.location).toContain('/api/auth/login?returnTo=')
    expect(decodeURIComponent(String(toLogin.headers.location))).toContain(
      'https://nivaro.example/oauth/authorize?'
    )

    // Signed in long ago → sign in again first.
    session.userId = 'U1'
    session.authAt = Date.now() - 2 * 3600_000
    const stale = await app.inject({ url: `/oauth/authorize?${qs}` })
    expect(stale.statusCode).toBe(302)
    expect(stale.headers.location).toContain('/api/auth/login?returnTo=')
    // …without ending the session: a GET never changes it (any site can navigate here).
    expect(destroyed).toBe(0)
    expect(session.userId).toBe('U1')

    // Signed in recently → the consent page, framed nowhere.
    session.authAt = Date.now()
    const consent = await app.inject({ url: `/oauth/authorize?${qs}` })
    expect(consent.statusCode).toBe(200)
    expect(consent.headers['x-frame-options']).toBe('DENY')
    expect(consent.body).toContain('ChatGPT')
    expect(consent.body).toContain('chatgpt.com')
    expect(consent.body).toContain('Pat Lee')
    const csrf = session.oauthCsrf as string
    expect(csrf).toBeTruthy()

    // A forged post (wrong csrf) is refused.
    const forged = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      ...form({ ...params, csrf: 'nope', decision: 'allow' })
    })
    expect(forged.statusCode).toBe(400)

    // Allow → back to the client with a code, the state and iss.
    await app.inject({ url: `/oauth/authorize?${qs}` })
    const allow = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      ...form({ ...params, csrf: session.oauthCsrf as string, decision: 'allow' })
    })
    expect(allow.statusCode).toBe(302)
    const back = new URL(String(allow.headers.location))
    expect(back.origin + back.pathname).toBe('https://chatgpt.com/cb')
    expect(back.searchParams.get('state')).toBe('st-1')
    expect(back.searchParams.get('iss')).toBe('https://nivaro.example')
    const code = back.searchParams.get('code') as string

    // Wrong verifier fails — and spends the code.
    const bad = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/cb',
        code_verifier: 'w'.repeat(50)
      })
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('invalid_grant')

    // A fresh authorization, exchanged properly.
    await app.inject({ url: `/oauth/authorize?${qs}` })
    const allow2 = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      ...form({ ...params, csrf: session.oauthCsrf as string, decision: 'allow' })
    })
    const code2 = new URL(String(allow2.headers.location)).searchParams.get('code') as string
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'authorization_code',
        code: code2,
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/cb',
        code_verifier: verifier
      })
    })
    expect(tok.statusCode).toBe(200)
    const t = tok.json()
    expect(t.token_type).toBe('Bearer')
    expect(t.access_token.startsWith('nvo_')).toBe(true)
    expect(await resolveAccessToken(redis as never, t.access_token)).toMatchObject({
      user_id: 'U1'
    })

    // The code works once.
    const again = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({
        grant_type: 'authorization_code',
        code: code2,
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/cb',
        code_verifier: verifier
      })
    })
    expect(again.statusCode).toBe(400)

    // Refresh rotates: the old refresh token is spent.
    const ref = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })
    })
    expect(ref.statusCode).toBe(200)
    const reuse = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      ...form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })
    })
    expect(reuse.statusCode).toBe(400)

    // One connection for the two consents; revoking it ends every token at once.
    const grants = await listGrants(redis as never, 'U1')
    expect(grants).toHaveLength(1)
    expect(await revokeGrant(redis as never, 'U1', grants[0].id)).toBe(true)
    expect(await resolveAccessToken(redis as never, ref.json().access_token)).toBeNull()
  })

  it("chat is the person's choice on the consent page and rides the grant (#2492)", async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }
    })
    const clientId = reg.json().client_id as string
    const p = {
      client_id: clientId,
      redirect_uri: 'https://claude.ai/cb',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      scope: 'nivaro chat'
    }
    const as = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json()
    expect(as.scopes_supported).toEqual(['nivaro', 'chat'])
    session.userId = 'U1'
    session.authAt = Date.now()
    const page = await app.inject({ url: `/oauth/authorize?${new URLSearchParams(p)}` })
    // Asked for chat → the box is pre-ticked; the person may still untick it.
    expect(page.body).toMatch(/name="chat" value="1" checked/)
    const consent = async (chat: boolean) => {
      await app.inject({ url: `/oauth/authorize?${new URLSearchParams(p)}` })
      const allow = await app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        ...form({
          ...p,
          csrf: session.oauthCsrf as string,
          decision: 'allow',
          ...(chat ? { chat: '1' } : {})
        })
      })
      const code = new URL(String(allow.headers.location)).searchParams.get('code') as string
      return (
        await app.inject({
          method: 'POST',
          url: '/oauth/token',
          ...form({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            redirect_uri: 'https://claude.ai/cb',
            code_verifier: verifier
          })
        })
      ).json()
    }
    const withChat = await consent(true)
    expect(withChat.scope).toBe('nivaro chat')
    expect(await resolveAccessToken(redis as never, withChat.access_token)).toMatchObject({
      scope: 'nivaro chat',
      client_name: 'Claude'
    })
    // A second consent without chat takes it away from the earlier token too.
    const without = await consent(false)
    expect(without.scope).toBe('nivaro')
    expect(await resolveAccessToken(redis as never, withChat.access_token)).toMatchObject({
      scope: 'nivaro'
    })
    // An unknown scope is still refused before anything else.
    const bad = await app.inject({
      url: `/oauth/authorize?${new URLSearchParams({ ...p, scope: 'nivaro admin' })}`
    })
    expect(bad.statusCode).toBe(400)
  })

  it('Cancel sends access_denied back to the client', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'Claude', redirect_uris: ['http://127.0.0.1:5000/callback'] }
    })
    const p = {
      client_id: reg.json().client_id,
      redirect_uri: 'http://127.0.0.1:61000/callback',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's'
    }
    session.userId = 'U1'
    session.authAt = Date.now()
    await app.inject({ url: `/oauth/authorize?${new URLSearchParams(p)}` })
    const deny = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      ...form({ ...p, csrf: session.oauthCsrf as string, decision: 'deny' })
    })
    expect(String(deny.headers.location)).toContain(
      'http://127.0.0.1:61000/callback?error=access_denied'
    )
  })

  it('an unknown client or unregistered redirect never redirects', async () => {
    const res = await app.inject({
      url: '/oauth/authorize?client_id=nvc_00000000-0000-0000-0000-000000000000&redirect_uri=https://evil.example'
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('a bad request from a known client is shown here, never sent to its address', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] }
    })
    session.userId = 'U1'
    session.authAt = Date.now()
    const res = await app.inject({
      url: `/oauth/authorize?${new URLSearchParams({
        client_id: reg.json().client_id,
        redirect_uri: 'https://evil.example/cb',
        response_type: 'token'
      })}`
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })
})
