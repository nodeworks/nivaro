// #2273 temporary cache through real Fastify hooks: a hit skips the route, callers stay apart,
// a write in between is seen, and nothing changes while no cache is on.
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CACHE_HEADER,
  noteCollectionChanged,
  registerTempCacheHooks,
  resetTempCache
} from './temp-cache.js'
import { setTimedRulesForTest } from './timed-rules.js'

let calls = 0

async function app(): Promise<FastifyInstance> {
  const a = Fastify()
  await a.register(
    async (items) => {
      // stands in for authenticate + resolveWorkspace
      items.addHook('preHandler', async (req) => {
        const who = String(req.headers['x-test-user'] ?? '')
        ;(req as unknown as { user: unknown }).user = who ? { id: who, role: 'r' } : undefined
        ;(req as unknown as { authMethod: string }).authMethod = 'session'
      })
      registerTempCacheHooks(items)
      items.get('/:collection', async (req) => {
        calls++
        return { data: [{ n: calls, q: req.query }] }
      })
      items.get('/:collection/export', async () => {
        calls++
        return { data: 'export' }
      })
    },
    { prefix: '/api/items' }
  )
  await a.ready()
  return a
}

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

beforeEach(() => {
  calls = 0
  resetTempCache()
})
afterEach(() => {
  setTimedRulesForTest([])
  resetTempCache()
})

function on() {
  setTimedRulesForTest([
    {
      kind: 'cache',
      id: 'r1',
      target: 'items/orders',
      until: Date.now() + 600_000,
      at: Date.now(),
      by: null,
      by_name: null,
      opts: { entry_s: 30, related: [] }
    }
  ])
}

describe('temporary cache hooks', () => {
  it('do nothing while no cache is on', async () => {
    const a = await app()
    const r1 = await a.inject({ url: '/api/items/orders?limit=1', headers: { 'x-test-user': A } })
    const r2 = await a.inject({ url: '/api/items/orders?limit=1', headers: { 'x-test-user': A } })
    expect(calls).toBe(2)
    expect(r1.headers[CACHE_HEADER]).toBeUndefined()
    expect(r2.json().data[0].n).toBe(2)
  })

  it('answer a repeat from memory without running the route', async () => {
    on()
    const a = await app()
    const r1 = await a.inject({
      url: '/api/items/orders?limit=1&sort=id',
      headers: { 'x-test-user': A }
    })
    const r2 = await a.inject({
      url: '/api/items/orders?sort=id&limit=1',
      headers: { 'x-test-user': A }
    })
    expect(calls).toBe(1)
    expect(r1.headers[CACHE_HEADER]).toBe('miss')
    expect(r2.headers[CACHE_HEADER]).toBe('hit')
    expect(r2.headers['content-type']).toContain('application/json')
    expect(r2.body).toBe(r1.body)
  })

  it('never hand one caller another’s answer, nor an anonymous caller anything', async () => {
    on()
    const a = await app()
    await a.inject({ url: '/api/items/orders', headers: { 'x-test-user': A } })
    const rb = await a.inject({ url: '/api/items/orders', headers: { 'x-test-user': B } })
    const anon1 = await a.inject({ url: '/api/items/orders' })
    const anon2 = await a.inject({ url: '/api/items/orders' })
    expect(rb.headers[CACHE_HEADER]).toBe('miss')
    expect(anon1.headers[CACHE_HEADER]).toBeUndefined()
    expect(anon2.headers[CACHE_HEADER]).toBeUndefined()
    expect(calls).toBe(4)
  })

  it('re-read after a write to the collection', async () => {
    on()
    const a = await app()
    await a.inject({ url: '/api/items/orders', headers: { 'x-test-user': A } })
    noteCollectionChanged('orders')
    const r = await a.inject({ url: '/api/items/orders', headers: { 'x-test-user': A } })
    expect(r.headers[CACHE_HEADER]).toBe('miss')
    expect(calls).toBe(2)
  })

  it('leave routes off the allowlist alone', async () => {
    on()
    const a = await app()
    await a.inject({ url: '/api/items/orders/export', headers: { 'x-test-user': A } })
    const r = await a.inject({ url: '/api/items/orders/export', headers: { 'x-test-user': A } })
    expect(r.headers[CACHE_HEADER]).toBeUndefined()
    expect(calls).toBe(2)
  })
})
