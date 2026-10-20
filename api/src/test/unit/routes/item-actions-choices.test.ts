import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// An item action's choose step: the registry lists `choose` without its
// options function, and GET /item-actions/:id/choices answers per record.
const state = vi.hoisted(() => ({
  actions: new Map<string, Record<string, unknown>>(),
  canRead: true,
  hidden: new Set<string>()
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  },
  requireAuth: async () => {}
}))
vi.mock('../../../services/permissions.js', () => ({ can: async () => state.canRead }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/items.js', () => ({
  readOne: async (_u: unknown, _c: string, id: string) =>
    state.hidden.has(String(id)) ? null : { id }
}))
vi.mock('../../../extensions/item-actions.js', () => ({
  itemActionRegistry: {
    get: (id: string) => state.actions.get(id),
    list: () => [...state.actions.values()]
  }
}))

import { itemActionsRoutes } from '../../../routes/item-actions.js'

async function app() {
  const a = Fastify()
  await a.register(itemActionsRoutes)
  return a
}

const options = vi.fn()

beforeEach(() => {
  state.canRead = true
  state.hidden = new Set()
  options.mockReset()
  state.actions = new Map([
    [
      'push',
      {
        id: 'push',
        label: 'Push',
        execute: vi.fn(),
        collections: ['workflows'],
        choose: { key: 'file_id', label: 'File to send', options }
      }
    ],
    ['plain', { id: 'plain', label: 'Plain', execute: vi.fn() }]
  ])
})

describe('item action choose step', () => {
  it('lists choose without its options function', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/item-actions/registered?collection=workflows'
    })
    const data = res.json().data as Array<Record<string, unknown>>
    expect(data.find((a) => a.id === 'push')?.choose).toEqual({
      key: 'file_id',
      label: 'File to send',
      body: null
    })
    expect(data.find((a) => a.id === 'plain')?.choose).toBeUndefined()
  })

  it('answers the options for the record, cleaned', async () => {
    options.mockResolvedValue([
      { value: 7, label: 'Quote.pdf', hint: '12 KB' },
      { value: 'f2', label: 'Spec.docx' },
      { label: 'no value' }
    ])
    const res = await (await app()).inject({
      method: 'GET',
      url: '/item-actions/push/choices?collection=workflows&item=42'
    })
    expect(res.statusCode).toBe(200)
    expect(options).toHaveBeenCalledWith({ collection: 'workflows', itemId: '42', userId: 'U1' })
    expect(res.json().data).toEqual([
      { value: '7', label: 'Quote.pdf', hint: '12 KB' },
      { value: 'f2', label: 'Spec.docx' }
    ])
  })

  it('answers an empty list for an action without a choose step', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/item-actions/plain/choices?collection=workflows&item=42'
    })
    expect(res.json().data).toEqual([])
  })

  it('refuses a caller who cannot read the collection', async () => {
    state.canRead = false
    const res = await (await app()).inject({
      method: 'GET',
      url: '/item-actions/push/choices?collection=workflows&item=42'
    })
    expect(res.statusCode).toBe(403)
    expect(options).not.toHaveBeenCalled()
  })

  it('refuses a collection the action does not serve', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/item-actions/push/choices?collection=invoices&item=42'
    })
    expect(res.statusCode).toBe(404)
    expect(options).not.toHaveBeenCalled()
  })

  it('refuses a record the caller cannot see', async () => {
    state.hidden.add('42')
    const res = await (await app()).inject({
      method: 'GET',
      url: '/item-actions/push/choices?collection=workflows&item=42'
    })
    expect(res.statusCode).toBe(404)
    expect(options).not.toHaveBeenCalled()
  })

  it('never sends the extension error text to the browser', async () => {
    options.mockRejectedValue(new Error("Invalid column name 'secret_col'"))
    const res = await (await app()).inject({
      method: 'GET',
      url: '/item-actions/push/choices?collection=workflows&item=42'
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'Could not load the options' })
  })

  it('needs a collection and an item', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/item-actions/push/choices' })
    expect(res.statusCode).toBe(400)
  })
})
