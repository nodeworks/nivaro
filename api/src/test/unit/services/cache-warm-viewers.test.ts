import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

// User Scopes for the as-whom tests: u-north and u-north2 share an allowance.
const scopes: Record<string, Array<{ dimension: string; mode: string; values: string[] }>> = {
  'u-north': [{ dimension: 'region', mode: 'restrict', values: ['N'] }],
  'u-north2': [{ dimension: 'region', mode: 'restrict', values: ['N'] }],
  'u-south': [{ dimension: 'region', mode: 'restrict', values: ['S'] }]
}
vi.mock('../../../services/user-scopes.js', () => ({
  getUserScopes: async (id: string) => scopes[id] ?? [],
  listScopeDimensions: async () => []
}))

import { runCacheWarm } from '../../../services/cache-warm.js'
import {
  pickViewerTargets,
  runViewerTargets,
  scopeSignature,
  type ViewerPlan,
  type ViewerQueryDef,
  type ViewerTarget,
  type ViewerUsageRow,
  type WarmViewer,
  type WarmWidgetDef
} from '../../../services/cache-warm-viewers.js'
import {
  clearCacheWarmers,
  registerCacheWarmer,
  runCacheWarmers
} from '../../../services/cache-warmers.js'
import { customQueryCacheValue } from '../../../services/custom-query-cache.js'
import { buildFinalParams } from '../../../services/custom-query-exec.js'
import { planWidgetQuery } from '../../../services/widget-query.js'

function q(slug: string, extra: Partial<ViewerQueryDef> = {}): ViewerQueryDef {
  return {
    id: slug,
    slug,
    enabled: true,
    access: 'authenticated',
    params: JSON.stringify([{ name: 'year', type: 'integer', default: 2026 }]),
    sql_text: `EXEC ${slug} :year, :region`,
    cache_ttl: 300,
    warm_daily: false,
    scope_params: JSON.stringify({ region: { dimension: 'region' } }),
    ...extra
  }
}

function w(id: number, queryId: string, extra: Partial<WarmWidgetDef> = {}): WarmWidgetDef {
  return {
    id,
    widget_type: 'custom-query',
    config: JSON.stringify({
      query_id: queryId,
      param_bindings: [{ param: ':year', input_key: 'year', default_value: '2026' }]
    }),
    is_active: true,
    ...extra
  }
}

const V = (id: string, signature: string, isAdmin = false): WarmViewer => ({
  id,
  isAdmin,
  signature
})
const use = (
  kind: 'widget' | 'query',
  target: string,
  user: string,
  n: number
): ViewerUsageRow => ({
  kind,
  target,
  user,
  n
})

afterEach(() => {
  clearCacheWarmers()
  vi.restoreAllMocks()
})

describe('scopeSignature', () => {
  it('is admin, empty for no restriction, and order-insensitive otherwise', () => {
    expect(scopeSignature(true, [{ dimension: 'r', mode: 'restrict', values: [1] }])).toBe('admin')
    expect(scopeSignature(false, [{ dimension: 'r', mode: 'default', values: [1] }])).toBe('')
    expect(scopeSignature(false, [{ dimension: 'r', mode: 'restrict', values: [] }])).toBe('')
    const a = scopeSignature(false, [
      { dimension: 'zone', mode: 'restrict', values: ['b', 'a'] },
      { dimension: 'region', mode: 'restrict', values: [2, 1] }
    ])
    const b = scopeSignature(false, [
      { dimension: 'region', mode: 'restrict', values: ['1', '2'] },
      { dimension: 'zone', mode: 'restrict', values: ['a', 'b'] }
    ])
    expect(a).toBe(b)
    expect(a).not.toBe('')
  })
})

