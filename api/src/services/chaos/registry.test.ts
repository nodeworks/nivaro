import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetCatalogForTests, registerFault } from './catalog.js'
import {
  _resetRegistryForTests,
  ARMED_KEY,
  armedFaults,
  armFault,
  CHAOS_CHANNEL,
  CHAOS_NODE,
  type ChaosBus,
  chaosNumber,
  chaosPoint,
  disarm,
  loadArmedFromBus,
  onRegistryChange,
  onStopAll,
  routeMatches,
  startChaosCluster,
  stopAll,
  targetMatches
} from './registry.js'

const saved = { ...process.env }

/** An in-memory stand-in for the slice of ioredis the registry uses. */
function fakeBus(opts: { down?: boolean } = {}) {
  const hash = new Map<string, string>()
  const published: unknown[] = []
  let onMessage: ((channel: string, message: string) => void) | null = null
  const fail = async () => {
    if (opts.down) throw new Error('ECONNREFUSED')
  }
  const bus: ChaosBus = {
    publish: async (_c, m) => {
      await fail()
      published.push(JSON.parse(m))
      return 1
    },
    hset: async (_k, f, v) => {
      await fail()
      hash.set(f, v)
    },
    hdel: async (_k, ...fs) => {
      await fail()
      for (const f of fs) hash.delete(f)
    },
    hgetall: async () => {
      await fail()
      return Object.fromEntries(hash)
    },
    del: async () => {
      await fail()
      hash.clear()
    },
    expire: async () => {
      await fail()
    },
    duplicate: () => ({
      subscribe: async () => 1,
      on: (_e, fn) => {
        onMessage = fn
      }
    })
  }
  return {
    bus,
    hash,
    published,
    deliver: (m: unknown) => onMessage?.(CHAOS_CHANNEL, JSON.stringify(m))
  }
}

const applied: string[] = []
const released: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _resetCatalogForTests()
  applied.length = 0
  released.length = 0
  registerFault({
    key: 'slow',
    label: 'Slow',
    proves: 'x',
    claim_keys: [],
    targets: ['all', 'route', 'share', 'user', 'node'],
    params: { delay_ms: { type: 'number', label: 'Delay', min: 100, max: 5000, default: 1500 } },
    max_seconds: 300,
    points: ['http.request']
  })
  registerFault({
    key: 'side',
    label: 'Side effect',
    proves: 'x',
    claim_keys: [],
    targets: ['all'],
    params: {},
    max_seconds: 60,
    points: ['redis.command'],
    apply(fault) {
      applied.push(fault.id)
      return () => {
        released.push(fault.id)
      }
    }
  })
})

afterEach(async () => {
  await _resetRegistryForTests()
  vi.useRealTimers()
  process.env = { ...saved }
})

