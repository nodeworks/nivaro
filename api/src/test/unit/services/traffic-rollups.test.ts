import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { maxSloWindowDays, parseSloTargets, validateSloTargets } from '../../../services/slo.js'
import { metricExpr, ROLLUP_METRICS, windowOf } from '../../../services/telemetry-ai.js'
import { setStoreFetchForTests } from '../../../services/telemetry-store.js'
import { stepIndex } from '../../../services/traffic-history-store.js'
import {
  endStepIndex,
  envMatcher,
  meanFromBuckets,
  percentileFromBuckets,
  rollupActive,
  rollupRouteTotals,
  rollupSloRows,
  rollupSteps,
  rollupTotals,
  sel,
  windowSeconds
} from '../../../services/traffic-rollups.js'

const KEYS = [
  'TELEMETRY_STORE_URL',
  'TELEMETRY_STORE_TOKEN',
  'TELEMETRY_STORE_ENV',
  'CLOUD_META_DB_URL'
] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  setStoreFetchForTests(null)
})

const H = 3600_000
const D = 86_400_000

/** A fake metrics store: answers by matching the query text; records every call. */
function fakeStore(
  answer: (path: string, params: URLSearchParams) => Array<Record<string, unknown>>
) {
  process.env.TELEMETRY_STORE_URL = 'http://store:8427'
  process.env.TELEMETRY_STORE_ENV = 'staging'
  const calls: Array<{ path: string; params: URLSearchParams }> = []
  setStoreFetchForTests(async (url, init) => {
    const path = new URL(url).pathname
    const params = new URLSearchParams(String(init.body))
    calls.push({ path, params })
    return new Response(
      JSON.stringify({ status: 'success', data: { result: answer(path, params) } })
    )
  })
  return calls
}

const range = (metric: Record<string, string>, points: Array<[number, number]>) => ({
  metric,
  values: points.map(([t, v]) => [t / 1000, String(v)])
})
const instant = (metric: Record<string, string>, v: number) => ({ metric, value: [0, String(v)] })

/** Cumulative buckets: `under` = {bound: requests at or under it, beyond the previous bound}. */
function cumulative(perBand: Record<number, number>, over30s = 0): Record<string, number> {
  const out: Record<string, number> = {}
  let run = 0
  for (const b of [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]) {
    run += perBand[b] ?? 0
    out[`le_${b}`] = run
  }
  out.le_inf = run + over30s
  return out
}

describe('percentiles from cumulative latency buckets (#2544 Phase 5)', () => {
  it('interpolates inside the bucket that crosses the quantile', () => {
    const b = cumulative({ 50: 10, 100: 10 })
    expect(percentileFromBuckets(b, 0.5)).toBe(50)
    expect(percentileFromBuckets(b, 0.25)).toBe(38)
    expect(percentileFromBuckets(b, 0.95)).toBe(95)
    expect(percentileFromBuckets(b, 1)).toBe(100)
  })
  it('answers the last bound past it, null with no requests', () => {
    expect(percentileFromBuckets(cumulative({}, 5), 0.95)).toBe(30000)
    expect(percentileFromBuckets({}, 0.95)).toBeNull()
    expect(percentileFromBuckets(cumulative({}), 0.5)).toBeNull()
  })
  it('treats missing buckets as the previous count (never falling)', () => {
    expect(percentileFromBuckets({ le_100: 4, le_inf: 4 }, 0.5)).toBe(75)
  })
  it('estimates a mean from bucket midpoints', () => {
    expect(meanFromBuckets(cumulative({ 50: 2, 100: 2 }))).toBe(56.3)
    expect(meanFromBuckets({})).toBeNull()
  })
})

