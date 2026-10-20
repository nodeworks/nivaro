import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Schedule a change…" is offered to non-admins when the record's form grants
// it (allow_schedule). The API must hold the same line: record visible, form
// grants it, record updatable, and every field in the change updatable.

const state = vi.hoisted(() => ({
  admin: false,
  canUpdate: true,
  layout: { allow_schedule: true } as Record<string, unknown> | null,
  visible: true,
  updatable: true,
  updateFields: null as string[] | null,
  readFields: null as string[] | null,
  resolveArgs: [] as unknown[],
  inserts: 0,
  updates: 0,
  rows: [] as Record<string, unknown>[],
  existing: undefined as Record<string, unknown> | undefined
}))

vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.orderBy = () => q
    q.first = async () =>
      table === 'nivaro_scheduled_changes'
        ? (state.existing ?? { id: 1, changes: '{}' })
        : undefined
    q.insert = () => {
      state.inserts++
      return { returning: async () => [{ id: 1 }] }
    }
    q.update = async () => {
      state.updates++
      return 1
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.rows).then(res, rej)
    return q
  }
  return { db: vi.fn((table: string) => chain(table)) }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'R1' }
    req.isAdmin = state.admin
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => state.canUpdate),
  getAllowedFields: vi.fn(async (_u: unknown, action: string) =>
    action === 'update' ? state.updateFields : state.readFields
  )
}))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async () => (state.visible ? { id: 7 } : null)),
  canUpdateItem: vi.fn(async () => state.updatable)
}))
vi.mock('../../../routes/collection-layouts.js', () => ({
  resolveLayout: vi.fn(async (opts: unknown) => {
    state.resolveArgs.push(opts)
    return { row: state.layout, reason: null, checked: [] }
  }),
  legitimatePinForRecord: vi.fn(async () => null)
}))

import { scheduledChangesRoutes } from '../../../routes/scheduled-changes.js'

const body = (changes: Record<string, unknown> = { status: 'closed' }) => ({
  collection: 'orders',
  item_id: '7',
  change_type: 'field_update',
  changes,
  scheduled_at: '2026-11-01T09:00:00.000Z'
})

async function app() {
  const a = Fastify()
  await a.register(scheduledChangesRoutes, { prefix: '/api/scheduled-changes' })
  return a
}

beforeEach(() => {
  state.admin = false
  state.canUpdate = true
  state.layout = { allow_schedule: true }
  state.visible = true
  state.updatable = true
  state.updateFields = null
  state.readFields = null
  state.resolveArgs = []
  state.inserts = 0
  state.updates = 0
  state.rows = []
  state.existing = undefined
})

describe('POST /scheduled-changes', () => {
  it('refuses a non-admin whose form does not grant scheduling', async () => {
    state.layout = { allow_schedule: false }
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/scheduled-changes',
      payload: body()
    })
    expect(res.statusCode).toBe(403)
    expect(state.inserts).toBe(0)
  })

  it('answers 404 for a hidden record without resolving its form', async () => {
    state.visible = false
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/scheduled-changes',
      payload: body()
    })
    expect(res.statusCode).toBe(404)
    expect(state.resolveArgs).toHaveLength(0)
    expect(state.inserts).toBe(0)
  })

  it('refuses a visible, granted record the caller may not update', async () => {
    state.updatable = false
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/scheduled-changes',
      payload: body()
    })
    expect(res.statusCode).toBe(403)
    expect(state.inserts).toBe(0)
  })

  it('refuses a change to a field the caller may not update, naming it', async () => {
    state.updateFields = ['status']
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/scheduled-changes',
      payload: body({ status: 'closed', budget: 1_000_000 })
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toContain('budget')
    expect(state.inserts).toBe(0)
  })

  it('stores a granted change to allowed fields', async () => {
    state.updateFields = ['status']
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/scheduled-changes',
      payload: body({ status: 'closed' })
    })
    expect(res.statusCode).toBe(201)
    expect(state.inserts).toBe(1)
  })

  it('treats a "*" update policy as every field', async () => {
    state.updateFields = ['*']
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/scheduled-changes',
      payload: body({ status: 'closed', budget: 5 })
    })
    expect(res.statusCode).toBe(201)
    expect(state.inserts).toBe(1)
  })

  it('ignores a layout pin that is not a string', async () => {
    state.layout = null
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/scheduled-changes',
      payload: { ...body(), layout: { slug: 'x' } }
    })
    expect(res.statusCode).toBe(403)
    expect(state.inserts).toBe(0)
  })

  it('lets administrators schedule without a grant or field check', async () => {
    state.admin = true
    state.layout = null
    state.updatable = false
    state.updateFields = []
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/scheduled-changes',
      payload: body({ budget: 5 })
    })
    expect(res.statusCode).toBe(201)
    expect(state.resolveArgs).toHaveLength(0)
    expect(state.inserts).toBe(1)
  })
})

