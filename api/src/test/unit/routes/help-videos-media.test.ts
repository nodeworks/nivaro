import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Review Focus #3: a role-limited video can't be fetched by id or by an old
// link. Media routes are authorised by a signed ?st= ticket, and every request
// re-checks the person's current status/role and the video's visibility.

const VID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
const USER = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'
const ROLE = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC'
const OTHER_ROLE = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD'

const state = vi.hoisted(() => ({
  author: false,
  masquerade: false,
  user: null as Record<string, unknown> | null,
  video: null as Record<string, unknown> | null,
  versions: {} as Record<string, Record<string, unknown>>
}))

vi.mock('../../../config.js', () => ({ config: { SESSION_SECRET: 'x'.repeat(40) } }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
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
        if (table === 'nivaro_users') {
          const u = state.user
          return u && eq(u.id, filter.id) && u.status === filter.status ? u : undefined
        }
        if (table === 'nivaro_roles') return { admin_access: false }
        if (table === 'nivaro_help_videos') {
          return state.video && eq(state.video.id, filter.id) ? state.video : undefined
        }
        if (table === 'nivaro_help_video_versions') return state.versions[String(filter.id)]
        return undefined
      }
    }
    return b
  })
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; masqueradeAdminId?: string }) => {
    req.user = { id: USER, role: ROLE }
    if (state.masquerade) req.masqueradeAdminId = 'ADMIN'
  }
}))
vi.mock('../../../services/files.js', () => ({
  getFile: vi.fn(async (id: string) => ({ id, filename_disk: `${id}.webm`, type: 'video/webm' }))
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  sendStoredObject: vi.fn(
    async (reply: { code(n: number): { send(b: string): unknown } }, key: string) =>
      reply.code(200).send(`bytes:${key}`)
  )
}))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  isAuthor: vi.fn(async () => state.author)
}))
vi.mock('../../../services/help-video-views.js', async (orig) => ({
  ...(await orig<object>()),
  recordProgress: vi.fn(async () => ({ completed: false }))
}))

import { helpVideoMediaRoutes, helpVideosRoutes } from '../../../routes/help-videos.js'
import { recordProgress } from '../../../services/help-video-views.js'
import { mediaTicket } from '../../../services/help-videos.js'

async function app() {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  await a.register(helpVideoMediaRoutes, { prefix: '/api/help-videos' })
  return a
}

const get = async (url: string) => (await app()).inject({ method: 'GET', url })
const stream = (ticket: string, id = VID) => get(`/api/help-videos/${id}/stream?st=${ticket}`)

beforeEach(() => {
  state.author = false
  state.masquerade = false
  state.user = { id: USER, role: ROLE, status: 'active' }
  state.video = {
    id: VID,
    title: 'T',
    status: 'published',
    visibility: JSON.stringify({ mode: 'roles', role_ids: [ROLE] }),
    published_version_id: 'P1',
    draft_version_id: 'D1',
    poster_file: 'POSTER'
  }
  state.versions = {
    P1: { id: 'P1', source_file: 'PUB_SRC', rendered_file: null, edits: null },
    D1: { id: 'D1', source_file: 'DRAFT_SRC', rendered_file: null, edits: null }
  }
  vi.mocked(recordProgress).mockClear()
})

describe('media routes — signed tickets', () => {
  it('serves the published recording to a person whose role sees the video, with no Authorization header', async () => {
    const res = await stream(mediaTicket(VID, USER, 'p'))
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('bytes:PUB_SRC.webm')
    expect(res.headers['cache-control']).toBe('private, no-cache')
  })

  it('answers 404 with no ticket, a garbage ticket, or a ticket for another video', async () => {
    expect((await get(`/api/help-videos/${VID}/stream`)).statusCode).toBe(404)
    expect((await stream('garbage')).statusCode).toBe(404)
    const otherVideo = 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE'
    expect((await stream(mediaTicket(otherVideo, USER, 'p'))).statusCode).toBe(404)
  })

  it('answers 404 for a non-uuid id even with a matching ticket', async () => {
    const res = await stream(mediaTicket('abc', USER, 'p'), 'abc')
    expect(res.statusCode).toBe(404)
  })

  it('an old link stops working once the video is limited to another role', async () => {
    const ticket = mediaTicket(VID, USER, 'p')
    expect((await stream(ticket)).statusCode).toBe(200)
    state.video!.visibility = JSON.stringify({ mode: 'roles', role_ids: [OTHER_ROLE] })
    expect((await stream(ticket)).statusCode).toBe(404)
    expect((await get(`/api/help-videos/${VID}/captions.vtt?st=${ticket}`)).statusCode).toBe(404)
    expect((await get(`/api/help-videos/${VID}/poster?st=${ticket}`)).statusCode).toBe(404)
    // …and the record itself is not readable by id either
    expect((await get(`/api/help-videos/${VID}`)).statusCode).toBe(404)
  })

  it('an old link stops working once the person moves to a role outside the video', async () => {
    const ticket = mediaTicket(VID, USER, 'p')
    state.user = { ...state.user!, role: OTHER_ROLE }
    expect((await stream(ticket)).statusCode).toBe(404)
  })

  it('an old link stops working for a suspended person', async () => {
    const ticket = mediaTicket(VID, USER, 'p')
    state.user = { ...state.user!, status: 'suspended' }
    expect((await stream(ticket)).statusCode).toBe(404)
  })

  it('an unpublished video is invisible to a non-author ticket holder', async () => {
    const ticket = mediaTicket(VID, USER, 'p')
    state.video!.status = 'archived'
    expect((await stream(ticket)).statusCode).toBe(404)
  })

  it('a draft-scope ticket answers 404 to a non-author', async () => {
    const res = await stream(mediaTicket(VID, USER, 'd'))
    expect(res.statusCode).toBe(404)
  })

  it('a draft-scope ticket serves the draft recording to an author', async () => {
    state.author = true
    const res = await stream(mediaTicket(VID, USER, 'd'))
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('bytes:DRAFT_SRC.webm')
  })

  it('a published-scope ticket never serves the draft, even to an author', async () => {
    state.author = true
    const res = await stream(mediaTicket(VID, USER, 'p'))
    expect(res.body).toBe('bytes:PUB_SRC.webm')
  })

  it('serves captions as WebVTT for a valid ticket', async () => {
    const res = await get(`/api/help-videos/${VID}/captions.vtt?st=${mediaTicket(VID, USER, 'p')}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/vtt')
    expect(res.body.startsWith('WEBVTT')).toBe(true)
  })
})

describe('POST /:id/progress', () => {
  it('is not recorded under masquerade (204)', async () => {
    state.masquerade = true
    const res = await (await app()).inject({
      method: 'POST',
      url: `/api/help-videos/${VID}/progress`,
      payload: { position_ms: 1000, buckets: '1'.repeat(20) }
    })
    expect(res.statusCode).toBe(204)
    expect(recordProgress).not.toHaveBeenCalled()
  })

  it('records progress for the person themselves', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: `/api/help-videos/${VID}/progress`,
      payload: { position_ms: 1000 }
    })
    expect(res.statusCode).toBe(200)
    expect(recordProgress).toHaveBeenCalledTimes(1)
  })

  it('answers 404 on a video the person cannot see', async () => {
    state.video!.visibility = JSON.stringify({ mode: 'roles', role_ids: [OTHER_ROLE] })
    const res = await (await app()).inject({
      method: 'POST',
      url: `/api/help-videos/${VID}/progress`,
      payload: { position_ms: 1000 }
    })
    expect(res.statusCode).toBe(404)
    expect(recordProgress).not.toHaveBeenCalled()
  })
})
