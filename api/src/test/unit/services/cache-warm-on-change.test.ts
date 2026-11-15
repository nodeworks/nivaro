import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  planChangeWarmTarget,
  selectChangeWarmTargets,
  UNRESTRICTED_WARM_VIEWER,
  type WarmQueryDef
} from '../../../services/cache-warm.js'
import {
  CHANGE_WARM_COOLDOWN_MS,
  CHANGE_WARM_DEBOUNCE_MS,
  type ChangeWarmDeps,
  type ChangeWarmPlan,
  type ChangeWarmRedis,
  ChangeWarmScheduler,
  groupUnits,
  indexReads,
  noticeChangesData,
  STATS_PREFIX,
  statsBucket,
  sumStats
} from '../../../services/cache-warm-on-change.js'
import type {
  ViewerQueryDef,
  ViewerTarget,
  ViewerWarmSummary,
  WarmViewer
} from '../../../services/cache-warm-viewers.js'
import {
  customQueryCacheKey,
  customQueryStaleKey,
  hitFreshness,
  parseCustomQueryStaleMark,
  withStaleMark
} from '../../../services/custom-query-cache.js'
import { buildFinalParams } from '../../../services/custom-query-exec.js'

// ─── fakes ──────────────────────────────────────────────────────────────────

function fakeRedis(clock: { now: number }) {
  const kv = new Map<string, { v: string; exp: number | null }>()
  const hashes = new Map<string, Record<string, string>>()
  const live = (k: string) => {
    const e = kv.get(k)
    if (!e) return null
    if (e.exp != null && e.exp <= clock.now) {
      kv.delete(k)
      return null
    }
    return e
  }
  const r: ChangeWarmRedis & { kv: typeof kv; hashes: typeof hashes } = {
    kv,
    hashes,
    async get(k) {
      return live(k)?.v ?? null
    },
    async set(k, v, ...args) {
      const a = args.map((x) => String(x).toUpperCase())
      if (a.includes('NX') && live(k)) return null
      let exp: number | null = null
      const px = a.indexOf('PX')
      const ex = a.indexOf('EX')
      if (px >= 0) exp = clock.now + Number(args[px + 1])
      if (ex >= 0) exp = clock.now + Number(args[ex + 1]) * 1000
      kv.set(k, { v, exp })
      return 'OK'
    },
    async setex(k, s, v) {
      kv.set(k, { v, exp: clock.now + s * 1000 })
      return 'OK'
    },
    async del(...keys) {
      let n = 0
      for (const k of keys) if (kv.delete(k)) n++
      return n
    },
    async pttl(k) {
      const e = live(k)
      if (!e) return -2
      return e.exp == null ? -1 : e.exp - clock.now
    },
    async hincrby(k, f, n) {
      const h = hashes.get(k) ?? {}
      h[f] = String((Number(h[f]) || 0) + n)
      hashes.set(k, h)
      return Number(h[f])
    },
    async hset(k, f, v) {
      const h = hashes.get(k) ?? {}
      h[f] = String(v)
      hashes.set(k, h)
      return 1
    },
    async expire() {
      return 1
    },
    async hgetall(k) {
      return hashes.get(k) ?? {}
    }
  }
  return r
}

const viewer = (id: string, signature = ''): WarmViewer => ({ id, isAdmin: false, signature })

function target(over: Partial<ViewerTarget>): ViewerTarget {
  return {
    surface: 'widget',
    slug: 'spend',
    widgetId: '7',
    params: {},
    kind: 'default',
    as: viewer('u1'),
    groupHits: 10,
    members: 1,
    seen: 0,
    ...over
  }
}

function summary(over: Partial<ViewerWarmSummary> = {}): ViewerWarmSummary {
  return {
    warmed: 1,
    joined: 0,
    skipped: 0,
    failed: 0,
    cached: 1,
    targets: 1,
    budgetSpent: false,
    signatures: 1,
    ...over
  }
}

