import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Learning paths (#1508): the routes gate on the author check, hand bodies
// to the service, tell the required roles on publish, and the required list
// folds a required path in without double-counting its videos.

const state = vi.hoisted(() => ({
  author: true,
  pathStatus: 'draft',
  publishedNow: false,
  addedRequired: [] as string[],
  requiredRoles: ['R1'] as string[],
  singles: [] as Array<{ id: string }>,
  mine: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ whereIn: vi.fn(async () => state.singles) }))
}))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  }
}))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  isAuthor: vi.fn(async () => state.author),
  viewerMaySee: () => true,
  serializeVideo: vi.fn(async (v: { id: string }) => ({ id: v.id, my_progress: null }))
}))
vi.mock('../../../services/help-video-views.js', async (orig) => ({
  ...(await orig<object>()),
  requiredForUser: vi.fn(async () => state.singles.map((s) => s.id))
}))
vi.mock('../../../services/help-video-paths.js', async (orig) => ({
  ...(await orig<object>()),
  createPath: vi.fn(async () => 'P1'),
  loadPath: vi.fn(async (id: string) => {
    if (id !== 'P1') throw Object.assign(new Error('nf'), { statusCode: 404 })
    return { id: 'P1', title: 'Start here', status: state.pathStatus }
  }),
  serializePath: vi.fn(async (row: { id: string }) => ({ id: row.id, title: 'Start here' })),
  listPaths: vi.fn(async () => [{ id: 'P1' }]),
  updatePath: vi.fn(async () => ({ published_now: state.publishedNow })),
  replacePathItems: vi.fn(async () => undefined),
  replacePathRoles: vi.fn(async () => ({ added_required: state.addedRequired })),
  requiredRolesOf: vi.fn(async () => state.requiredRoles),
  deletePath: vi.fn(async () => undefined),
  pathsForUser: vi.fn(async () => state.mine),
  notifyRequiredPathViewersSafely: vi.fn(async () => 1)
}))

import { helpVideosRoutes } from '../../../routes/help-videos.js'
import {
  notifyRequiredPathViewersSafely,
  replacePathItems,
  replacePathRoles
} from '../../../services/help-video-paths.js'

async function app() {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a
}

beforeEach(() => {
  vi.clearAllMocks()
  state.author = true
  state.pathStatus = 'draft'
  state.publishedNow = false
  state.addedRequired = []
  state.requiredRoles = ['R1']
  state.singles = []
  state.mine = []
})

describe('learning path routes', () => {
  it('authoring needs an author', async () => {
    state.author = false
    const a = await app()
    const r = await a.inject({ method: 'GET', url: '/api/help-videos/paths' })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('HELP_VIDEO_AUTHOR_ONLY')
    const c = await a.inject({ method: 'POST', url: '/api/help-videos/paths', payload: {} })
    expect(c.statusCode).toBe(403)
  })

  it('creates and lists', async () => {
    const a = await app()
    const c = await a.inject({
      method: 'POST',
      url: '/api/help-videos/paths',
      payload: { title: 'Start here' }
    })
    expect(c.statusCode).toBe(201)
    expect(c.json().data).toEqual({ id: 'P1', title: 'Start here' })
    const l = await a.inject({ method: 'GET', url: '/api/help-videos/paths' })
    expect(l.json().data).toEqual([{ id: 'P1' }])
    const one = await a.inject({ method: 'GET', url: '/api/help-videos/paths/P1' })
    expect(one.statusCode).toBe(200)
    const nf = await a.inject({ method: 'GET', url: '/api/help-videos/paths/P9' })
    expect(nf.statusCode).toBe(404)
  })

  it('PUT items and roles pass the body through', async () => {
    const a = await app()
    await a.inject({
      method: 'PUT',
      url: '/api/help-videos/paths/P1/items',
      payload: { video_ids: ['a'] }
    })
    expect(vi.mocked(replacePathItems).mock.calls[0][2]).toEqual(['a'])
    await a.inject({
      method: 'PUT',
      url: '/api/help-videos/paths/P1/roles',
      payload: { roles: [{ role_id: 'r', required: true }] }
    })
    expect(vi.mocked(replacePathRoles).mock.calls[0][2]).toEqual([{ role_id: 'r', required: true }])
  })

  it('tells newly required roles only when the path is published', async () => {
    const a = await app()
    state.addedRequired = ['R1']
    await a.inject({
      method: 'PUT',
      url: '/api/help-videos/paths/P1/roles',
      payload: { roles: [] }
    })
    expect(notifyRequiredPathViewersSafely).not.toHaveBeenCalled()
    state.pathStatus = 'published'
    await a.inject({
      method: 'PUT',
      url: '/api/help-videos/paths/P1/roles',
      payload: { roles: [] }
    })
    expect(notifyRequiredPathViewersSafely).toHaveBeenCalledWith('P1', 'Start here', ['R1'])
  })

  it('publishing through PATCH tells the required roles', async () => {
    const a = await app()
    state.publishedNow = true
    const r = await a.inject({
      method: 'PATCH',
      url: '/api/help-videos/paths/P1',
      payload: { status: 'published' }
    })
    expect(r.statusCode).toBe(200)
    expect(notifyRequiredPathViewersSafely).toHaveBeenCalledWith('P1', 'Start here', ['R1'])
    state.publishedNow = false
    vi.mocked(notifyRequiredPathViewersSafely).mockClear()
    await a.inject({ method: 'PATCH', url: '/api/help-videos/paths/P1', payload: { title: 'x' } })
    expect(notifyRequiredPathViewersSafely).not.toHaveBeenCalled()
  })

  it('DELETE answers 204', async () => {
    const a = await app()
    const r = await a.inject({ method: 'DELETE', url: '/api/help-videos/paths/P1' })
    expect(r.statusCode).toBe(204)
  })

  it('GET /paths/mine needs no author', async () => {
    state.author = false
    state.mine = [{ id: 'P1' }]
    const a = await app()
    const r = await a.inject({ method: 'GET', url: '/api/help-videos/paths/mine' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual([{ id: 'P1' }])
  })
})

describe('GET /required/mine with paths', () => {
  it('lists a required unfinished path once and leaves its videos out of the singles', async () => {
    state.singles = [{ id: 'V1' }, { id: 'V2' }]
    state.mine = [
      {
        id: 'P1',
        title: 'Start here',
        required: true,
        new_user: false,
        videos: [{ id: 'V1' }],
        progress: { total: 1, completed: 0, percent: 0, finished: false },
        next_video_id: 'V1'
      },
      {
        id: 'P2',
        title: 'Optional',
        required: false,
        new_user: false,
        videos: [{ id: 'V2' }],
        progress: { total: 1, completed: 0, percent: 0, finished: false },
        next_video_id: 'V2'
      }
    ]
    const a = await app()
    const r = await a.inject({ method: 'GET', url: '/api/help-videos/required/mine' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.data.map((v: { id: string }) => v.id)).toEqual(['V2'])
    expect(body.paths.map((p: { id: string }) => p.id)).toEqual(['P1'])
  })

  it('answers empty lists without paths', async () => {
    const a = await app()
    const r = await a.inject({ method: 'GET', url: '/api/help-videos/required/mine' })
    expect(r.json()).toEqual({ data: [], paths: [] })
  })
})
