import { describe, expect, it } from 'vitest'
import { buildRedisStore, REVOKED_PREFIX, revokeSessions } from '../../../auth/session.js'

// A minimal in-memory Redis that honours exactly what the store uses.
function fakeRedis() {
  const kv = new Map<string, string>()
  const api = {
    kv,
    async mget(...keys: string[]) {
      return keys.map((k) => kv.get(k) ?? null)
    },
    async eval(
      _script: string,
      _n: number,
      sessKey: string,
      revokedKey: string,
      _ttl: number,
      value: string
    ) {
      if (kv.has(revokedKey)) return 0
      kv.set(sessKey, value)
      return 1
    },
    multi() {
      const ops: Array<() => void> = []
      const m = {
        del: (k: string) => (ops.push(() => kv.delete(k)), m),
        setex: (k: string, _ttl: number, v: string) => (ops.push(() => kv.set(k, v)), m),
        exec: async () => {
          for (const op of ops) op()
          return []
        }
      }
      return m
    }
  }
  return api
}

const call = <T>(fn: (cb: (err: unknown, v?: T) => void) => void) =>
  new Promise<T | undefined>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))))

describe('session store: logout holds against the rolling save', () => {
  it('a save that lands after destroy is a no-op (the other tab cannot resurrect the session)', async () => {
    const redis = fakeRedis()
    const store = buildRedisStore(redis as never)
    const sess = { userId: 'u1', cookie: {} } as never
    await call<void>((cb) => store.set('abc', sess, cb))
    expect(redis.kv.get('sess:abc')).toContain('u1')
    // tab A logs out
    await call<void>((cb) => store.destroy('abc', cb))
    expect(redis.kv.has('sess:abc')).toBe(false)
    expect(redis.kv.has(`${REVOKED_PREFIX}abc`)).toBe(true)
    // tab B's in-flight request finishes and the rolling save fires
    await call<void>((cb) => store.set('abc', sess, cb))
    expect(redis.kv.has('sess:abc')).toBe(false)
    const got = await call<unknown>((cb) => store.get('abc', cb))
    expect(got).toBeNull()
  })

  it('a revoked id reads as no session even if a raw row somehow exists', async () => {
    const redis = fakeRedis()
    const store = buildRedisStore(redis as never)
    redis.kv.set('sess:xyz', JSON.stringify({ userId: 'u1' }))
    redis.kv.set(`${REVOKED_PREFIX}xyz`, '1')
    expect(await call<unknown>((cb) => store.get('xyz', cb))).toBeNull()
  })

  it('revokeSessions handles a list (logout-all) and leaves other ids alone', async () => {
    const redis = fakeRedis()
    redis.kv.set('sess:a', '{}')
    redis.kv.set('sess:b', '{}')
    redis.kv.set('sess:c', '{}')
    await revokeSessions(redis as never, ['a', 'b'])
    expect(redis.kv.has('sess:a')).toBe(false)
    expect(redis.kv.has('sess:b')).toBe(false)
    expect(redis.kv.has('sess:c')).toBe(true)
    expect(redis.kv.has(`${REVOKED_PREFIX}a`)).toBe(true)
    expect(redis.kv.has(`${REVOKED_PREFIX}c`)).toBe(false)
  })

  it('a fresh id is unaffected by an older revocation', async () => {
    const redis = fakeRedis()
    const store = buildRedisStore(redis as never)
    await revokeSessions(redis as never, ['old'])
    await call<void>((cb) => store.set('new', { userId: 'u1' } as never, cb))
    expect(redis.kv.has('sess:new')).toBe(true)
  })
})
