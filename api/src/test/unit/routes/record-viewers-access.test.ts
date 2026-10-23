import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

/**
 * POST /presence/record-viewers answers counts only for records the caller may read (second
 * review of post-mortem 3.3: with the realtime board the counts are cluster-wide).
 */
vi.mock('../../../middleware/authenticate.js', async (orig) => ({
  ...(await orig<typeof import('../../../middleware/authenticate.js')>()),
  requireAuth: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-1', role: 'r-1' }
    req.isAdmin = false
  },
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'admin', role: 'r-admin' }
    req.isAdmin = true
  }
}))
vi.mock('../../../plugins/socketio.js', async (orig) => ({
  ...(await orig<typeof import('../../../plugins/socketio.js')>()),
  getRecordViewerSnapshot: () => [
    { collection: 'projects', item: '1', viewers: [{ id: 'a', name: 'A' }] },
    {
      collection: 'projects',
      item: '2',
      viewers: [
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' }
      ]
    },
    { collection: 'secrets', item: '9', viewers: [{ id: 'd', name: 'D' }] }
  ]
}))
const visible = vi.fn(async (_u: unknown, collection: string, ids: string[]) =>
  collection === 'projects' ? ids.filter((id) => id !== '2') : []
)
vi.mock('../../../services/socket-access.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/socket-access.js')>()),
  visibleRecordIds: (u: unknown, c: string, ids: string[]) => visible(u, c, ids)
}))

describe('POST /presence/record-viewers', () => {
  it('counts only records the caller can read, one gate read per collection', async () => {
    const { recordViewersRoutes } = await import('../../../routes/realtime.js')
    const app = Fastify()
    await app.register(recordViewersRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/record-viewers',
      payload: {
        pairs: [
          { collection: 'projects', item_id: '1' },
          { collection: 'projects', item_id: '2' },
          { collection: 'projects', item_id: '3' },
          { collection: 'secrets', item_id: '9' }
        ]
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ 'projects:1': 1 })
    // Only records someone is viewing are checked, grouped per collection.
    expect(visible).toHaveBeenCalledTimes(2)
    expect(visible.mock.calls[0][2]).toEqual(['1', '2'])
    await app.close()
  })
})

describe('socket inspector with SOCKETS=off', () => {
  it('answers 409 naming the realtime process that holds the socket', async () => {
    const board = await import('../../../services/realtime-board.js')
    board.setBoardsForTests(
      [],
      [{ node: 'rt-b', at: Date.now(), sockets: [{ id: 'sock-1', user: null }], rooms: [] }]
    )
    try {
      const { realtimeRoutes } = await import('../../../routes/realtime.js')
      const app = Fastify()
      await app.register(realtimeRoutes)
      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        const res = await app.inject({ method, url: '/sockets/sock-1/inspect' })
        expect(res.statusCode).toBe(409)
        expect(res.json()).toMatchObject({ code: 'SOCKET_ON_REALTIME', node: 'rt-b' })
      }
      await app.close()
    } finally {
      board.resetBoard()
    }
  })
})