function harness(plan: ChangeWarmPlan, opts: { enabled?: boolean } = {}) {
  const clock = { now: 1_000_000 }
  const redis = fakeRedis(clock)
  const timers: Array<{ fn: () => void; at: number }> = []
  const runs: Array<{ units: string[]; changedAt: number; at: number }> = []
  let builds = 0
  const deps: ChangeWarmDeps = {
    now: () => clock.now,
    enabled: () => opts.enabled ?? true,
    buildPlan: async () => {
      builds++
      return { ...plan, built_at: clock.now }
    },
    loadQueries: async () => [],
    runUnit: async (targets, _q, o) => {
      runs.push({
        units: [...new Set(targets.map((t) => t.widgetId ?? t.slug))],
        changedAt: o.changedAt,
        at: clock.now
      })
      return summary({ warmed: targets.length, cached: targets.length })
    },
    setTimer: (fn, ms) => {
      const t = { fn, at: clock.now + ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    }
  }
  const s = new ChangeWarmScheduler(redis, deps)
  /** Advance the clock, firing due timers (and what they arm) in order. */
  const advance = async (ms: number) => {
    const end = clock.now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      clock.now = Math.max(clock.now, t.at)
      t.fn()
      // Let the async flush / pump finish.
      for (let i = 0; i < 50; i++) await Promise.resolve()
      await new Promise((r) => setImmediate(r))
    }
    clock.now = end
  }
  return { s, clock, redis, runs, advance, builds: () => builds, timers }
}

const PLAN: ChangeWarmPlan = {
  built_at: 0,
  units: groupUnits([
    target({ widgetId: '7', slug: 'spend', groupHits: 50 }),
    target({ widgetId: '7', slug: 'spend', groupHits: 20, as: viewer('u2', 'region=["N"]') }),
    target({ surface: 'query', widgetId: undefined, slug: 'spend', groupHits: 40 }),
    target({ widgetId: '9', slug: 'stock', groupHits: 5 })
  ]),
  reads: indexReads([
    { slug: 'spend', tables: ['Invoices', 'workflows'] },
    { slug: 'stock', tables: ['inventory_items'] }
  ])
}

// ─── pure parts ─────────────────────────────────────────────────────────────

describe('noticeChangesData', () => {
  it('counts writes, raw writes, imports and pipeline moves, never system tables or other aspects', () => {
    expect(noticeChangesData({ collection: 'invoices', item: 1, action: 'update' })).toBe(true)
    expect(noticeChangesData({ collection: 'invoices', item: '*', source: 'raw' })).toBe(true)
    expect(noticeChangesData({ collection: 'wf', item: 2, changed_fields: ['$state'] })).toBe(true)
    expect(noticeChangesData({ collection: 'wf', item: 2, changed_fields: ['$comments'] })).toBe(
      false
    )
    expect(noticeChangesData({ collection: 'nivaro_activity', item: 1, action: 'create' })).toBe(
      false
    )
    expect(noticeChangesData({ collection: 'directus_files', item: 1, action: 'create' })).toBe(
      false
    )
  })
})

describe('groupUnits / indexReads', () => {
  it('groups a widget’s signatures into one unit, most used first, capped per unit', () => {
    const units = groupUnits(
      [
        target({ widgetId: '7', groupHits: 50 }),
        target({ widgetId: '7', groupHits: 30, as: viewer('u2', 'a') }),
        target({ widgetId: '7', groupHits: 20, as: viewer('u3', 'b') }),
        target({ surface: 'query', widgetId: undefined, slug: 'other', groupHits: 60 })
      ],
      2
    )
    expect(units.map((u) => u.unit)).toEqual(['q:other', 'w:7'])
    expect(units[1].targets.map((t) => t.as.id)).toEqual(['u1', 'u2'])
  })

  it('leaves out what nobody opened (a Warm daily query with no views)', () => {
    const units = groupUnits([
      target({ surface: 'query', widgetId: undefined, slug: 'daily-only', groupHits: 0 }),
      target({ widgetId: '7', groupHits: 3 })
    ])
    expect(units.map((u) => u.unit)).toEqual(['w:7'])
  })

  it('indexes collections case-insensitively', () => {
    expect(PLAN.reads.invoices).toEqual(['spend'])
    expect(PLAN.reads.workflows).toEqual(['spend'])
  })
})

describe('sumStats', () => {
  it('adds the hourly buckets and ranks queries', () => {
    const s = sumStats([
      { changes: '3', warmed: '2', 'q:spend': '2', last_at: '1000' },
      null,
      { changes: '1', warmed: '5', 'q:stock': '5', failed: '1', last_at: '5000' }
    ])
    expect(s.changes).toBe(4)
    expect(s.warmed).toBe(7)
    expect(s.failed).toBe(1)
    expect(s.by_query).toEqual([
      { slug: 'stock', warmed: 5 },
      { slug: 'spend', warmed: 2 }
    ])
    expect(s.last_at).toBe(new Date(5000).toISOString())
  })
})

