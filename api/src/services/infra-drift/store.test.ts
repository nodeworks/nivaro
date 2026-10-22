import { describe, expect, it } from 'vitest'
import { isDuplicateKey, withStackLock } from './store.js'

/** A Redis double with SET NX EX and the compare-and-delete release script. */
function fakeRedis() {
  const keys = new Map<string, string>()
  return {
    keys,
    set: async (key: unknown, value: unknown, ..._rest: unknown[]) => {
      if (keys.has(String(key))) return null
      keys.set(String(key), String(value))
      return 'OK'
    },
    eval: async (_script: unknown, _n: unknown, key: unknown, token: unknown) => {
      if (keys.get(String(key)) !== String(token)) return 0
      keys.delete(String(key))
      return 1
    }
  }
}

describe('withStackLock', () => {
  it('lets one check of a stack run at a time, across replicas sharing Redis', async () => {
    const redis = fakeRedis()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = withStackLock('efp', 'production', () => gate.then(() => 'first'), redis)
    // Same process: the local guard refuses at once.
    expect(await withStackLock('efp', 'production', async () => 'second', redis)).toBeNull()
    // Another stack is independent.
    expect(await withStackLock('efp', 'staging', async () => 'other', redis)).toBe('other')
    release()
    expect(await first).toBe('first')
    expect(redis.keys.size).toBe(0)
  })

  it('refuses while another replica holds the lease, and never deletes a lease it does not own', async () => {
    const redis = fakeRedis()
    redis.keys.set('nvr:infra-drift:lock:efp:production', 'other-replica')
    expect(await withStackLock('efp', 'production', async () => 'ran', redis)).toBeNull()
    expect(redis.keys.get('nvr:infra-drift:lock:efp:production')).toBe('other-replica')
  })

  it('without Redis still guards the process', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = withStackLock('s', 'e', () => gate.then(() => 1), null)
    expect(await withStackLock('s', 'e', async () => 2, null)).toBeNull()
    release()
    expect(await first).toBe(1)
    expect(await withStackLock('s', 'e', async () => 3, null)).toBe(3)
  })
})

describe('isDuplicateKey', () => {
  it('knows the unique-index refusals of each dialect', () => {
    expect(isDuplicateKey({ number: 2601 })).toBe(true)
    expect(isDuplicateKey({ number: 2627 })).toBe(true)
    expect(isDuplicateKey({ code: '23505' })).toBe(true)
    expect(isDuplicateKey({ errno: 1062 })).toBe(true)
    expect(isDuplicateKey({ number: 208 })).toBe(false)
    expect(isDuplicateKey(null)).toBe(false)
  })
})
