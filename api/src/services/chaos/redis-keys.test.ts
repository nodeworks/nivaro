import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { _resetCatalogForTests } from './catalog.js'
import {
  dropFamily,
  evictShare,
  type KeyClient,
  keyFamily,
  redisDbIndex,
  restoreSnapshot,
  scanPrefix,
  sessionLossRefusal
} from './redis-keys.js'
import { _resetRegistryForTests, armFault, onRegistryChange, stopAll } from './registry.js'

/** An in-memory Redis with the calls the key drills use. */
function fakeKeys(entries: Record<string, string>, db = 9) {
  const store = new Map<string, { v: string; ttl: number }>(
    Object.entries(entries).map(([k, v]) => [k, { v, ttl: 60_000 }])
  )
  const glob = (p: string) =>
    new RegExp(
      `^${p
        .replace(/\\(.)/g, '$1')
        .replace(/[.+^${}()|]/g, '\\$&')
        .replace(/\*/g, '.*')}$`
    )
  const client: KeyClient & { options: { db: number }; store: typeof store } = {
    options: { db },
    store,
    async scan(_cursor, _m, pattern) {
      const re = glob(String(pattern))
      return ['0', [...store.keys()].filter((k) => re.test(k))]
    },
    async dumpBuffer(key) {
      const e = store.get(key)
      return e ? Buffer.from(e.v) : null
    },
    async pttl(key) {
      return store.get(key)?.ttl ?? -2
    },
    async unlink(...keys) {
      let n = 0
      for (const k of keys) if (store.delete(k)) n++
      return n
    },
    async restore(key, ttl, value) {
      if (store.has(key)) throw new Error('BUSYKEY Target key name already exists.')
      store.set(key, { v: value.toString(), ttl })
      return 'OK'
    }
  }
  return client
}

describe('key families (#2832)', () => {
  it('never touch nvr:chaos:* and stop at the cap', async () => {
    const c = fakeKeys({ 'nvr:chaos:armed': 'x', 'nvr:a': '1', 'nvr:b': '2', 'nvr:c': '3' })
    expect(await scanPrefix(c, 'nvr:', 10)).toEqual(['nvr:a', 'nvr:b', 'nvr:c'])
    expect(await scanPrefix(c, 'nvr:', 2)).toHaveLength(2)
  })

  it('loss keeps a snapshot; restore brings back only what was not rewritten', async () => {
    const c = fakeKeys({ 'cq:1': 'old1', 'cq:2': 'old2', 'sess:x': 's' })
    const fam = keyFamily('query_cache')
    if (!fam) throw new Error('family')
    const loss = await dropFamily(c, fam, 100, true)
    expect(loss.deleted).toBe(2)
    expect(c.store.has('sess:x')).toBe(true)
    c.store.set('cq:2', { v: 'new', ttl: 1 })
    expect(await restoreSnapshot(c, loss.snapshot)).toBe(1)
    expect(c.store.get('cq:1')?.v).toBe('old1')
    expect(c.store.get('cq:2')?.v).toBe('new')
  })

  it('sessions are refused on db 0 of a development Redis', () => {
    expect(sessionLossRefusal(0, { NODE_ENV: 'development' })).toMatch(/other than 0/)
    expect(sessionLossRefusal(0, { NODE_ENV: 'development', REDIS_CHANNEL_PREFIX: 'x:' })).toMatch(
      /other than 0/
    )
    expect(
      sessionLossRefusal(0, { NODE_ENV: 'production', REDIS_CHANNEL_PREFIX: 'stg:' })
    ).toBeNull()
    expect(sessionLossRefusal(9, { NODE_ENV: 'development' })).toBeNull()
    expect(redisDbIndex({ options: { db: 9 } })).toBe(9)
    expect(redisDbIndex(null)).toBe(0)
  })

  it('eviction drops a stable share of nvr:* keys', async () => {
    const keys: Record<string, string> = {}
    for (let i = 0; i < 400; i++) keys[`nvr:k${i}`] = '1'
    const c = fakeKeys(keys)
    const n = await evictShare(c, 25, 1000, 'seed')
    expect(n).toBeGreaterThan(60)
    expect(n).toBeLessThan(140)
    expect(c.store.size).toBe(400 - n)
  })
})