describe('stale marks', () => {
  it('fold into a hit’s freshness and name the collection', () => {
    const mark = parseCustomQueryStaleMark(
      JSON.stringify({ at: '2026-11-14T10:05:00.000Z', c: 'invoices' })
    )
    const f = withStaleMark(
      { data_changed_at: '2026-11-14T09:00:00.000Z', sources: [] },
      mark,
      '2026-11-14T10:00:00.000Z'
    )
    expect(f.stale).toBe(true)
    expect(f.data_changed_at).toBe('2026-11-14T10:05:00.000Z')
    expect(f.freshness_sources).toEqual([
      { table: 'invoices', column: '', changed_at: '2026-11-14T10:05:00.000Z' }
    ])
  })

  it('an entry computed after the change is not stale', () => {
    const f = withStaleMark(
      null,
      { at: '2026-11-14T10:05:00.000Z', collection: 'invoices' },
      '2026-11-14T10:06:00.000Z'
    )
    expect(f.stale).toBe(false)
  })

  it('no mark leaves the probe’s answer alone; a Redis failure reads as no mark', async () => {
    const fresh = {
      data_changed_at: '2026-11-14T10:05:00.000Z',
      sources: [{ table: 't', column: 'updated_at', changed_at: '2026-11-14T10:05:00.000Z' }]
    }
    const f = await hitFreshness(
      { get: async () => Promise.reject(new Error('down')) },
      'spend',
      fresh,
      '2026-11-14T10:00:00.000Z'
    )
    expect(f).toEqual({
      data_changed_at: fresh.data_changed_at,
      freshness_sources: fresh.sources,
      stale: true
    })
  })
})

// ─── the scheduler ──────────────────────────────────────────────────────────

describe('ChangeWarmScheduler', () => {
  it('coalesces a burst into one flush, marks the queries that read it and warms their units', async () => {
    const h = harness(PLAN)
    for (let i = 0; i < 500; i++)
      h.s.note({ collection: 'invoices', item: i, action: 'create', source: 'import' })
    expect(h.timers.length).toBe(1)
    await h.advance(CHANGE_WARM_DEBOUNCE_MS)
    // Stale mark on the query that reads invoices — not on the one that does not.
    const mark = parseCustomQueryStaleMark(await h.redis.get(customQueryStaleKey('spend')))
    expect(mark?.collection).toBe('invoices')
    expect(await h.redis.get(customQueryStaleKey('stock'))).toBeNull()
    // Both units of `spend` (widget 7, the execute entries) ran once; `stock` never.
    expect(h.runs.map((r) => r.units[0]).sort()).toEqual(['7', 'spend'])
    expect(h.runs.every((r) => r.changedAt <= h.clock.now)).toBe(true)
    const stats = await h.redis.hgetall(`${STATS_PREFIX}${statsBucket(h.clock.now)}`)
    expect(Number(stats.changes)).toBe(500)
    expect(Number(stats.flushes)).toBe(1)
    expect(Number(stats.recomputes)).toBe(2)
    expect(Number(stats['q:spend'])).toBe(3)
  })

  it('runs a unit at most once per cooldown and catches the last change on the trailing edge', async () => {
    const h = harness(PLAN)
    h.s.note({ collection: 'invoices', item: 1, action: 'update' })
    await h.advance(CHANGE_WARM_DEBOUNCE_MS)
    expect(h.runs.length).toBe(2)
    const firstAt = h.runs[0].at
    // More changes inside the cooldown: nothing runs yet.
    await h.advance(30_000)
    h.s.note({ collection: 'invoices', item: 2, action: 'update' })
    await h.advance(CHANGE_WARM_DEBOUNCE_MS)
    const lastChange = h.clock.now
    h.s.note({ collection: 'workflows', item: 3, changed_fields: ['$state'] })
    await h.advance(CHANGE_WARM_DEBOUNCE_MS)
    expect(h.runs.length).toBe(2)
    // When the cooldown ends, each unit runs once more, carrying the newest change.
    await h.advance(CHANGE_WARM_COOLDOWN_MS)
    expect(h.runs.length).toBe(4)
    for (const r of h.runs.slice(2)) {
      expect(r.at - firstAt).toBeGreaterThanOrEqual(CHANGE_WARM_COOLDOWN_MS)
      expect(r.changedAt).toBe(lastChange)
    }
    const stats = await h.redis.hgetall(`${STATS_PREFIX}${statsBucket(h.clock.now)}`)
    expect(Number(stats.deferred)).toBe(2)
  })

  it('another replica’s cooldown holds this replica back too', async () => {
    const h = harness(PLAN)
    await h.redis.set('nvr:warm:chg:cd:w:7', 'other', 'PX', 60_000)
    h.s.note({ collection: 'invoices', item: 1, action: 'update' })
    await h.advance(CHANGE_WARM_DEBOUNCE_MS)
    expect(h.runs.map((r) => r.units[0])).toEqual(['spend'])
    await h.advance(60_000)
    expect(h.runs.map((r) => r.units[0])).toEqual(['spend', '7'])
  })

  it('builds the plan once and shares it through Redis', async () => {
    const h = harness(PLAN)
    h.s.note({ collection: 'invoices', item: 1, action: 'update' })
    await h.advance(CHANGE_WARM_DEBOUNCE_MS)
    expect(h.builds()).toBe(1)
    expect(await h.redis.get('nvr:warm:chg:plan')).toContain('"reads"')
    // A second process reads the shared plan instead of scanning the log again.
    let builds2 = 0
    const s2 = new ChangeWarmScheduler(h.redis, {
      now: () => h.clock.now,
      enabled: () => true,
      buildPlan: async () => {
        builds2++
        return PLAN
      },
      loadQueries: async () => [],
      runUnit: async () => summary(),
      setTimer: () => null,
      clearTimer: () => undefined
    })
    expect((await s2.getPlan())?.units.length).toBe(PLAN.units.length)
    expect(builds2).toBe(0)
  })

  it('keeps the changes and retries while another replica builds the plan', async () => {
    const h = harness(PLAN)
    await h.redis.set('nvr:warm:chg:plan:lock', 'other', 'EX', 300)
    h.s.note({ collection: 'invoices', item: 1, action: 'update' })
    await h.advance(CHANGE_WARM_DEBOUNCE_MS)
    expect(h.runs.length).toBe(0)
    expect(h.s.snapshot().dirty).toEqual(['invoices'])
    await h.redis.del('nvr:warm:chg:plan:lock')
    await h.advance(15_000)
    expect(h.runs.length).toBe(2)
  })

  it('does nothing while switched off, and ignores system tables', async () => {
    const off = harness(PLAN, { enabled: false })
    off.s.note({ collection: 'invoices', item: 1, action: 'update' })
    await off.advance(60_000)
    expect(off.runs.length).toBe(0)
    expect(off.timers.length).toBe(0)
    const on = harness(PLAN)
    on.s.note({ collection: 'nivaro_activity', item: 1, action: 'create' })
    expect(on.timers.length).toBe(0)
  })
})

