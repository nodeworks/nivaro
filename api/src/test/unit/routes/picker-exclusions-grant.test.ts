import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  admin: false,
  canUpdate: true,
  layout: { allow_disable_pickers: true } as Record<string, unknown> | null,
  visible: true as boolean,
  updatable: true as boolean,
  pin: null as Record<string, unknown> | null,
  pinArgs: [] as unknown[],
  resolveArgs: [] as unknown[],
  inserts: 0
}))

vi.mock('../../../db/index.js', () => {
  const chain = () => {
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.whereIn = () => q
    q.first = async () => undefined
    q.insert = async () => {
      state.inserts++
    }
    q.delete = async () => 1
    return q
  }
  return { db: vi.fn(() => chain()) }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'R1' }
    req.isAdmin = state.admin
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => state.canUpdate) }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async () => (state.visible ? { id: 7 } : null)),
  canUpdateItem: vi.fn(async () => state.updatable)
}))
vi.mock('../../../routes/collection-layouts.js', () => ({
  resolveLayout: vi.fn(async (opts: unknown) => {
    state.resolveArgs.push(opts)
    return { row: state.layout, reason: null, checked: [] }
  }),
  // Stands in for the real check: a role-allowed record form whose record
  // rules match this record, or null.
  legitimatePinForRecord: vi.fn(async (opts: unknown) => {
    state.pinArgs.push(opts)
    return state.pin
  })
}))

import { pickerExclusionRoutes, pickerToggleRefusal } from '../../../routes/picker-exclusions.js'

const member = { user: { id: 'U1', role: 'R1' } as never, isAdmin: false }

beforeEach(() => {
  state.admin = false
  state.canUpdate = true
  state.layout = { allow_disable_pickers: true }
  state.visible = true
  state.updatable = true
  state.pin = null
  state.pinArgs = []
  state.resolveArgs = []
  state.inserts = 0
})

describe('pickerToggleRefusal — "Hide from pickers" for all users', () => {
  it('lets administrators through without resolving a layout', async () => {
    expect(await pickerToggleRefusal({ ...member, isAdmin: true }, 'orders', '7')).toBeNull()
    expect(state.resolveArgs).toHaveLength(0)
  })

  it('resolves the form from the record and role, never from the requested slug', async () => {
    expect(await pickerToggleRefusal(member, 'orders', '7', 'unit-order')).toBeNull()
    expect(state.resolveArgs[0]).toEqual({
      collection: 'orders',
      slug: null,
      item: '7',
      role: 'R1',
      isAdmin: false,
      userId: 'U1'
    })
    // The record's own form granted it — the pin is never consulted.
    expect(state.pinArgs).toHaveLength(0)
  })

  it('refuses a slug naming a granting form this record would not open with', async () => {
    state.layout = { allow_disable_pickers: false }
    state.pin = null // role or record rules rule the pin out
    expect((await pickerToggleRefusal(member, 'orders', '7', 'granting-form'))?.status).toBe(403)
    expect(state.pinArgs[0]).toEqual({
      collection: 'orders',
      slug: 'granting-form',
      item: '7',
      role: 'R1'
    })
  })

  it('honours a pin the person could legitimately be on when it grants it', async () => {
    state.layout = { allow_disable_pickers: false }
    state.pin = { allow_disable_pickers: true }
    expect(await pickerToggleRefusal(member, 'orders', '7', 'unit-order')).toBeNull()
    state.pin = { allow_disable_pickers: false }
    expect((await pickerToggleRefusal(member, 'orders', '7', 'unit-order'))?.status).toBe(403)
  })

  it('refuses a record the person can see but may not update', async () => {
    state.updatable = false
    expect((await pickerToggleRefusal(member, 'orders', '7'))?.status).toBe(403)
  })

  it('refuses when the resolved form does not grant it, or there is no form', async () => {
    state.layout = { allow_disable_pickers: false }
    expect((await pickerToggleRefusal(member, 'orders', '7'))?.status).toBe(403)
    state.layout = null
    expect((await pickerToggleRefusal(member, 'orders', '7'))?.status).toBe(403)
  })

  it('refuses people who may not update the collection, and system tables', async () => {
    state.canUpdate = false
    expect((await pickerToggleRefusal(member, 'orders', '7'))?.status).toBe(403)
    state.canUpdate = true
    expect((await pickerToggleRefusal(member, 'nivaro_users', '7'))?.status).toBe(403)
  })

  it('answers 404 for a record the person cannot see', async () => {
    state.visible = false
    expect((await pickerToggleRefusal(member, 'orders', '7', 'unit-order'))?.status).toBe(404)
    // Decided before any form is looked at.
    expect(state.resolveArgs).toHaveLength(0)
    expect(state.pinArgs).toHaveLength(0)
  })
})

describe('POST/DELETE /picker-exclusions run the grant gate', () => {
  it('refuses an ungranted member before writing, and writes for a granted one', async () => {
    const app = Fastify()
    await app.register(pickerExclusionRoutes, { prefix: '/api/picker-exclusions' })
    state.layout = { allow_disable_pickers: false }
    const refused = await app.inject({
      method: 'POST',
      url: '/api/picker-exclusions',
      payload: { collection: 'orders', item_id: '7' }
    })
    expect(refused.statusCode).toBe(403)
    expect(state.inserts).toBe(0)

    state.layout = { allow_disable_pickers: true }
    const ok = await app.inject({
      method: 'POST',
      url: '/api/picker-exclusions',
      payload: { collection: 'orders', item_id: '7' }
    })
    expect(ok.statusCode).toBe(200)
    expect(state.inserts).toBe(1)

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/picker-exclusions',
      payload: { collection: 'orders', item_id: '7' }
    })
    expect(del.statusCode).toBe(200)
  })

  it('refuses a slug pointing at a granting form the record would not resolve to', async () => {
    const app = Fastify()
    await app.register(pickerExclusionRoutes, { prefix: '/api/picker-exclusions' })
    state.layout = { allow_disable_pickers: false }
    state.pin = null
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/picker-exclusions',
        payload: { collection: 'orders', item_id: '7', layout: 'granting-form' }
      })
      expect(res.statusCode).toBe(403)
    }
    expect(state.inserts).toBe(0)
  })

  it('refuses a visible record the caller may not update, on POST and DELETE', async () => {
    const app = Fastify()
    await app.register(pickerExclusionRoutes, { prefix: '/api/picker-exclusions' })
    state.updatable = false
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/picker-exclusions',
        payload: { collection: 'orders', item_id: '7' }
      })
      expect(res.statusCode).toBe(403)
    }
    expect(state.inserts).toBe(0)
  })

  it('lets administrators toggle any record', async () => {
    const app = Fastify()
    await app.register(pickerExclusionRoutes, { prefix: '/api/picker-exclusions' })
    state.admin = true
    state.layout = null
    state.updatable = false
    const res = await app.inject({
      method: 'POST',
      url: '/api/picker-exclusions',
      payload: { collection: 'orders', item_id: '7' }
    })
    expect(res.statusCode).toBe(200)
    expect(state.inserts).toBe(1)
  })
})
