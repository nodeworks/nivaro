import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

/**
 * POST /presence/record-viewers answers counts only for records the caller may read (second
 * review of post-mortem 3.3: with the realtime board the counts are cluster-wide).
 */
const caller = vi.hoisted(() => ({
  current: {
    user: { id: 'u-1', role: 'r-1' } as Record<string, unknown>,
    isAdmin: false,
    scopes: null as unknown
  }
}))
vi.mock('../../../middleware/authenticate.js', async (orig) => ({
  ...(await orig<typeof import('../../../middleware/authenticate.js')>()),
  requireAuth: async (req: { user?: unknown; isAdmin?: boolean; apiKeyScopes?: unknown }) => {
    req.user = caller.current.user
    req.isAdmin = caller.current.isAdmin
    if (caller.current.scopes) req.apiKeyScopes = caller.current.scopes
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
const visible = vi.fn(async (_u: unknown, collection: string, ids: string[], admin?: boolean) =>
  admin ? ids : collection === 'projects' ? ids.filter((id) => id !== '2') : []
)
vi.mock('../../../services/socket-access.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/socket-access.js')>()),
  visibleRecordIds: (u: unknown, c: string, ids: string[], admin?: boolean) =>
    visible(u, c, ids, admin)
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

describe('POST /presence/record-viewers with an admin API key', () => {
  it('keeps to the key: its collection scopes, then the full read gate', async () => {
    const scopes = [{ collection: 'projects', actions: ['read'] }]
    caller.current = {
      user: { id: 'svc', role: 'r-admin', api_key_scopes: scopes },
      isAdmin: true,
      scopes
    }
    visible.mockClear()
    try {
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
            { collection: 'secrets', item_id: '9' }
          ]
        }
      })
      // `secrets` is outside the key's scopes; `projects` went through the gate, not the
      // admin short cut (which would have counted record 2 too).
      expect(res.json().data).toEqual({ 'projects:1': 1 })
      expect(visible).toHaveBeenCalledTimes(1)
      expect(visible.mock.calls[0][3]).toBe(false)
      await app.close()
    } finally {
      caller.current = { user: { id: 'u-1', role: 'r-1' }, isAdmin: false, scopes: null }
    }
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
