import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/traffic-map.js', () => ({
  noteRequest: vi.fn(),
  hasCacheHit: () => false,
  errorCode: () => null
}))

import { apiLoggerPlugin, INTERNAL_DISPATCH_HEADER } from '../../../plugins/api-logger.js'
import { noteRequest } from '../../../services/traffic-map.js'

async function app() {
  const a = Fastify()
  await a.register(apiLoggerPlugin)
  a.all('/api/items/workflows', async () => ({ ok: true }))
  a.all('/graphql', async () => ({ ok: true }))
  a.all('/files', async () => ({ ok: true }))
  await a.ready()
  return a
}

describe('api-logger -> traffic map', () => {
  beforeEach(() => vi.mocked(noteRequest).mockClear())
  it('counts internally dispatched requests', async () => {
    const a = await app()
    await a.inject({
      method: 'GET',
      url: '/api/items/workflows',
      headers: { [INTERNAL_DISPATCH_HEADER]: '1' }
    })
    expect(noteRequest).toHaveBeenCalledTimes(1)
    await a.close()
  })
  it('does not count the outer /graphql alias but counts POST /files', async () => {
    const a = await app()
    await a.inject({ method: 'POST', url: '/graphql', payload: {} })
    expect(noteRequest).not.toHaveBeenCalled()
    await a.inject({ method: 'POST', url: '/files', payload: {} })
    expect(noteRequest).toHaveBeenCalledTimes(1)
    await a.close()
  })
})
