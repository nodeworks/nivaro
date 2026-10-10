import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1562 / #1560: the clip routes (list for anyone who can watch, make and
// delete for authors, the ticketed file for the same people as the video)
// and the ticketed sprite sheet (authors only: it shows the original frames).

const VID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CLIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROLE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PUB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const DRAFT = '99999999-9999-4999-8999-999999999999'
const DRAFT_CLIP = '12121212-1212-4121-8121-121212121212'

const state = vi.hoisted(() => ({
  author: false,
  status: 'published',
  clips: [] as Array<Record<string, unknown>>,
  sprite: null as string | null
}))

vi.mock('../../../config.js', () => ({ config: { SESSION_SECRET: 'x'.repeat(40) } }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((table: string) => {
    let filter: Record<string, unknown> = {}
    const b = {
      where(f: Record<string, unknown>) {
        filter = { ...filter, ...f }
        return b
      },
      async first() {
        const eq = (a: unknown, c: unknown) => String(a).toUpperCase() === String(c).toUpperCase()
        if (table === 'nivaro_users')
          return eq(filter.id, USER) ? { id: USER, role: ROLE, status: 'active' } : undefined
        if (table === 'nivaro_roles') return { admin_access: false }
        if (table === 'nivaro_help_videos') {
          return eq(filter.id, VID)
            ? {
                id: VID,
                title: 'Raise a PO',
                status: state.status,
                visibility: JSON.stringify({ mode: 'everyone', role_ids: [] }),
                published_version_id: PUB,
                draft_version_id: DRAFT
              }
            : undefined
        }
        if (table === 'nivaro_help_video_versions') {
          return eq(filter.id, PUB)
            ? { id: PUB, video_id: VID, source_file: 'S', sprite_file: state.sprite }
            : undefined
        }
        return undefined
      }
    }
    return b
  })
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { headers: Record<string, unknown>; user?: unknown }) => {
    if (!req.headers.authorization) {
      throw Object.assign(new Error('Not signed in'), { statusCode: 401 })
    }
    req.user = { id: USER, role: ROLE }
  }
}))
vi.mock('../../../services/files.js', () => ({
  getFile: vi.fn(async (id: string) => ({ id, filename_disk: `${id}.bin`, type: 'image/jpeg' }))
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  sendStoredObject: vi.fn(
    async (
      reply: {
        code(n: number): { header(k: string, v: string): unknown; send(b: string): unknown }
      },
      key: string,
      opts: { contentType?: string; disposition?: string }
    ) => {
      const r = reply.code(200)
      if (opts.disposition) r.header('Content-Disposition', opts.disposition)
      return r.send(`bytes:${key}:${opts.contentType}`)
    }
  )
}))
vi.mock('../../../services/help-videos.js', async (orig) => {
  const real = await orig<typeof import('../../../services/help-videos.js')>()
  return {
    ...real,
    isAuthor: vi.fn(async () => state.author),
    // loadVideoForUser asks isAuthor inside its own module: its answer is
    // the state's, with the video (and the 404) as the real one gives them.
    loadVideoForUser: vi.fn(async (req: never, id: string) => ({
      ...(await real.loadVideoForUser(req, id)),
      author: state.author
    }))
  }
})
const created = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../../../services/help-video-clips.js', async (orig) => ({
  ...(await orig<object>()),
  listClips: vi.fn(async () => state.clips),
  clipRow: vi.fn(
    async (videoId: string, clipId: string) =>
      state.clips.find(
        (c) =>
          String(c.id).toLowerCase() === clipId.toLowerCase() &&
          String(c.video_id).toLowerCase() === videoId.toLowerCase()
      ) ?? null
  ),
  createClip: vi.fn(async (_v: unknown, _u: unknown, body: unknown) => {
    created.calls.push(body)
    return { ...readyClip(), id: CLIP, status: 'queued', file_id: null }
  }),
  deleteClip: vi.fn(async () => undefined)
}))

import { helpVideoMediaRoutes, helpVideosRoutes } from '../../../routes/help-videos.js'
import { logActivity } from '../../../services/activity.js'
import { createClip, deleteClip } from '../../../services/help-video-clips.js'
import { mediaTicket } from '../../../services/help-videos.js'