describe('pickViewerTargets', () => {
  const north = 'region=["N"]'
  const south = 'region=["S"]'

  it('computes ONE person per scope signature — the group’s most frequent viewer', () => {
    const t = pickViewerTargets({
      queries: [q('budget')],
      widgets: [w(7, 'budget')],
      usage: [
        use('widget', '7', 'u1', 3),
        use('widget', '7', 'u2', 9),
        use('widget', '7', 'u3', 1),
        use('widget', '7', 'u4', 2)
      ],
      viewers: [V('u1', north), V('u2', north), V('u3', north), V('u4', south)],
      widgetParamSets: [],
      queryParamSets: []
    })
    expect(t.map((x) => [x.surface, x.as.id, x.members, x.groupHits])).toEqual([
      ['widget', 'u2', 3, 13],
      ['widget', 'u4', 1, 2]
    ])
    // The widget's default bound set, in binding order.
    expect(t[0].params).toEqual({ year: '2026' })
  })

  it('never picks uncached (ttl 0), disabled, invalid-access or inactive targets — and no unknown people', () => {
    const t = pickViewerTargets({
      queries: [
        q('ttl0', { cache_ttl: 0 }),
        q('off', { enabled: false }),
        q('nobody', { access: 'nobody' }),
        q('ok')
      ],
      widgets: [
        w(1, 'ttl0'),
        w(2, 'off'),
        w(3, 'nobody'),
        w(4, 'ok', { is_active: false }),
        w(5, 'ok')
      ],
      usage: [
        ...[1, 2, 3, 4, 5].map((id) => use('widget', String(id), 'u1', 50)),
        use('widget', '5', 'ghost', 99),
        use('query', 'ttl0', 'u1', 50)
      ],
      viewers: [V('u1', north)],
      widgetParamSets: [],
      queryParamSets: []
    })
    expect(t.map((x) => `${x.surface}:${x.widgetId ?? x.slug}:${x.as.id}`)).toEqual(['widget:5:u1'])
  })

  it('an admin-only query is computed for administrators only', () => {
    const t = pickViewerTargets({
      queries: [q('adm', { access: 'admin' })],
      widgets: [w(1, 'adm')],
      usage: [
        use('widget', '1', 'u1', 9),
        use('widget', '1', 'a1', 1),
        use('query', 'adm', 'u1', 9)
      ],
      viewers: [V('u1', north), V('a1', 'admin', true)],
      widgetParamSets: [],
      queryParamSets: []
    })
    expect(t.map((x) => `${x.surface}:${x.as.id}`)).toEqual(['widget:a1'])
  })

  it('execute calls: only restricted signatures, only queries that declare scope params', () => {
    const t = pickViewerTargets({
      queries: [q('scoped'), q('plain', { scope_params: null })],
      widgets: [],
      usage: [
        use('query', 'scoped', 'u1', 5),
        use('query', 'scoped', 'free', 50),
        use('query', 'scoped', 'a1', 50),
        use('query', 'plain', 'u1', 50)
      ],
      viewers: [V('u1', north), V('free', ''), V('a1', 'admin', true)],
      widgetParamSets: [],
      queryParamSets: []
    })
    // Unrestricted people share the key the unrestricted warm already filled.
    expect(t.map((x) => `${x.surface}:${x.slug}:${x.as.id}`)).toEqual(['query:scoped:u1'])
    expect(t[0].params).toEqual({})
  })

  it('defaults first (by use), then recorded sets — re-bound in binding order, masked and incomplete sets dropped', () => {
    const widget = w(1, 'budget', {
      config: JSON.stringify({
        query_id: 'budget',
        param_bindings: [
          { param: 'year', input_key: 'year', default_value: '2026' },
          { param: ':project', input_key: 'project', default_value: '' }
        ]
      })
    })
    const t = pickViewerTargets({
      queries: [q('budget'), q('other')],
      widgets: [widget, w(2, 'other')],
      usage: [use('widget', '1', 'u1', 5), use('widget', '2', 'u1', 2)],
      viewers: [V('u1', north)],
      widgetParamSets: [
        // Stored in another key order: the key must follow the bindings.
        { target: '1', params: '{"project":"P1","year":2025}', seen_count: 9 },
        { target: '1', params: '{"project":"••••••","year":2025}', seen_count: 50 },
        { target: '1', params: '{"year":2024}', seen_count: 40 }
      ],
      queryParamSets: []
    })
    // Widget 1's default has an unbound :project — never run unscoped.
    expect(t.map((x) => `${x.widgetId}:${x.kind}:${JSON.stringify(x.params)}`)).toEqual([
      '2:default:{"year":"2026"}',
      '1:param-set:{"year":2025,"project":"P1"}'
    ])
  })
})

