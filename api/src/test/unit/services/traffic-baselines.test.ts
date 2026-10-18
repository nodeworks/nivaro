// api/src/test/unit/services/traffic-baselines.test.ts — Traffic Map baselines and what is judged
// against them (#2145, #2144 server side, #2148, #2221, #2244, #2137, #2222, #2247)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, calls: 0 }))
vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of [
    'where',
    'whereIn',
    'whereNull',
    'orWhereNotIn',
    'orWhereRaw',
    'select',
    'limit',
    'orderBy',
    'groupBy',
    'count',
    'avg',
    'first'
  ])
    chain[m] = vi.fn((...a: unknown[]) => {
      if (m === 'where' && typeof a[0] === 'function') (a[0] as (b: unknown) => void)(chain)
      return chain
    })
    // biome-ignore lint/suspicious/noThenProperty: knex query builders are thenables
  ;(chain as { then: unknown }).then = (res: (v: unknown) => unknown) => {
    logRows.calls++
    return res(logRows.rows)
  }
  const db = Object.assign(
    vi.fn(() => chain),
    { raw: vi.fn(() => 'raw'), client: {} }
  )
  return { db }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/api-log-instances.js', () => ({
  instanceScope: vi.fn(async () => ({
    all: true,
    apply: (q: unknown) => q,
    sql: () => '',
    bindings: []
  }))
}))
vi.mock('../../../services/ops-incidents.js', () => ({ openThreads: vi.fn(async () => []) }))

import { replayMonitor } from '../../../services/traffic-alert-preview.js'
import {
  type BandWire,
  bandFrom,
  bandsFromHours,
  computable,
  decodeCell,
  encodeCell,
  epochHour,
  type HourCells,
  heatmapFrom,
  loadHours,
  rememberHourForTest,
  resetBaselinesForTest,
  rollupKeyFor,
  rollupRows,
  sampleHours,
  scoreAgainstBaseline,
  scoreErrors,
  setBaselineRedisForTest,
  slotOf,
  worstLevel
} from '../../../services/traffic-baselines.js'
import { deployRecommendation, summaryTiles } from '../../../services/traffic-judgements.js'
import { edgeLabel, normalizeTrafficConfig } from '../../../services/traffic-monitor.js'
import {
  entityMinutes,
  explainRise,
  findPivot,
  recordRequest,
  sizeBucket
} from '../../../services/traffic-taps/what-changed.js'
import { resetTapState } from '../../../services/traffic-taps.js'

const U = '0a0b0c0d-0000-0000-0000-000000000001'
const UK = `u${U.toUpperCase()}`

beforeEach(() => {
  resetTapState()
  resetBaselinesForTest()
  setBaselineRedisForTest(null)
  logRows.rows = []
  logRows.calls = 0
})
afterEach(() => setBaselineRedisForTest(undefined))

