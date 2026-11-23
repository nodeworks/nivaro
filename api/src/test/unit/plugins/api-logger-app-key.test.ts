// Nivaro Hub phase 6 (ruling P6-7, review I-2): an app's ENCRYPTION_KEY sent to
// PUT /api/hub/environments/:envId/app-key never reaches nivaro_api_logs.request_body, whoever
// calls (a token or API-key caller's write body is otherwise kept for 14 days). Also the masker
// covers `encryption_key` / `app_key` fields anywhere else.
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const inserted: Array<Record<string, unknown>> = []
vi.mock('../../../db/index.js', () => {
  const builder = {
    insert: async (rows: Array<Record<string, unknown>>) => {
      inserted.push(...rows)
    },
    where: () => builder,
    delete: async () => 0
  }
  const db = () => builder
  return { db }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../services/chain-columns.js', () => ({ hasChainColumns: async () => false }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/traffic-taps/public-clients.js', () => ({ notePublicHit: vi.fn() }))

import { apiLoggerPlugin, maskLoggedBody } from '../../../plugins/api-logger.js'
import { bodyNeverKept } from '../../../services/secret-mask.js'
import { captureBody } from '../../../services/traffic-inspect/request-capture.js'

const APP_KEY = 'ab'.repeat(32)

async function app(authMethod: 'token' | 'api_key') {
  const a = Fastify()
  await a.register(apiLoggerPlugin)
  const sign = async (req: unknown) => {
    ;(req as { user?: unknown }).user = { id: 'ADMIN-1' }
    ;(req as { authMethod?: string }).authMethod = authMethod
  }
  a.put('/api/hub/environments/:envId/app-key', { preHandler: sign }, async () => ({ data: {} }))
  a.put('/api/items/things/1', { preHandler: sign }, async () => ({ data: {} }))
  await a.ready()
  return a
}

afterEach(() => {
  inserted.length = 0
})

describe('app key in the request log', () => {
  for (const method of ['token', 'api_key'] as const) {
    it(`a ${method} caller's app-key PUT leaves no key text in the logged row`, async () => {
      const a = await app(method)
      const res = await a.inject({
        method: 'PUT',
        url: '/api/hub/environments/9/app-key',
        payload: { key: APP_KEY, note: 'x' }
      })
      expect(res.statusCode).toBe(200)
      await a.close() // flushes the buffer
      expect(inserted).toHaveLength(1)
      expect(inserted[0].path).toBe('/api/hub/environments/9/app-key')
      expect(inserted[0].request_body ?? null).toBeNull()
      expect(JSON.stringify(inserted[0])).not.toContain(APP_KEY)
    })
  }

  it('other write bodies are still kept (masked)', async () => {
    const a = await app('token')
    await a.inject({ method: 'PUT', url: '/api/items/things/1', payload: { title: 'Hello' } })
    await a.close()
    expect(inserted[0].request_body).toBe(JSON.stringify({ title: 'Hello' }))
  })

  it('encryption_key and app_key fields are masked anywhere', () => {
    const out = JSON.parse(
      maskLoggedBody(
        JSON.stringify({ encryption_key: APP_KEY, nested: { app_key: APP_KEY }, item_key: 'k1' })
      )
    )
    expect(JSON.stringify(out)).not.toContain(APP_KEY)
    expect(out.item_key).toBe('k1')
  })
  it('a Traffic Map capture of the app-key route keeps no body either', () => {
    const req = { body: { key: APP_KEY }, headers: { 'content-type': 'application/json' } }
    const out = captureBody(req, 'PUT', '/api/hub/environments/9/app-key')
    expect(out.body).toBeNull()
    expect(JSON.stringify(out)).not.toContain(APP_KEY)
    expect(captureBody(req, 'PUT', '/api/items/things/1').body).not.toBeNull()
  })

  // Re-review N-1 (ruling P6-9): Fastify decodes the path before routing, so an encoded spelling
  // reaches the same handler; the route pattern decides, never the raw text.
  for (const url of [
    '/api/hub/environments/9/app%2Dkey',
    '/api/hub/%65nvironments/9/app-key',
    '/api/hub/environments/9/app%2dkey'
  ]) {
    it(`an encoded spelling (${url}) reaches the route and still keeps no body`, async () => {
      const a = await app('token')
      const res = await a.inject({ method: 'PUT', url, payload: { key: APP_KEY } })
      expect(res.statusCode).toBe(200)
      await a.close()
      expect(inserted).toHaveLength(1)
      expect(inserted[0].request_body ?? null).toBeNull()
      expect(JSON.stringify(inserted[0])).not.toContain(APP_KEY)
    })

    it(`a Traffic Map capture of ${url} keeps no body`, () => {
      const req = {
        body: { key: APP_KEY },
        headers: { 'content-type': 'application/json' },
        routeOptions: { url: '/api/hub/environments/:envId/app-key' }
      }
      expect(captureBody(req, 'PUT', url).body).toBeNull()
      // unrouted: the decoded path decides
      const { routeOptions: _r, ...bare } = req
      expect(captureBody(bare, 'PUT', url).body).toBeNull()
    })
  }

  it('a path that cannot be decoded is never kept (fail closed)', () => {
    expect(bodyNeverKept('/api/hub/environments/9/app-key%E0%A4%A')).toBe(true)
    expect(bodyNeverKept('/api/items/%E0%A4%A')).toBe(true)
    expect(bodyNeverKept('/api/items/things/1')).toBe(false)
    expect(bodyNeverKept('/x', '/api/hub/environments/:envId/app-key')).toBe(true)
    expect(bodyNeverKept('/api/items/things/1', '/api/items/:collection/:id')).toBe(false)
  })
})