describe('as whom — the key carries exactly the scope the statement ran with', () => {
  it('people with the same allowance share one key; another allowance gets its own', async () => {
    const cq = q('budget')
    const n1 = await planWidgetQuery(cq, { year: '2026' }, 'u-north', false)
    const n2 = await planWidgetQuery(cq, { year: '2026' }, 'u-north2', false)
    const s = await planWidgetQuery(cq, { year: '2026' }, 'u-south', false)
    const admin = await planWidgetQuery(cq, { year: '2026' }, 'u-north', true)
    expect(n1.cacheKey).toBe(n2.cacheKey)
    expect(n1.cacheKey).not.toBe(s.cacheKey)
    expect(n1.resolvedSql).toBe(`EXEC budget '2026', 'N'`)
    expect(s.resolvedSql).toBe(`EXEC budget '2026', 'S'`)
    // An administrator is unrestricted — a different key again, never the scoped one.
    expect(admin.resolvedSql).toBe(`EXEC budget '2026', NULL`)
    expect(new Set([n1.cacheKey, s.cacheKey, admin.cacheKey]).size).toBe(3)
  })
})

function fakeRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, { value: string; ttl: number }>(
    Object.entries(seed).map(([k, v]) => [k, { value: v, ttl: 300 }])
  )
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    setex: vi.fn(async (key: string, ttl: number, value: string) => {
      store.set(key, { value, ttl })
      return 'OK'
    })
  }
}

function target(over: Partial<ViewerTarget> & { as: WarmViewer }): ViewerTarget {
  return {
    surface: 'widget',
    slug: 'budget',
    widgetId: '1',
    params: { year: '2026' },
    kind: 'default',
    groupHits: 1,
    members: 1,
    seen: 0,
    ...over
  }
}

