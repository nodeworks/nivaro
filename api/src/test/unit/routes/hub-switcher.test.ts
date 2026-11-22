import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7, Task 7: GET /api/hub-switcher (Review Focus 4) and the readiness check
// `hub-signin`. Only a person on their own browser session is ever described; View-as, API keys,
// OAuth/MCP and the static token get an empty list and the Hub is never asked.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: FastifyRequest) => {
    const h = req.headers
    const method = String(h['x-test-auth'] ?? '')
    if (!method) {
      const err = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      throw err
    }
    ;(req as any).user = { id: 'u1', email: 'pat@example.com' }
    ;(req as any).authMethod = method
    if (h['x-test-masq']) (req as any).masqueradeAdminId = 'admin-1'
  }
}))
const registered: any[] = []
vi.mock('../../../services/readiness.js', () => ({
  registerReadinessCheck: (c: unknown) => registered.push(c)
}))

const { hubSwitcherRoutes, registerHubSigninReadiness } = await import(
  '../../../routes/hub-switcher.js'
)
const { enabledFeatures } = await import('../../../services/app-info.js')

const TOKEN = `hubt_${'t'.repeat(40)}`
const APPS = [
  {
    app_key: 'ops',
    app_name: 'Ops desk',
    environment_key: 'production',
    url: 'https://ops.example.com/',
    signin_url: 'https://ops.example.com/api/auth/login?returnTo=%2F',
    current: false
  }
]

const saved: Record<string, string | undefined> = {}
const KEYS = ['HUB_URL', 'HUB_TOKEN', 'CLOUD_META_DB_URL', 'HUB']
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
  process.env.HUB_URL = 'https://hub.example.com'
  process.env.HUB_TOKEN = TOKEN
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function server() {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { apps: APPS } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )
  const store = new Map<string, string>()
  const app = Fastify()
  app.decorate('redis', {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v)
      return 'OK'
    }
  } as any)
  await app.register(hubSwitcherRoutes, {
    prefix: '/api',
    linkDeps: {
      fetchImpl,
      readUser: async () => ({ entra_oid: 'oid-1', entra_tid: 'tid-1' }),
      log: () => {}
    }
  })
  await app.ready()
  return { app, fetchImpl }
}

const get = (app: Awaited<ReturnType<typeof server>>['app'], headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/api/hub-switcher', headers })

describe('GET /api/hub-switcher', () => {
  it('a person on their own session gets the Hub’s answer', async () => {
    const { app, fetchImpl } = await server()
    const res = await get(app, { 'x-test-auth': 'session' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { apps: APPS, unavailable: false } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(res.headers['cache-control']).toContain('no-store')
    // Only names, keys and sign-in links: no email, code, token or sid.
    expect(res.body).not.toMatch(/@|code=|token|sid=/)
  })

  it('View-as, an API key, OAuth/MCP, a phone token and the static token → empty, Hub not asked', async () => {
    const { app, fetchImpl } = await server()
    const callers: Array<Record<string, string>> = [
      { 'x-test-auth': 'masquerade' },
      { 'x-test-auth': 'session', 'x-test-masq': '1' },
      { 'x-test-auth': 'api_key' },
      { 'x-test-auth': 'oauth' },
      { 'x-test-auth': 'device' },
      { 'x-test-auth': 'token' }
    ]
    for (const headers of callers) {
      const res = await get(app, headers)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ data: { apps: [], unavailable: false } })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('signed out → 401', async () => {
    const { app } = await server()
    expect((await get(app, {})).statusCode).toBe(401)
  })

  it('404 without HUB_URL + HUB_TOKEN, and in cloud mode', async () => {
    const { app, fetchImpl } = await server()
    delete process.env.HUB_TOKEN
    expect((await get(app, { 'x-test-auth': 'session' })).statusCode).toBe(404)
    process.env.HUB_TOKEN = TOKEN
    process.env.CLOUD_META_DB_URL = 'x'
    expect((await get(app, { 'x-test-auth': 'session' })).statusCode).toBe(404)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('app-info advertises hub-switcher only with HUB_URL and HUB_TOKEN', () => {
    const on = { HUB_URL: 'https://hub.example.com', HUB_TOKEN: TOKEN } as any
    expect(enabledFeatures(on)).toContain('hub-switcher')
    expect(enabledFeatures({ HUB_URL: 'https://hub.example.com' } as any)).not.toContain(
      'hub-switcher'
    )
    expect(enabledFeatures({ HUB_TOKEN: TOKEN } as any)).not.toContain('hub-switcher')
    expect(enabledFeatures({ ...on, CLOUD_META_DB_URL: 'x' })).not.toContain('hub-switcher')
  })
})

describe('readiness hub-signin', () => {
  const SECRET = `hubs_${'s'.repeat(43)}`
  const full = {
    NODE_ENV: 'test',
    HUB_URL: 'https://hub.example.com',
    HUB_CLIENT_ID: 'hubc_0123456789abcdef01234567',
    HUB_CLIENT_SECRET: SECRET,
    HUB_IDP_AUDIENCE: 'hub-entra-client',
    OIDC_ISSUER: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
    OIDC_CLIENT_ID: 'app-entra-client'
  }
  const check = (env: Record<string, string | undefined>, up = async () => true) => {
    registered.length = 0
    registerHubSigninReadiness({ env: env as NodeJS.ProcessEnv, up })
    const c = registered[0]
    expect(c.id).toBe('hub-signin')
    expect(c.group).toBe('Sign-in')
    return c.run()
  }

  it('the plugin registers it', async () => {
    registered.length = 0
    await server()
    expect(registered.map((c) => c.id)).toContain('hub-signin')
  })

  it('passes with no Hub sign-in env set', async () => {
    const up = vi.fn(async () => true)
    expect((await check({ NODE_ENV: 'test' }, up)).status).toBe('pass')
    expect(up).not.toHaveBeenCalled()
  })

  it('warns naming the missing variables', async () => {
    const out = await check({ ...full, HUB_CLIENT_SECRET: 'short', HUB_IDP_AUDIENCE: undefined })
    expect(out.status).toBe('warn')
    expect(out.detail).toContain('HUB_CLIENT_SECRET')
    expect(out.detail).toContain('HUB_IDP_AUDIENCE')
    expect(out.detail).not.toContain(SECRET)
  })

  it('warns when configured and the Hub is down; passes when up; never fails', async () => {
    const down = await check(full, async () => false)
    expect(down.status).toBe('warn')
    expect(down.detail).toContain('people sign in directly with Microsoft until the Hub answers')
    expect((await check(full, async () => true)).status).toBe('pass')
  })
})