describe('step alignment', () => {
  it('reads each point at its step end — the same steps as the log store', () => {
    const from = 10 * H
    const to = 13 * H
    // A point read at from + (s + 1) * step is step s …
    expect(endStepIndex(from + H, from, to, 3600)).toBe(0)
    expect(endStepIndex(to, from, to, 3600)).toBe(2)
    // … which is where stepIndex puts a row stamped inside that step.
    expect(stepIndex(from + H - 1, from, to, 3600)).toBe(0)
    expect(endStepIndex(from, from, to, 3600)).toBe(-1)
    expect(endStepIndex(to + H, from, to, 3600)).toBe(-1)
    expect(endStepIndex(Number.NaN, from, to, 3600)).toBe(-1)
  })
  it('reads hourly twins for whole-hour windows, minute series otherwise', () => {
    expect(windowSeconds('43200s')).toBe(43200)
    expect(windowSeconds('395d')).toBe(395 * 86_400)
    expect(windowSeconds('nope')).toBeNaN()
    expect(sel('nivaro_tm_requests', '43200s')).toMatch(/^nivaro_tm_requests:1h/)
    expect(sel('nivaro_route_latency', '1d')).toMatch(/^nivaro_route_latency:1h/)
    expect(sel('nivaro_tm_requests', '300s')).toMatch(/^nivaro_tm_requests(?!:)/)
    expect(sel('nivaro_tm_requests', '5400s')).toMatch(/^nivaro_tm_requests(?!:)/)
    expect(sel('nivaro_tm_active_people_1h', '86400s')).toMatch(/^nivaro_tm_active_people_1h(?!:)/)
  })
  it('quotes the env label', () => {
    expect(envMatcher('staging')).toBe('{env="staging"}')
    expect(envMatcher('a"b\\c')).toBe('{env="a\\"b\\\\c"}')
    expect(envMatcher(null)).toBe('')
  })
})

