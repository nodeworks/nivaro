import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Embed feeds: the generated widget.js parses and carries the live / refresh paths, and the
// public push stream sends a bare `changed` signal (coalesced) for writes on the feed's own
// collection only, refuses unknown or inactive tokens, and never carries record data.

const TOKEN = 'a'.repeat(32)
const m = vi.hoisted(() => ({
  feed: null as Record<string, unknown> | null,
  creator: { id: 'u1', status: 'active' } as Record<string, unknown> | null
}))

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const chain = {
      where: () => chain,
      select: async () => [],
      first: async () => (table === 'nivaro_widget_feeds' ? m.feed : m.creator)
    }
    return chain
  }
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/queues.js', () => ({ fetchQueueItems: vi.fn() }))
vi.mock('../../../routes/queues.js', () => ({ canReadQueue: vi.fn(async () => true) }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

const { buildWidgetScript, widgetRoutes } = await import('../../../routes/widget.js')
const { publishSseEvent } = await import('../../../services/sse-hub.js')

function readStream(
  app: FastifyInstance,
  path: string,
  ms: number
): Promise<{ status: number; body: string }> {
  const { port } = app.server.address() as AddressInfo
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      setTimeout(() => {
        req.destroy()
        resolve({ status: res.statusCode ?? 0, body })
      }, ms)
    })
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ECONNRESET') return
      reject(e)
    })
    req.end()
  })
}

describe('widget.js', () => {
  it('is valid JavaScript with the live and refresh paths', () => {
    const src = buildWidgetScript()
    expect(() => new Function(src)).not.toThrow()
    expect(src).toContain('data-live')
    expect(src).toContain('EventSource')
    expect(src).toContain('/stream')
    expect(src).toContain('data-refresh')
    expect(src).toContain('visibilitychange')
  })
})

describe('GET /widget/public/feed/:token/stream', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    m.feed = { id: 1, token: TOKEN, is_active: true, collection: 'news', created_by: 'u1' }
    m.creator = { id: 'u1', status: 'active' }
    app = Fastify()
    await app.register(widgetRoutes, { prefix: '/widget' })
    await app.listen({ port: 0, host: '127.0.0.1' })
  })
  afterEach(async () => {
    await app.close()
  })

  it('refuses a malformed, unknown or inactive token', async () => {
    expect((await app.inject(`/widget/public/feed/nope/stream`)).statusCode).toBe(404)
    m.feed = null
    expect((await app.inject(`/widget/public/feed/${TOKEN}/stream`)).statusCode).toBe(404)
    m.feed = { id: 1, token: TOKEN, is_active: false, collection: 'news', created_by: 'u1' }
    expect((await app.inject(`/widget/public/feed/${TOKEN}/stream`)).statusCode).toBe(404)
    m.feed = { id: 1, token: TOKEN, is_active: true, collection: 'news', created_by: 'u1' }
    m.creator = { id: 'u1', status: 'suspended' }
    expect((await app.inject(`/widget/public/feed/${TOKEN}/stream`)).statusCode).toBe(404)
  })

  it('pushes one bare changed signal for writes on the feed collection only', async () => {
    const pending = readStream(app, `/widget/public/feed/${TOKEN}/stream`, 2_800)
    await new Promise((r) => setTimeout(r, 150))
    publishSseEvent({ collection: 'other', item: 1, action: 'update' })
    publishSseEvent({ collection: 'news', item: 7, action: 'update', changed_fields: ['title'] })
    publishSseEvent({ collection: 'news', item: 8, action: 'create' })
    const { status, body } = await pending
    expect(status).toBe(200)
    expect(body).toContain(': connected')
    // Coalesced: three writes, two on the feed's collection → exactly one signal.
    expect(body.match(/event: changed/g)?.length).toBe(1)
    // Never record data: no ids, fields or collection names in the stream.
    expect(body).not.toContain('news')
    expect(body).not.toContain('title')
    expect(body).not.toMatch(/"item"/)
  }, 10_000)
})