// ─── targets: one list for the viewer runner ────────────────────────────────

function wq(slug: string, extra: Partial<WarmQueryDef> = {}): WarmQueryDef {
  return {
    id: slug,
    slug,
    enabled: true,
    access: 'authenticated',
    params: JSON.stringify([{ name: 'year', default: '2026' }]),
    sql_text: `SELECT * FROM t_${slug} WHERE y = :year`,
    cache_ttl: 600,
    ...extra
  }
}

describe('selectChangeWarmTargets / planChangeWarmTarget', () => {
  it('lists cached unrestricted execute runs as the unrestricted caller, uncached ones never', async () => {
    const { targets } = await selectChangeWarmTargets({
      cloud: true,
      deps: {
        now: () => Date.parse('2026-11-14T12:00:00Z'),
        loadQueries: async () => [wq('spend'), wq('live', { cache_ttl: 0, warm_daily: true })],
        loadHits: async () => ({ hits: new Map([['spend', 9]]), ownerLoad: 0 }),
        loadParamSets: async () => []
      }
    })
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      surface: 'query',
      slug: 'spend',
      as: UNRESTRICTED_WARM_VIEWER,
      groupHits: 9
    })
  })

  it('an unrestricted target writes exactly the key the execute route reads', async () => {
    const q = wq('spend') as ViewerQueryDef
    const plan = await planChangeWarmTarget(
      target({
        surface: 'query',
        widgetId: undefined,
        slug: 'spend',
        as: UNRESTRICTED_WARM_VIEWER
      }),
      q
    )
    const expected = customQueryCacheKey(
      'spend',
      buildFinalParams(JSON.parse(q.params as string), {}),
      q
    )
    expect(plan.cacheKey).toBe(expected)
    expect(plan.flightKey).toBe(expected)
    expect(plan.ttl).toBe(600)
  })

  it('a viewer target goes through the viewer phase’s plan', async () => {
    const seen: string[] = []
    const plan = await planChangeWarmTarget(target({}), wq('spend') as ViewerQueryDef, {
      plan: async (t) => {
        seen.push(t.as.id)
        return { cacheKey: 'k', flightKey: 'widget|k', ttl: 1, run: async () => [] }
      }
    })
    expect(seen).toEqual(['u1'])
    expect(plan.flightKey).toBe('widget|k')
  })
})
