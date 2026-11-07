import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Army 5 b11-N9 / b16-N8: GET /api/user-scopes/mine reached the admin route as
// userId "mine" and answered 500 with the SQL conversion text.

const who = vi.hoisted(() => ({ admin: false, signedIn: true }))
const described = vi.hoisted(() => ({
  ids: [] as string[],
  restricted: {} as Record<string, Array<string | number>>
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!who.signedIn) return reply.code(401).send({ error: 'Unauthorized' })
    req.user = { id: '11111111-2222-3333-4444-555555555555', role: 'R' } as never
    req.isAdmin = who.admin
  }
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply)
    if (reply.sent) return reply
    if (!who.admin) return reply.code(403).send({ error: 'Forbidden' })
  }
  return { requireAuth, requireAdmin, authenticate: requireAuth }
})
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/user-scopes.js', () => ({
  bustScopeDimensionCache: vi.fn(),
  bustScopePathCache: vi.fn(),
  bustUserScopeCache: vi.fn(),
  describeHops: vi.fn(),
  describeUserScopes: vi.fn(async (id: string) => {
    described.ids.push(id)
    return { user: id, scopes: [], restricted: described.restricted, defaults: {} }
  }),
  listScopeDimensions: vi.fn(async () => [{ name: 'zone' }]),
  resolveScopeLabelsForUsers: vi.fn(async (ids: string[]) => {
    return new Map([[ids[0], new Map([['division', ['National']]])]])
  }),
  scopeHopsFor: vi.fn()
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { userScopesRoutes } from '../../../routes/user-scopes.js'

const ME = '11111111-2222-3333-4444-555555555555'
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
let app: FastifyInstance

beforeEach(async () => {
  who.admin = false
  who.signedIn = true
  described.ids = []
  described.restricted = {}
  app = Fastify()
  await app.register(userScopesRoutes, { prefix: '/api' })
  await app.ready()
})
afterEach(async () => {
  await app.close()
})

describe('GET /api/user-scopes/mine', () => {
  it('answers the caller own scopes for a normal role', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/user-scopes/mine' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.user).toBe(ME)
    expect(described.ids).toEqual([ME])
  })

  it('answers the caller own scopes for an admin (and service accounts), never "mine" as an id', async () => {
    who.admin = true
    const res = await app.inject({ method: 'GET', url: '/api/user-scopes/mine' })
    expect(res.statusCode).toBe(200)
    expect(described.ids).toEqual([ME])
  })

  it('still needs a signed-in caller', async () => {
    who.signedIn = false
    const res = await app.inject({ method: 'GET', url: '/api/user-scopes/mine' })
    expect(res.statusCode).toBe(401)
  })

  it('matches GET /api/users/me/scopes', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/user-scopes/mine' })
    const b = await app.inject({ method: 'GET', url: '/api/users/me/scopes' })
    expect(a.json()).toEqual(b.json())
  })
})

describe('GET /api/users/me/scopes: admin access scope label (army 6 D8 / M36)', () => {
  it('an admin with a restriction is told which scope they carry', async () => {
    who.admin = true
    described.restricted = { division: [4] }
    const res = await app.inject({ method: 'GET', url: '/api/users/me/scopes' })
    expect(res.json().data.admin).toBe(true)
    expect(res.json().data.access_scope_label).toBe('National')
  })

  it('an admin without a restriction gets no label', async () => {
    who.admin = true
    const res = await app.inject({ method: 'GET', url: '/api/users/me/scopes' })
    expect(res.json().data.admin).toBe(true)
    expect(res.json().data.access_scope_label).toBeNull()
  })

  it('a normal role answers admin false and no label', async () => {
    described.restricted = { division: [4] }
    const res = await app.inject({ method: 'GET', url: '/api/users/me/scopes' })
    expect(res.json().data.admin).toBe(false)
    expect(res.json().data.access_scope_label).toBeNull()
  })
})

describe('/api/user-scopes/:userId', () => {
  it('an admin reads any user by id', async () => {
    who.admin = true
    const res = await app.inject({ method: 'GET', url: `/api/user-scopes/${OTHER}` })
    expect(res.statusCode).toBe(200)
    expect(described.ids).toEqual([OTHER])
  })

  it('a non-uuid id is a 400 with no SQL, for GET, PUT and impact', async () => {
    who.admin = true
    for (const [method, url] of [
      ['GET', '/api/user-scopes/me'],
      ['GET', "/api/user-scopes/x'%20OR%201=1"],
      ['PUT', '/api/user-scopes/123'],
      ['POST', '/api/user-scopes/abc/impact']
    ] as const) {
      const res = await app.inject({ method, url, payload: { mode: 'default', dimension: 'zone' } })
      expect(res.statusCode, `${method} ${url}`).toBe(400)
      expect(res.json().code).toBe('INVALID_USER_ID')
    }
    expect(described.ids).toEqual([])
  })

  it('a normal role still gets 403 for another person', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/user-scopes/${OTHER}` })
    expect(res.statusCode).toBe(403)
  })
})