describe('roll-ups (#2145)', () => {
  it('folds log rows into node, caller, edge, total and people cells with the live classifier', () => {
    const t0 = Date.UTC(2026, 9, 12, 14, 0, 0)
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => ({
        method: 'GET',
        path: '/api/items/workflows',
        status: 200,
        latency_ms: 100 + i * 10,
        user: U,
        created_at: new Date(t0 + i * 60_000)
      })),
      {
        method: 'PATCH',
        path: '/api/items/workflows/12',
        status: 500,
        latency_ms: 900,
        user: U,
        created_at: new Date(t0 + 20 * 60_000)
      },
      { method: 'GET', path: '/api/health', status: 200, latency_ms: 1 }
    ]
    const cells = rollupRows(rows, () => null)
    expect(cells.get('n:items/workflows')?.[0]).toBe(10)
    expect(cells.get('n:items/workflows')?.[1]).toBe(1)
    expect(cells.get(`c:${UK}`)?.[0]).toBe(10)
    expect(cells.get(`e:${UK}>items/workflows`)?.[0]).toBe(10)
    // /api/health is never a map node
    expect(cells.get('t')?.[0]).toBe(10)
    expect(cells.get('n:items/workflows')?.[3]).toBe(900)
    // one person, seen in two quarter-hours
    expect(cells.get('p')).toEqual([1, 1, 0, 0])
  })

  it('round-trips cells through the Redis encoding', () => {
    expect(decodeCell(encodeCell([12, 1, 140.04, 900]))).toEqual([12, 1, 140, 900])
    expect(decodeCell('x')).toBeNull()
    expect(decodeCell(undefined)).toBeNull()
  })

  it('samples the same weekday and hour over four weeks, the hour either side', () => {
    const hs = sampleHours(1000)
    expect(hs).toHaveLength(12)
    expect(hs).toContain(1000 - 168)
    expect(hs).toContain(1000 - 168 * 4 + 1)
    expect(hs).not.toContain(1000)
  })

  it('only rolls up complete hours inside the log retention', () => {
    const now = Date.UTC(2026, 9, 17, 12, 30)
    const cur = epochHour(now)
    expect(computable(cur, now)).toBe(false)
    expect(computable(cur - 1, now)).toBe(true)
    expect(computable(cur - 14 * 24 - 5, now)).toBe(false)
  })

  it('reads memory first, then Redis, then rolls up from the log within the budget', async () => {
    const now = Date.now()
    const cur = epochHour(now)
    rememberHourForTest(cur - 2, new Map([['t', [60, 0, 10, 20]]]))
    const redisHash: Record<string, Record<string, string>> = {}
    const pipe = () => {
      const ops: Array<() => unknown> = []
      const p = {
        hgetall: (k: string) => ops.push(() => redisHash[k] ?? {}),
        hmget: (k: string, ...f: string[]) =>
          ops.push(() => f.map((x) => redisHash[k]?.[x] ?? null)),
        hset: (k: string, v: Record<string, string>) =>
          ops.push(() => {
            redisHash[k] = { ...(redisHash[k] ?? {}), ...v }
          }),
        expireat: () => ops.push(() => 1),
        exec: async () => ops.map((o) => [null, o()] as [null, unknown])
      }
      return p
    }
    setBaselineRedisForTest({ pipeline: pipe } as never)
    redisHash[`nvr:tm:roll:default:${cur - 3}`] = { _: '5,0', t: '30,3,10,40' }
    logRows.rows = [{ method: 'GET', path: '/api/items/x', status: 200, latency_ms: 5 }]
    const map = await loadHours([cur - 2, cur - 3, cur - 4, cur - 5], { maxCompute: 1 })
    expect(map.get(cur - 2)?.get('t')?.[0]).toBe(60)
    expect(map.get(cur - 3)?.get('t')).toEqual([30, 3, 10, 40])
    // newest missing hour computed, the next one over budget
    expect(map.get(cur - 4)?.get('n:items/x')?.[0]).toBe(1)
    expect(map.get(cur - 5)).toBeNull()
    // the computed hour was written back with its `_` marker
    expect(redisHash[`nvr:tm:roll:default:${cur - 4}`]?._).toBeDefined()
  })
})

describe('bands and scoring (#2145)', () => {
  it('learns median and a MAD spread with a floor', () => {
    const b = bandFrom([10, 11, 12, 10, 50, 11], 'rpm') as BandWire
    expect(b[0]).toBe(11)
    // MAD = 1 → spread 1.48 (above the 1.1 floor)
    expect(b[3]).toBeCloseTo(1.48, 1)
    expect(b[1]).toBeLessThan(11)
    expect(b[2]).toBeGreaterThan(11)
    expect(b[4]).toBe(6)
    expect(bandFrom([1, 2], 'rpm')).toBeNull()
    // identical samples: the floor keeps the band from collapsing
    expect(bandFrom([0, 0, 0, 0], 'rpm')?.[3]).toBe(0.5)
    expect(bandFrom([200, 200, 200], 'p95')?.[3]).toBe(25)
  })

  it('scores against the band: elevated at 2 spreads, high at 4, low only when it matters', () => {
    const b: BandWire = [100, 80, 120, 10, 12]
    expect(scoreAgainstBaseline(105, b).level).toBe('normal')
    expect(scoreAgainstBaseline(125, b)).toMatchObject({ level: 'elevated', z: 2.5, ratio: 1.25 })
    expect(scoreAgainstBaseline(145, b).level).toBe('high')
    expect(scoreAgainstBaseline(60, b).level).toBe('normal')
    expect(scoreAgainstBaseline(60, b, true).level).toBe('low')
    expect(scoreAgainstBaseline(60, null).level).toBe('unknown')
    expect(worstLevel(['normal', 'high', 'elevated'])).toBe('high')
  })

  it('does not judge an error rate on a handful of requests', () => {
    const b: BandWire = [1, 0, 2, 0.5, 12]
    expect(scoreErrors(3, 1, b).level).toBe('normal')
    expect(scoreErrors(100, 10, b).level).toBe('high')
  })

  it('zero-fills request samples, but only counts busy hours for errors and latency', () => {
    const busy: HourCells = new Map([['n:items/a', [600, 6, 50, 200]]])
    const quiet: HourCells = new Map([['n:items/a', [3, 3, 50, 900]]])
    const empty: HourCells = new Map()
    const bands = bandsFromHours([busy, busy, quiet, empty, busy])
    const a = bands.get('n:items/a')
    expect(a?.rpm?.[4]).toBe(5)
    // the quiet hour's 100% error rate (3 requests) is not a sample
    expect(a?.err_pct?.[4]).toBe(3)
    expect(a?.err_pct?.[0]).toBe(1)
  })
})