describe('chaosPoint', () => {
  it('answers null for every point when nothing is armed', () => {
    expect(chaosPoint('http.request')).toBeNull()
    expect(chaosNumber('http.request', 'delay_ms')).toBe(0)
  })

  it('answers the armed fault at its point only, with capped params', async () => {
    const f = await armFault({ fault_key: 'slow', params: { delay_ms: 99_999 }, seconds: 30 })
    expect(chaosPoint('http.request')?.id).toBe(f.id)
    expect(chaosNumber('http.request', 'delay_ms')).toBe(5000)
    expect(chaosPoint('mail.send')).toBeNull()
    expect(armedFaults()).toHaveLength(1)
  })

  it('matches route patterns, shares, users and nodes', async () => {
    const route = await armFault({
      fault_key: 'slow',
      target: { kind: 'route', pattern: '/api/items/*' }
    })
    expect(chaosPoint('http.request', { route: '/api/items/articles?x=1' })?.id).toBe(route.id)
    expect(chaosPoint('http.request', { route: '/api/users' })).toBeNull()
    await disarm(route.id)

    const share = await armFault({ fault_key: 'slow', target: { kind: 'share', share_pct: 50 } })
    const hits = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].filter(
      (k) => chaosPoint('http.request', { key: k }) != null
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThan(12)
    // Stable: the same key always gets the same answer.
    expect(chaosPoint('http.request', { key: 'a' }) != null).toBe(hits.includes('a'))
    await disarm(share.id)

    const id = '11111111-2222-3333-4444-555555555555'
    const user = await armFault({ fault_key: 'slow', target: { kind: 'user', user_id: id } })
    expect(chaosPoint('http.request', { userId: id.toUpperCase() })?.id).toBe(user.id)
    expect(chaosPoint('http.request', { userId: 'someone-else' })).toBeNull()
    expect(chaosPoint('http.request')).toBeNull()
    expect(targetMatches(user, undefined)).toBe(false)
    await disarm(user.id)

    const node = await armFault({ fault_key: 'slow', target: { kind: 'node', node: CHAOS_NODE } })
    expect(chaosPoint('http.request')?.id).toBe(node.id)
    expect(chaosPoint('http.request', { node: 'other' })).toBeNull()
  })

  it('matches globs in linear time, even against a crafted URL', async () => {
    const f = await armFault({
      fault_key: 'slow',
      target: { kind: 'route', pattern: '/api/*/x*y*z' }
    })
    expect(chaosPoint('http.request', { route: '/api/items/xaybz' })?.id).toBe(f.id)
    expect(chaosPoint('http.request', { route: '/api/items/xaybz?q=1' })?.id).toBe(f.id)
    expect(chaosPoint('http.request', { route: '/api/items/xayb' })).toBeNull()
    const evil = `/api/${'x'.repeat(20_000)}`
    const t0 = Date.now()
    for (let i = 0; i < 200; i++) chaosPoint('http.request', { route: evil })
    expect(Date.now() - t0).toBeLessThan(500)
    expect(routeMatches('/api/items', '/api/items/1')).toBe(true)
    expect(routeMatches('/api/items', '/api/itemsx')).toBe(false)
    expect(routeMatches('*/end', '/a/b/end')).toBe(true)
    expect(routeMatches('/a*', '/a')).toBe(true)
    await disarm(f.id)
    await expect(
      armFault({ fault_key: 'slow', target: { kind: 'route', pattern: '/*/*/*/*/*/x' } })
    ).rejects.toThrow(/at most four/)
  })

  it('refuses unknown faults, wrong targets and the gate', async () => {
    await expect(armFault({ fault_key: 'nope' })).rejects.toThrow(/unknown fault/)
    await expect(
      armFault({ fault_key: 'side', target: { kind: 'route', pattern: '/x' } })
    ).rejects.toThrow(/cannot target route/)
    process.env.CLOUD_META_DB_URL = 'postgres://x'
    await expect(armFault({ fault_key: 'slow' })).rejects.toThrow(/cloud mode/)
  })
})

describe('time box', () => {
  it('clamps seconds to the cap and self-heals at the end, from the timer and from the check', async () => {
    const events: string[] = []
    onRegistryChange((ev) => events.push(ev.type))
    const f = await armFault({ fault_key: 'slow', seconds: 99_999 })
    expect(f.ends_at - f.started_at).toBe(300_000)
    vi.setSystemTime(Date.now() + 301_000)
    // The ends_at check answers null before the timer has fired.
    expect(chaosPoint('http.request')).toBeNull()
    expect(armedFaults()).toHaveLength(0)
    await vi.runAllTimersAsync()
    expect(events).toEqual(['armed', 'expired'])
  })

  it('runs apply when armed and the release when the window ends', async () => {
    const f = await armFault({ fault_key: 'side', seconds: 10 })
    expect(applied).toEqual([f.id])
    expect(released).toEqual([])
    await vi.advanceTimersByTimeAsync(10_001)
    expect(released).toEqual([f.id])
    expect(chaosPoint('redis.command')).toBeNull()
  })
})

