import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// An update_fields custom action is a person's write to the record: it used to
// call the items service without the request, so the record's edit locks
// (post-approval admin-only tier included) never judged it. The route now asks
// recordWriteRefusal with the fields it writes and hands updateOne the request.

const state = vi.hoisted(() => ({ isAdmin: false, adminOnly: false }))

const ACTION = {
  id: 'A1',
  label: 'Mark received',
  collection: 'orders',
  action_type: 'update_fields',
  is_active: true,
  guard: null,
  config: JSON.stringify({ set: { received: true } })
}

vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.first = async () => ACTION
    return q
  })
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: Record<string, unknown>) => {
    Object.assign(req, { user: { id: 'U1', role: 'R' }, isAdmin: state.isAdmin })
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async () => ({ id: '7', received: false })),
  updateOne: vi.fn(async () => ({ id: '7' }))
}))
vi.mock('../../../services/edit-lock.js', () => ({
  // Stands in for the real gate (edit-lock.test.ts proves it): admins pass,
  // an admin-only state refuses everyone else, an ordinary state is open.
  recordWriteRefusal: vi.fn(async (req: { isAdmin?: boolean }) =>
    !req.isAdmin && state.adminOnly
      ? {
          status: 403,
          body: {
            error:
              'This record is at Approved — only administrators can change it. Use Request help to ask for a change.',
            code: 'EDIT_LOCKED'
          }
        }
      : null
  )
}))

const { customActionRoutes } = await import('../../../routes/custom-actions.js')
const { recordWriteRefusal } = await import('../../../services/edit-lock.js')
const { updateOne } = await import('../../../services/items.js')

async function execute() {
  const app = Fastify()
  await app.register(customActionRoutes)
  const res = await app.inject({ method: 'POST', url: '/A1/execute', payload: { item: '7' } })
  await app.close()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  state.isAdmin = false
  state.adminOnly = false
})

describe('POST /:id/execute — update_fields judges the record', () => {
  it('refuses a non-admin in an admin-only state before writing', async () => {
    state.adminOnly = true
    const res = await execute()
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('EDIT_LOCKED')
    expect(recordWriteRefusal).toHaveBeenCalledWith(expect.anything(), 'orders', '7', {
      fields: ['received']
    })
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('lets an admin through; the write carries the request', async () => {
    state.adminOnly = true
    state.isAdmin = true
    const res = await execute()
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(updateOne).mock.calls[0]?.[4]).toMatchObject({ isAdmin: true })
  })

  it('an ordinary state is unchanged: the fields are written', async () => {
    const res = await execute()
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ ok: true, updated: ['received'] })
    expect(updateOne).toHaveBeenCalledWith(
      expect.anything(),
      'orders',
      '7',
      { received: true },
      expect.objectContaining({ user: expect.anything() })
    )
  })
})