describe('runViewerTargets', () => {
  const plan = vi.fn(async (t: ViewerTarget, query: ViewerQueryDef): Promise<ViewerPlan> => {
    const p = await planWidgetQuery(query, t.params, t.as.id, t.as.isAdmin)
    return {
      cacheKey: p.cacheKey,
      flightKey: `widget|${p.cacheKey}`,
      ttl: p.cacheTtl,
      run: async () => [{ sql: p.resolvedSql }]
    }
  })
  const gate = async <T>(_k: string, fn: () => Promise<T>) => ({ value: await fn(), shared: false })

  it('computes each signature as its representative, dedupes equal keys, writes the route shape', async () => {
    const redis = fakeRedis()
    const s = await runViewerTargets(
      [
        target({ as: V('u-north', 'N') }),
        target({ as: V('u-north2', 'N2') }), // same allowance, mis-grouped: same key → skipped
        target({ as: V('u-south', 'S') })
      ],
      [q('budget')],
      {
        deadline: Number.POSITIVE_INFINITY,
        deps: { plan, gate, now: () => Date.now() },
        redis,
        freshMs: 3_600_000,
        queryTimeoutMs: 90_000,
        concurrency: 1
      }
    )
    expect(plan.mock.calls.map((c) => c[0].as.id)).toEqual(['u-north', 'u-north2', 'u-south'])
    expect(s).toMatchObject({ warmed: 2, cached: 2, skipped: 1, failed: 0, signatures: 2 })
    const values = [...redis.store.values()].map((v) => JSON.parse(v.value).rows[0].sql)
    expect(values.sort()).toEqual([`EXEC budget '2026', 'N'`, `EXEC budget '2026', 'S'`])
    expect([...redis.store.values()].every((v) => v.ttl === 300)).toBe(true)
  })

  it('never runs a writer: ttl-0 and invalid-access queries are skipped at run time too', async () => {
    const run = vi.fn(async () => [])
    const s = await runViewerTargets(
      [
        target({ slug: 'ttl0', as: V('u1', 'x') }),
        target({ slug: 'nobody', as: V('u1', 'x') }),
        target({ slug: 'adm', as: V('u1', 'x') })
      ],
      [
        q('ttl0', { cache_ttl: 0 }),
        q('nobody', { access: 'nobody' }),
        q('adm', { access: 'admin' })
      ],
      {
        deadline: Number.POSITIVE_INFINITY,
        deps: {
          plan: async () => ({ cacheKey: 'k', flightKey: 'k', ttl: 300, run }),
          gate,
          now: Date.now
        },
        redis: fakeRedis(),
        freshMs: 0,
        queryTimeoutMs: 1
      }
    )
    expect(run).not.toHaveBeenCalled()
    expect(s.skipped).toBe(3)
  })

  it('stops starting runs once the budget is spent, and leaves fresh keys alone', async () => {
    let now = 1_000
    const fresh = fakeRedis({
      'cq:budget:{"year":"2026"}': customQueryCacheValue([], new Date(now - 60_000))
    })
    const run = vi.fn(async () => {
      now += 600
      return []
    })
    const s = await runViewerTargets(
      [
        target({ as: V('a', '1'), params: { year: '2026' } }),
        target({ as: V('b', '2'), params: { year: '2025' } }),
        target({ as: V('c', '3'), params: { year: '2024' } }),
        target({ as: V('d', '4'), params: { year: '2023' } })
      ],
      [q('budget', { scope_params: null })],
      {
        deadline: 2_000,
        deps: {
          plan: async (t) => {
            const key = `cq:budget:${JSON.stringify(t.params)}`
            return { cacheKey: key, flightKey: key, ttl: 300, run }
          },
          gate,
          now: () => now
        },
        redis: fresh,
        freshMs: 3_600_000,
        queryTimeoutMs: 90_000,
        concurrency: 1
      }
    )
    // a: fresh (skipped), b: runs (now 1600), c: runs (now 2200), d: budget spent.
    expect(run).toHaveBeenCalledTimes(2)
    expect(s).toMatchObject({ warmed: 2, skipped: 2, budgetSpent: true })
  })

  it('a viewer run already in flight is joined, not repeated', async () => {
    const run = vi.fn(async () => [])
    const s = await runViewerTargets([target({ as: V('u1', 'x') })], [q('budget')], {
      deadline: Number.POSITIVE_INFINITY,
      deps: {
        plan: async () => ({ cacheKey: 'k', flightKey: 'widget|k', ttl: 300, run }),
        gate: async () => ({ value: { rows: [], cachedAt: 'x' } as never, shared: true }),
        now: Date.now
      },
      redis: fakeRedis(),
      freshMs: 0,
      queryTimeoutMs: 1
    })
    expect(run).not.toHaveBeenCalled()
    expect(s).toMatchObject({ warmed: 1, joined: 1, cached: 0 })
  })
})

