// api/src/test/unit/services/traffic-history-long.test.ts — Traffic Map long history (tm-history:
// #2228 minute store, #2183 time-lapse, #2175 search, #2193 latency modes, #2252 slow parameters,
// #2165 jobs against peaks, #2151 what-if capacity)
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'select', 'limit', 'orderBy', 'first', 'update', 'insert'])
    chain[m] = vi.fn(() => chain)
    // biome-ignore lint/suspicious/noThenProperty: knex query builders are thenables
  ;(chain as { then: unknown }).then = (res: (v: unknown) => unknown) => res([])
  const db = Object.assign(
    vi.fn(() => chain),
    { client: { config: { client: 'mssql' } }, schema: { hasTable: vi.fn(async () => false) } }
  )
  return { db }
})
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import {
  buildTimelapse,
  histFromText,
  histPercentile,
  histToText,
  jobsAgainstPeaks,
  LAT_BUCKETS,
  latBucket,
  latencyDistribution,
  projectWhatIf,
  queryFeatures,
  slowParameters,
  zoneOffsetMinutes
} from '../../../services/traffic-history-analysis.js'
import { familyEntity, isoUtc, routeLike } from '../../../services/traffic-history-reads.js'
import {
  MinuteAggregator,
  mergeWire,
  overflowKey,
  parseMinuteSettings,
  setRecordingForTest,
  TAP_ID,
  toRows,
  toWire,
  validateMinuteSettings
} from '../../../services/traffic-minutes.js'
import { tapState, trafficTaps } from '../../../services/traffic-taps.js'

describe('latency buckets', () => {
  it('buckets and reads percentiles back from a histogram', () => {
    expect(latBucket(5)).toBe(0)
    expect(latBucket(10)).toBe(1)
    expect(latBucket(99_999)).toBe(LAT_BUCKETS - 1)
    const h = new Array(LAT_BUCKETS).fill(0)
    for (let i = 0; i < 90; i++) h[latBucket(40)]++
    for (let i = 0; i < 10; i++) h[latBucket(3000)]++
    expect(histPercentile(h, 0.5)).toBeGreaterThanOrEqual(25)
    expect(histPercentile(h, 0.5)).toBeLessThan(50)
    expect(histPercentile(h, 0.95)).toBeGreaterThanOrEqual(2500)
    expect(histPercentile(h, 0.95, 3000)).toBeLessThanOrEqual(3000)
    expect(histPercentile(new Array(LAT_BUCKETS).fill(0), 0.95)).toBe(0)
  })
  it('round-trips the stored text form and survives junk', () => {
    const h = [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 9]
    expect(histFromText(histToText(h))).toEqual(h)
    expect(histFromText('x,-1,4')).toEqual([0, 0, 4, ...new Array(LAT_BUCKETS - 3).fill(0)])
    expect(histFromText(null)).toHaveLength(LAT_BUCKETS)
  })
})

describe('#2193 latency distribution', () => {
  it('finds two modes in a route split into fast and slow requests', () => {
    const lat = [
      ...Array.from({ length: 300 }, (_, i) => 15 + (i % 10)),
      ...Array.from({ length: 120 }, (_, i) => 1800 + (i % 50) * 10)
    ]
    const d = latencyDistribution(lat)
    expect(d.total).toBe(420)
    expect(d.bimodal).toBe(true)
    expect(d.modes).toHaveLength(2)
    expect(d.modes[0].median).toBeLessThan(30)
    expect(d.modes[1].median).toBeGreaterThan(1500)
    expect(d.modes[0].share + d.modes[1].share).toBeCloseTo(1, 1)
    expect(d.bins.reduce((a, b) => a + b.n, 0)).toBe(420)
  })
  it('reads one mode for a single bell of durations, and nothing for a handful', () => {
    const lat = Array.from({ length: 400 }, (_, i) => 80 + ((i * 37) % 60))
    const d = latencyDistribution(lat)
    expect(d.bimodal).toBe(false)
    expect(d.modes).toHaveLength(1)
    expect(latencyDistribution([5, 10]).modes).toEqual([])
  })
})

