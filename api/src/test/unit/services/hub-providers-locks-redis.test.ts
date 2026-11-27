import { describe, expect, it } from 'vitest'
import type { PromoteRedis } from '../../../services/hub/promote-lock.js'
import {
  holdResourceLocks,
  hubResourceChangeLockKey,
  hubResourceLockKey,
  RESOURCE_LOCK_TTL_MS,
  redisResourceLock
} from '../../../services/hub/providers/engine/locks.js'

// Hub providers (Task 11b): the engine's per-resource lock on its Redis path. A small fake Redis
// with a clock answers SET NX PX, EXISTS and the two fixed compare-and-act scripts, so token
// compare-and-delete, token compare-and-renew and expiry are proven without a server.

function fakeRedis() {
  let now = 0
  const store = new Map<string, { value: string; until: number }>()
  const live = (key: string) => {
    const e = store.get(key)
    if (e && e.until <= now) store.delete(key)
    return store.get(key)
  }
  let failing = false
  const redis: PromoteRedis = {
    async set(key, value, ...args) {
      if (failing) throw new Error('redis down')
      const px = Number(args[args.indexOf('PX') + 1])
      if (args.includes('NX') && live(key)) return null
      store.set(key, { value, until: now + px })
      return 'OK'
    },
    async get(key) {
      return live(key)?.value ?? null
    },
    async del(...keys) {
      for (const k of keys) store.delete(k)
      return keys.length
    },
    async exists(key) {
      if (failing) throw new Error('redis down')
      return live(key) ? 1 : 0
    },
    async eval(script, _n, key, token, ttl) {
      if (failing) throw new Error('redis down')
      const e = live(String(key))
      if (!e || e.value !== token) return 0
      if (script.includes("'pexpire'")) {
        e.until = now + Number(ttl)
        return 1
      }
      if (script.includes("'del'")) {
        store.delete(String(key))
        return 1
      }
      throw new Error('unexpected script')
    }
  }
  return {
    redis,
    store,
    advance: (ms: number) => {
      now += ms
    },
    fail: (v: boolean) => {
      failing = v
    }
  }
}

const KEY = hubResourceLockKey(5)

describe('redis resource lock', () => {
  it('takes with SET NX PX: one holder, the other gets null', async () => {
    const r = fakeRedis()
    const lock = redisResourceLock(r.redis)
    const a = await lock.take(KEY)
    expect(a).toMatch(/^hub-res:/)
    expect(await lock.take(KEY)).toBeNull()
    expect(await lock.held(KEY)).toBe(true)
  })

  it('release deletes only for the token that holds it (compare-and-delete)', async () => {
    const r = fakeRedis()
    const lock = redisResourceLock(r.redis)
    const a = (await lock.take(KEY)) as string
    await lock.release(KEY, 'hub-res:someone-else')
    expect(await lock.held(KEY)).toBe(true)
    await lock.release(KEY, a)
    expect(await lock.held(KEY)).toBe(false)
    // A stale token after another process took the key never deletes theirs.
    const b = (await lock.take(KEY)) as string
    await lock.release(KEY, a)
    expect(r.store.get(KEY)?.value).toBe(b)
  })

  it('a heartbeat renews the holder; a wrong token, or a lock that expired, is lost', async () => {
    const r = fakeRedis()
    const lock = redisResourceLock(r.redis)
    const a = (await lock.take(KEY)) as string
    r.advance(RESOURCE_LOCK_TTL_MS - 1_000)
    expect(await lock.renew(KEY, a)).toBe(true)
    r.advance(RESOURCE_LOCK_TTL_MS - 1_000)
    // Still held: the renewal moved the expiry a full TTL on.
    expect(await lock.held(KEY)).toBe(true)
    expect(await lock.renew(KEY, 'hub-res:other')).toBe(false)
    r.advance(RESOURCE_LOCK_TTL_MS + 1)
    expect(await lock.held(KEY)).toBe(false)
    expect(await lock.renew(KEY, a)).toBe(false)
    // Free again: someone else may take it.
    expect(await lock.take(KEY)).not.toBeNull()
  })

  it('a Redis error: take refuses (LOCK_UNAVAILABLE), renew counts as lost, held is unknown', async () => {
    const r = fakeRedis()
    const lock = redisResourceLock(r.redis)
    const a = (await lock.take(KEY)) as string
    r.fail(true)
    await expect(lock.take(hubResourceLockKey(6))).rejects.toMatchObject({
      code: 'LOCK_UNAVAILABLE'
    })
    expect(await lock.renew(KEY, a)).toBe(false)
    expect(await lock.held(KEY)).toBe('unknown')
    await expect(lock.release(KEY, a)).resolves.toBeUndefined()
  })
})

describe('holding the locks of a run on Redis', () => {
  it('takes the change lock and every resource lock; a busy one releases what was taken', async () => {
    const r = fakeRedis()
    const lock = redisResourceLock(r.redis)
    const other = (await lock.take(hubResourceLockKey(2))) as string
    await expect(
      holdResourceLocks(lock, [
        hubResourceChangeLockKey(9),
        hubResourceLockKey(1),
        hubResourceLockKey(2)
      ])
    ).rejects.toMatchObject({ code: 'RESOURCE_BUSY' })
    // Nothing of the failed run is kept; the other holder keeps theirs.
    expect(await lock.held(hubResourceLockKey(1))).toBe(false)
    expect(await lock.held(hubResourceChangeLockKey(9))).toBe(false)
    expect(r.store.get(hubResourceLockKey(2))?.value).toBe(other)
  })

  it('renews every key; a heartbeat past the TTL loses the hold, and release frees all', async () => {
    const r = fakeRedis()
    const lock = redisResourceLock(r.redis)
    const hold = await holdResourceLocks(lock, [hubResourceChangeLockKey(9), hubResourceLockKey(1)])
    r.advance(RESOURCE_LOCK_TTL_MS - 5_000)
    expect(await hold.renew()).toBe(true)
    r.advance(RESOURCE_LOCK_TTL_MS - 5_000)
    expect(await hold.renew()).toBe(true)
    expect(hold.lost()).toBe(false)
    await hold.release()
    expect(await lock.held(hubResourceLockKey(1))).toBe(false)

    const again = await holdResourceLocks(lock, [hubResourceLockKey(1)])
    r.advance(RESOURCE_LOCK_TTL_MS + 1)
    expect(await again.renew()).toBe(false)
    expect(again.lost()).toBe(true)
    // Lost stays lost, even if the key is free again.
    expect(await again.renew()).toBe(false)
  })
})
