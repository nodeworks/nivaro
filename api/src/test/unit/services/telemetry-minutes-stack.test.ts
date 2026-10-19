import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  accessLogLine,
  callerKind,
  outLogLine,
  setStoreFetchForTests
} from '../../../services/telemetry-store.js'
import {
  foldDailyPeaks,
  rollupBusiestMinutes,
  selWith,
  stackSteps,
  weekOf
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

type Series = { metric: Record<string, string>; values: Array<[number, string]> }
const range = (metric: Record<string, string>, points: Array<[number, number]>): Series => ({
  metric,
  values: points.map(([t, v]) => [t / 1000, String(v)])
})

/** A fake stack: metrics answers by query text, logs answers ndjson rows; records every call. */
function fakeStack(opts: {
  metrics?: (query: string, params: URLSearchParams) => Series[] | 'fail'
  logs?: (query: string) => Array<Record<string, string>>
}) {
  process.env.TELEMETRY_STORE_URL = 'http://store:8427'
  process.env.TELEMETRY_STORE_ENV = 'staging'
  const calls: Array<{ path: string; query: string; params: URLSearchParams }> = []
  setStoreFetchForTests(async (url, init) => {
    const path = new URL(url).pathname
    const params = new URLSearchParams(String(init.body))
    const query = params.get('query') ?? ''
    calls.push({ path, query, params })
    if (path.includes('logsql')) {
      const rows = opts.logs?.(query) ?? []
      return new Response(rows.map((r) => JSON.stringify(r)).join('\n'))
    }
    const ans = opts.metrics?.(query, params) ?? []
    if (ans === 'fail') return new Response('boom', { status: 500 })
    return new Response(JSON.stringify({ status: 'success', data: { result: ans } }))
  })
  return calls
}

describe('lines for the stack (#2544)', () => {
  it('access line carries the caller kind and response bytes, never the path or query', () => {
    const line = accessLogLine({
      method: 'GET',
      path: '/api/items/workflows/12?search=secret@example.com',
      status: 200,
      latency_ms: 40,
      user: 'abc',
      api_key_id: null,
      auth: 'session',
      collection: 'workflows',
      error: null,
      instance: 'staging',
      response_bytes: 2048.4
    })
    expect(line).toMatchObject({ nvr: 'api', ck: 'user', bytes: 2048, caller: 'uABC' })
    expect(JSON.stringify(line)).not.toContain('secret')
    expect(JSON.stringify(line)).not.toContain('search=')
    const noBytes = accessLogLine({
      method: 'GET',
      path: '/api/x',
      status: 200,
      latency_ms: 1,
      user: null,
      api_key_id: null,
      auth: null,
      collection: null,
      error: null,
      instance: 'staging'
    })
    expect(noBytes).not.toHaveProperty('bytes')
    expect(noBytes.ck).toBe('anon')
  })
  it('caller kinds', () => {
    expect(callerKind({ authMethod: 'api_key', apiKeyId: 4 })).toBe('key')
    expect(callerKind({ authMethod: 'oauth', userId: 'u' })).toBe('oauth')
    expect(callerKind({ authMethod: 'token', userId: 'u' })).toBe('token')
    expect(callerKind({ authMethod: 'static', userId: 'u' })).toBe('token')
    expect(callerKind({ authMethod: 'masquerade', userId: 'u' })).toBe('user')
    expect(callerKind({ authMethod: 'session', userId: 'u' })).toBe('user')
    expect(callerKind({})).toBe('anon')
  })
  it('out line: ids, status and timing only', () => {
    expect(
      outLogLine({
        down: 'ext:12',
        entity: 'data/workflows',
        status: null,
        ms: 812.6,
        failed: true,
        instance: 'staging'
      })
    ).toEqual({
      nvr: 'out',
      down: 'ext:12',
      entity: 'data/workflows',
      status: 0,
      ms: 813,
      fail: 1,
      inst: 'staging'
    })
    expect(
      outLogLine({
        down: 'ext:3',
        entity: 'other/__background__',
        status: 201,
        ms: 5,
        failed: false,
        bytes: 99,
        instance: 'p'
      })
    ).toMatchObject({ status: 201, fail: 0, bytes: 99 })
  })
})

describe('selectors', () => {
  it('adds extra matchers beside env, values escaped', () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    process.env.TELEMETRY_STORE_ENV = 'staging'
    expect(selWith('nivaro_tm_requests', { stats_result: 'n', inst: 'a"b' })).toBe(
      'nivaro_tm_requests{env="staging",stats_result="n",inst="a\\"b"}'
    )
    process.env.TELEMETRY_STORE_ENV = ''
    expect(selWith('nivaro_tm_requests', {})).toBe('nivaro_tm_requests')
  })
})

