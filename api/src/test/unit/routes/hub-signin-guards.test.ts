import Fastify, { type FastifyRequest } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7, fix round 1: the sign-in admin routes mint and rotate client secrets and
// signing keys, so they are credential routes. Through the REAL authenticate middleware a
// View-as (nvm_) request and a connected app (nvo_, inside an MCP tool call) are refused on
// every write under /api/hub/signin, before any handler runs.

vi.mock('../../../services/oauth-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/oauth-store.js')>()),
  resolveAccessToken: vi.fn(async () => ({
    user_id: 'TARGET',
    grant_id: 'g1',
    client_id: 'c1',
    client_name: 'Some agent',
    scope: 'mcp',
    kind: 'mcp',
    grant_created_at: new Date().toISOString(),
    grant_last_used_at: null
  }))
}))
vi.mock('../../../services/hub/oidc/clients.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/hub/oidc/clients.js')>()),
  createClient: vi.fn(async () => ({ client_id: 'hubc_x', client_secret: 'hubs_x' })),
  rotateClientSecret: vi.fn(async () => ({ client_secret: 'hubs_x' }))
}))
vi.mock('../../../services/hub/oidc/keys.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/hub/oidc/keys.js')>()),
  rotateSigningKey: vi.fn(async () => ({ kid: 'k' })),
  removeSigningKey: vi.fn(async () => ({ kid: 'k', signing_kid: 'j', warning: null }))
}))

const { db } = await import('../../../db/index.js')
const { authenticate, delegatedWriteRefusal, resetAdminRecheckCache } = await import(
  '../../../middleware/authenticate.js'
)
const { MCP_INNER_HEADER, markMcpInnerRequest, mcpInnerHeaderValue, oauthAudienceRefusal } =
  await import('../../../services/mcp-config.js')
const { hubSigninAdminRoutes } = await import('../../../routes/hub-signin-admin.js')
const { createClient, rotateClientSecret } = await import('../../../services/hub/oidc/clients.js')
const { removeSigningKey, rotateSigningKey } = await import('../../../services/hub/oidc/keys.js')

const WRITES: Array<['POST' | 'PATCH' | 'DELETE', string]> = [
  ['POST', '/api/hub/signin/environments/1/client'],
  ['POST', '/api/hub/signin/environments/1/client/rotate'],
  ['PATCH', '/api/hub/signin/environments/1/client'],
  ['POST', '/api/hub/signin/keys/rotate'],
  ['DELETE', '/api/hub/signin/keys/k'],
  ['PATCH', '/api/hub/signin/apps/1/mode']
]

let prevHub: string | undefined
beforeAll(() => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
})
afterAll(() => {
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
})

function server() {
  // nivaro_users: the target / the issuing admin (ADM); nivaro_roles: their roles.
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
    let id: unknown
    const c: Record<string, unknown> = {}
    for (const m of ['whereNull', 'orWhere', 'select', 'orderBy']) c[m] = () => c
    c.where = (arg: unknown) => {
      id = (arg as { id?: unknown } | null)?.id
      return c
    }
    c.first = async () => {
      if (table === 'nivaro_users')
        return id === 'ADM'
          ? { id: 'ADM', role: 'R-ADMIN', status: 'active', is_redacted: false }
          : { id: 'TARGET', role: 'R-ADMIN', status: 'active' }
      if (table === 'nivaro_roles') return { id: 'R-ADMIN', admin_access: true, app_access: true }
      return null
    }
    c.update = () => ({ catch: () => undefined })
    return c
  })
  const a = Fastify({ logger: false })
  a.decorate('redis', {
    get: async (k: string) =>
      k.startsWith('masq:') ? JSON.stringify({ user_id: 'TARGET', admin_id: 'ADM' }) : null,
    set: async () => 'OK',
    del: async () => 1
  } as never)
  a.decorateRequest('session', null as never)
  a.addHook('onRequest', async (r) => {
    ;(r as unknown as { session: unknown }).session = { destroy: async () => {} }
  })
  a.addHook('onRequest', markMcpInnerRequest)
  a.post('/api/control', { preHandler: authenticate }, async () => ({ ok: true }))
  a.register(hubSigninAdminRoutes, { prefix: '/api/hub/signin' })
  return a
}

