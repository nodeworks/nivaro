// #1102 — the root /graphql alias logs ONE row that names the operation; #1152 — public pages
// outside /api reach the public-client tap.
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
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'PARTNER-1' }
    ;(req as { authMethod?: string }).authMethod = 'token'
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/files.js', () => ({ uploadFile: vi.fn() }))
vi.mock('../../../services/traffic-taps/public-clients.js', () => ({ notePublicHit: vi.fn() }))

import { apiLoggerPlugin, internalDispatchStamps } from '../../../plugins/api-logger.js'
import { legacyCompatRoutes } from '../../../plugins/legacy-compat.js'
import { notePublicHit } from '../../../services/traffic-taps/public-clients.js'

async function app() {
  const a = Fastify()
  await a.register(apiLoggerPlugin)
  await a.register(legacyCompatRoutes)
  a.post('/api/graphql', async (req) => {
    ;(req as unknown as { __nvrGql?: unknown }).__nvrGql = {
      operation: 'PartnerWorkflows',
      kind: 'query',
      depth: 3,
      selections: 9,
      errors: 0,
      deprecated: []
    }
    return { data: {} }
  })
  a.get('/share/:token', async () => 'page')
  await a.ready()
  return a
}

afterEach(() => {
  inserted.length = 0
  vi.mocked(notePublicHit).mockClear()
})

describe('root /graphql alias', () => {
  it('logs one row carrying the inner operation and the caller', async () => {
    const a = await app()
    const res = await a.inject({ method: 'POST', url: '/graphql', payload: { query: '{ x }' } })
    expect(res.statusCode).toBe(200)
    await a.close() // flushes the buffer
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      path: '/graphql',
      graphql_operation: 'PartnerWorkflows',
      user: 'PARTNER-1',
      auth: 'token'
    })
    expect(internalDispatchStamps.size).toBe(0)
  })
})

describe('public pages', () => {
  it('a /share page reaches the public-client tap with its user agent and IP', async () => {
    const a = await app()
    await a.inject({
      method: 'GET',
      url: '/share/abc123token',
      headers: { 'user-agent': 'curl/8', 'x-forwarded-for': '203.0.113.5' }
    })
    await a.close()
    expect(notePublicHit).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notePublicHit).mock.calls[0][0]).toMatchObject({
      path: '/share/abc123token',
      userAgent: 'curl/8',
      ip: '203.0.113.5',
      signedIn: false
    })
    expect(inserted).toHaveLength(0) // still outside the request log
  })
})
