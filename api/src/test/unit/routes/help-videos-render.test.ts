import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  author: true,
  published: 'PUB-VERSION' as string | null,
  draft: 'DRAFT-VERSION' as string | null
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
// Everything real except the author flag and the video row. A non-uuid id
// still reaches the REAL loadVideoForUser, so its 404 is what is tested.
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
              published_version_id: state.published,
              draft_version_id: state.draft
            },
            author: true
          }
        : real.loadVideoForUser(req, id)
    )
  }
})

import { helpVideosRoutes } from '../../../routes/help-videos.js'
import { logActivity } from '../../../services/activity.js'
import { queueRender } from '../../../services/help-video-render.js'

async function post(id: string, query = '') {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a.inject({ method: 'POST', url: `/api/help-videos/${id}/render${query}` })
}

describe('POST /:id/render', () => {
  beforeEach(() => {
    vi.mocked(queueRender).mockClear()
    vi.mocked(logActivity).mockClear()
    state.author = true
    state.published = 'PUB-VERSION'
    state.draft = 'DRAFT-VERSION'
  })

  it('queues the published version for an author and logs it', async () => {
    const res = await post(UUID)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { ok: true } })
    expect(queueRender).toHaveBeenCalledWith('PUB-VERSION')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'help-video-render', user: 'U1', item: UUID })
    )
  })

  it('queues the draft version with ?draft=1', async () => {
    expect((await post(UUID, '?draft=1')).statusCode).toBe(200)
    expect(queueRender).toHaveBeenCalledWith('DRAFT-VERSION')
  })

  it('answers 409 when there is nothing to render', async () => {
    state.draft = null
    const res = await post(UUID, '?draft=1')
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HELP_VIDEO_NOTHING_TO_RENDER')
    expect(queueRender).not.toHaveBeenCalled()
  })

  it('answers 403 to a non-author and renders nothing', async () => {
    state.author = false
    const res = await post(UUID)
    expect(res.statusCode).toBe(403)
    expect(queueRender).not.toHaveBeenCalled()
  })

  it('answers 404 to an id that is not a uuid', async () => {
    const res = await post('not-a-uuid')
    expect(res.statusCode).toBe(404)
    expect(queueRender).not.toHaveBeenCalled()
  })
})