describe('#2252 slow parameters', () => {
  it('turns a query string into features (buckets, filter fields, date spans, masks)', () => {
    const f = queryFeatures(
      'limit=5000&fields=*,owner.name&sort=-date&filter=' +
        encodeURIComponent(
          JSON.stringify({
            status: { _eq: 'open' },
            date: { _between: ['2024-01-01', '2026-01-01'] },
            title: { _icontains: 'x' }
          })
        ) +
        '&token=abc&api_secret=••••••'
    )
    expect(f.has('limit:1001-10000')).toBe(true)
    expect(f.has('fields:wildcard')).toBe(true)
    expect(f.has('fields:related')).toBe(true)
    expect(f.has('sort=-date')).toBe(true)
    expect(f.has('filter.field:status')).toBe(true)
    expect(f.has('filter.range:date:>1y')).toBe(true)
    expect(f.has('filter.contains:title')).toBe(true)
    expect(f.has('token=abc')).toBe(false)
    expect(f.has('api_secret:present')).toBe(true)
    expect([...f.keys()].some((k) => k.includes('••'))).toBe(false)
    expect(queryFeatures(null).size).toBe(0)
  })
  it('ranks the parameter that explains the slow requests first', () => {
    const rows = [
      ...Array.from({ length: 80 }, (_, i) => ({
        latency_ms: 40 + (i % 20),
        query: 'limit=25&sort=id'
      })),
      ...Array.from({ length: 12 }, () => ({ latency_ms: 3000, query: 'limit=5000&sort=id' })),
      ...Array.from({ length: 8 }, () => ({ latency_ms: 60, query: 'limit=25&sort=-id' }))
    ]
    const r = slowParameters(rows)
    expect(r.total).toBe(100)
    expect(r.threshold_ms).toBeGreaterThan(60)
    expect(r.features[0].feature).toBe('limit:1001-10000')
    expect(r.features[0].lift).toBeGreaterThan(1.5)
    expect(r.features[0].explains).toBeGreaterThan(0.5)
    expect(r.features[0].median_with).toBe(3000)
    // A parameter every request carries explains nothing.
    expect(r.features.some((f) => f.feature === 'sort=id' && f.n === 100)).toBe(false)
  })
  it('says nothing on too few requests', () => {
    expect(slowParameters([{ latency_ms: 10, query: 'a=1' }]).features).toEqual([])
  })
})

describe('#2165 jobs against peaks', () => {
  const curve = Array.from({ length: 24 }, (_, h) => (h >= 13 && h <= 16 ? 100 : h < 6 ? 2 : 30))
  const daily = (hour: number, ms: number, days = 7) =>
    Array.from({ length: days }, (_, d) => ({
      at: Date.UTC(2026, 9, 1 + d, hour, 0),
      ms
    }))
  it('flags a job in the afternoon peak and suggests a quiet slot as a cron expression', () => {
    const r = jobsAgainstPeaks(
      curve,
      [
        {
          id: 'big-import',
          expression: '0 14 * * *',
          heavy: true,
          timezone: 'UTC',
          runs: daily(14, 1800_000)
        }
      ],
      { days: 7, now: Date.UTC(2026, 9, 10) }
    )
    expect(r.peak_level).toBe(65)
    const j = r.jobs[0]
    expect(j.start_minute_utc).toBe(14 * 60)
    expect(j.overlaps_peak).toBe(true)
    expect(j.suggest_minute_utc).not.toBeNull()
    expect(Math.floor((j.suggest_minute_utc as number) / 60)).toBeLessThan(6)
    expect(j.suggest_expression).toMatch(/^\d+ [0-5] \* \* \*$/)
    expect(j.suggest_traffic).toBe(2)
  })
  it('leaves quiet jobs and all-day jobs without a slot', () => {
    const every5 = Array.from({ length: 7 * 288 }, (_, i) => ({
      at: Date.UTC(2026, 9, 1) + i * 300_000,
      ms: 2000
    }))
    const r = jobsAgainstPeaks(
      curve,
      [
        { id: 'night', expression: '0 3 * * *', runs: daily(3, 60_000) },
        { id: 'sweep', expression: '*/5 * * * *', runs: every5 }
      ],
      { days: 7 }
    )
    const night = r.jobs.find((j) => j.id === 'night')
    const sweep = r.jobs.find((j) => j.id === 'sweep')
    expect(night?.overlaps_peak).toBe(false)
    expect(night?.suggest_minute_utc).toBeNull()
    expect(sweep?.start_minute_utc).toBeNull()
    expect(sweep?.per_day).toBeGreaterThan(4)
  })
  it('knows zone offsets', () => {
    expect(zoneOffsetMinutes('UTC')).toBe(0)
    expect([-240, -300]).toContain(zoneOffsetMinutes('America/New_York', Date.UTC(2026, 6, 1)))
    expect(zoneOffsetMinutes('Not/AZone')).toBe(0)
  })
})

