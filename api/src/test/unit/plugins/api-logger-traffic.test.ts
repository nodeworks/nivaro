import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/traffic-map.js', () => ({
  noteRequest: vi.fn(),
  hasCacheHit: () => false,
  errorCode: () => null
}))

import {
  apiLoggerPlugin,
  INTERNAL_DISPATCH_HEADER,
  internalDispatchTokens
} from '../../../plugins/api-logger.js'
import { noteRequest } from '../../../services/traffic-map.js'

async function app() {
  const a = Fastify()
  await a.register(apiLoggerPlugin)
  a.all('/api/items/workflows', async () => ({ ok: true }))
  a.all('/graphql', async () => ({ ok: true }))
  a.all('/files', async () => ({ ok: true }))
  a.get('/api/items/broken', async (_req, reply) => reply.code(422).send({ code: 'NOPE' }))
  await a.ready()
  return a
}

describe('api-logger -> traffic map', () => {
  beforeEach(() => vi.mocked(noteRequest).mockClear())
  it('counts internally dispatched requests', async () => {
    const a = await app()
    // A REGISTERED dispatch token — an unregistered header value is just a wire request, which
    // would make this test pass no matter where noteRequest sits.
    const token = 'traffic-test-dispatch-token'
    internalDispatchTokens.add(token)
    try {
      await a.inject({
        method: 'GET',
        url: '/api/items/workflows',
        headers: { [INTERNAL_DISPATCH_HEADER]: token }
      })
      expect(noteRequest).toHaveBeenCalledTimes(1)
    } finally {
      internalDispatchTokens.delete(token)
      await a.close()
    }
  })
  it('does not count the outer /graphql alias but counts POST /files', async () => {
    const a = await app()
    await a.inject({ method: 'POST', url: '/graphql', payload: {} })
    expect(noteRequest).not.toHaveBeenCalled()
    await a.inject({ method: 'POST', url: '/files', payload: {} })
    expect(noteRequest).toHaveBeenCalledTimes(1)
    await a.close()
  })
  it('hands the map the request, reply and response bytes for every status', async () => {
    const a = await app()
    await a.inject({ method: 'GET', url: '/api/items/workflows' })
    await a.inject({ method: 'GET', url: '/api/items/broken' })
    const [ok, bad] = vi.mocked(noteRequest).mock.calls.map((c) => c[0])
    expect(ok.responseBytes).toBe(Buffer.byteLength(JSON.stringify({ ok: true })))
    expect(bad.responseBytes).toBe(Buffer.byteLength(JSON.stringify({ code: 'NOPE' })))
    expect(bad.status).toBe(422)
    expect((ok.req as { url?: string }).url).toBe('/api/items/workflows')
    expect((ok.reply as { statusCode?: number }).statusCode).toBe(200)
    await a.close()
  })
})
