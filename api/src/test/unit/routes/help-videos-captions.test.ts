import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  author: true,
  draft: 'draft-version' as string | null,
  job: null as null | Record<string, unknown>,
  provider: { kind: 'gateway', model: 'whisper-1' } as Record<string, unknown>
}))
const UUID = '11111111-2222-4333-8444-555555555555'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => undefined) }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/help-video-draft.js', () => ({
  DraftError: class extends Error {},
  suggestDraftForVideo: vi.fn()
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  }
}))
vi.mock('../../../services/help-video-captions.js', async (orig) => {
  const real = await orig<typeof import('../../../services/help-video-captions.js')>()
  return {
    ...real,
    captionProvider: vi.fn(async () => state.provider),
    readCaptionJob: vi.fn(async () => state.job),
    clearCaptionJob: vi.fn(async () => undefined),
    startCaptionJob: vi.fn(
      async (video: { id: string }, versionId: string, user: { id: string }) => {
        if (state.provider.kind === 'none')
          throw new real.CaptionsError(
            503,
            'HELP_VIDEO_CAPTIONS_NOT_CONFIGURED',
            String(state.provider.reason)
          )
        if (state.job && state.job.status === 'running')
          throw new real.CaptionsError(409, 'HELP_VIDEO_CAPTIONS_BUSY', 'busy')
        return {
          version_id: versionId,
          video_id: video.id,
          status: 'queued',
          requested_by: user.id,
          provider: 'gateway'
        }
      }
    )
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
import { logActivity } from '../../../services/activity.js'
import { clearCaptionJob, startCaptionJob } from '../../../services/help-video-captions.js'

async function call(method: 'GET' | 'POST' | 'DELETE', id = UUID) {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a.inject({ method, url: `/api/help-videos/${id}/captions/generate` })
}

describe('/:id/captions/generate (#1520)', () => {
  beforeEach(() => {
    vi.mocked(startCaptionJob).mockClear()
    vi.mocked(clearCaptionJob).mockClear()
    vi.mocked(logActivity).mockClear()
    state.author = true
    state.draft = 'draft-version'
    state.job = null
    state.provider = { kind: 'gateway', model: 'whisper-1' }
  })

  it('GET answers the pending job for this video and which transcriber would run', async () => {
    state.job = { version_id: 'draft-version', video_id: UUID, status: 'done', captions: [] }
    const res = await call('GET')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: {
        job: { version_id: 'draft-version', video_id: UUID, status: 'done', captions: [] },
        provider: { kind: 'gateway', model: 'whisper-1', reason: null }
      }
    })
  })
  it('GET hides a job that belongs to another video and explains a missing transcriber', async () => {
    state.job = { version_id: 'draft-version', video_id: 'other', status: 'done' }
    state.provider = { kind: 'none', reason: 'No transcriber is set up: …' }
    const res = await call('GET')
    expect(res.json().data).toEqual({
      job: null,
      provider: { kind: 'none', model: null, reason: 'No transcriber is set up: …' }
    })
  })
  it('POST queues the draft version and logs it', async () => {
    const res = await call('POST')
    expect(res.statusCode).toBe(202)
    expect(res.json().data).toMatchObject({
      status: 'queued',
      version_id: 'draft-version',
      requested_by: 'U1'
    })
    expect(startCaptionJob).toHaveBeenCalledWith(
      { id: UUID },
      'draft-version',
      expect.objectContaining({ id: 'U1' })
    )
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'help-video-captions', item: UUID })
    )
  })
  it('POST answers 409 without a draft, 503 without a transcriber, 409 while busy', async () => {
    state.draft = null
    expect((await call('POST')).json().code).toBe('HELP_VIDEO_NO_DRAFT')
    state.draft = 'draft-version'
    state.provider = { kind: 'none', reason: 'set it up' }
    const none = await call('POST')
    expect(none.statusCode).toBe(503)
    expect(none.json()).toEqual({ error: 'set it up', code: 'HELP_VIDEO_CAPTIONS_NOT_CONFIGURED' })
    state.provider = { kind: 'gateway', model: 'w' }
    state.job = { status: 'running' }
    expect((await call('POST')).statusCode).toBe(409)
  })
  it('DELETE clears a finished set and refuses while one runs', async () => {
    state.job = { status: 'done' }
    expect((await call('DELETE')).statusCode).toBe(204)
    expect(clearCaptionJob).toHaveBeenCalledWith('draft-version')
    state.job = { status: 'queued' }
    expect((await call('DELETE')).statusCode).toBe(409)
  })
  it('answers 403 to a non-author and 404 to an id that is not a uuid', async () => {
    state.author = false
    expect((await call('POST')).statusCode).toBe(403)
    expect((await call('GET')).statusCode).toBe(403)
    state.author = true
    expect((await call('POST', 'nope')).statusCode).toBe(404)
    expect(startCaptionJob).not.toHaveBeenCalled()
  })
})