describe('GET /scheduled-changes/:collection/:itemId', () => {
  it('answers 404 to a non-admin who cannot see the record', async () => {
    state.visible = false
    state.rows = [{ id: 1, changes: '{"status":"closed"}' }]
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/scheduled-changes/orders/7'
    })
    expect(res.statusCode).toBe(404)
  })

  it('leaves out values of fields the caller may not read', async () => {
    state.readFields = ['status']
    state.rows = [{ id: 1, changes: '{"status":"closed","budget":5}' }]
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/scheduled-changes/orders/7'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data[0].changes).toEqual({ status: 'closed' })
  })

  it('never shows a stored value it cannot filter to a field-limited caller', async () => {
    state.readFields = ['status']
    state.rows = [
      { id: 1, changes: '"budget=5"' },
      { id: 2, changes: '[{"budget":5}]' },
      { id: 3, changes: 'not json' }
    ]
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/scheduled-changes/orders/7'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.map((r: { changes: unknown }) => r.changes)).toEqual([{}, {}, {}])
  })

  it('treats a "*" read policy as every field', async () => {
    state.readFields = ['*']
    state.rows = [{ id: 1, changes: '{"status":"closed","budget":5}' }]
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/scheduled-changes/orders/7'
    })
    expect(res.json().data[0].changes).toEqual({ status: 'closed', budget: 5 })
  })

  it('shows administrators every value', async () => {
    state.admin = true
    state.visible = false
    state.readFields = []
    state.rows = [{ id: 1, changes: '{"status":"closed","budget":5}' }]
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/scheduled-changes/orders/7'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data[0].changes).toEqual({ status: 'closed', budget: 5 })
  })
})

describe('DELETE /scheduled-changes/:id', () => {
  const own = { id: 1, created_by: 'U1', collection: 'orders', item_id: 7, status: 'pending' }

  it("refuses someone else's change", async () => {
    state.existing = { ...own, created_by: 'U2' }
    const res = await (await app()).inject({ method: 'DELETE', url: '/api/scheduled-changes/1' })
    expect(res.statusCode).toBe(403)
    expect(state.updates).toBe(0)
  })

  it('refuses an own change on a record the caller can no longer update or see', async () => {
    state.existing = own
    state.updatable = false
    const refused = await (await app()).inject({
      method: 'DELETE',
      url: '/api/scheduled-changes/1'
    })
    expect(refused.statusCode).toBe(403)
    state.visible = false
    const hidden = await (await app()).inject({ method: 'DELETE', url: '/api/scheduled-changes/1' })
    expect(hidden.statusCode).toBe(404)
    expect(state.updates).toBe(0)
  })

  it('cancels an own change on an updatable record', async () => {
    state.existing = own
    const res = await (await app()).inject({ method: 'DELETE', url: '/api/scheduled-changes/1' })
    expect(res.statusCode).toBe(204)
    expect(state.updates).toBe(1)
  })
})