describe('heatmap (#2137)', () => {
  it('folds hours into a Monday-first weekday × hour grid in the asked time zone', () => {
    // 2026-10-12 is a Monday; 14:00 UTC
    const h = epochHour(Date.UTC(2026, 9, 12, 14))
    expect(slotOf(h, 'UTC')).toEqual({ dow: 0, hour: 14 })
    expect(slotOf(h, 'America/New_York')).toEqual({ dow: 0, hour: 10 })
    const hm = heatmapFrom(
      'n:items/a',
      [
        { h, cells: new Map([['n:items/a', [120, 2, 10, 300]]]) },
        { h: h + 168, cells: new Map([['n:items/a', [60, 0, 10, 100]]]) },
        { h: h + 1, cells: new Map() },
        { h: h + 2, cells: null }
      ],
      'req',
      'UTC'
    )
    expect(hm.cells[0][14]).toBe(90)
    expect(hm.cells[0][15]).toBe(0)
    expect(hm.cells[0][16]).toBeNull()
    expect(hm.max).toBe(90)
    expect(hm.hours_known).toBe(3)
  })

  it('maps map node ids to roll-up keys and refuses anything else', () => {
    expect(rollupKeyFor('entity', 'items/workflows')).toBe('n:items/workflows')
    expect(rollupKeyFor('caller', 'k12')).toBe('c:k12')
    expect(rollupKeyFor('down', 'ext:9')).toBe('d:ext:9')
    expect(rollupKeyFor('entity', 'bad key')).toBeNull()
    expect(rollupKeyFor('caller', 'x')).toBeNull()
  })
})

describe('what changed (#2148)', () => {
  const base = 1_000_000 * 60
  function feed(min: number, n: number, errEvery: number | null, caller: string, build = 'b1') {
    for (let i = 0; i < n; i++)
      recordRequest({
        entityKey: 'items/workflows',
        sec: (base / 60 + min) * 60 + (i % 50),
        isError: errEvery != null && i % errEvery === 0,
        ms: 100,
        caller,
        route: 'GET /api/items/workflows',
        build
      })
  }
  it('finds the rise and ranks what explains it by share of the rise', () => {
    const now = base / 60 + 29
    for (let m = 0; m < 22; m++) feed(m, 20, null, 'k1')
    for (let m = 22; m < 30; m++) {
      feed(m, 20, null, 'k1')
      feed(m, 10, 1, 'k2', 'b2') // a new caller on a new build, every call failing
    }
    const series = entityMinutes('items/workflows', now)
    expect(findPivot(series, now, 'errors')).toBe(base / 60 + 22)
    const ex = explainRise(series, now, 'errors')
    expect(ex.rose).toBe(true)
    expect(ex.before.rate).toBe(0)
    expect(ex.after.rate).toBeCloseTo(33.33, 1)
    const top = ex.factors[0]
    expect(top.share).toBeCloseTo(1, 5)
    expect(ex.by_dim.caller[0]).toMatchObject({ value: 'k2', is_new: true })
    expect(ex.by_dim.build[0].value).toBe('b2')
    // contributions within one dimension add up to the rise
    const sum = ex.factors.filter((f) => f.dim === 'caller').reduce((a, f) => a + f.contribution, 0)
    expect(sum).toBeCloseTo(ex.delta, 1)
  })

  it('reports no rise when nothing rose', () => {
    const now = base / 60 + 29
    for (let m = 0; m < 30; m++) feed(m, 10, null, 'k1')
    const ex = explainRise(entityMinutes('items/workflows', now), now, 'errors')
    expect(ex.rose).toBe(false)
    expect(ex.factors).toHaveLength(0)
  })

  it('buckets response sizes', () => {
    expect(sizeBucket(10)).toBe('under 1 KB')
    expect(sizeBucket(50_000)).toBe('10–100 KB')
    expect(sizeBucket(null)).toBe('streamed')
  })
})

