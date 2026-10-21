import { beforeEach, describe, expect, it } from 'vitest'
import {
  overWindowLimit,
  resetWindowedMemory,
  takeWindowed
} from '../../../services/windowed-limit.js'

/** A Redis stand-in that runs the limiter's script the way Redis would: INCRBY, then EXPIRE
 *  whenever the key has no TTL — in one call. `ttl` -1 = no expiry, as Redis reports it. */
function fakeRedis() {
  const store = new Map<string, { v: number; ttl: number }>()
  const calls: string[] = []
  return {
    store,
    calls,
    eval: async (script: string, numKeys: number, key: string, n: number, windowS: number) => {
      calls.push('eval')
      expect(numKeys).toBe(1)
      expect(script).toContain('INCRBY')
      expect(script).toContain("redis.call('TTL', KEYS[1]) < 0")
      const e = store.get(key) ?? { v: 0, ttl: -1 }
      e.v += Number(n)
      if (e.ttl < 0) e.ttl = Number(windowS)
      store.set(key, e)
      return e.v
    }
  }
}

beforeEach(() => resetWindowedMemory())

describe('takeWindowed', () => {
  it('grants a straddling batch the remainder and nothing after, one call each', async () => {
    const r = fakeRedis()
    expect(await takeWindowed(r, 'k', 40, 60, 60)).toBe(40)
    expect(await takeWindowed(r, 'k', 40, 60, 60)).toBe(20)
    expect(await takeWindowed(r, 'k', 5, 60, 60)).toBe(0)
    expect(r.calls).toHaveLength(3)
    const [entry] = [...r.store.values()]
    expect(entry.ttl).toBe(60)
  })
  it('gives a key left without a TTL its window on the next call', async () => {
    const r = fakeRedis()
    await takeWindowed(r, 'stale', 1, 10, 60)
    const [key] = [...r.store.keys()]
    // A process died before an expiry was set (older code), or someone PERSISTed it.
    r.store.set(key, { v: 999, ttl: -1 })
    expect(await takeWindowed(r, 'stale', 1, 10, 60)).toBe(0)
    expect(r.store.get(key)?.ttl).toBe(60)
  })
  it('counts in memory when Redis fails or answers nonsense', async () => {
    expect(await takeWindowed(null, 'm', 8, 10, 60)).toBe(8)
    expect(await takeWindowed(null, 'm', 8, 10, 60)).toBe(2)
    expect(await overWindowLimit(null, 'm', 10, 60)).toBe(true)
    expect(await overWindowLimit(null, 'other', 10, 60)).toBe(false)
    const broken = { eval: async () => 'OK' }
    expect(await takeWindowed(broken, 'b', 3, 10, 60)).toBe(3)
    const down = {
      eval: async () => {
        throw new Error('down')
      }
    }
    expect(await takeWindowed(down, 'b', 9, 10, 60)).toBe(7)
  })
})