describe('stop all', () => {
  it('clears locally and runs the hooks even when Redis is down', async () => {
    const { bus } = fakeBus({ down: true })
    await startChaosCluster(bus)
    const hook = vi.fn()
    onStopAll(hook)
    const a = await armFault({ fault_key: 'slow' })
    const b = await armFault({ fault_key: 'side' })
    expect(
      armedFaults()
        .map((f) => f.id)
        .sort()
    ).toEqual([a.id, b.id].sort())
    const stopped = await stopAll('test')
    expect(stopped).toHaveLength(2)
    expect(armedFaults()).toEqual([])
    expect(chaosPoint('http.request')).toBeNull()
    expect(released).toEqual([b.id])
    expect(hook).toHaveBeenCalledWith('test')
  })

  it('tells the other replicas and clears the shared key when Redis is up', async () => {
    const { bus, hash, published } = fakeBus()
    await startChaosCluster(bus)
    const f = await armFault({ fault_key: 'slow' })
    expect(hash.has(f.id)).toBe(true)
    expect(published.at(-1)).toMatchObject({ action: 'arm', node: CHAOS_NODE })
    await stopAll('done')
    expect(hash.size).toBe(0)
    expect(published.at(-1)).toMatchObject({ action: 'stop-all', reason: 'done' })
  })
})

describe('cluster', () => {
  it('arms faults another replica broadcast and drops them on its disarm / stop-all', async () => {
    const { bus, deliver } = fakeBus()
    await startChaosCluster(bus)
    const now = Date.now()
    const fault = {
      id: 'remote-1',
      fault_key: 'slow',
      label: 'Slow',
      target: { kind: 'all' },
      params: { delay_ms: 700 },
      started_at: now,
      ends_at: now + 60_000,
      started_by: null,
      started_by_name: null,
      run_id: null,
      node: 'other·node'
    }
    deliver({ node: 'other·node', action: 'arm', fault })
    await Promise.resolve()
    expect(chaosNumber('http.request', 'delay_ms')).toBe(700)
    // Own messages are ignored.
    deliver({ node: CHAOS_NODE, action: 'stop-all', reason: 'self' })
    await Promise.resolve()
    expect(chaosNumber('http.request', 'delay_ms')).toBe(700)
    deliver({ node: 'other·node', action: 'disarm', id: 'remote-1', reason: 'x' })
    await vi.runAllTimersAsync()
    expect(chaosPoint('http.request')).toBeNull()
  })

  it('picks up unexpired faults from the shared key on boot and drops expired ones', async () => {
    const { bus, hash } = fakeBus()
    const now = Date.now()
    const live = {
      id: 'live',
      fault_key: 'slow',
      label: 'Slow',
      target: { kind: 'all' },
      params: { delay_ms: 300 },
      started_at: now,
      ends_at: now + 30_000,
      started_by: null,
      started_by_name: null,
      run_id: null,
      node: 'x'
    }
    const dead = { ...live, id: 'dead', ends_at: now - 1 }
    hash.set('live', JSON.stringify(live))
    hash.set('dead', JSON.stringify(dead))
    await startChaosCluster(bus)
    expect(chaosNumber('http.request', 'delay_ms')).toBe(300)
    expect(hash.has('dead')).toBe(false)
    expect(await loadArmedFromBus()).toBe(0) // already armed: idempotent
    expect(ARMED_KEY).toBe('nvr:chaos:armed')
  })

  it('ignores broadcasts when the gate refuses here', async () => {
    const { bus, deliver } = fakeBus()
    await startChaosCluster(bus)
    process.env.CLOUD_META_DB_URL = 'x'
    deliver({
      node: 'o',
      action: 'arm',
      fault: {
        id: 'r',
        fault_key: 'slow',
        label: 'Slow',
        target: { kind: 'all' },
        params: {},
        started_at: Date.now(),
        ends_at: Date.now() + 9000,
        started_by: null,
        started_by_name: null,
        run_id: null,
        node: 'o'
      }
    })
    await Promise.resolve()
    expect(chaosPoint('http.request')).toBeNull()
  })
})
