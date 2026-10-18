import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  type CacheWarmDeps,
  cacheWarmAllowed,
  customQueryCacheKey,
  hitsFromParamSets,
  pickWarmTargets,
  runCacheWarm,
  takeBootWarm,
  type WarmQueryDef
} from '../../../services/cache-warm.js'

function q(slug: string, extra: Partial<WarmQueryDef> = {}): WarmQueryDef {
  return {
    id: slug,
    slug,
    enabled: true,
    access: 'authenticated',
    params: JSON.stringify([{ name: 'year', type: 'integer', default: 2026 }]),
    sql_text: `EXEC ${slug} :year`,
    cache_ttl: 300,
    warm_daily: false,
    ...extra
  }
}

function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>()
  return {
    store,
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    setex: vi.fn(async (key: string, ttl: number, value: string) => {
      store.set(key, { value, ttl })
      return 'OK'
    }),
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
      if (store.has(key)) return null
      store.set(key, { value, ttl: -1 })
      return 'OK'
    })
  }
}

// The route's builder: declared params with defaults, typed.
function buildFinalParams(defs: never, incoming: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const d of defs as Array<{ name: string; default?: unknown; required?: boolean }>) {
    const v = Object.hasOwn(incoming, d.name) ? incoming[d.name] : d.default
    if (v == null && d.required) throw new Error(`Missing required parameter: ${d.name}`)
    out[d.name] = v == null ? null : Number(v)
  }
  return out
}

function deps(over: Partial<CacheWarmDeps> = {}): Partial<CacheWarmDeps> {
  return {
    loadQueries: async () => [q('a'), q('b')],
    loadHits: async () => ({
      hits: new Map([
        ['a', 5],
        ['b', 2]
      ]),
      ownerLoad: 0
    }),
    loadParamSets: async () => [],
    buildFinalParams: buildFinalParams as never,
    exec: vi.fn(async () => [{ n: 1 }]),
    ownerLoad: vi.fn(async () => ({})),
    ...over
  }
}

describe('pickWarmTargets', () => {
  it('ranks used slugs, caps them, and always adds warm_daily queries', () => {
    const queries = [
      q('low'),
      q('top'),
      q('mid'),
      q('daily', { warm_daily: true }),
      q('off', { enabled: false }),
      q('weird', { access: 'nobody' })
    ]
    const hits = new Map([
      ['low', 1],
      ['top', 50],
      ['mid', 10],
      ['off', 99],
      ['weird', 99]
    ])
    const t = pickWarmTargets({ queries, hits, paramSets: [], cap: 2 })
    expect(t.map((x) => x.slug)).toEqual(['daily', 'top', 'mid'])
    expect(t.every((x) => x.kind === 'default')).toBe(true)
  })

  it('adds the top param sets per slug after every default, skipping empty and masked sets', () => {
    const paramSets = [
      { target: 'a', params: '{"year":2024}', seen_count: 3 },
      { target: 'a', params: '{"year":2025}', seen_count: 9 },
      { target: 'a', params: '{}', seen_count: 50 },
      { target: 'a', params: '{"token":"••••••"}', seen_count: 40 },
      { target: 'a', params: '{"year":2023}', seen_count: 2 },
      { target: 'a', params: '{"year":2022}', seen_count: 1 },
      { target: 'b', params: '{"year":2020}', seen_count: 1 }
    ]
    const t = pickWarmTargets({
      queries: [q('a'), q('b')],
      hits: new Map([
        ['a', 2],
        ['b', 1]
      ]),
      paramSets
    })
    expect(t.map((x) => `${x.slug}:${JSON.stringify(x.incoming)}`)).toEqual([
      'a:{}',
      'b:{}',
      'a:{"year":2025}',
      'a:{"year":2024}',
      'a:{"year":2023}',
      'b:{"year":2020}'
    ])
  })

  it('only=warm_daily ignores usage', () => {
    const t = pickWarmTargets({
      queries: [q('a'), q('d', { warm_daily: 1 })],
      hits: new Map([['a', 9]]),
      paramSets: [],
      only: 'warm_daily'
    })
    expect(t.map((x) => x.slug)).toEqual(['d'])
  })

  it('falls back to recorded param-set counts inside the window', () => {
    const since = new Date('2026-10-10T00:00:00Z')
    const hits = hitsFromParamSets(
      [
        { target: 'a', params: '{}', seen_count: 4, last_seen: '2026-10-15T00:00:00Z' },
        { target: 'a', params: '{"x":1}', seen_count: 3, last_seen: '2026-10-16T00:00:00Z' },
        { target: 'b', params: '{}', seen_count: 99, last_seen: '2026-09-01T00:00:00Z' }
      ],
      since
    )
    expect(hits.get('a')).toBe(7)
    expect(hits.has('b')).toBe(false)
  })
})

