import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ status: 'published', added: ['R1'] as string[] }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  }
}))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  isAuthor: vi.fn(async () => true),
  loadVideoForUser: vi.fn(async () => ({
    video: { id: 'V1', title: 'Hello', status: state.status },
    author: true
  })),
  replaceRequirements: vi.fn(async () => ({ added: state.added })),
  notifyRequiredViewersSafely: vi.fn(async () => 0)
}))

import { helpVideosRoutes } from '../../../routes/help-videos.js'
import { notifyRequiredViewersSafely } from '../../../services/help-videos.js'

async function put() {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a.inject({
    method: 'PUT',
    url: '/api/help-videos/V1/requirements',
    payload: { role_ids: [] }
  })
}

describe('PUT /:id/requirements notifications', () => {
  beforeEach(() => vi.mocked(notifyRequiredViewersSafely).mockClear())

  it('notifies the added roles of a published video', async () => {
    state.status = 'published'
    state.added = ['R1']
    expect((await put()).statusCode).toBe(200)
    expect(notifyRequiredViewersSafely).toHaveBeenCalledWith('V1', 'Hello', ['R1'])
  })

  it('does not notify for a draft video', async () => {
    state.status = 'draft'
    state.added = ['R1']
    await put()
    expect(notifyRequiredViewersSafely).not.toHaveBeenCalled()
  })

  it('does not notify when nothing was added', async () => {
    state.status = 'published'
    state.added = []
    await put()
    expect(notifyRequiredViewersSafely).not.toHaveBeenCalled()
  })
})
