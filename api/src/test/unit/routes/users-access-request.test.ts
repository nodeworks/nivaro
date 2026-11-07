import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /users/me/access-request (army 4 a09-2 / a09-4): admins are told once on
// the first submit, never on a resend; an identical resend writes nothing; a
// reason over the limit is refused; junk zone ids are not stored.

const FA = 'F1F1F1F1-0000-4000-8000-000000000001'
const NA = 'A2A2A2A2-0000-4000-8000-000000000002'

const state = vi.hoisted(() => ({
  user: { role: '', preferences: null as string | null },
  updates: [] as Array<Record<string, unknown>>,
  activity: [] as Array<Record<string, unknown>>,
  notified: 0
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = {
      id: 'AAAAAAAA-0000-4000-8000-000000000001',
      role: 'X',
      first_name: 'Pamela',
      last_name: 'Wells'
    }
    req.isAdmin = false
  }
  return { authenticate, requireAdmin: authenticate }
})
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (a: Record<string, unknown>) => {
    state.activity.push(a)
    return 1
  })
}))
vi.mock('../../../services/portal-access-request.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  // Zones 1–3 exist; vendor 753 exists.
  existingIds: vi.fn(async (table: string, ids: Array<string | number>) =>
    ids.filter((v) => (table === 'divisions' ? ['1', '2', '3'] : ['753']).includes(String(v)))
  ),
  // army6 L46: the vendor's name comes from the vendors table, not the body.
  vendorOf: vi.fn(async (id: string | number | null) =>
    String(id) === '753' ? { id: 753, name: 'Acme Fiber Supply' } : null
  ),
  notifyAdminsOfAccessRequest: vi.fn(async () => {
    state.notified++
    return 2
  })
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((table: string) => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.catch = vi.fn(() => c)
    c.first = vi.fn(() => {
      const p =
        table === 'nivaro_users'
          ? Promise.resolve({ ...state.user })
          : table === 'nivaro_settings'
            ? Promise.resolve({ new_user_role: FA, access_request_role: NA })
            : table === 'nivaro_roles'
              ? Promise.resolve({ id: NA, admin_access: false })
              : Promise.resolve(undefined)
      return p
    })
    c.update = vi.fn(async (patch: Record<string, unknown>) => {
      state.updates.push(patch)
      if (typeof patch.preferences === 'string') state.user.preferences = patch.preferences
      if (typeof patch.role === 'string') state.user.role = patch.role
      return 1
    })
    return c
  })
  return { db }
})

import { usersRoutes } from '../../../routes/users.js'

async function submit(payload: unknown) {
  const app = Fastify({ logger: false })
  await app.register(usersRoutes)
  return app.inject({ method: 'POST', url: '/me/access-request', payload: payload as object })
}

const body = { divisions: [2, 'abc', 99], vendor: 753, vendor_name: 'V', reason: 'Forecasting' }

beforeEach(() => {
  state.user = { role: FA, preferences: null }
  state.updates = []
  state.activity = []
  state.notified = 0
})

describe('POST /me/access-request', () => {
  it('first submit: stores only real zones, moves to review, tells admins once', async () => {
    const res = await submit(body)
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.role_changed).toBe(true)
    expect(data.access_request.divisions).toEqual([2])
    expect(data.access_request.vendor).toBe(753)
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].role).toBe(NA)
    expect(state.activity).toHaveLength(1)
    expect(state.notified).toBe(1)
  })

  it('an identical resend writes nothing, logs nothing and tells nobody', async () => {
    await submit(body)
    state.updates = []
    state.activity = []
    state.notified = 0
    const res = await submit(body)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.unchanged).toBe(true)
    expect(state.updates).toHaveLength(0)
    expect(state.activity).toHaveLength(0)
    expect(state.notified).toBe(0)
  })

  it('a changed resend is stored and logged once, admins are not told again', async () => {
    await submit(body)
    state.updates = []
    state.activity = []
    state.notified = 0
    const res = await submit({ ...body, reason: 'Forecasting and budgets' })
    expect(res.statusCode).toBe(200)
    expect(state.updates).toHaveLength(1)
    expect(state.activity).toHaveLength(1)
    expect(state.activity[0].comment).toBe('updated')
    expect(state.notified).toBe(0)
  })

  it('refuses a reason over 2000 characters instead of cutting it', async () => {
    const res = await submit({ ...body, reason: 'x'.repeat(2001) })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).code).toBe('REASON_TOO_LONG')
    expect(state.updates).toHaveLength(0)
  })

  it('a vendor that does not exist is not stored', async () => {
    const res = await submit({ ...body, vendor: 42, vendor_name: 'Nope' })
    const data = JSON.parse(res.body).data
    expect(data.access_request.vendor).toBeNull()
    expect(data.access_request.vendor_name).toBeNull()
  })

  it('stores the vendor’s own name, never the text the client sent (army6 L46)', async () => {
    const res = await submit({ ...body, vendor_name: 'x'.repeat(400) })
    const data = JSON.parse(res.body).data
    expect(data.access_request.vendor).toBe(753)
    expect(data.access_request.vendor_name).toBe('Acme Fiber Supply')
  })
})