function readyClip(): Record<string, unknown> {
  return {
    id: CLIP,
    video_id: VID,
    version_id: PUB,
    kind: 'gif',
    status: 'ready',
    progress: 100,
    error: null,
    start_ms: 1000,
    end_ms: 4000,
    label: 'Approve',
    bytes: 1000,
    width: 640,
    height: 360,
    file_id: 'F1',
    created_by: USER,
    created_at: new Date('2026-10-10T00:00:00Z')
  }
}

/** A clip cut from the draft (#1562 `draft: true`): authors only. */
function draftClip(): Record<string, unknown> {
  return {
    ...readyClip(),
    id: DRAFT_CLIP,
    version_id: DRAFT,
    kind: 'mp4',
    label: 'Draft take',
    file_id: 'F2',
    error: null
  }
}

async function app() {
  const a = Fastify()
  a.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) =>
    reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code })
  )
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  await a.register(helpVideoMediaRoutes, { prefix: '/api/help-videos' })
  return a
}
const auth = { authorization: 'Bearer t' }

beforeEach(() => {
  state.author = false
  state.status = 'published'
  state.clips = [readyClip()]
  state.sprite = null
  created.calls = []
  vi.mocked(createClip).mockClear()
  vi.mocked(deleteClip).mockClear()
  vi.mocked(logActivity).mockClear()
})

