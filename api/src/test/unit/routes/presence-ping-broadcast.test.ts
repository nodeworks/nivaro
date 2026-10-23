import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// POST /api/presence/ping (public, embeddable script) used to SCAN the whole Redis keyspace and
// broadcast presence:update inline on EVERY ping. Pings now answer at once and the admin room
// gets at most one broadcast per window per tenant (staging demo 2026-10-23).

vi.mock('../../../db/index.js', () => {
  const b = { first: () => Promise.resolve(null) }
  return { db: () => b }
})

import { PRESENCE_BROADCAST_COALESCE_MS, presencePublicRoutes } from '../../../routes/presence.js'

function fakeRedis() {
  const store = new Map<string, string>()
  const calls = { scan: 0 }
  return {
    calls,
    get: async (k: string) => store.get(k) ?? null,
    setex: async (k: string, _ttl: number, v: string) => {
      store.set(k, v)
    },
    del: async (k: string) => {
      store.delete(k)
    },
    scan: async () => {
      calls.scan++
      return ['0', [...store.keys()]]
    },
    mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)
  }
}

describe('presence ping broadcast', () => {
  it('answers pings without scanning and sends one coalesced broadcast', async () => {
    const redis = fakeRedis()
    const emits: unknown[] = []
    const io = { to: () => ({ emit: (_ev: string, payload: unknown) => emits.push(payload) }) }
    const app = Fastify()
    app.decorate('redis', redis as never)
    app.decorate('io', io as never)
    await app.register(presencePublicRoutes, { prefix: '/api/presence' })
    await app.ready()
    // let the boot sweep (one scan + one emit) settle
    await new Promise((r) => setTimeout(r, 20))
    const scansAtStart = redis.calls.scan
    const emitsAtStart = emits.length

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/presence/ping',
        payload: { sessionId: `s${i}`, pageUrl: 'https://example.test/' }
      })
      expect(res.statusCode).toBe(204)
    }
    // Nothing scanned on the request path.
    expect(redis.calls.scan).toBe(scansAtStart)

    await new Promise((r) => setTimeout(r, PRESENCE_BROADCAST_COALESCE_MS + 100))
    expect(redis.calls.scan).toBe(scansAtStart + 1)
    expect(emits.length).toBe(emitsAtStart + 1)
    expect((emits.at(-1) as { sessions: unknown[] }).sessions).toHaveLength(5)
    await app.close()
  }, 10_000)
})
