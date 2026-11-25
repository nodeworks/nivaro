import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub offboard block (security review of 052dffe48, MEDIUM 2–4): every path that leaves
// an account ACTIVE runs the ONE guard (services/hub/people/block.ts) on the row as it will be
// after the write — POST /users, PATCH /users/:id, POST /users/:id/authorize, updateUser, SCIM
// POST/PATCH (409 in the SCIM error shape) and the first Microsoft / SAML sign-in. The block
// itself is mocked here (hub-people-routes.test.ts proves its rule on a real database).

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OTHER = 'BBBBBBBB-0000-4000-8000-000000000002'
const s = vi.hoisted(() => ({
  blocked: true,
  judged: [] as Array<Record<string, unknown>>,
  user: {} as Record<string, unknown>,
  writes: [] as Array<{ table: string; op: string; data: unknown }>
}))

vi.mock('../../../services/hub/people/block.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/people/block.js')>()
  const emailOffboarded = vi.fn(async (next: Record<string, unknown>) => {
    s.judged.push(next)
    return s.blocked
  })
  return {
    ...real,
    emailOffboarded,
    assertEmailNotOffboarded: vi.fn(async (next: Record<string, unknown>) => {
      if (await emailOffboarded(next)) throw new real.EmailOffboardedError()
    })
  }
})
vi.mock('../../../middleware/authenticate.js', async (orig) => {
  const real = await orig<typeof import('../../../middleware/authenticate.js')>()
  const authenticate = vi.fn(
    async (req: {
      user?: unknown
      isAdmin?: boolean
      apiKeyScopes?: unknown
      authMethod?: string
    }) => {
      req.user = { id: ADMIN, role: 'R' }
      req.isAdmin = true
      req.authMethod = 'session'
      req.apiKeyScopes = [{ collection: 'scim', actions: ['*'] }]
    }
  )
  return { ...real, authenticate, requireAdmin: authenticate, requireAuth: authenticate }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 7) }))
vi.mock('../../../services/revisions.js', () => ({ writeRevision: vi.fn(async () => {}) }))
vi.mock('../../../services/teams-bot/profile.js', () => ({ ownTeamsFacts: async () => ({}) }))
vi.mock('../../../services/chat-default-joins.js', () => ({ joinDefaultChannelsSoon: vi.fn() }))
vi.mock('../../../services/security-alerts.js', () => ({
  noteUserRoleChange: vi.fn(),
  noteUsersDeactivated: vi.fn()
}))
vi.mock('../../../services/users.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/users.js')>()),
  getUser: vi.fn(async () => ({ ...s.user })),
  updateUser: vi.fn(async () => ({ ...s.user }))
}))
vi.mock('../../../db/index.js', () => {
  // A chain that answers any builder call; `first` answers the account / role row.
  const chain = (table: string): unknown => {
    const c: Record<string, unknown> = {}
    const self = new Proxy(c, {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown) => res([])
        if (prop === 'first')
          return async () =>
            table === 'nivaro_roles'
              ? { id: 'R', admin_access: false }
              : table === 'nivaro_users'
                ? s.user.id
                  ? { ...s.user }
                  : undefined
                : undefined
        if (prop === 'insert' || prop === 'update')
          return async (data: unknown) => {
            s.writes.push({ table, op: String(prop), data })
            return [1]
          }
        return () => self
      }
    })
    return self
  }
  const db = Object.assign(
    vi.fn((t: string) => chain(t)),
    {
      raw: vi.fn((sql: string) => sql),
      client: { config: { client: 'mssql' } },
      transaction: vi.fn(async (fn: (trx: unknown) => unknown) => fn((t: string) => chain(t)))
    }
  )
  return { db }
})

const { usersRoutes } = await import('../../../routes/users.js')
const { scimRoutes } = await import('../../../routes/scim.js')

async function build() {
  const app = Fastify({ logger: false })
  await app.register(usersRoutes, { prefix: '/users' })
  await app.register(scimRoutes, { prefix: '/scim/v2' })
  await app.ready()
  return app
}

beforeEach(() => {
  s.blocked = true
  s.judged.length = 0
  s.writes.length = 0
  s.user = { id: OTHER, email: 'dana@x.io', status: 'suspended', role: 'R' }
})

const userWrites = () => s.writes.filter((w) => w.table === 'nivaro_users')

describe('every active-account path runs the offboard guard', () => {
  it('POST /users refuses a blocked email and writes nothing', async () => {
    s.user = {}
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { email: 'dana@x.io', first_name: 'Dana' }
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('EMAIL_OFFBOARDED')
    expect(s.judged[0]).toMatchObject({ email: 'dana@x.io' })
    expect(userWrites()).toEqual([])
  })

  it('PATCH /users/:id to active is judged on the row as it will be', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'PATCH',
      url: `/users/${OTHER}`,
      payload: { status: 'active' }
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('EMAIL_OFFBOARDED')
    expect(s.judged[0]).toMatchObject({ id: OTHER, email: 'dana@x.io' })
  })

  it('PATCH of an already-active account’s other fields is not judged', async () => {
    s.user = { ...s.user, status: 'active' }
    const app = await build()
    const r = await app.inject({
      method: 'PATCH',
      url: `/users/${OTHER}`,
      payload: { first_name: 'D' }
    })
    expect(r.statusCode).not.toBe(409)
    expect(s.judged).toEqual([])
  })

  it('POST /users/:id/authorize refuses before anything is written', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: `/users/${OTHER}/authorize`,
      payload: { role: 'R', all_zones: true }
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('EMAIL_OFFBOARDED')
    expect(s.judged[0]).toMatchObject({ id: OTHER, email: 'dana@x.io' })
    expect(userWrites()).toEqual([])
  })

  it('SCIM POST /Users answers 409 in the SCIM error shape', async () => {
    s.user = {}
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer nvk_admin_scim' },
      payload: { userName: 'dana@x.io', active: true }
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error'])
    expect(r.json().detail).toContain('EMAIL_OFFBOARDED')
    expect(userWrites()).toEqual([])
  })

  it('SCIM POST of an INACTIVE account is not judged (it never ends up active)', async () => {
    s.user = {}
    const app = await build()
    await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer nvk_admin_scim' },
      payload: { userName: 'dana@x.io', active: false }
    })
    expect(s.judged).toEqual([])
  })

  it('SCIM PATCH: activation and an email change on an active row are both judged', async () => {
    const app = await build()
    const act = await app.inject({
      method: 'PATCH',
      url: `/scim/v2/Users/${OTHER}`,
      headers: { authorization: 'Bearer nvk_admin_scim' },
      payload: { active: true }
    })
    expect(act.statusCode).toBe(409)
    expect(s.judged[0]).toMatchObject({ id: OTHER, email: 'dana@x.io' })

    s.user = { id: OTHER, email: 'old@x.io', status: 'active', role: 'R' }
    const mail = await app.inject({
      method: 'PATCH',
      url: `/scim/v2/Users/${OTHER}`,
      headers: { authorization: 'Bearer nvk_admin_scim' },
      payload: { userName: 'dana@x.io' }
    })
    expect(mail.statusCode).toBe(409)
    // The NEXT email, not the one the row has now.
    expect(s.judged[1]).toMatchObject({ id: OTHER, email: 'dana@x.io' })
    expect(userWrites()).toEqual([])
  })

  it('nothing is refused when the guard says the account is clear', async () => {
    s.blocked = false
    s.user = {}
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer nvk_admin_scim' },
      payload: { userName: 'new@x.io' }
    })
    expect(r.statusCode).not.toBe(409)
    expect(userWrites().length).toBe(1)
  })
})