describe('time-lapse from the stack', () => {
  it('nodes and partners from the rollups, callers from the busiest raw lines', async () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    const to = Math.ceil(now / H) * H
    const from = to - 2 * H
    const calls = fakeStack({
      metrics: (q) => {
        if (q.includes('nivaro_tm_down_requests'))
          return [
            range({ down: 'ext:12', stats_result: 'n' }, [[from + H, 6]]),
            range({ down: 'ext:12', stats_result: 'e' }, [[from + H, 1]])
          ]
        if (q.includes('nivaro_tm_requests'))
          return [range({ entity: 'data/workflows', stats_result: 'n' }, [[to, 9]])]
        return []
      },
      logs: (q) =>
        q.includes('sort by (n desc)')
          ? [{ caller: 'uABC', n: '30' }]
          : [
              {
                _time: new Date(from).toISOString(),
                caller: 'uABC',
                n: '30',
                e: '2',
                p95: '120'
              }
            ]
    })
    const groups = await stackSteps(from, to, 3600, now)
    expect(groups).toEqual(
      expect.arrayContaining([
        { s: 1, key: 'e:data/workflows', n: 9, e: 0, p95: 0 },
        { s: 0, key: 'd:ext:12', n: 6, e: 1, p95: 0 },
        { s: 0, key: 'c:uABC', n: 30, e: 2, p95: 120 }
      ])
    )
    const callerRead = calls.find((c) => c.query.includes('caller:in('))
    expect(callerRead?.query).toContain('caller:in("uABC")')
    expect(callerRead?.query).toContain('{env="staging"}')
    // The hourly per-caller rollups are not read while the raw lines cover the window.
    expect(calls.some((c) => c.query.includes('nivaro_tm_caller_requests'))).toBe(false)
  })
  it('past the raw lines’ month, callers come from the hourly per-caller rollups', async () => {
    const now = Date.parse('2027-06-01T00:00:00Z')
    const to = now
    const from = to - 90 * D
    const calls = fakeStack({
      metrics: (q) =>
        q.includes('nivaro_tm_caller_requests:1h')
          ? [range({ caller: 'k7', stats_result: 'n' }, [[from + 12 * H, 40]])]
          : []
    })
    const groups = await stackSteps(from, to, 12 * 3600, now)
    expect(groups).toContainEqual({ s: 0, key: 'c:k7', n: 40, e: 0, p95: 0 })
    expect(calls.some((c) => c.path.includes('logsql'))).toBe(false)
  })
  it('a failing partner read leaves partners out; a failing node read throws', async () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    const to = Math.ceil(now / H) * H
    const from = to - H
    fakeStack({
      metrics: (q) =>
        q.includes('nivaro_tm_down_')
          ? 'fail'
          : q.includes('nivaro_tm_requests')
            ? [range({ entity: 'data/x', stats_result: 'n' }, [[to, 3]])]
            : []
    })
    const groups = await stackSteps(from, to, 3600, now)
    expect(groups.map((g) => g.key)).toEqual(['e:data/x'])
    fakeStack({ metrics: () => 'fail' })
    await expect(stackSteps(from, to, 3600, now)).rejects.toThrow()
  })
})

describe('busiest minute over 13 months (capacity)', () => {
  it('weeks start on Monday (UTC); a day’s point is stamped at its end', () => {
    expect(weekOf(Date.parse('2026-10-21T10:00:00Z'))).toBe('2026-10-19')
    expect(weekOf(Date.parse('2026-10-19T00:00:00Z'))).toBe('2026-10-19')
    expect(weekOf(Date.parse('2026-10-18T23:59:00Z'))).toBe('2026-10-12')
    const tue = Date.parse('2026-10-21T00:00:00Z') // end of Tuesday the 20th
    const mon = Date.parse('2026-10-19T00:00:00Z') // end of Sunday the 18th
    const folded = foldDailyPeaks([
      [mon, 40],
      [tue, 90],
      [tue + D, 0]
    ])
    expect(folded.best).toEqual({ t: tue, v: 90 })
    expect(folded.weekly).toEqual([
      { week: '2026-10-12', peak_rpm: 40 },
      { week: '2026-10-19', peak_rpm: 90 }
    ])
    expect(folded.first).toBe(mon)
  })
  it('daily peaks, then the exact minute inside the best day, narrowed to the instance', async () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    const bestDayEnd = Date.parse('2026-11-04T00:00:00Z')
    const minuteEnd = Date.parse('2026-11-03T14:06:00Z')
    const calls = fakeStack({
      metrics: (q, params) =>
        q.startsWith('max_over_time(')
          ? [
              range({}, [
                [bestDayEnd - D, 300],
                [bestDayEnd, 1200]
              ])
            ]
          : params.get('step') === '60s'
            ? [
                range({}, [
                  [minuteEnd - 60_000, 800],
                  [minuteEnd, 1200]
                ])
              ]
            : []
    })
    const r = await rollupBusiestMinutes(395, 'staging', now)
    expect(r).toEqual({
      best_rpm: 1200,
      at: minuteEnd - 60_000,
      weekly: [{ week: '2026-11-02', peak_rpm: 1200 }],
      data_from: bestDayEnd - D
    })
    const daily = calls.find((c) => c.query.startsWith('max_over_time('))
    expect(daily?.query).toBe(
      'max_over_time(sum(sum_over_time(nivaro_tm_requests{env="staging",stats_result="n",inst="staging"}[1m]))[1d:1m])'
    )
    expect(daily?.params.get('step')).toBe('86400s')
  })
  it('no data: no ceiling', async () => {
    fakeStack({ metrics: () => [] })
    expect(await rollupBusiestMinutes(395, null)).toEqual({
      best_rpm: 0,
      at: null,
      weekly: [],
      data_from: null
    })
  })
})