describe('key-loss and eviction drills (#2832)', () => {
  const notes: string[] = []
  beforeAll(async () => {
    _resetCatalogForTests()
    await import('./faults/redis.js')
  })
  afterEach(async () => {
    vi.useRealTimers()
    await stopAll('test')
    await _resetRegistryForTests()
    notes.length = 0
  })

  it('unarmed nothing is deleted; armed the family goes; the window end brings it back', async () => {
    vi.useFakeTimers()
    const { setChaosApp } = await import('./registry.js')
    const c = fakeKeys({ 'cq:1': 'a', 'cq:2': 'b', 'nvr:x': 'keep' })
    setChaosApp({ redis: c })
    expect(c.store.size).toBe(3)
    await armFault({ fault_key: 'redis_key_loss', params: { family: 'query_cache' }, seconds: 10 })
    expect(c.store.has('cq:1')).toBe(false)
    expect(c.store.has('nvr:x')).toBe(true)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(c.store.get('cq:1')?.v).toBe('a')
  })

  it('Stop all restores at once', async () => {
    const { setChaosApp } = await import('./registry.js')
    const c = fakeKeys({ 'nvr:cron:leader': 'me' })
    setChaosApp({ redis: c })
    await armFault({ fault_key: 'redis_key_loss', params: { family: 'cron_lease' }, seconds: 60 })
    expect(c.store.size).toBe(0)
    await stopAll('test')
    expect(c.store.get('nvr:cron:leader')?.v).toBe('me')
  })

  it('the sessions family is refused on db 0, and says why', async () => {
    const { setChaosApp } = await import('./registry.js')
    const c = fakeKeys({ 'sess:a': '1' }, 0)
    setChaosApp({ redis: c })
    const off = onRegistryChange((ev) => {
      if (ev.type === 'disarmed') notes.push(ev.reason)
    })
    const saved = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      await armFault({ fault_key: 'redis_key_loss', params: { family: 'sessions' }, seconds: 10 })
    } finally {
      process.env.NODE_ENV = saved
      off()
    }
    expect(c.store.has('sess:a')).toBe(true)
    expect(notes[0]).toMatch(/apply failed: Sessions are dropped only/)
  })

  it('eviction sweeps on its interval and stops with the window', async () => {
    vi.useFakeTimers()
    const { setChaosApp } = await import('./registry.js')
    const keys: Record<string, string> = {}
    for (let i = 0; i < 200; i++) keys[`nvr:k${i}`] = '1'
    const c = fakeKeys(keys)
    setChaosApp({ redis: c })
    await armFault({
      fault_key: 'redis_evict',
      params: { share_pct: 50, interval_s: 2, max_keys: 5000 },
      seconds: 5
    })
    await vi.advanceTimersByTimeAsync(10)
    const afterFirst = c.store.size
    expect(afterFirst).toBeLessThan(200)
    await vi.advanceTimersByTimeAsync(2000)
    expect(c.store.size).toBeLessThan(afterFirst)
    await vi.advanceTimersByTimeAsync(3100)
    const atEnd = c.store.size
    await vi.advanceTimersByTimeAsync(10_000)
    expect(c.store.size).toBe(atEnd)
  })
})

describe('Redis drill samplers (#2832)', () => {
  it('hit rate is measured between samples, null when nothing was looked up', async () => {
    const { hitPctBetween } = await import('./redis-samplers.js')
    expect(hitPctBetween(null, { hits: 9, misses: 1 })).toBe(90)
    expect(hitPctBetween({ hits: 9, misses: 1 }, { hits: 10, misses: 4 })).toBe(25)
    expect(hitPctBetween({ hits: 9, misses: 1 }, { hits: 9, misses: 1 })).toBeNull()
  })

  it('the Redis faults file registers both samplers', async () => {
    const { listSamplers } = await import('./steady-state.js')
    const keys = listSamplers().map((s) => s.key)
    expect(keys).toEqual(expect.arrayContaining(['redis.errors_per_min', 'cache.metadata_hit_pct']))
  })
})