describe('#2151 what-if capacity', () => {
  const base = {
    now_rps: 10,
    ceiling_rps: 50,
    replicas: 2,
    pool_used: 4,
    pool_max: 20,
    pool_per_rps: 0.4,
    loop_p99_ms: 20
  }
  it("projects +50% traffic on today's costs", () => {
    const r = projectWhatIf(base, { traffic_pct: 50, add_replicas: 0 })
    expect(r.now.rps_per_replica).toBe(10)
    expect(r.projected.rps_per_replica).toBe(15)
    expect(r.projected.headroom_pct).toBe(30)
    expect(r.projected.pool_used).toBe(6)
    expect(r.projected.pool_pct).toBe(30)
    expect(r.projected.loop_p99_ms as number).toBeGreaterThan(20)
    expect(r.projected.saturated).toBe(false)
  })
  it('spreads load over an added replica', () => {
    const r = projectWhatIf(base, { traffic_pct: 0, add_replicas: 2 })
    expect(r.replicas).toEqual({ now: 2, projected: 4 })
    expect(r.projected.rps_per_replica).toBe(5)
    expect(r.projected.loop_p99_ms as number).toBeLessThan(20)
  })
  it('flags saturation and says what it cannot project', () => {
    const r = projectWhatIf(base, { traffic_pct: 500, add_replicas: 0 })
    expect(r.projected.saturated).toBe(true)
    expect(r.projected.loop_p99_ms).toBeNull()
    expect(r.notes.join(' ')).toMatch(/pool would be full|queue without bound/)
    const none = projectWhatIf(
      { ...base, ceiling_rps: null, pool_per_rps: null, now_rps: 0 },
      { traffic_pct: 10, add_replicas: 0 }
    )
    expect(none.projected.headroom_pct).toBeNull()
    expect(none.notes.length).toBe(2)
  })
  it('moves a job: its connection leaves the old slot and lands on the new one', () => {
    const r = projectWhatIf(base, {
      traffic_pct: 0,
      add_replicas: 0,
      move_job: { id: 'import', from_rpm: 1200, to_rpm: 60, connections: 2 }
    })
    expect(r.job?.from_before.pool_used).toBeCloseTo(0.4 * 10 + 2, 5)
    expect(r.job?.from_after.pool_used).toBeCloseTo(4, 5)
    expect(r.job?.to_after.pool_used).toBeCloseTo(0.4 * 0.5 + 2, 5)
  })
})

