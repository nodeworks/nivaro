import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// GET /queues/:id/totals (2026-11-14): canReadQueue is the gate, and the figures come from
// the same gated read the worklist makes, with the caller's scope tab and column filters.

const currentUser = { id: 'user-a', role: 'role-a' as string | null, isAdmin: false }

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/realtime.js', () => ({ broadcastCollectionUpdate: vi.fn() }))
vi.mock('../../../functions/queue-materialization-jobs.js', () => ({
  enqueueQueueMaterializationBackfill: vi.fn(async () => {})
}))
vi.mock('../../../services/queues.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/queues.js')>()),
  fetchQueueItems: vi.fn(async () => ({
    items: [],
    totals: { amount: { sum: 10, count: 2, min: 4, max: 6, avg: 5, by_collection: {} } },
    stats: { total: 2 },
    total: 2,
    truncated: false
  }))
}))
const queueRow: { current: Record<string, unknown> | undefined } = { current: undefined }
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ where: () => ({ first: async () => queueRow.current }) }))
}))

import { queuesRoutes } from '../../../routes/queues.js'
import { fetchQueueItems } from '../../../services/queues.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(queuesRoutes, { prefix: '/queues' })
  return app
}

afterEach(() => vi.clearAllMocks())

describe('GET /queues/:id/totals', () => {
  it('refuses a queue the caller may not read, before any read runs', async () => {
    queueRow.current = { id: 'q1', owner: 'someone-else', is_shared: false, role_id: null }
    const res = await buildApp().inject({
      method: 'GET',
      url: '/queues/00000000-0000-4000-8000-000000000001/totals?totals=extra.amount'
    })
    expect(res.statusCode).toBe(403)
    expect(fetchQueueItems).not.toHaveBeenCalled()
  })

  it('asks for at least one column', async () => {
    queueRow.current = { id: 'q1', owner: 'user-a', is_shared: false, role_id: null }
    const res = await buildApp().inject({
      method: 'GET',
      url: '/queues/00000000-0000-4000-8000-000000000001/totals'
    })
    expect(res.statusCode).toBe(400)
  })

  it('reads as the caller with their scope tab and column filters', async () => {
    queueRow.current = { id: 'q1', owner: 'x', is_shared: true, role_id: 'role-a' }
    const filters = JSON.stringify({ 'extra.region': 'East' })
    const res = await buildApp().inject({
      method: 'GET',
      url: `/queues/00000000-0000-4000-8000-000000000001/totals?scope=mine&totals=extra.amount,qty&filters=${encodeURIComponent(filters)}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { amount: { sum: 10, avg: 5 } }, total: 2 })
    const call = vi.mocked(fetchQueueItems).mock.calls[0]
    expect(call[0]).toBe('00000000-0000-4000-8000-000000000001')
    expect((call[1] as { id: string }).id).toBe('user-a')
    expect(call[2]).toBe('mine')
    expect(call[3]).toMatchObject({
      filters: { 'extra.region': 'East' },
      totals: ['amount', 'qty']
    })
    // Through the heavy-read gate like every worklist read.
    expect((call[3] as { readGate?: unknown }).readGate).toBeTruthy()
  })
})
