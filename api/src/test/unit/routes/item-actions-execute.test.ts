import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /item-actions/:id/execute runs extension code that changes a record —
// it must apply the record form's gates, not only sign-in.
const state = vi.hoisted(() => ({
  actions: new Map<string, Record<string, unknown>>(),
  can: { read: true, update: true } as Record<string, boolean>,
  hidden: new Set<string>(),
  locked: new Set<string>(),
  editLock: 'open' as 'open' | 'refuse' | 'broken'
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  },
  requireAuth: async () => {}
}))
vi.mock('../../../services/permissions.js', () => ({
  can: async (_u: unknown, action: string) => state.can[action] !== false
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/items.js', () => ({
  readOne: async (_u: unknown, _c: string, id: string) =>
    state.hidden.has(String(id)) ? null : { id },
  canUpdateItem: async (_u: unknown, _c: string, id: string) => !state.locked.has(String(id))
}))
vi.mock('../../../services/edit-lock.js', () => {
  class EditLockedError extends Error {}
  return {
    EDIT_LOCKED: 'EDIT_LOCKED',
    EditLockedError,
    assertNotEditLocked: async () => {
      if (state.editLock === 'refuse')
        throw new EditLockedError('Only the step owners may change it.')
      if (state.editLock === 'broken') throw new Error('db down')
    }
  }
})
vi.mock('../../../extensions/item-actions.js', () => ({
  itemActionRegistry: {
    get: (id: string) => state.actions.get(id),
    list: () => [...state.actions.values()]
  }
}))

import { executeFailure, itemActionsRoutes } from '../../../routes/item-actions.js'

async function app() {
  const a = Fastify()
  await a.register(itemActionsRoutes)
  return a
}

const execute = vi.fn()
const applicable = vi.fn()

function run(body: Record<string, unknown>, id = 'push') {
  return app().then((a) =>
    a.inject({ method: 'POST', url: `/item-actions/${id}/execute`, payload: body })
  )
}

beforeEach(() => {
  state.can = { read: true, update: true }
  state.hidden = new Set()
  state.locked = new Set()
  state.editLock = 'open'
  execute.mockReset().mockResolvedValue({ message: 'done' })
  applicable.mockReset().mockResolvedValue(true)
  state.actions = new Map([
    ['push', { id: 'push', label: 'Push', execute, applicable, collections: ['workflows'] }]
  ])
})

describe('item action execute gates', () => {
  it('runs for a caller who may read and update the record', async () => {
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ message: 'done' })
    expect(execute).toHaveBeenCalledWith({
      collection: 'workflows',
      itemId: 42,
      payload: undefined,
      userId: 'U1',
      // Runs a step as the caller, never as a machine identity.
      callAsCaller: expect.any(Function)
    })
  })

  it('refuses a collection the action does not serve', async () => {
    const res = await run({ collection: 'invoices', itemId: 42 })
    expect(res.statusCode).toBe(404)
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses a caller without update on the collection', async () => {
    state.can.update = false
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses a caller without read on the collection', async () => {
    state.can.read = false
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('answers 404 for a record the caller cannot see', async () => {
    state.hidden.add('42')
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(404)
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses a record the caller may see but not update', async () => {
    state.locked.add('42')
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses a record the approval edit lock holds for someone else', async () => {
    state.editLock = 'refuse'
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({
      error: 'Only the step owners may change it.',
      code: 'EDIT_LOCKED'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses when the edit lock cannot be checked (fails closed)', async () => {
    state.editLock = 'broken'
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('EDIT_LOCKED')
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses when the action says it does not apply to the record', async () => {
    applicable.mockResolvedValue(false)
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(409)
    expect(applicable).toHaveBeenCalledWith({ collection: 'workflows', itemId: '42' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('still runs when the applicability check itself breaks', async () => {
    applicable.mockRejectedValue(new Error('boom'))
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(200)
  })

  it('needs a collection and an item', async () => {
    expect((await run({ collection: 'workflows' })).statusCode).toBe(400)
    expect((await run({ collection: 'bad name;', itemId: 1 })).statusCode).toBe(400)
  })

  it('passes on a refusal the extension marks as the caller’s', async () => {
    execute.mockRejectedValue(
      Object.assign(new Error('Workflow has no line items'), { statusCode: 422 })
    )
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'Workflow has no line items' })
  })

  it('never sends driver text to the browser', async () => {
    execute.mockRejectedValue(
      Object.assign(new Error("select * from [workflows] - Invalid column name 'secret_col'"), {
        number: 207
      })
    )
    const res = await run({ collection: 'workflows', itemId: 42 })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toMatch(/secret_col|workflows\]/)
  })
})

describe('executeFailure', () => {
  it('turns a foreign-key refusal into its 4xx', () => {
    const f = executeFailure(
      new Error(
        'The INSERT statement conflicted with the FOREIGN KEY constraint "fk_x". The conflict occurred'
      )
    )
    expect(f.status).toBe(422)
    expect(f.code).toBe('LINKED_RECORD_MISSING')
  })

  it('keeps a plain extension message on a real failure', () => {
    expect(executeFailure(new Error('Fusion push failed: HTTP 503'))).toEqual({
      status: 500,
      error: 'Fusion push failed: HTTP 503'
    })
  })

  it('hides a 4xx-marked error that still carries driver text', () => {
    const f = executeFailure(
      Object.assign(new Error('Validation failed for parameter p1. Invalid number.'), {
        statusCode: 400
      })
    )
    expect(f.status).toBe(500)
    expect(f.error).not.toMatch(/p1/)
  })
})
