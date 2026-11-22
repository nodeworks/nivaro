import { describe, expect, it } from 'vitest'
import {
  type PromoteRedis,
  PromotionError,
  redisPromoteLock,
  sharedLock
} from '../../../services/hub/promote-lock.js'

// Nivaro Hub phase 6, Task 15 round 2: a lock holder read that fails is never "free". Both the
// environment lock and the shared lock answer a Redis error on holder() with LOCK_UNAVAILABLE
// (503) instead of null (which every caller reads as "nobody holds it").

/** A Redis that has the key (SET NX misses) but cannot be read. */
const down: PromoteRedis = {
  set: async () => null,
  get: async () => {
    throw new Error('ECONNREFUSED')
  },
  del: async () => 0,
  exists: async () => {
    throw new Error('ECONNREFUSED')
  },
  eval: async () => 0
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a throw')
}

describe('lock holder reads fail closed', () => {
  it('the environment lock: a Redis error on holder() is LOCK_UNAVAILABLE (503), never null', async () => {
    const err = await thrown(redisPromoteLock(down).holder?.(3) ?? Promise.resolve())
    expect(err).toBeInstanceOf(PromotionError)
    expect(err).toMatchObject({ code: 'LOCK_UNAVAILABLE', status: 503 })
  })

  it('the shared lock: a Redis error on holder() is LOCK_UNAVAILABLE (503), never null', async () => {
    const err = await thrown(sharedLock(down).holder(3))
    expect(err).toBeInstanceOf(PromotionError)
    expect(err).toMatchObject({ code: 'LOCK_UNAVAILABLE', status: 503 })
  })

  it('a readable empty lock is still null', async () => {
    const empty: PromoteRedis = { ...down, get: async () => null }
    expect(await redisPromoteLock(empty).holder?.(3)).toBeNull()
    expect(await sharedLock(empty).holder(3)).toBeNull()
  })
})
