// api/src/test/unit/plugins/request-id-public.test.ts
// Traffic Map drill-down Wave 0, fix round 1: beginTrace uses enterWith, so a previous /api
// request's trace can still be the async store when a public page (/share, /form) is served on
// the same keep-alive socket. The public-client event must not inherit that request's id.
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const builder = {
    insert: async () => undefined,
    where: () => builder,
    delete: async () => 0
  }
  const db = Object.assign(() => builder, { raw: async () => [] })
  return { db, _staticDb: {}, dbRead: {} }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../services/chain-columns.js', () => ({ hasChainColumns: async () => false }))

import { apiLoggerPlugin } from '../../../plugins/api-logger.js'
import { requestTracePlugin } from '../../../plugins/request-trace.js'
import { beginTrace, currentTraceMeta } from '../../../services/request-trace.js'
import { advanceTo, drainEvents, resetTrafficMap } from '../../../services/traffic-map.js'
// Registers the public-clients tap (the producer of the public event).
import '../../../services/traffic-taps/public-clients.js'

/** The previous /api request on this async context: its trace store is still entered. */
function leakTrace(): string {
  beginTrace('/api/items/workflows', {})
  return currentTraceMeta()?.id ?? ''
}

async function app(withTracePlugin: boolean) {
  const a = Fastify()
  if (withTracePlugin) await a.register(requestTracePlugin)
  await a.register(apiLoggerPlugin)
  a.get('/share/:token', async () => ({ meta: currentTraceMeta() }))
  await a.ready()
  return a
}

beforeEach(() => {
  resetTrafficMap()
  advanceTo(Math.floor(Date.now() / 1000))
})
afterEach(() => {
  resetTrafficMap()
})

describe('a public hit after an /api request on the same async context', () => {
  it('control: without the trace plugin the stale trace reaches the public page', async () => {
    const a = await app(false)
    const leaked = leakTrace()
    expect(leaked).toMatch(/^[0-9a-f-]{36}$/i)
    const res = await a.inject({ url: '/share/abc', headers: { 'x-forwarded-for': '203.0.113.7' } })
    expect(res.json().meta?.id).toBe(leaked)
    await a.close()
  })
  it('carries no rid: the plugin clears the stale trace for untraced paths', async () => {
    const a = await app(true)
    expect(leakTrace()).toMatch(/^[0-9a-f-]{36}$/i)
    const res = await a.inject({
      url: '/share/abc',
      headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'curl/8.4.0' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().meta).toBeNull()
    const pub = drainEvents().filter((e) => e.tags?.includes('public'))
    expect(pub).toHaveLength(1)
    expect(pub[0].rid).toBeUndefined()
    expect(pub[0].node).toBeTruthy()
    await a.close()
  })
})
