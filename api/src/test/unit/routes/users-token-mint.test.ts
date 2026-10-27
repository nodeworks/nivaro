import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Security audit H3: a narrow API key (collection-scoped, IP-pinned) could mint a full,
// permanent static token for its owner — and an admin-owned scoped key anyone's. Only a person
// signed in as themselves mints one; another person's only as an unrestricted admin.
// H6: GET /users/:id never carries credentials.

const ME = 'AAAAAAAA-0000-4000-8000-000000000001'
const OTHER = 'BBBBBBBB-0000-4000-8000-000000000002'
const who = vi.hoisted(() => ({
  authMethod: 'session' as string,
  isAdmin: false,
  scopes: null as unknown,
  masq: undefined as string | undefined
}))
const writes = vi.hoisted(() => [] as unknown[])

vi.mock('../../../middleware/authenticate.js', async (orig) => {
  const real = await orig<typeof import('../../../middleware/authenticate.js')>()
  const authenticate = async (req: Record<string, unknown>) => {
    req.user = {
      id: 'AAAAAAAA-0000-4000-8000-000000000001',
      role: 'R',
      ...(who.scopes ? { api_key_scopes: who.scopes } : {})
    }
    req.isAdmin = who.isAdmin
    req.authMethod = who.authMethod
    req.masqueradeAdminId = who.masq
  }
  return {
    authenticate,
    requireAdmin: authenticate,
    adminRefusal: real.adminRefusal,
    credentialMintRefusal: real.credentialMintRefusal
  }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 7) }))
vi.mock('../../../services/revisions.js', () => ({ writeRevision: vi.fn(async () => {}) }))
// The raw row WITH credentials, so the route's own stripping is what the tests see.
const rawRow = () => ({
  id: 'AAAAAAAA-0000-4000-8000-000000000001',
  email: 'me@x.test',
  status: 'active',
  static_token: 'tok-live',
  password_hash: 'salt:hash',
  totp_secret: 'T',
  external_id: 'sub'
})
vi.mock('../../../services/users.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/users.js')>()),
  getUser: vi.fn(async () => rawRow()),
  updateUser: vi.fn(async () => rawRow())
}))
vi.mock('../../../services/teams-bot/profile.js', () => ({ ownTeamsFacts: async () => ({}) }))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.first = vi.fn(async () => undefined)
    c.insert = vi.fn(async () => [1])
    c.update = vi.fn(async (patch: unknown) => {
      writes.push(patch)
      return 1
    })
    return c
  })
  return { db }
})

import { usersRoutes } from '../../../routes/users.js'
import { writeRevision } from '../../../services/revisions.js'

async function call(method: 'POST' | 'DELETE' | 'GET', url: string) {
  const app = Fastify({ logger: false })
  await app.register(usersRoutes)
  return app.inject({ method, url })
}

beforeEach(() => {
  Object.assign(who, { authMethod: 'session', isAdmin: false, scopes: null, masq: undefined })
  writes.length = 0
})

describe('POST /users/:id/token', () => {
  it('a person signed in as themselves mints their own', async () => {
    const res = await call('POST', '/me/token')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each(['api_key', 'key_sim', 'masquerade', 'oauth'])('refuses a %s caller', async (m) => {
    who.authMethod = m
    who.isAdmin = true
    const res = await call('POST', '/me/token')
    expect(res.statusCode).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('refuses a session that is a View-as', async () => {
    who.masq = 'REAL-ADMIN'
    expect((await call('POST', '/me/token')).statusCode).toBe(403)
  })

  it('another person: unrestricted admins only', async () => {
    expect((await call('POST', `/${OTHER}/token`)).statusCode).toBe(403)
    who.isAdmin = true
    who.scopes = [{ collection: 'orders', actions: ['read'] }]
    expect((await call('POST', `/${OTHER}/token`)).statusCode).toBe(403)
    who.scopes = null
    expect((await call('POST', `/${OTHER}/token`)).statusCode).toBe(200)
  })
})

const CREDENTIALS = ['static_token', 'password_hash', 'totp_secret', 'external_id']

describe('user rows in answers and revisions never carry credentials (H6)', () => {
  it('GET /users/:id', async () => {
    const res = await call('GET', '/me')
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    for (const f of CREDENTIALS) expect(data).not.toHaveProperty(f)
    expect(data.has_static_token).toBe(true)
  })

  it('POST /users (and its create revision)', async () => {
    who.isAdmin = true
    const app = Fastify({ logger: false })
    await app.register(usersRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: { email: 'new@x.test' }
    })
    expect(res.statusCode).toBe(201)
    const data = JSON.parse(res.body).data
    for (const f of CREDENTIALS) expect(data).not.toHaveProperty(f)
    expect(res.body).not.toContain('tok-live')
    for (const call of vi.mocked(writeRevision).mock.calls)
      for (const f of CREDENTIALS) expect(call[0].data).not.toHaveProperty(f)
  })

  it('PATCH /users/:id on oneself (and its revision)', async () => {
    const app = Fastify({ logger: false })
    await app.register(usersRoutes)
    const res = await app.inject({ method: 'PATCH', url: `/${ME}`, payload: { first_name: 'Ana' } })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('tok-live')
    expect(res.body).not.toContain('salt:hash')
    expect(writeRevision).toHaveBeenCalled()
    for (const c of vi.mocked(writeRevision).mock.calls) {
      for (const f of CREDENTIALS) expect(c[0].data).not.toHaveProperty(f)
      for (const f of CREDENTIALS) expect(c[0].delta ?? {}).not.toHaveProperty(f)
    }
  })
})