afterEach(() => {
  resetAdminRecheckCache()
  vi.clearAllMocks()
})

describe('View-as (nvm_) on /api/hub/signin writes', () => {
  it('is refused 403 NOT_WHILE_MASQUERADING on every write; nothing is minted', async () => {
    const a = server()
    for (const [method, url] of WRITES) {
      const r = await a.inject({
        method,
        url,
        headers: { authorization: 'Bearer nvm_abc' },
        payload: {}
      })
      expect(r.statusCode, `${method} ${url}`).toBe(403)
      expect(r.json().code).toBe('NOT_WHILE_MASQUERADING')
    }
    expect(createClient).not.toHaveBeenCalled()
    expect(rotateClientSecret).not.toHaveBeenCalled()
    expect(rotateSigningKey).not.toHaveBeenCalled()
    expect(removeSigningKey).not.toHaveBeenCalled()
  })

  it('the same token still signs in elsewhere (the refusal is the route, not the token)', async () => {
    const r = await server().inject({
      method: 'POST',
      url: '/api/control',
      headers: { authorization: 'Bearer nvm_abc' }
    })
    expect(r.statusCode).toBe(200)
  })
})

describe('connected app (nvo_) inside an MCP tool call on /api/hub/signin writes', () => {
  const inner = () => ({
    authorization: 'Bearer nvo_abc',
    [MCP_INNER_HEADER]: mcpInnerHeaderValue()
  })

  it('is refused 403 OAUTH_TOKEN_AUDIENCE on every write; nothing is minted', async () => {
    const a = server()
    for (const [method, url] of WRITES) {
      const r = await a.inject({ method, url, headers: inner(), payload: {} })
      expect(r.statusCode, `${method} ${url}`).toBe(403)
      expect(r.json().code).toBe('OAUTH_TOKEN_AUDIENCE')
    }
    expect(createClient).not.toHaveBeenCalled()
    expect(rotateClientSecret).not.toHaveBeenCalled()
    expect(rotateSigningKey).not.toHaveBeenCalled()
    expect(removeSigningKey).not.toHaveBeenCalled()
  })

  it('the audience check passes an ordinary in-MCP write (the refusal is the route)', async () => {
    const r = await server().inject({ method: 'POST', url: '/api/control', headers: inner() })
    expect(r.json().code).not.toBe('OAUTH_TOKEN_AUDIENCE')
  })
})

describe('the route patterns', () => {
  const req = (method: string, url: string, extra: Record<string, unknown> = {}) =>
    ({ method, url, ...extra }) as unknown as FastifyRequest

  it('refuse every spelling of a hub/signin write; reads stay allowed', () => {
    for (const url of [
      '/api/hub/signin/environments/1/client',
      '/api/hub/signin/environments/1/client/rotate',
      '/api/hub/signin/keys/rotate',
      '/api/Hub/SignIn/keys/rotate',
      '/api/hub/%73ignin/keys/rotate',
      '//api//hub/signin/keys/rotate',
      '/api/hub/signin/environments/1/client?x=1'
    ]) {
      expect(delegatedWriteRefusal(req('POST', url)), url).not.toBeNull()
      expect(oauthAudienceRefusal(req('POST', url, { mcpInner: true })), url).not.toBeNull()
    }
    expect(delegatedWriteRefusal(req('GET', '/api/hub/signin/environments/1/client'))).toBeNull()
    expect(
      oauthAudienceRefusal(req('GET', '/api/hub/signin/settings', { mcpInner: true }))
    ).toBeNull()
    // Other hub routes are untouched by this pattern.
    expect(delegatedWriteRefusal(req('POST', '/api/hub/signins'))).toBeNull()
    expect(delegatedWriteRefusal(req('PATCH', '/api/hub/apps/1'))).toBeNull()
  })
})
