import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ author: false }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  }
}))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  isAuthor: vi.fn(async () => state.author),
  registerPage: vi.fn(async () => undefined)
}))

import { helpVideosRoutes } from '../../../routes/help-videos.js'
import { registerPage } from '../../../services/help-videos.js'

async function app() {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a
}

describe('POST /pages', () => {
  beforeEach(() => vi.mocked(registerPage).mockClear())

  it('refuses a non-author with 403 and writes nothing', async () => {
    state.author = false
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/help-videos/pages',
      payload: { key: 'k', label: 'L' }
    })
    expect(res.statusCode).toBe(403)
    expect(registerPage).not.toHaveBeenCalled()
  })

  it('lets an author register a page', async () => {
    state.author = true
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/help-videos/pages',
      payload: { key: 'k', label: 'L' }
    })
    expect(res.statusCode).toBe(204)
    expect(registerPage).toHaveBeenCalledWith('k', 'L', null)
  })
})
