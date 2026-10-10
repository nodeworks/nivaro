import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /help-videos/:id/stale/dismiss (#1495): authors only, 409 when there
// is nothing to dismiss, the fresh video otherwise.

const state = vi.hoisted(() => ({
  author: true,
  stale: JSON.stringify({
    kind: 'layout',
    detail: 'The "Main" layout of orders changed',
    since: 's'
  }) as string | null,
  dismissedAt: null as Date | null
}))
const UUID = '11111111-2222-4333-8444-555555555555'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => undefined) }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  }
}))
vi.mock('../../../services/help-videos.js', async (orig) => {
  const real = await orig<typeof import('../../../services/help-videos.js')>()
  return {
    ...real,
    isAuthor: vi.fn(async () => state.author),
    loadVideoForUser: vi.fn(async (req: never, id: string) =>
      real.isUuid(id)
        ? {
            video: {
              id,
              title: 'Hello',
              status: 'published',
              stale_reason: state.stale,
              stale_dismissed_at: state.dismissedAt
            },
            author: true
          }
        : real.loadVideoForUser(req, id)
    ),
    serializeVideo: vi.fn(async (video: { id: string }) => ({ id: video.id, stale: null }))
  }
})

import { db } from '../../../db/index.js'
import { helpVideosRoutes } from '../../../routes/help-videos.js'
import { logActivity } from '../../../services/activity.js'

const updates: Array<Record<string, unknown>> = []

async function post(id: string) {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a.inject({ method: 'POST', url: `/api/help-videos/${id}/stale/dismiss` })
}

describe('POST /:id/stale/dismiss', () => {
  beforeEach(() => {
    state.author = true
    state.stale = JSON.stringify({
      kind: 'layout',
      detail: 'The "Main" layout of orders changed',
      since: 's'
    })
    state.dismissedAt = null
    updates.length = 0
    vi.mocked(logActivity).mockClear()
    vi.mocked(db).mockImplementation(((table: string) => {
      const q: Record<string, unknown> = {}
      q.where = () => q
      q.update = async (patch: Record<string, unknown>) => {
        updates.push({ table, ...patch })
        return 1
      }
      return q
    }) as never)
  })

  it('refuses a non-author with 403', async () => {
    state.author = false
    const res = await post(UUID)
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('HELP_VIDEO_AUTHOR_ONLY')
    expect(updates).toEqual([])
  })

  it('answers 404 for an id that is not a uuid', async () => {
    const res = await post('not-a-uuid')
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('HELP_VIDEO_NOT_FOUND')
  })

  it.each([
    ['no flag', null, null],
    ['a dismissed flag', 'x', new Date()]
  ])('answers 409 HELP_VIDEO_NOT_STALE with %s', async (_n, stale, at) => {
    state.stale = stale ? JSON.stringify({ kind: 'label', detail: 'd', since: 's' }) : null
    state.dismissedAt = at
    const res = await post(UUID)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HELP_VIDEO_NOT_STALE')
    expect(updates).toEqual([])
  })

  it('dismisses the flag, logs it and answers the video', async () => {
    const res = await post(UUID)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ id: UUID, stale: null })
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ table: 'nivaro_help_videos', updated_by: 'U1' })
    expect(updates[0].stale_dismissed_at).toBeInstanceOf(Date)
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'help-video-stale-dismiss',
        item: UUID,
        comment: 'The "Main" layout of orders changed'
      })
    )
  })
})
