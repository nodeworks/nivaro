import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ status: 'archived', admin: true }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'R1' }
    req.isAdmin = state.admin
  }
}))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  isAuthor: vi.fn(async () => true),
  loadVideoForUser: vi.fn(async () => ({
    video: { id: 'V1', title: 'Hello', status: state.status },
    author: true
  })),
  purgeVideo: vi.fn(async () => undefined),
  archiveVideo: vi.fn(async () => undefined)
}))

import { helpVideosRoutes } from '../../../routes/help-videos.js'
import { archiveVideo, purgeVideo } from '../../../services/help-videos.js'

async function del(query = '?purge=1') {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a.inject({ method: 'DELETE', url: `/api/help-videos/V1${query}` })
}

describe('DELETE /:id?purge=1', () => {
  beforeEach(() => {
    state.status = 'archived'
    state.admin = true
    vi.mocked(purgeVideo).mockClear()
    vi.mocked(archiveVideo).mockClear()
  })

  it('refuses an author who is not an administrator', async () => {
    state.admin = false
    const res = await del()
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('ADMIN_ONLY')
    expect(purgeVideo).not.toHaveBeenCalled()
  })

  it.each(['published', 'draft'])('refuses a %s video with 409 and deletes nothing', async (s) => {
    state.status = s
    const res = await del()
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HELP_VIDEO_NOT_ARCHIVED')
    expect(purgeVideo).not.toHaveBeenCalled()
  })

  it('deletes an archived video', async () => {
    const res = await del()
    expect(res.statusCode).toBe(204)
    expect(purgeVideo).toHaveBeenCalledTimes(1)
  })

  it('still archives a published video without purge', async () => {
    state.status = 'published'
    const res = await del('')
    expect(res.statusCode).toBe(204)
    expect(archiveVideo).toHaveBeenCalledTimes(1)
    expect(purgeVideo).not.toHaveBeenCalled()
  })
})
