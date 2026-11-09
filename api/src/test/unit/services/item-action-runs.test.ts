import { describe, expect, it } from 'vitest'
import {
  claimItemActionRun,
  itemActionRunKey,
  releaseItemActionRun
} from '../../../services/item-action-runs.js'

function fakeRedis() {
  const keys = new Map<string, string>()
  return {
    keys,
    async set(k: string, v: string) {
      if (keys.has(k)) return null
      keys.set(k, v)
      return 'OK'
    },
    async del(k: string) {
      return keys.delete(k) ? 1 : 0
    }
  }
}

describe('item action runs', () => {
  it('refuses a second run on the same record until the first ends', async () => {
    const redis = fakeRedis()
    const key = itemActionRunKey('push-to-fusion', 'workflows', 371201)
    expect(await claimItemActionRun(key, redis, 'a')).toBe(true)
    expect(await claimItemActionRun(key, redis, 'b')).toBe(false)
    expect(
      await claimItemActionRun(itemActionRunKey('push-to-fusion', 'workflows', 2), redis, 'c')
    ).toBe(true)
    await releaseItemActionRun(key, redis)
    expect(await claimItemActionRun(key, redis, 'd')).toBe(true)
  })

  it('another replica holding it (Redis only) also refuses', async () => {
    const redis = fakeRedis()
    const key = itemActionRunKey('x', 'c', 1)
    redis.keys.set(key, 'other')
    expect(await claimItemActionRun(key, redis, 'me')).toBe(false)
    expect(await claimItemActionRun(key, null, 'me')).toBe(true)
  })
})