describe('runCacheWarmers', () => {
  it('isolates a hanging warmer (timeout, signal aborted) and a throwing one; the rest still run', async () => {
    let aborted = false
    const ran: string[] = []
    registerCacheWarmer(
      'ext',
      'hang',
      ({ signal }) => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise(() => {})
      },
      { budgetMs: 20 }
    )
    registerCacheWarmer('ext', 'boom', async () => {
      throw new Error('nope')
    })
    registerCacheWarmer('ext', 'fine', async ({ budgetMs }) => {
      ran.push(`fine:${budgetMs}`)
    })
    const gated: number[] = []
    const out = await runCacheWarmers({
      deadline: Date.now() + 10_000,
      gate: async (fn) => {
        gated.push(1)
        return fn()
      }
    })
    expect(out.map((o) => [o.id, o.status])).toEqual([
      ['ext:hang', 'timeout'],
      ['ext:boom', 'failed'],
      ['ext:fine', 'ok']
    ])
    expect(out[1].error).toBe('nope')
    expect(aborted).toBe(true)
    // Never more than what the run has left.
    expect(Number(ran[0].split(':')[1])).toBeLessThanOrEqual(10_000)
    expect(gated).toHaveLength(3)
  })

  it('skips warmers once the budget is spent', async () => {
    const fn = vi.fn()
    registerCacheWarmer('ext', 'late', fn)
    const out = await runCacheWarmers({ deadline: Date.now() - 1 })
    expect(out).toEqual([{ id: 'ext:late', status: 'skipped', ms: 0 }])
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('runCacheWarm — viewer phase and warmers', () => {
  const coreDeps = {
    loadQueries: async () => [q('budget', { scope_params: null })],
    loadHits: async () => ({ hits: new Map([['budget', 5]]), ownerLoad: 0 }),
    loadParamSets: async () => [],
    buildFinalParams: buildFinalParams as never,
    exec: vi.fn(async () => [{ n: 1 }]),
    ownerLoad: vi.fn(async () => ({}))
  }
  const viewerDeps = (
    plan = vi.fn(async (t: ViewerTarget) => ({
      cacheKey: `cq:w:${t.as.id}`,
      flightKey: `widget|cq:w:${t.as.id}`,
      ttl: 300,
      run: async () => [{ v: t.as.id }]
    }))
  ) => ({
    loadUsage: async () => [use('widget', '1', 'u1', 4), use('widget', '1', 'u2', 1)],
    loadWidgets: async () => [w(1, 'budget')],
    loadViewers: async () => [V('u1', 'N'), V('u2', 'S')],
    loadWidgetParamSets: async () => [],
    plan,
    gate: async <T>(_k: string, fn: () => Promise<T>) => ({ value: await fn(), shared: false })
  })

  it('runs after the core queries, inside the same budget, then the extension warmers', async () => {
    const redis = fakeRedis()
    const order: string[] = []
    registerCacheWarmer('ext', 'one', async () => {
      order.push('warmer')
    })
    const v = viewerDeps()
    const s = await runCacheWarm({
      redis,
      cloud: false,
      deps: {
        ...coreDeps,
        exec: vi.fn(async () => {
          order.push('core')
          return []
        })
      },
      viewers: {
        ...v,
        plan: async (t) => {
          order.push(`viewer:${t.as.id}`)
          return v.plan(t)
        }
      },
      warmers: { gate: (fn) => fn() }
    })
    expect(order).toEqual(['core', 'viewer:u1', 'viewer:u2', 'warmer'])
    expect(s.viewers).toMatchObject({ warmed: 2, cached: 2, signatures: 2 })
    expect(s.warmers?.map((x) => x.status)).toEqual(['ok'])
    expect(redis.store.has('cq:w:u1') && redis.store.has('cq:w:u2')).toBe(true)
  })

  it('warm_daily runs and cloud mode skip the viewer phase and warmers', async () => {
    const fn = vi.fn()
    registerCacheWarmer('ext', 'one', fn)
    const v = viewerDeps()
    const daily = await runCacheWarm({
      only: 'warm_daily',
      cloud: false,
      deps: coreDeps,
      viewers: v,
      warmers: { gate: (f) => f() }
    })
    const cloud = await runCacheWarm({
      cloud: true,
      deps: coreDeps,
      viewers: v,
      warmers: { gate: (f) => f() }
    })
    expect(daily.viewers).toBeUndefined()
    expect(cloud.viewers).toBeUndefined()
    expect(cloud.warmers).toBeUndefined()
    expect(v.plan).not.toHaveBeenCalled()
    expect(fn).not.toHaveBeenCalled()
  })
})