describe('rollup reads', () => {
  it('time-lapse steps: per node and step, p95 from bucket deltas, env matched exactly', async () => {
    const from = 100 * 12 * H
    const to = from + 2 * 12 * H
    const calls = fakeStore((_p, params) => {
      const q = params.get('query') ?? ''
      if (q.includes('nivaro_tm_requests'))
        return [
          range({ entity: 'data/workflows', stats_result: 'n' }, [
            [from + 12 * H, 20],
            [to, 4]
          ]),
          range({ entity: 'data/workflows', stats_result: 'e' }, [[from + 12 * H, 2]]),
          range({ entity: 'data/workflows', stats_result: 'e5' }, [[from + 12 * H, 1]])
        ]
      return Object.entries(cumulative({ 50: 10, 100: 10 })).map(([k, v]) =>
        range({ entity: 'data/workflows', stats_result: k }, [[from + 12 * H, v]])
      )
    })
    const groups = await rollupSteps(from, to, 12 * 3600)
    expect(groups).toEqual(
      expect.arrayContaining([
        { s: 0, key: 'e:data/workflows', n: 20, e: 2, p95: 95 },
        { s: 1, key: 'e:data/workflows', n: 4, e: 0, p95: 0 }
      ])
    )
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.path).toBe('/api/v1/query_range')
      expect(c.params.get('query')).toContain('{env="staging"}[43200s]')
      expect(c.params.get('start')).toBe(String((from + 12 * H) / 1000))
      expect(c.params.get('end')).toBe(String(to / 1000))
    }
  })
  it('people: the busiest hour inside each step; quiet steps stay zero', async () => {
    const from = 0
    const to = 3 * D
    fakeStore(() => [range({ env: 'staging', stats_result: 'n' }, [[2 * D, 7]])])
    expect(await rollupActive(from, to, 86_400)).toEqual([0, 7, 0])
  })
  it('totals per step for the API analytics chart', async () => {
    fakeStore((_p, params) =>
      (params.get('query') ?? '').includes('nivaro_tm_requests')
        ? [
            range({ stats_result: 'n' }, [[D, 10]]),
            range({ stats_result: 'e' }, [[D, 3]]),
            range({ stats_result: 'e5' }, [[D, 1]])
          ]
        : Object.entries(cumulative({ 100: 10 })).map(([k, v]) =>
            range({ stats_result: k }, [[D, v]])
          )
    )
    expect(await rollupTotals(0, 2 * D, 86_400)).toEqual([
      { at: 0, n: 10, e: 3, e5: 1, p50: 75, p95: 98, avg_ms: 75 }
    ])
  })
  it('route totals: busiest first, method split from the template, window in hours', async () => {
    const calls = fakeStore((_p, params) =>
      (params.get('query') ?? '').includes('nivaro_route_requests')
        ? [
            instant({ route: 'GET /api/items/:collection', stats_result: 'n' }, 50),
            instant({ route: 'GET /api/items/:collection', stats_result: 'e' }, 5),
            instant({ route: 'POST /api/auth/login', stats_result: 'n' }, 80)
          ]
        : Object.entries(cumulative({ 250: 50 })).map(([k, v]) =>
            instant({ route: 'GET /api/items/:collection', stats_result: k }, v)
          )
    )
    const rows = await rollupRouteTotals(0, 90 * D, 20)
    expect(rows.map((r) => r.route)).toEqual(['POST /api/auth/login', 'GET /api/items/:collection'])
    expect(rows[1]).toMatchObject({ method: 'GET', path: '/api/items/:collection', n: 50, e: 5 })
    expect(rows[1].p95).toBe(243)
    expect(rows[0].p95).toBeNull()
    expect(calls[0].path).toBe('/api/v1/query')
    expect(calls[0].params.get('query')).toContain('[2160h]')
    expect(calls[0].params.get('time')).toBe(String((90 * D) / 1000))
  })
  it('SLO rows per instance and UTC day, 4xx = errors minus 5xx', async () => {
    const from = 10 * D + 5 * H
    const to = 12 * D + 3 * H
    fakeStore((path, params) => {
      const q = params.get('query') ?? ''
      if (path === '/api/v1/query')
        return Object.entries(cumulative({ 500: 100 })).map(([k, v]) =>
          instant({ inst: 'api-1', stats_result: k }, v)
        )
      if (q.includes('nivaro_tm_requests'))
        return [
          range({ inst: 'api-1', stats_result: 'n' }, [
            [11 * D, 60],
            [12 * D, 40]
          ]),
          range({ inst: 'api-1', stats_result: 'e' }, [[11 * D, 6]]),
          range({ inst: 'api-1', stats_result: 'e5' }, [[11 * D, 2]])
        ]
      return []
    })
    const r = await rollupSloRows(from, to)
    expect(r.days).toEqual([
      { instance: 'api-1', day: '1970-01-11', n: 60, e5: 2, e4: 4, p95: null },
      { instance: 'api-1', day: '1970-01-12', n: 40, e5: 0, e4: 0, p95: null }
    ])
    expect(r.p95ByInstance.get('api-1')).toBe(488)
  })
})

describe('13-month reach elsewhere', () => {
  it('SLO windows reach 395 days with the store', () => {
    expect(maxSloWindowDays()).toBe(14)
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    expect(maxSloWindowDays()).toBe(395)
    expect(parseSloTargets('{"window_days":365}').window_days).toBe(365)
    expect(validateSloTargets({ window_days: 365 })).toBeNull()
    expect(validateSloTargets({ window_days: 400 })).toMatch(/window_days/)
  })
  it('daily AI metrics read the rollups with the env matcher and a 400-day window', () => {
    expect(ROLLUP_METRICS.has('requests_per_day')).toBe(true)
    expect(metricExpr('requests_per_day', 'staging')).toBe(
      'sum(sum_over_time(nivaro_tm_requests{env="staging",stats_result="n"}[1d]))'
    )
    expect(metricExpr('p95_ms_daily', 'staging')).toContain(
      'sum_over_time(nivaro_tm_latency{env="staging"}[1d])'
    )
    const now = Date.parse('2026-10-19T12:00:00Z')
    expect(windowOf({ minutes: 10_000_000 }, now, 400).from).toBe(now - 400 * D)
    expect(windowOf({ minutes: 10_000_000 }, now).from).toBe(now - 31 * D)
  })
})
