import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Sub-rows hang off one record's field: they answer to that record (visible
// as the caller, the field in their policy) and a write also passes what a
// PATCH would (update rights, edit lock, approval lock).
const s = vi.hoisted(() => ({
  hidden: new Set<string>(),
  refusals: new Map<string, { status: 403 | 404 | 409; body: { error: string; code?: string } }>(),
  fields: null as string[] | null,
  deletes: 0
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'paul', role: 'R' }
    req.isAdmin = false
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => s.fields)
}))
vi.mock('../../../services/edit-lock.js', () => ({
  recordWriteRefusal: vi.fn(
    async (_r: unknown, _c: string, id: string) => s.refusals.get(id) ?? null
  )
}))
vi.mock('../../../services/items.js', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  CollectionNotFoundError: class CollectionNotFoundError extends Error {},
  ItemNotFoundError: class ItemNotFoundError extends Error {},
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) => (s.hidden.has(id) ? null : { id }))
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'select', 'orderBy', 'max', 'returning']) c[m] = () => c
    c.first = async () => ({ id: 1, sort: 1, data: '{}' })
    c.delete = async () => {
      s.deletes++
      return 1
    }
    c.insert = () => c
    // biome-ignore lint/suspicious/noThenProperty: knex builders are awaitable
    c.then = (res: (v: unknown) => unknown) => Promise.resolve([{ id: 1 }]).then(res)
    return c
  })
}))

import { subRowsRoutes } from '../../../routes/sub-rows.js'

async function call(method: 'GET' | 'PATCH', id: string) {
  const app = Fastify({ logger: false })
  await app.register(subRowsRoutes, { prefix: '/sub-rows' })
  return app.inject({
    method,
    url: `/sub-rows/workflows/${id}/checklist`,
    ...(method === 'PATCH' ? { payload: { items: [{ sort: 1, data: { a: 1 } }] } } : {})
  })
}

describe('sub-rows answer to their record', () => {
  beforeEach(() => {
    s.hidden.clear()
    s.refusals.clear()
    s.fields = null
    s.deletes = 0
  })

  it('refuses a hidden record, a field outside the policy and a locked record', async () => {
    s.hidden.add('371801')
    expect((await call('GET', '371801')).statusCode).toBe(404)
    s.refusals.set('372703', { status: 403, body: { error: 'locked', code: 'EDIT_LOCKED' } })
    const locked = await call('PATCH', '372703')
    expect(locked.statusCode).toBe(403)
    expect(locked.json().code).toBe('EDIT_LOCKED')
    s.refusals.set('372704', {
      status: 409,
      body: { error: 'Andy is editing', code: 'RECORD_LOCKED' }
    })
    expect((await call('PATCH', '372704')).statusCode).toBe(409)
    s.fields = ['title']
    expect((await call('GET', '500')).statusCode).toBe(403)
    expect(s.deletes).toBe(0)
  })

  it('serves and replaces the sub-rows of a record the caller may change', async () => {
    expect((await call('GET', '500')).statusCode).toBe(200)
    s.fields = ['checklist']
    expect((await call('PATCH', '500')).statusCode).toBe(200)
    expect(s.deletes).toBe(1)
  })
})