describe('#2183 time-lapse frames', () => {
  it('builds frames, totals from entities only, busiest nodes first', () => {
    const t = buildTimelapse(
      [
        { s: 0, key: 'e:items/workflows', n: 10, e: 1, p95: 100 },
        { s: 0, key: 'c:uABC', n: 10, e: 1, p95: 100 },
        { s: 1, key: 'e:items/workflows', n: 5, e: 0, p95: 50 },
        { s: 1, key: 'e:items/workflows', n: 5, e: 0, p95: 150 },
        { s: 1, key: 'e:graphql/getX', n: 30, e: 0, p95: 20 },
        { s: 9, key: 'e:graphql/getX', n: 99, e: 0, p95: 20 }
      ],
      { from: 0, to: 3 * 300_000, stepS: 300 },
      40
    )
    expect(t.frames).toHaveLength(3)
    expect(t.frames[0].req).toBe(10)
    expect(t.frames[1].req).toBe(40)
    expect(t.nodes[0].key).toBe('e:graphql/getX')
    const wf = t.nodes.findIndex((n) => n.key === 'e:items/workflows')
    const cell = t.frames[1].nodes.find((c) => c[0] === wf)
    expect(cell).toEqual([wf, 10, 0, 100])
    expect(buildTimelapse([], { from: 0, to: 600_000, stepS: 300 }, 5).frames).toHaveLength(2)
  })
  it('maps request-log families to map entities', () => {
    expect(familyEntity('i:workflows', 'GET')).toBe('items/workflows')
    expect(familyEntity('i:nivaro_users', 'GET')).toBe('system/nivaro_users')
    expect(familyEntity('g:getBudget', 'POST')).toBe('graphql/getBudget')
    expect(familyEntity('g:', 'POST')).toBe('graphql/anonymous')
    expect(familyEntity('p:/api/custom-queries/budget/execute', 'POST')).toBe('queries/budget')
    expect(familyEntity('p:/api/pipelines/instance/workflows', 'GET')).toBe('items/workflows')
    expect(familyEntity('p:/api/users', 'GET')).toBe('other/users')
  })
  it('turns route templates into LIKE patterns and stamps UTC', () => {
    expect(routeLike('GET /api/items/workflows/:id')).toEqual({
      method: 'GET',
      like: '/api/items/workflows/%',
      op: null
    })
    expect(routeLike('POST /api/graphql · getX')).toEqual({
      method: 'POST',
      like: '/api/graphql',
      op: 'getX'
    })
    expect(routeLike('GET /api/a_b')).toEqual({ method: 'GET', like: '/api/a\\_b', op: null })
    expect(isoUtc(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02T03:04:05')
  })
})

describe('#2228 minute store', () => {
  it('validates settings strictly and parses stored JSON leniently', () => {
    expect(validateMinuteSettings({ enabled: true })).toEqual({
      enabled: true,
      retention_days: 30,
      edges: true
    })
    expect(() => validateMinuteSettings({ retention_days: 0 })).toThrow(/1 to 90/)
    expect(() => validateMinuteSettings({ retention_days: 2.5 })).toThrow()
    expect(parseMinuteSettings('{bad')).toEqual({ enabled: false, retention_days: 30, edges: true })
    expect(parseMinuteSettings('{"enabled":true,"retention_days":7,"edges":false}')).toEqual({
      enabled: true,
      retention_days: 7,
      edges: false
    })
  })
  it('aggregates a minute, closes it on the next, and merges processes exactly', () => {
    const a = new MinuteAggregator()
    a.add(100, 'e:items/w', 40, false, 500)
    a.add(100, 'e:items/w', 3000, true, 100)
    a.add(101, 'e:items/w', 20, false, 0)
    const closed = a.drain()
    expect(closed).toHaveLength(1)
    expect(closed[0].minute).toBe(100)
    const b = new MinuteAggregator()
    b.add(100, 'e:items/w', 45, false, 50)
    b.rotate(101)
    const merged = mergeWire([toWire(closed[0].keys), toWire(b.drain()[0].keys), 'junk', [[1, 2]]])
    const rows = toRows(100, merged)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: 'e:items/w',
      kind: 'node',
      requests: 3,
      errors: 1,
      bytes: 650
    })
    expect(rows[0].p50).toBeLessThanOrEqual(50)
    expect(rows[0].p95).toBeGreaterThan(1000)
    expect(rows[0].p95).toBeLessThanOrEqual(3000)
    expect(rows[0].bucket.toISOString()).toBe(new Date(100 * 60_000).toISOString())
  })
  it('folds keys past the cap into overflow keys by kind', () => {
    expect(overflowKey('c:u1>e:items/a')).toBe('x:__overflow__')
    expect(overflowKey('e:items/a')).toBe('e:other/__overflow__')
    expect(overflowKey('c:u1')).toBe('c:__overflow__')
    expect(overflowKey('d:ext:1')).toBe('d:__overflow__')
    const a = new MinuteAggregator()
    for (let i = 0; i < 3005; i++) a.add(5, `e:items/c${i}`, 1, false, 0)
    expect(a.keys.size).toBe(3001)
    expect(a.keys.get('e:other/__overflow__')?.n).toBe(5)
  })
  it('records nothing while off, nodes and edges while on', () => {
    const tap = trafficTaps().find((t) => t.id === TAP_ID)
    expect(tap).toBeTruthy()
    const ctx = {
      ev: { latencyMs: 30, responseBytes: 200 },
      entityKey: 'items/workflows',
      caller: 'uX',
      isError: false,
      sec: 600
    } as unknown as Parameters<NonNullable<NonNullable<typeof tap>['onRequest']>>[0]
    setRecordingForTest(false)
    tap?.onRequest?.(ctx)
    const agg = tapState<MinuteAggregator>(TAP_ID, () => new MinuteAggregator())
    expect(agg.keys.size).toBe(0)
    setRecordingForTest(true, true)
    tap?.onRequest?.(ctx)
    expect([...agg.keys.keys()].sort()).toEqual([
      'c:uX',
      'c:uX>e:items/workflows',
      'e:items/workflows'
    ])
    setRecordingForTest(true, false)
    tap?.onOutbound?.({
      ev: { durationMs: 80 },
      downId: 'ext:4',
      entityKey: 'items/workflows',
      failed: true,
      sec: 600
    } as never)
    expect(agg.keys.get('d:ext:4')?.e).toBe(1)
    expect(agg.keys.has('e:items/workflows>d:ext:4')).toBe(false)
    setRecordingForTest(false)
  })
})
