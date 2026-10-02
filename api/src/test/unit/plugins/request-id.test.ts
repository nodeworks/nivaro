// api/src/test/unit/plugins/request-id.test.ts
// Traffic Map drill-down Wave 0: one request id joins the response header, the API log row and
// the slow-request trace.
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Keep every trace (the threshold is read at module load).
vi.hoisted(() => {
  process.env.TRACE_SLOW_MS = '0'
})

const inserted: Array<Record<string, unknown>> = []
const columns = new Set(['query', 'graphql_operation', 'instance', 'request_id'])
vi.mock('../../../db/index.js', () => {
  const builder = {
    insert: async (rows: Array<Record<string, unknown>>) => {
      inserted.push(...rows)
    },
    where: () => builder,
    delete: async () => 0
  }
  const db = Object.assign(() => builder, { raw: async () => [] })
  return { db, _staticDb: {}, dbRead: {} }
})
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: async (_t: string, c: string) => columns.has(c)
}))
vi.mock('../../../services/chain-columns.js', () => ({ hasChainColumns: async () => false }))
vi.mock('../../../services/traffic-taps/public-clients.js', () => ({ notePublicHit: vi.fn() }))

import { apiLoggerPlugin } from '../../../plugins/api-logger.js'
import { REQUEST_ID_HEADER, requestTracePlugin } from '../../../plugins/request-trace.js'
import { clearTraces, getTrace } from '../../../services/request-trace.js'

async function app() {
  const a = Fastify()
  await a.register(requestTracePlugin)
  await a.register(apiLoggerPlugin)
  a.get('/api/things', async (req) => ({ id: req.requestId }))
  a.get('/share/:token', async (req) => ({ id: req.requestId ?? null }))
  await a.ready()
  return a
}

afterEach(() => {
  inserted.length = 0
  columns.add('request_id')
  clearTraces()
})

describe('request id', () => {
  it('is the header, the log row request_id and the trace id', async () => {
    const a = await app()
    const res = await a.inject({ url: '/api/things' })
    const rid = res.headers[REQUEST_ID_HEADER]
    expect(typeof rid).toBe('string')
    expect(rid).toMatch(/^[0-9a-f-]{36}$/i)
    expect(res.json().id).toBe(rid)
    expect(getTrace(rid as string)?.route).toBe('/api/things')
    await a.close() // flushes the log buffer
    expect(inserted).toHaveLength(1)
    expect(inserted[0].request_id).toBe(rid)
  })
  it('a database behind migration 389 gets no request_id key at all', async () => {
    columns.delete('request_id')
    const a = await app()
    await a.inject({ url: '/api/things' })
    await a.close()
    expect(inserted).toHaveLength(1)
    expect(Object.keys(inserted[0])).not.toContain('request_id')
  })
  it('paths outside /api get no id and no header', async () => {
    const a = await app()
    const res = await a.inject({ url: '/share/abc' })
    expect(res.headers[REQUEST_ID_HEADER]).toBeUndefined()
    expect(res.json().id).toBeNull()
    await a.close()
  })
})
