import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// GET /auth/me carries `access_pending` (the new-user flow, migration 330): null for a person
// with real access, 'first_access' / 'needs_authorization' while they wait — by role id.

const START = 'AAAAAAAA-0000-4000-8000-00000000000a'
const REVIEW = 'BBBBBBBB-0000-4000-8000-00000000000b'
const REAL = 'CCCCCCCC-0000-4000-8000-00000000000c'

const h = vi.hoisted(() => ({ user: {} as Record<string, unknown>, admin: false }))

vi.mock('../../../services/access-pending.js', async (orig) => {
  const real = await orig<typeof import('../../../services/access-pending.js')>()
  return {
    ...real,
    accessPendingFor: vi.fn(async (u: { role?: string | null }, isAdmin: boolean) =>
      real.accessPendingOf(u, { new_user_role: START, access_request_role: REVIEW }, isAdmin)
    )
  }
})
vi.mock('../../../services/team.js', () => ({ hasReports: vi.fn(async () => false) }))
vi.mock('../../../middleware/authenticate.js', async (orig) => ({
  ...(await orig<object>()),
  authenticate: vi.fn(async (req: Record<string, unknown>) => {
    req.user = { ...h.user }
    req.isAdmin = h.admin
    req.userRole = { name: 'Whatever', app_access: true }
  })
}))

const { authRoutes } = await import('../../../routes/auth.js')

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  h.admin = false
})

const me = async () => (await app.inject({ url: '/auth/me' })).json().data

describe('/auth/me access_pending', () => {
  it('first sign-in role, nothing asked → first_access', async () => {
    h.user = { id: 'U1', role: START, preferences: null }
    expect((await me()).access_pending).toBe('first_access')
  })

  it('a request sent (or the review role) → needs_authorization', async () => {
    h.user = {
      id: 'U1',
      role: START,
      preferences: JSON.stringify({ access_request: { submitted_at: '2026-11-01T00:00:00Z' } })
    }
    expect((await me()).access_pending).toBe('needs_authorization')
    h.user = { id: 'U1', role: REVIEW }
    expect((await me()).access_pending).toBe('needs_authorization')
  })

  it('a real role, or an admin → null', async () => {
    h.user = { id: 'U1', role: REAL }
    expect((await me()).access_pending).toBeNull()
    h.user = { id: 'U1', role: START }
    h.admin = true
    expect((await me()).access_pending).toBeNull()
  })
})
