import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /session-recordings/:id/events on a recording moved to storage (#1411):
 * 202 while it loads back, 502 when it can't, the events once it is hot.
 * Deleting a recording deletes its object.
 */

const h = vi.hoisted(() => ({
  hot: { state: 'hot' } as { state: string; message?: string },
  chunks: [] as Array<{ seq: number; events: string }>,
  deletedObjects: [] as string[]
}))

vi.mock('../../../services/session-replay-storage.js', () => ({
  ensureRecordingHot: vi.fn(async () => h.hot),
  deleteColdObject: vi.fn(async (id: string) => {
    h.deletedObjects.push(id)
  }),
  purgeColdObjects: vi.fn(async () => 0),
  replayTierSizes: vi.fn(async () => ({}))
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'modify', 'orderBy']) chain[m] = vi.fn(() => chain)
    chain.select = vi.fn(async () => h.chunks)
    chain.del = vi.fn(async () => 1)
    return chain
  })
  ;(db as unknown as Record<string, unknown>).raw = vi.fn((sql: string) => ({ sql }))
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async () => undefined,
  requireAuth: async () => undefined,
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: 'ADMIN' }
  }
}))

import { sessionRecordingRoutes } from '../../../routes/session-recordings.js'

const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'

async function call(method: 'GET' | 'DELETE', url: string) {
  const app = Fastify()
  await app.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
  const res = await app.inject({ method, url: `/api/session-recordings${url}` })
  return { status: res.statusCode, body: res.json() }
}

beforeEach(() => {
  h.hot = { state: 'hot' }
  h.chunks = [{ seq: 0, events: '[{"type":4,"timestamp":1},{"type":2,"timestamp":2}]' }]
  h.deletedObjects = []
})

describe('GET /session-recordings/:id/events on a cold recording', () => {
  it('answers 202 while it loads from storage', async () => {
    h.hot = { state: 'loading' }
    const r = await call('GET', `/${REC}/events`)
    expect(r.status).toBe(202)
    expect(r.body).toEqual({ data: { status: 'loading_from_storage' } })
  })

  it('answers 502 when storage could not give it back', async () => {
    h.hot = { state: 'failed', message: '404' }
    const r = await call('GET', `/${REC}/events`)
    expect(r.status).toBe(502)
  })

  it('serves the events once it is hot', async () => {
    const r = await call('GET', `/${REC}/events`)
    expect(r.status).toBe(200)
    expect(r.body.data.events).toHaveLength(2)
  })
})

describe('DELETE /session-recordings/:id', () => {
  it('deletes the cold object with the recording', async () => {
    const r = await call('DELETE', `/${REC}`)
    expect(r.status).toBe(200)
    expect(h.deletedObjects).toEqual([REC])
  })
})
