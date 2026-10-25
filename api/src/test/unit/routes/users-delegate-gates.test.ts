import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Out-of-office delegation (army 2026-10-25): approvals were handed to a
// delegate who could open none of them, with no warning; and PATCH /users/:id
// on one's own row skipped the delegate checks /users/me/delegate makes.

const ME = 'AAAAAAAA-0000-4000-8000-000000000001'
const HOWARD = 'BBBBBBBB-0000-4000-8000-000000000002'
const reach = vi.hoisted(() => ({ owned: 12, hidden: 12 }))
const saved = vi.hoisted(() => [] as unknown[])

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'AAAAAAAA-0000-4000-8000-000000000001', role: 'R' }
    req.isAdmin = false
  }
  return { authenticate, requireAdmin: authenticate }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/revisions.js', () => ({ writeRevision: vi.fn(async () => {}) }))
vi.mock('../../../services/users.js', () => ({
  getUser: vi.fn(async () => ({ id: ME })),
  listUsers: vi.fn(),
  updateUser: vi.fn(async (_id: string, patch: unknown) => {
    saved.push(patch)
    return { id: ME }
  })
}))
vi.mock('../../../services/delegate-visibility.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  delegateReach: vi.fn(async () => ({ ...reach }))
}))
vi.mock('../../../services/delegate-coverage.js', () => ({
  computeCoverageWarnings: vi.fn(async () => []),
  countOwnedApprovals: vi.fn(async () => 12),
  sendDelegateBriefing: vi.fn(async () => {})
}))
vi.mock('../../../services/task-delegation.js', () => ({
  delegateOpenTasks: vi.fn(async () => {})
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.first = vi.fn(async () => ({
      id: 'BBBBBBBB-0000-4000-8000-000000000002',
      status: 'active',
      first_name: 'Howard',
      last_name: 'Hebert',
      email: 'h@x'
    }))
    return c
  })
  return { db }
})

import { usersRoutes } from '../../../routes/users.js'

async function call(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  const app = Fastify({ logger: false })
  await app.register(usersRoutes)
  return app.inject({ method, url, payload: payload as object })
}

beforeEach(() => {
  reach.owned = 12
  reach.hidden = 12
  saved.length = 0
})

describe('POST /me/delegate', () => {
  it('refuses a delegate who cannot open any inherited approval', async () => {
    const res = await call('POST', '/me/delegate', { delegate_id: HOWARD, is_out_of_office: true })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).code).toBe('DELEGATE_CANNOT_SEE')
    expect(saved).toHaveLength(0)
  })

  it('saves when the person confirms anyway', async () => {
    const res = await call('POST', '/me/delegate', {
      delegate_id: HOWARD,
      is_out_of_office: true,
      acknowledge_unreachable: true
    })
    expect(res.statusCode).toBe(200)
    expect(saved).toHaveLength(1)
  })

  it('saves a delegate who sees some of them, with a warning', async () => {
    reach.hidden = 5
    const res = await call('POST', '/me/delegate', { delegate_id: HOWARD, is_out_of_office: true })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).warnings[0]).toMatch(/cannot open 5 of the 12/)
  })
})

describe('PATCH /users/:id (own row)', () => {
  it('refuses delegating to oneself and a malformed delegate id', async () => {
    expect((await call('PATCH', `/${ME}`, { delegate_id: ME.toLowerCase() })).statusCode).toBe(400)
    expect((await call('PATCH', `/${ME}`, { delegate_id: 'nope' })).statusCode).toBe(400)
    expect((await call('PATCH', `/${ME}`, { delegate_expires_at: 'soon' })).statusCode).toBe(400)
    expect(saved).toHaveLength(0)
  })

  it('applies the same reach check as /me/delegate, and saves a reachable delegate', async () => {
    expect((await call('PATCH', `/${ME}`, { delegate_id: HOWARD })).statusCode).toBe(409)
    reach.hidden = 0
    const ok = await call('PATCH', `/${ME}`, { delegate_id: HOWARD })
    expect(ok.statusCode).toBe(200)
    expect(saved[0]).toMatchObject({ delegate_id: HOWARD })
  })
})
