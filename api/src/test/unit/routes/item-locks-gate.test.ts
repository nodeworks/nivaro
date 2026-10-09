import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ author: false }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  },
  requireAuth: async () => undefined,
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/help-videos.js', () => ({
  isAuthor: vi.fn(async () => state.author),
  isUuid: (v: unknown) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}))

import { itemLocksRoutes, lockRefusal } from '../../../routes/item-locks.js'

const VIDEO = '6f1c2b3a-1234-4abc-9def-0123456789ab'
const user = { id: 'U1', role: 'R1' } as never

describe('lockRefusal (#1523)', () => {
  it('lets help-video authors lock a video and nobody else', async () => {
    state.author = true
    expect(await lockRefusal(user, false, 'nivaro_help_videos', VIDEO)).toBeNull()
    state.author = false
    expect(await lockRefusal(user, false, 'nivaro_help_videos', VIDEO)).toEqual({
      status: 403,
      error: 'Only help-video authors can edit videos'
    })
  })
  it('wants a real video id', async () => {
    state.author = true
    expect((await lockRefusal(user, false, 'nivaro_help_videos', 'x/../y'))?.status).toBe(404)
  })
  it('refuses every other system table and leaves business collections alone', async () => {
    state.author = true
    expect((await lockRefusal(user, true, 'nivaro_users', 'abc'))?.status).toBe(403)
    expect((await lockRefusal(user, true, 'NIVARO_settings', '1'))?.status).toBe(403)
    expect((await lockRefusal(user, true, 'directus_users', 'abc'))?.status).toBe(403)
    expect(await lockRefusal(user, false, 'workflows', '123')).toBeNull()
  })
})

describe('the item-locks routes run the gate first', () => {
  it('refuses a non-author before touching the database', async () => {
    state.author = false
    const a = Fastify()
    await a.register(itemLocksRoutes, { prefix: '/api/item-locks' })
    const res = await a.inject({
      method: 'POST',
      url: `/api/item-locks/nivaro_help_videos/${VIDEO}/lock`,
      payload: {}
    })
    expect(res.statusCode).toBe(403)
    const res2 = await a.inject({ method: 'GET', url: '/api/item-locks/nivaro_files/abc/lock' })
    expect(res2.statusCode).toBe(403)
  })
})
