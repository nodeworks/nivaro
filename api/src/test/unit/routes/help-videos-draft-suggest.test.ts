import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  author: true,
  draft: 'DRAFT-VERSION' as string | null,
  fail: null as null | { statusCode: number; code: string; message: string }
}))
const UUID = '11111111-2222-4333-8444-555555555555'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => undefined) }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/help-video-captions.js', () => ({
  CaptionsError: class extends Error {},
  captionProvider: vi.fn(),
  clearCaptionJob: vi.fn(),
  readCaptionJob: vi.fn(),
  startCaptionJob: vi.fn()
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  }
}))
vi.mock('../../../services/help-video-draft.js', async (orig) => {
  const real = await orig<typeof import('../../../services/help-video-draft.js')>()
  return {
    ...real,
    suggestDraftForVideo: vi.fn(async () => {
      if (state.fail)
        throw new real.DraftError(state.fail.statusCode, state.fail.code, state.fail.message)
      return {
        suggestions: [{ id: 'title', kind: 'title', text: 'Approving an order' }],
        model: 'fake'
      }
    })
  }
})
vi.mock('../../../services/help-videos.js', async (orig) => {
  const real = await orig<typeof import('../../../services/help-videos.js')>()
  return {
    ...real,
    isAuthor: vi.fn(async () => state.author),
    loadVersion: vi.fn(async (id: string | null) =>
      id ? { id, edits: '{}', source_file: 'F' } : undefined
    ),
    loadVideoForUser: vi.fn(async (req: never, id: string) =>
      real.isUuid(id)
        ? {
            video: {
              id,
              title: 'Hello',
              status: 'draft',
              published_version_id: null,
              draft_version_id: state.draft
            },
            author: true
          }
        : real.loadVideoForUser(req, id)
    )
  }
})

import { helpVideosRoutes } from '../../../routes/help-videos.js'
import { suggestDraftForVideo } from '../../../services/help-video-draft.js'

async function post(id: string) {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a.inject({ method: 'POST', url: `/api/help-videos/${id}/draft/suggest` })
}

describe('POST /:id/draft/suggest (#1487)', () => {
  beforeEach(() => {
    vi.mocked(suggestDraftForVideo).mockClear()
    state.author = true
    state.draft = 'DRAFT-VERSION'
    state.fail = null
  })

  it('answers the suggestions for the draft version', async () => {
    const res = await post(UUID)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: {
        suggestions: [{ id: 'title', kind: 'title', text: 'Approving an order' }],
        model: 'fake'
      }
    })
    expect(suggestDraftForVideo).toHaveBeenCalledWith(
      expect.objectContaining({ id: UUID }),
      expect.objectContaining({ id: 'DRAFT-VERSION' }),
      expect.objectContaining({ id: 'U1' })
    )
  })
  it('answers 409 HELP_VIDEO_NO_DRAFT when the video has no draft', async () => {
    state.draft = null
    const res = await post(UUID)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('HELP_VIDEO_NO_DRAFT')
    expect(suggestDraftForVideo).not.toHaveBeenCalled()
  })
  it('passes the service error code through (no provider, unreadable answer)', async () => {
    state.fail = {
      statusCode: 503,
      code: 'HELP_VIDEO_AI_NOT_CONFIGURED',
      message: 'No AI provider is configured.'
    }
    const res = await post(UUID)
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      error: 'No AI provider is configured.',
      code: 'HELP_VIDEO_AI_NOT_CONFIGURED'
    })
    state.fail = { statusCode: 502, code: 'HELP_VIDEO_DRAFT_UNREADABLE', message: 'not JSON' }
    expect((await post(UUID)).statusCode).toBe(502)
  })
  it('answers 403 to a non-author and 404 to an id that is not a uuid', async () => {
    state.author = false
    expect((await post(UUID)).statusCode).toBe(403)
    state.author = true
    expect((await post('nope')).statusCode).toBe(404)
    expect(suggestDraftForVideo).not.toHaveBeenCalled()
  })
})