describe('alert preview + edge alerts (#2222, #2247)', () => {
  it('replays a threshold every five minutes and counts each failing run once', () => {
    const start = 1_000_000
    const buckets = new Map<number, { n: number; e: number; lat: number[] }>()
    for (let m = start; m < start + 120; m++) buckets.set(m, { n: 10, e: 0, lat: [] })
    // two bursts of errors
    for (let m = start + 30; m < start + 41; m++) buckets.set(m, { n: 10, e: 8, lat: [] })
    for (let m = start + 90; m < start + 96; m++) buckets.set(m, { n: 10, e: 9, lat: [] })
    const r = replayMonitor(buckets, start, start + 120, {
      metric: 'errors_per_min',
      threshold: 5,
      window_s: 300
    })
    expect(r.fired).toBe(2)
    expect(r.episodes[0].from).toBeGreaterThan(r.episodes[1].from)
    expect(r.peak).toBe(9)
    expect(r.hourly).toHaveLength(2)
    expect(
      replayMonitor(buckets, start, start + 120, {
        metric: 'errors_per_min',
        threshold: 50,
        window_s: 300
      }).fired
    ).toBe(0)
  })

  it('accepts one edge side and labels it', () => {
    const base = { entity: 'items/workflows', metric: 'errors_per_min' as const, threshold: 5 }
    expect(normalizeTrafficConfig({ ...base, edge: { from: 'k12' } })?.edge).toEqual({
      from: 'k12'
    })
    expect(normalizeTrafficConfig({ ...base, edge: { to: 'ext:9' } })?.edge).toEqual({
      to: 'ext:9'
    })
    expect(normalizeTrafficConfig({ ...base, edge: { from: 'k1', to: 'ext:9' } })).toBeNull()
    expect(normalizeTrafficConfig({ ...base, edge: { from: 'nope' } })).toBeNull()
    // a node monitor keeps its old shape
    expect(normalizeTrafficConfig(base)).toEqual({ ...base, window_s: 300 })
    expect(edgeLabel('items/w', { to: 'ext:9' })).toBe('items/w → ext:9')
  })
})

describe('deploy check (#2221) and executive summary (#2244)', () => {
  const normal = { level: 'normal' as const, z: 0.2, ratio: 1 }
  it('says deploy now when traffic is normal and nothing is running', () => {
    const v = deployRecommendation({
      load: { rpm: 100, usual: 98, score: normal },
      heavy: [],
      running: [],
      imports: 0,
      incidents: [],
      quiet: null
    })
    expect(v.verdict).toBe('go')
    expect(v.sentence).toMatch(/^Deploy now/)
  })
  it('says wait, with the first reason, when something is in the way', () => {
    const v = deployRecommendation({
      load: { rpm: 300, usual: 100, score: { level: 'high', z: 9, ratio: 3 } },
      heavy: ['worker (nightly-rebuild)'],
      running: [],
      imports: 1,
      incidents: ['Payments down'],
      quiet: { label: '03:00', rpm: 4 }
    })
    expect(v.verdict).toBe('wait')
    expect(v.reasons).toHaveLength(4)
    expect(v.sentence).toMatch(/^Wait\. An incident is open: Payments down\./)
    expect(v.sentence).toMatch(/Quietest hour ahead: 03:00/)
  })

  it('turns live figures and bands into five plain tiles, with a sentence on anything not green', () => {
    const live: HourCells = new Map([
      ['t', [3000, 300, 50, 400]],
      ['n:items/workflows', [600, 10, 80, 2500]],
      ['d:ext:9', [10, 9, 200, 0]],
      ['p', [4, 4, 0, 0]]
    ])
    const tiles = summaryTiles(
      live,
      {
        h: 1,
        at: '',
        weeks: 4,
        hours_wanted: 12,
        hours_known: 12,
        learning: false,
        nodes: { 'items/workflows': { p95: [300, 250, 350, 25, 12] } },
        callers: {},
        edges: {},
        downs: {},
        total: { rpm: [200, 180, 220, 10, 12], err_pct: [1, 0, 2, 0.5, 12] },
        people: [20, 16, 24, 2, 12]
      },
      'a Monday at 14:00'
    )
    const by = Object.fromEntries(tiles.map((t) => [t.id, t]))
    expect(by.requests.tone).toBe('green')
    expect(by.errors.tone).toBe('red')
    expect(by.errors.sentence).toMatch(/300 of 3000 requests failed/)
    expect(by.slowest).toMatchObject({ tone: 'red', keys: ['items/workflows'] })
    expect(by.partners).toMatchObject({ tone: 'red', keys: ['ext:9'] })
    expect(by.people.tone).toBe('amber')
    for (const t of tiles) if (t.tone !== 'green') expect(t.sentence).toBeTruthy()
  })
})
