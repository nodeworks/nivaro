import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Widget button actions (POST /widgets-internal/:id/action) change ONE record
// the caller names: it answers like a PATCH of that record (visible, theirs
// to change, not locked) and the write goes through the items service.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'paul', role: 'R' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))

const gate = vi.hoisted(() => ({
  refusals: new Map<string, { status: 403 | 404 | 409; body: { error: string; code?: string } }>()
}))
vi.mock('../../../services/edit-lock.js', () => ({
  recordWriteRefusal: vi.fn(
    async (_req: unknown, _c: string, id: string) => gate.refusals.get(id) ?? null
  )
}))
const items = vi.hoisted(() => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) => ({ id, skip_forecast_cron: 0 })),
  updateOne: vi.fn(async () => ({})),
  readItems: vi.fn(),
  aggregateItems: vi.fn()
}))
vi.mock('../../../services/items.js', () => items)

const widgets = vi.hoisted(() => new Map<number, Record<string, unknown>>())
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const c: Record<string, unknown> = {}
    let id = 0
    c.where = vi.fn((w: { id?: number }) => {
      id = Number(w?.id ?? 0)
      return c
    })
    c.first = vi.fn(async () => (table === 'nivaro_widgets' ? widgets.get(id) : undefined))
    c.update = vi.fn(async () => {
      throw new Error('raw write')
    })
    return c
  })
}))

import { widgetsInternalRoutes } from '../../../routes/widgets-internal.js'

widgets.set(2, {
  id: 2,
  widget_type: 'buttons',
  config: JSON.stringify({
    buttons: [
      {
        action: 'field-update',
        action_config: { collection: 'workflows', id_input: 'id', status: 'x' }
      },
      {
        action: 'toggle',
        action_config: { collection: 'workflows', id_input: 'id', field: 'skip_forecast_cron' }
      }
    ]
  })
})

async function act(button_index: number, id: string) {
  const app = Fastify({ logger: false })
  app.register(widgetsInternalRoutes, { prefix: '/widgets-internal' })
  await app.ready()
  return app.inject({
    method: 'POST',
    url: '/widgets-internal/2/action',
    payload: { button_index, inputs: { id } }
  })
}

describe('widget button actions', () => {
  beforeEach(() => {
    gate.refusals.clear()
    items.updateOne.mockClear()
  })

  it('refuse a record hidden from the caller or edit-locked, writing nothing', async () => {
    gate.refusals.set('371801', { status: 404, body: { error: 'Not found' } })
    gate.refusals.set('372703', {
      status: 403,
      body: { error: 'This record is at Level 2', code: 'EDIT_LOCKED' }
    })
    for (const b of [0, 1]) {
      expect((await act(b, '371801')).statusCode).toBe(404)
      const locked = await act(b, '372703')
      expect(locked.statusCode).toBe(403)
      expect(locked.json().code).toBe('EDIT_LOCKED')
    }
    expect(items.updateOne).not.toHaveBeenCalled()
  })

  it('write a record the caller may change through updateOne as the caller', async () => {
    expect((await act(0, '500')).statusCode).toBe(200)
    expect(items.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'paul' }),
      'workflows',
      '500',
      { status: 'x' },
      expect.anything(),
      undefined
    )
    const toggled = await act(1, '500')
    expect(toggled.json().data.new_value).toBe('1')
    expect(items.updateOne).toHaveBeenLastCalledWith(
      expect.anything(),
      'workflows',
      '500',
      { skip_forecast_cron: '1' },
      expect.anything(),
      undefined
    )
  })
})
