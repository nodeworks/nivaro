import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// POST /uploads/:id/finalize carries the recording's metadata (clicks,
// levels, activity, script, marks), which the normalisers bound at under
// 3 MB once stored: the body itself is refused above FINALIZE_BODY_BYTES
// instead of parsing under the global limit.

const UPLOAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const finalized = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock('../../../config.js', () => ({ config: { SESSION_SECRET: 'x'.repeat(40) } }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  }
}))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  isAuthor: vi.fn(async () => true)
}))
vi.mock('../../../services/help-video-uploads.js', async (orig) => ({
  ...(await orig<object>()),
  finalizeUpload: vi.fn(async (_u: unknown, id: string, meta: unknown) => {
    finalized.calls.push(meta)
    return { id, finalized: true }
  })
}))

import { FINALIZE_BODY_BYTES, helpVideosRoutes } from '../../../routes/help-videos.js'

async function app() {
  const a = Fastify({ bodyLimit: 64 * 1024 * 1024 })
  a.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) =>
    reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code })
  )
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a
}
const headers = { authorization: 'Bearer t', 'content-type': 'application/json' }

describe('POST /uploads/:id/finalize body limit', () => {
  it('is 8 MB, under the global limit', () => {
    expect(FINALIZE_BODY_BYTES).toBe(8 * 1024 * 1024)
  })
  it('refuses a body over the limit with 413 before the service sees it', async () => {
    const a = await app()
    const big = JSON.stringify({ duration_ms: 1000, script: 'x'.repeat(FINALIZE_BODY_BYTES) })
    const res = await a.inject({
      method: 'POST',
      url: `/api/help-videos/uploads/${UPLOAD}/finalize`,
      headers,
      payload: big
    })
    expect(res.statusCode).toBe(413)
    expect(finalized.calls).toHaveLength(0)
  })
  it('takes a body under the limit', async () => {
    const a = await app()
    const res = await a.inject({
      method: 'POST',
      url: `/api/help-videos/uploads/${UPLOAD}/finalize`,
      headers,
      payload: JSON.stringify({ duration_ms: 1000, script: 'x'.repeat(1024 * 1024) })
    })
    expect(res.statusCode).toBe(200)
    expect(finalized.calls).toHaveLength(1)
  })
})