describe('GET /:id/clips', () => {
  it('lists the clips with ticketed links for a viewer who can watch', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips`,
      headers: auth
    })
    expect(res.statusCode).toBe(200)
    const [c] = res.json().data
    expect(c.id).toBe(CLIP)
    expect(c.url).toMatch(new RegExp(`^/api/help-videos/${VID}/clips/${CLIP}\\?st=\\d+\\.`))
    expect(c.file_id).toBeUndefined()
  })
  it('is 404 for a video the viewer may not see', async () => {
    state.status = 'draft'
    const res = await (await app()).inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips`,
      headers: auth
    })
    expect(res.statusCode).toBe(404)
  })
  it('lists a clip of the draft, and why a clip failed, to authors only', async () => {
    const failed = {
      ...readyClip(),
      id: '34343434-3434-4343-8343-343434343434',
      status: 'failed',
      file_id: null,
      error: 'The clip could not be made'
    }
    state.clips = [readyClip(), draftClip(), failed]
    const a = await app()
    const viewer = await a.inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips`,
      headers: auth
    })
    expect(viewer.statusCode).toBe(200)
    expect(viewer.json().data.map((c: { id: string }) => c.id)).toEqual([CLIP, failed.id])
    expect(viewer.json().data[1]).toMatchObject({ status: 'failed', error: null })
    state.author = true
    const author = await a.inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips`,
      headers: auth
    })
    expect(author.json().data.map((c: { id: string }) => c.id)).toEqual([
      CLIP,
      DRAFT_CLIP,
      failed.id
    ])
    expect(author.json().data[2]).toMatchObject({
      status: 'failed',
      error: 'The clip could not be made'
    })
  })
  it('hides every clip from viewers while nothing is published', async () => {
    // The mock's video keeps PUB; a clip of some other version is not of it.
    state.clips = [
      { ...readyClip(), version_id: '77777777-7777-4777-8777-777777777777' },
      { ...readyClip(), version_id: null }
    ]
    const res = await (await app()).inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips`,
      headers: auth
    })
    expect(res.json().data).toEqual([])
  })
})

describe('POST / DELETE clips', () => {
  it('refuses a viewer, lets an author queue one', async () => {
    const a = await app()
    const body = { kind: 'gif', start_ms: 1000, end_ms: 4000, label: 'Approve' }
    const no = await a.inject({
      method: 'POST',
      url: `/api/help-videos/${VID}/clips`,
      headers: auth,
      payload: body
    })
    expect(no.statusCode).toBe(403)
    expect(createClip).not.toHaveBeenCalled()
    state.author = true
    const yes = await a.inject({
      method: 'POST',
      url: `/api/help-videos/${VID}/clips`,
      headers: auth,
      payload: body
    })
    expect(yes.statusCode).toBe(201)
    expect(yes.json().data).toMatchObject({ id: CLIP, status: 'queued', url: null })
    expect(created.calls[0]).toEqual(body)
  })
  it('deletes for authors only', async () => {
    const a = await app()
    const no = await a.inject({
      method: 'DELETE',
      url: `/api/help-videos/${VID}/clips/${CLIP}`,
      headers: auth
    })
    expect(no.statusCode).toBe(403)
    state.author = true
    const yes = await a.inject({
      method: 'DELETE',
      url: `/api/help-videos/${VID}/clips/${CLIP}`,
      headers: auth
    })
    expect(yes.statusCode).toBe(204)
    expect(deleteClip).toHaveBeenCalledWith(expect.anything(), VID, CLIP)
  })
})

describe('GET /:id/clips/:clipId (ticketed)', () => {
  const ticket = () => mediaTicket(VID, USER, 'p')
  it('serves a ready clip to the ticket holder, as an attachment with download=1', async () => {
    const a = await app()
    const res = await a.inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips/${CLIP}?st=${ticket()}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('bytes:F1.bin:image/gif')
    expect(res.headers['content-disposition']).toBeUndefined()
    const dl = await a.inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips/${CLIP}?st=${ticket()}&download=1`
    })
    expect(dl.headers['content-disposition']).toContain(
      'attachment; filename="Raise a PO - Approve.gif"'
    )
  })
  it('is 404 without a ticket, for a clip still being made, and for a clip of another video', async () => {
    const a = await app()
    expect(
      (await a.inject({ method: 'GET', url: `/api/help-videos/${VID}/clips/${CLIP}` })).statusCode
    ).toBe(404)
    state.clips[0].status = 'rendering'
    expect(
      (
        await a.inject({
          method: 'GET',
          url: `/api/help-videos/${VID}/clips/${CLIP}?st=${ticket()}`
        })
      ).statusCode
    ).toBe(404)
    state.clips[0].status = 'ready'
    state.clips[0].video_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    expect(
      (
        await a.inject({
          method: 'GET',
          url: `/api/help-videos/${VID}/clips/${CLIP}?st=${ticket()}`
        })
      ).statusCode
    ).toBe(404)
  })
  it('is 404 once the video is no longer published for viewers', async () => {
    state.status = 'archived'
    const res = await (await app()).inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips/${CLIP}?st=${ticket()}`
    })
    expect(res.statusCode).toBe(404)
  })
  it('serves a clip of the draft to authors only', async () => {
    state.clips = [readyClip(), draftClip()]
    const a = await app()
    const url = `/api/help-videos/${VID}/clips/${DRAFT_CLIP}?st=${ticket()}`
    expect((await a.inject({ method: 'GET', url })).statusCode).toBe(404)
    expect(logActivity).not.toHaveBeenCalled()
    state.author = true
    const res = await a.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('bytes:F2.bin:video/mp4')
  })
  it('logs each fetch and download as data egress, not a resumed range', async () => {
    const a = await app()
    await a.inject({ method: 'GET', url: `/api/help-videos/${VID}/clips/${CLIP}?st=${ticket()}` })
    expect(logActivity).toHaveBeenCalledTimes(1)
    expect(logActivity).toHaveBeenLastCalledWith({
      action: 'help-video-download',
      user: USER,
      collection: 'nivaro_help_videos',
      item: VID,
      comment: `clip ${CLIP} (gif)`
    })
    await a.inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips/${CLIP}?st=${ticket()}&download=1`
    })
    expect(logActivity).toHaveBeenCalledTimes(2)
    expect(logActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ comment: `clip ${CLIP} (gif) · download` })
    )
    await a.inject({
      method: 'GET',
      url: `/api/help-videos/${VID}/clips/${CLIP}?st=${ticket()}`,
      headers: { range: 'bytes=500-' }
    })
    expect(logActivity).toHaveBeenCalledTimes(2)
  })
})

describe('GET /:id/sprite (ticketed)', () => {
  it('serves the sheet to an author and 404 to a viewer or without one', async () => {
    const a = await app()
    state.sprite = 'SPRITE'
    const t = mediaTicket(VID, USER, 'p')
    expect(
      (await a.inject({ method: 'GET', url: `/api/help-videos/${VID}/sprite?st=${t}` })).statusCode
    ).toBe(404)
    state.author = true
    const res = await a.inject({ method: 'GET', url: `/api/help-videos/${VID}/sprite?st=${t}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('bytes:SPRITE.bin:image/jpeg')
    state.sprite = null
    expect(
      (await a.inject({ method: 'GET', url: `/api/help-videos/${VID}/sprite?st=${t}` })).statusCode
    ).toBe(404)
  })
})
