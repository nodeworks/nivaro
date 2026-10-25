import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /items/:collection/export used to ask readItems for 10,000 rows and get
// the 1,000-row list cap back without a word. It pages with offset now, ties
// on id, and says when more rows matched than one export holds.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN-1', role: 'ADMIN-ROLE' }
    req.isAdmin = true
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
const state = vi.hoisted(() => ({ total: 0 }))
const svc = vi.hoisted(() => ({
  readItems: vi.fn(
    async (_u: unknown, _c: string, q: { limit?: number; offset?: number; sort?: string[] }) => {
      const from = q.offset ?? 0
      const n = Math.max(0, Math.min(q.limit ?? 25, 1000, state.total - from))
      return { data: Array.from({ length: n }, (_, i) => ({ id: from + i + 1 })), total: null }
    }
  ),
  getActualColumns: vi.fn(async () => new Set(['id', 'name']))
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  ...svc
}))

import { itemsRoutes } from '../../../routes/items.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

beforeEach(() => {
  svc.readItems.mockClear()
})

describe('GET /items/:collection/export', () => {
  it('pages past the 1,000-row read cap', async () => {
    state.total = 2500
    const res = await (await app()).inject({ url: '/api/items/articles/export?format=json' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(2500)
    expect(res.headers['x-nivaro-export-truncated']).toBeUndefined()
    const offsets = svc.readItems.mock.calls.map((c) => (c[2] as { offset: number }).offset)
    expect(offsets).toEqual([0, 1000, 2000])
    // id breaks ties so offset pages neither repeat nor skip rows
    expect((svc.readItems.mock.calls[0][2] as { sort: string[] }).sort).toEqual(['id'])
  })

  it('keeps the caller sort and does not repeat id', async () => {
    state.total = 3
    await (await app()).inject({ url: '/api/items/articles/export?sort=-name,id' })
    expect((svc.readItems.mock.calls[0][2] as { sort: string[] }).sort).toEqual(['-name', 'id'])
  })

  it('stops at 10,000 rows and says so when more matched', async () => {
    state.total = 12000
    const res = await (await app()).inject({ url: '/api/items/articles/export?format=json' })
    expect(res.json().data).toHaveLength(10000)
    expect(res.headers['x-nivaro-export-truncated']).toBe('10000')
  })

  it('exactly 10,000 rows is not truncated', async () => {
    state.total = 10000
    const res = await (await app()).inject({ url: '/api/items/articles/export?format=json' })
    expect(res.json().data).toHaveLength(10000)
    expect(res.headers['x-nivaro-export-truncated']).toBeUndefined()
  })
})