describe('runCacheWarm', () => {
  it('writes the route key in the {cached_at, rows} shape with the query TTL', async () => {
    const redis = fakeRedis()
    const s = await runCacheWarm({ redis, deps: deps() })
    const key = customQueryCacheKey('a', { year: 2026 })
    expect(key).toBe('cq:a:{"year":2026}')
    const entry = redis.store.get(key)
    expect(entry?.ttl).toBe(300)
    const parsed = JSON.parse(entry?.value ?? 'null')
    expect(Object.keys(parsed).sort()).toEqual(['cached_at', 'rows'])
    expect(parsed.rows).toEqual([{ n: 1 }])
    expect(Number.isNaN(Date.parse(parsed.cached_at))).toBe(false)
    expect(s).toMatchObject({ warmed: 2, cached: 2, failed: 0, budgetSpent: false })
  })

  it('runs a cache_ttl 0 query but writes nothing', async () => {
    const redis = fakeRedis()
    const exec = vi.fn(async () => [{ n: 1 }])
    const s = await runCacheWarm({
      redis,
      deps: deps({ loadQueries: async () => [q('a', { cache_ttl: 0 })], exec })
    })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(redis.setex).not.toHaveBeenCalled()
    expect(s).toMatchObject({ warmed: 1, cached: 0 })
  })

  it('skips a key that is still cached and a set that lands on the same key', async () => {
    const redis = fakeRedis()
    redis.store.set('cq:a:{"year":2026}', { value: '{}', ttl: 10 })
    const exec = vi.fn(async () => [])
    const s = await runCacheWarm({
      redis,
      deps: deps({
        loadParamSets: async () => [{ target: 'b', params: '{"year":2026}', seen_count: 5 }],
        exec
      })
    })
    // a: cached already; b default; b's set is the default key again.
    expect(exec).toHaveBeenCalledTimes(1)
    expect(s).toMatchObject({ warmed: 1, skipped: 2 })
  })

  it('stops starting work once the budget is spent', async () => {
    let clock = 0
    const exec = vi.fn(async () => {
      clock += 1000
      return []
    })
    const s = await runCacheWarm({
      redis: fakeRedis(),
      budgetMs: 1500,
      concurrency: 1,
      deps: deps({
        loadQueries: async () => [q('a'), q('b'), q('c')],
        loadHits: async () => ({
          hits: new Map([
            ['a', 3],
            ['b', 2],
            ['c', 1]
          ]),
          ownerLoad: 4
        }),
        exec,
        now: () => clock
      })
    })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(s.budgetSpent).toBe(true)
    expect(s.warmed).toBe(2)
    // c + the owner-load read never started.
    expect(s.skipped).toBe(2)
  })

  it('counts a failing query and carries on; runs owner-load when it was used', async () => {
    const ownerLoad = vi.fn(async () => ({}))
    const exec = vi.fn(async (sql: string) => {
      if (sql.includes(' a ')) throw new Error('boom')
      return []
    })
    const s = await runCacheWarm({
      redis: null,
      deps: deps({
        exec,
        ownerLoad,
        loadHits: async () => ({
          hits: new Map([
            ['a', 1],
            ['b', 1]
          ]),
          ownerLoad: 3
        })
      })
    })
    expect(s).toMatchObject({ failed: 1, warmed: 2, cached: 0 })
    expect(ownerLoad).toHaveBeenCalledTimes(1)
  })

  it('skips a default set whose required param has no default', async () => {
    const exec = vi.fn(async () => [])
    const s = await runCacheWarm({
      redis: fakeRedis(),
      deps: deps({
        loadQueries: async () => [
          q('a', { params: JSON.stringify([{ name: 'id', type: 'integer', required: true }]) })
        ],
        loadHits: async () => ({ hits: new Map([['a', 1]]), ownerLoad: 0 }),
        exec
      })
    })
    expect(exec).not.toHaveBeenCalled()
    expect(s.skipped).toBe(1)
  })
})

describe('gates', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
  })

  it('CACHE_WARM=off disables even where crons tick', () => {
    process.env.CRON_TICKS = 'on'
    process.env.CACHE_WARM = 'off'
    expect(cacheWarmAllowed()).toBe(false)
  })

  it('unset follows cronTicksEnabled (development never warms)', () => {
    delete process.env.CACHE_WARM
    delete process.env.CRON_TICKS
    process.env.NODE_ENV = 'development'
    expect(cacheWarmAllowed()).toBe(false)
    process.env.NODE_ENV = 'production'
    expect(cacheWarmAllowed()).toBe(true)
  })

  it('CACHE_WARM=on overrides a non-ticking process', () => {
    process.env.CRON_TICKS = 'off'
    process.env.CACHE_WARM = 'on'
    expect(cacheWarmAllowed()).toBe(true)
  })

  it('the boot warm is taken once per version', async () => {
    const redis = fakeRedis()
    expect(await takeBootWarm(redis as never, '0.2.52', 'a')).toBe(true)
    expect(await takeBootWarm(redis as never, '0.2.52', 'b')).toBe(false)
    expect(await takeBootWarm(redis as never, '0.2.53', 'b')).toBe(true)
    expect(redis.set).toHaveBeenCalledWith('nvr:warm:0.2.52', 'a', 'EX', 14400, 'NX')
  })
})
