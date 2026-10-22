import { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildRedisStore, revokeSessions } from '../../auth/session.js'
import { _resetCatalogForTests } from './catalog.js'
import { chaosRedisClient, chaosRedisSubscriber } from './redis-hook.js'
import {
  dropFamily,
  keyFamily,
  redisDbIndex,
  restoreSnapshot,
  sessionLossRefusal
} from './redis-keys.js'
import { _resetRegistryForTests, armFault, CHAOS_NODE, stopAll } from './registry.js'

/**
 * Against a real Redis (#2832, #2838) — only with CHAOS_REDIS_IT=1, and never on database 0:
 * `CHAOS_REDIS_IT_URL` (default redis://localhost:6379/9). Keys are `chaos-it:*` and
 * `sess:chaos-it-*`, deleted afterwards.
 */
const URL = process.env.CHAOS_REDIS_IT_URL ?? 'redis://localhost:6379/9'
const run = process.env.CHAOS_REDIS_IT === '1'

describe.skipIf(!run)('Redis faults on a real Redis', () => {
  let redis: Redis
  let sub: Redis

  beforeAll(async () => {
    redis = new Redis(URL, { maxRetriesPerRequest: 1 })
    if (redisDbIndex(redis) === 0) throw new Error('refusing to run on Redis db 0')
    chaosRedisClient(redis)
    sub = redis.duplicate()
    chaosRedisSubscriber(sub)
    _resetCatalogForTests()
    await import('./faults/redis.js')
    await import('./faults/partition.js')
  })
  afterEach(async () => {
    await stopAll('test')
    await _resetRegistryForTests()
  })
  afterAll(async () => {
    const keys = [
      ...(await redis.keys('chaos-it:*')),
      ...(await redis.keys('sess:chaos-it-*')),
      ...(await redis.keys('sess:revoked:chaos-it-*'))
    ]
    if (keys.length) await redis.del(...keys)
    sub.disconnect()
    redis.disconnect()
  })

  it('READONLY: a write fails with the failover ReplyError, a read still answers', async () => {
    await redis.set('chaos-it:a', '1')
    await armFault({ fault_key: 'redis_readonly', seconds: 30 })
    await expect(redis.set('chaos-it:a', '2')).rejects.toMatchObject({
      name: 'ReplyError',
      message: expect.stringMatching(/^READONLY You can't write against a read only replica/)
    })
    expect(await redis.get('chaos-it:a')).toBe('1')
    // MULTI fails as a whole, like EXECABORT on a replica — nothing half-written.
    await expect(
      redis.multi().set('chaos-it:b', '1').set('chaos-it:c', '1').exec()
    ).rejects.toThrow(/EXECABORT/)
    await stopAll('test')
    expect(await redis.set('chaos-it:a', '3')).toBe('OK')
    expect(await redis.exists('chaos-it:b')).toBe(0)
  })

  it('latency: a command waits the added delay', async () => {
    await armFault({
      fault_key: 'redis_latency',
      params: { delay_ms: 120, jitter_ms: 0 },
      seconds: 30
    })
    const t = Date.now()
    await redis.get('chaos-it:a')
    expect(Date.now() - t).toBeGreaterThanOrEqual(115)
  })

  it('sign-out holds when lost session keys come back from a stale copy', async () => {
    expect(sessionLossRefusal(redisDbIndex(redis))).toBeNull()
    const store = buildRedisStore(redis)
    const put = (sid: string) =>
      new Promise<void>((res, rej) =>
        store.set(sid, { userId: sid } as never, (e) => (e ? rej(e) : res()))
      )
    const get = (sid: string) =>
      new Promise<unknown>((res, rej) => store.get(sid, (e, s) => (e ? rej(e) : res(s))))
    await put('chaos-it-a')
    await put('chaos-it-b')
    // The sessions family, narrowed to this test's own keys (the db may be shared by drills).
    const family = {
      ...keyFamily('sessions'),
      key: 'sessions',
      label: 'test',
      prefix: 'sess:chaos-it-'
    }
    const loss = await dropFamily(redis, family, 100, true)
    expect(loss.deleted).toBeGreaterThanOrEqual(2)
    expect(await get('chaos-it-a')).toBeNull()
    // Signed out during the window.
    await revokeSessions(redis, ['chaos-it-a'])
    // The window ends: the stale copy comes back.
    await restoreSnapshot(redis, loss.snapshot)
    expect(await redis.exists('sess:chaos-it-a')).toBe(1)
    expect(await get('chaos-it-a')).toBeNull()
    expect(await get('chaos-it-b')).toMatchObject({ userId: 'chaos-it-b' })
    // A rolling save of the signed-out session cannot write it back either.
    await put('chaos-it-a')
    expect(await get('chaos-it-a')).toBeNull()
  })

  it('partition: publishes from here and messages to here are cut, then flow again', async () => {
    const heard: string[] = []
    sub.on('message', (_c, m) => heard.push(m))
    await sub.subscribe('chaos-it:ch')
    const other = new Redis(URL)
    try {
      await armFault({
        fault_key: 'redis_partition',
        target: { kind: 'node', node: CHAOS_NODE },
        seconds: 30
      })
      expect(await redis.publish('chaos-it:ch', 'from-here')).toBe(0)
      await other.publish('chaos-it:ch', 'to-here')
      await new Promise((r) => setTimeout(r, 100))
      expect(heard).toEqual([])
      await stopAll('test')
      await other.publish('chaos-it:ch', 'after')
      await new Promise((r) => setTimeout(r, 100))
      expect(heard).toEqual(['after'])
    } finally {
      other.disconnect()
    }
  })
})
