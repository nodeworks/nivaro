import { Redis } from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { redisCoeditStore } from '../../../services/coedit.js'

// The Lua side of the co-edit store against a real Redis (db 9, never db 0). Off unless
// COEDIT_REDIS_IT=1 (COEDIT_REDIS_IT_URL picks the server).
const on = process.env.COEDIT_REDIS_IT === '1'
const url = process.env.COEDIT_REDIS_IT_URL ?? 'redis://localhost:6379/9'

describe.skipIf(!on)('coedit redis store', () => {
  const redis = on ? new Redis(url) : (null as unknown as Redis)
  const key = `nvr:coedit:{it-${Date.now()}|orders|7|notes}`
  afterAll(async () => {
    if (!on) return
    await redis.del(`${key}:m`, `${key}:s`, `${key}:p`)
    redis.disconnect()
  })
  const doc = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
  const step = (t: string) =>
    JSON.stringify({
      stepType: 'replace',
      from: 1,
      to: 1,
      slice: { content: [{ type: 'text', text: t }] }
    })

  it('opens, orders, refuses stale and foreign batches, catches up and ends', async () => {
    const store = redisCoeditStore(redis)
    const now = Date.now()
    const a = await store.open(key, doc, 'sa:A', now)
    expect(a.created).toBe(true)
    expect(a.state.version).toBe(0)
    const b = await store.open(key, '{"type":"doc"}', 'sb:B', now)
    expect(b.created).toBe(false)
    expect(b.state.sid).toBe(a.state.sid)
    const sid = a.state.sid
    expect(await store.append(key, sid, 0, [step('a'), step('b')], 'A', 'sa:A', now)).toEqual({
      ok: true,
      version: 2
    })
    expect(await store.append(key, sid, 0, [step('x')], 'B', 'sb:B', now)).toEqual({
      ok: false,
      reason: 'behind',
      version: 2
    })
    expect(await store.append(key, 'nope', 2, [step('x')], 'B', 'sb:B', now)).toEqual({
      ok: false,
      reason: 'gone'
    })
    const since = await store.since(key, 1)
    expect(since?.sid).toBe(sid)
    expect(since?.steps.map((s) => s.c)).toEqual(['A'])
    expect(await store.since(key, 5)).toBeNull()
    const read = await store.read(key)
    expect(read?.version).toBe(2)
    expect(read?.steps).toHaveLength(2)
    await store.seen(key, 'sb:B', now)
    expect(await store.leave(key, 'sa:A', now)).toBe(false)
    expect(await store.leave(key, 'sb:B', now)).toBe(true)
    expect(await store.read(key)).toBeNull()
  })
})
