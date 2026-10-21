// #2439 — per-viewer ETag + 304 through real Fastify hooks.
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ifNoneMatchHits, registerEtags, viewerEtag } from './etag.js'

let body: Record<string, unknown> = { data: { id: 1, name: 'Alpha' } }

async function app(): Promise<FastifyInstance> {
  const a = Fastify()
  registerEtags(a)
  await a.register(
    async (items) => {
      // stands in for authenticate
      items.addHook('preHandler', async (req) => {
        const who = String(req.headers['x-test-user'] ?? '')
        ;(req as unknown as { user: unknown }).user = who ? { id: who, role: 'r' } : undefined
        ;(req as unknown as { authMethod: string }).authMethod = 'session'
      })
      items.get('/items/:collection/:id', async () => body)
      items.get('/items/:collection', async () => ({ data: [body] }))
      items.get('/collection-layouts/active', async (_req, reply) => {
        void reply.header('cache-control', 'private, max-age=5')
        return { data: [] }
      })
    },
    { prefix: '/api' }
  )
  await a.ready()
  return a
}

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
let server: FastifyInstance

beforeEach(async () => {
  body = { data: { id: 1, name: 'Alpha' } }
  server = await app()
})
afterEach(async () => {
  await server.close()
})

describe('ETag on record and schema reads', () => {
  it('tags a record read and answers a matching If-None-Match with a body-less 304', async () => {
    const first = await server.inject({ url: '/api/items/orders/1', headers: { 'x-test-user': A } })
    expect(first.statusCode).toBe(200)
    const etag = first.headers.etag as string
    expect(etag).toMatch(/^W\/"/)
    expect(first.headers['cache-control']).toBe('private, no-cache')

    const again = await server.inject({
      url: '/api/items/orders/1',
      headers: { 'x-test-user': A, 'if-none-match': etag }
    })
    expect(again.statusCode).toBe(304)
    expect(again.body).toBe('')
    expect(again.headers['content-type']).toBeUndefined()
    expect(again.headers.etag).toBe(etag)
  })

  it('sends the full body again once the record changed', async () => {
    const first = await server.inject({ url: '/api/items/orders/1', headers: { 'x-test-user': A } })
    body = { data: { id: 1, name: 'Renamed' } }
    const again = await server.inject({
      url: '/api/items/orders/1',
      headers: { 'x-test-user': A, 'if-none-match': first.headers.etag as string }
    })
    expect(again.statusCode).toBe(200)
    expect(JSON.parse(again.body).data.name).toBe('Renamed')
    expect(again.headers.etag).not.toBe(first.headers.etag)
  })

  it('never lets one viewer reuse another viewer tag, even for the same body', async () => {
    const a = await server.inject({ url: '/api/items/orders/1', headers: { 'x-test-user': A } })
    const b = await server.inject({
      url: '/api/items/orders/1',
      headers: { 'x-test-user': B, 'if-none-match': a.headers.etag as string }
    })
    expect(b.statusCode).toBe(200)
    expect(b.headers.etag).not.toBe(a.headers.etag)
  })

  it('leaves lists, anonymous callers and route cache headers alone', async () => {
    const list = await server.inject({ url: '/api/items/orders', headers: { 'x-test-user': A } })
    expect(list.headers.etag).toBeUndefined()
    const anon = await server.inject({ url: '/api/items/orders/1' })
    expect(anon.headers.etag).toBeUndefined()
    const layouts = await server.inject({
      url: '/api/collection-layouts/active',
      headers: { 'x-test-user': A }
    })
    expect(layouts.headers.etag).toBeDefined()
    expect(layouts.headers['cache-control']).toBe('private, max-age=5')
  })
})

describe('helpers', () => {
  it('compares If-None-Match weakly, in a list, and honours *', () => {
    const tag = viewerEtag('t|u', '{"a":1}')
    expect(ifNoneMatchHits(tag, tag)).toBe(true)
    expect(ifNoneMatchHits(`"x", ${tag.replace(/^W\//, '')}`, tag)).toBe(true)
    expect(ifNoneMatchHits('*', tag)).toBe(true)
    expect(ifNoneMatchHits('"other"', tag)).toBe(false)
    expect(ifNoneMatchHits(undefined, tag)).toBe(false)
  })
  it('a tag depends on the viewer and the body', () => {
    expect(viewerEtag('a', 'x')).not.toBe(viewerEtag('b', 'x'))
    expect(viewerEtag('a', 'x')).not.toBe(viewerEtag('a', 'y'))
    expect(viewerEtag('a', Buffer.from('x'))).toBe(viewerEtag('a', 'x'))
  })
})
