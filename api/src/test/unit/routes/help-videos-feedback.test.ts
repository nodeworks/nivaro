import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ratings, questions (#1505) and Up next (#1530) routes: shapes, who may
// call them, and that a masquerade session writes nothing in the person's name.

const state = vi.hoisted(() => ({ author: false, masquerade: false }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; masqueradeAdminId?: string }) => {
    req.user = { id: 'U1', role: 'R1' }
    if (state.masquerade) req.masqueradeAdminId = 'ADMIN'
  }
}))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  isAuthor: vi.fn(async () => state.author),
  loadVideoForUser: vi.fn(async () => ({
    video: { id: 'V1', title: 'Hello', status: 'published', duration_ms: 60_000 },
    author: state.author
  }))
}))
vi.mock('../../../services/help-video-feedback.js', () => ({
  setRating: vi.fn(async (_u: unknown, _v: unknown, helpful: unknown) => ({ helpful: !!helpful })),
  myRating: vi.fn(async () => true),
  ratingSummary: vi.fn(async () => ({ up: 3, down: 1, helpful_rate: 0.75 })),
  listQuestions: vi.fn(async (_v: unknown, ctx: { author: boolean }) => [
    { id: 'Q1', text: 'q', author_view: ctx.author }
  ]),
  askQuestion: vi.fn(async (_u: unknown, _v: unknown, body: unknown) => ({
    id: 'Q2',
    ...(body as object)
  })),
  answerQuestion: vi.fn(
    async (_u: unknown, _v: unknown, qid: string, body: { answer: string }) => ({
      id: qid,
      answer: body.answer
    })
  )
}))
vi.mock('../../../services/help-video-next.js', () => ({
  nextForViewer: vi.fn(async () => [{ id: 'V2' }])
}))
vi.mock('../../../services/help-video-views.js', async (orig) => ({
  ...(await orig<object>()),
  videoAnalytics: vi.fn(async () => ({
    views: 4,
    unique_viewers: 4,
    completion_rate: 0.5,
    drop_off: [],
    watched_hours: 1
  }))
}))

import { helpVideosRoutes } from '../../../routes/help-videos.js'
import { askQuestion, setRating } from '../../../services/help-video-feedback.js'

async function call(
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  payload?: Record<string, unknown>
) {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a.inject({ method, url: `/api/help-videos${url}`, payload })
}

describe('feedback and up-next routes', () => {
  beforeEach(() => {
    state.author = false
    state.masquerade = false
    vi.clearAllMocks()
  })

  it('PUT /:id/rating stores the vote', async () => {
    const r = await call('PUT', '/V1/rating', { helpful: true })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ data: { helpful: true } })
    expect(setRating).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'U1' }),
      expect.anything(),
      true
    )
  })

  it('a masquerade session may neither vote nor ask', async () => {
    state.masquerade = true
    const r1 = await call('PUT', '/V1/rating', { helpful: true })
    expect(r1.statusCode).toBe(403)
    expect(r1.json().code).toBe('HELP_VIDEO_MASQUERADE')
    const r2 = await call('POST', '/V1/questions', { at_ms: 1, text: 'q' })
    expect(r2.statusCode).toBe(403)
    expect(setRating).not.toHaveBeenCalled()
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('GET /:id/questions answers the list and this person’s vote, as viewer or author', async () => {
    const r = await call('GET', '/V1/questions')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({
      data: [{ id: 'Q1', text: 'q', author_view: false }],
      my_rating: true
    })
    state.author = true
    expect((await call('GET', '/V1/questions')).json().data[0].author_view).toBe(true)
  })

  it('POST /:id/questions creates one (201)', async () => {
    const r = await call('POST', '/V1/questions', { at_ms: 42_000, text: 'Where is Save?' })
    expect(r.statusCode).toBe(201)
    expect(r.json().data).toEqual({ id: 'Q2', at_ms: 42_000, text: 'Where is Save?' })
  })

  it('POST /:id/questions/:qid/answer is for authors only', async () => {
    const no = await call('POST', '/V1/questions/Q1/answer', { answer: 'Top right' })
    expect(no.statusCode).toBe(403)
    expect(no.json().code).toBe('HELP_VIDEO_AUTHOR_ONLY')
    state.author = true
    const yes = await call('POST', '/V1/questions/Q1/answer', { answer: 'Top right' })
    expect(yes.statusCode).toBe(200)
    expect(yes.json()).toEqual({ data: { id: 'Q1', answer: 'Top right' } })
  })

  it('GET /:id/next lists the suggestions', async () => {
    const r = await call('GET', '/V1/next')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ data: [{ id: 'V2' }] })
  })

  it('GET /:id/analytics carries ratings and the questions beside drop-off', async () => {
    state.author = true
    const r = await call('GET', '/V1/analytics')
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({
      unique_viewers: 4,
      ratings: { up: 3, down: 1, helpful_rate: 0.75 },
      questions: [{ id: 'Q1', author_view: true }]
    })
  })
})
