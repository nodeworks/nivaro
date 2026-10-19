import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storeInstances } from '../../../services/slo.js'
import {
  accessLogEnabled,
  accessLogLine,
  baseFilter,
  containsRe,
  logsQuery,
  lq,
  parseNdjson,
  resetStoreStatusForTests,
  StoreUnavailableError,
  setStoreFetchForTests,
  storeConfig,
  storeStatus
} from '../../../services/telemetry-store.js'
import {
  searchFilter,
  stepIndex,
  stepsFromRows,
  storeSearch
} from '../../../services/traffic-history-store.js'

const ENV_KEYS = [
  'TELEMETRY_STORE_URL',
  'TELEMETRY_STORE_TOKEN',
  'TELEMETRY_STORE_ENV',
  'TELEMETRY_ACCESS_LOG',
  'CLOUD_META_DB_URL'
] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  resetStoreStatusForTests()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  setStoreFetchForTests(null)
})

function answer(lines: object[], status = 200) {
  return new Response(lines.map((l) => JSON.stringify(l)).join('\n'), { status })
}

describe('telemetry store config (#2544)', () => {
  it('is off until a URL is set, and always off in cloud mode', () => {
    expect(storeConfig()).toBeNull()
    process.env.TELEMETRY_STORE_URL = 'http://efp_obs_vmauth:8427/'
    process.env.TELEMETRY_STORE_ENV = 'staging'
    expect(storeConfig()).toMatchObject({ url: 'http://efp_obs_vmauth:8427', env: 'staging' })
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    expect(storeConfig()).toBeNull()
  })
  it('refuses a URL that is not http(s)', () => {
    process.env.TELEMETRY_STORE_URL = 'file:///etc/passwd'
    expect(storeConfig()).toBeNull()
  })
  it('writes access lines only when switched on, never in cloud mode', () => {
    expect(accessLogEnabled()).toBe(false)
    process.env.TELEMETRY_ACCESS_LOG = 'on'
    expect(accessLogEnabled()).toBe(true)
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    expect(accessLogEnabled()).toBe(false)
  })
})

describe('LogsQL building', () => {
  it('quotes values so they cannot break out of the string', () => {
    expect(lq('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"')
    expect(lq('x" | delete')).toBe('"x\\" | delete"')
  })
  it('matches error text literally and case-insensitively', () => {
    expect(containsRe('Timeout (15s) [db]')).toBe('(?i)Timeout \\(15s\\) \\[db\\]')
    expect(new RegExp(containsRe('a.b').slice(4), 'i').test('aXb')).toBe(false)
  })
  it('scopes every query to the env and the access lines', () => {
    expect(baseFilter('staging')).toBe('{env="staging"} nvr:=api')
    expect(baseFilter(null)).toBe('nvr:=api')
  })
  it('builds a search filter from typed parameters only', () => {
    const f = searchFilter(
      {
        kind: 'first_error',
        caller: 'u7a0411f3-c687-40e5-adf5-614157cf88ec',
        route: 'GET /api/items/workflows/:id',
        entity: 'items/workflows',
        error: 'deadlock',
        days: 30
      },
      'production'
    )
    expect(f).toBe(
      '{env="production"} nvr:=api caller:="u7A0411F3-C687-40E5-ADF5-614157CF88EC" route:="GET /api/items/workflows/:id" entity:="items/workflows" status:>=400 err:~"(?i)deadlock"'
    )
    expect(searchFilter({ kind: 'last_hit', caller: 'anon', days: 30 }, null)).toBe(
      'nvr:=api caller:="anon"'
    )
  })
})

describe('reading the store', () => {
  it('parses newline-delimited JSON and skips a cut-off last line', () => {
    expect(parseNdjson('{"n":"3"}\n\n{"n":"4"}\n{"n":')).toEqual([{ n: '3' }, { n: '4' }])
  })
  it('sends the read token and the time range, and reports a failing store', async () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    process.env.TELEMETRY_STORE_TOKEN = 'read-token'
    let seen: { url: string; init: RequestInit } | null = null
    setStoreFetchForTests(async (url, init) => {
      seen = { url, init }
      return answer([{ n: '1' }])
    })
    const rows = await logsQuery('nvr:=api | stats count() as n', 0, 3_600_000)
    expect(rows).toEqual([{ n: '1' }])
    expect(seen!.url).toBe('http://store:8427/select/logsql/query')
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer read-token')
    const body = new URLSearchParams(String(seen!.init.body))
    expect(body.get('start')).toBe('1970-01-01T00:00:00.000Z')
    expect(body.get('end')).toBe('1970-01-01T01:00:00.000Z')

    setStoreFetchForTests(async () => new Response('nope', { status: 401 }))
    await expect(logsQuery('nvr:=api', 0, 1)).rejects.toBeInstanceOf(StoreUnavailableError)
  })
  it('answers a busiest-hour search from store buckets', async () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    const queries: string[] = []
    setStoreFetchForTests(async (_url, init) => {
      const q = new URLSearchParams(String(init.body)).get('query') ?? ''
      queries.push(q)
      if (q.endsWith('stats count() as n')) return answer([{ n: '42' }])
      return answer([
        { _time: '2026-09-20T14:00:00Z', n: '30' },
        { _time: '2026-09-21T09:00:00Z', n: '12' }
      ])
    })
    const a = await storeSearch(
      { kind: 'busiest_hour', route: 'GET /api/my-work', days: 30 },
      0,
      Date.parse('2026-10-19T00:00:00Z')
    )
    expect(a.count).toBe(42)
    expect(a.hit).toEqual({
      at: Date.parse('2026-09-20T14:00:00Z'),
      until: Date.parse('2026-09-20T15:00:00Z'),
      n: 30
    })
    expect(a.more).toHaveLength(1)
    expect(queries[1]).toContain('stats by (_time:1h) count() as n')
  })
  it('reports status without throwing when the store is down', async () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    setStoreFetchForTests(async () => {
      throw new TypeError('fetch failed')
    })
    const s = await storeStatus()
    expect(s).toMatchObject({ configured: true, reachable: false })
    expect(s.error).toMatch(/did not answer/)
  })
})

describe('mapping store rows', () => {
  const from = Date.parse('2026-09-19T00:00:00Z')
  const to = from + 30 * 86_400_000
  it('places buckets on steps and ignores rows outside the window', () => {
    expect(stepIndex(from, from, to, 21600)).toBe(0)
    expect(stepIndex(from + 21600_000 * 3 + 5, from, to, 21600)).toBe(3)
    expect(stepIndex(from - 1, from, to, 21600)).toBe(-1)
    expect(stepIndex(to, from, to, 21600)).toBe(-1)
  })
  it('turns stats rows into time-lapse groups keyed like the map', () => {
    const g = stepsFromRows(
      [
        { _time: '2026-09-19T06:00:00Z', entity: 'items/workflows', n: '120', e: '3', p95: '412' },
        { _time: '2026-09-19T06:00:00Z', entity: '', n: '1', e: '0', p95: '1' }
      ],
      from,
      to,
      21600
    )
    expect(g).toEqual([{ s: 1, key: 'e:items/workflows', n: 120, e: 3, p95: 412 }])
  })
  it('builds SLO instances from per-day store figures', () => {
    const [inst] = storeInstances(
      {
        days: [
          { instance: 'api-1', day: '2026-09-21', n: 1000, e5: 1, e4: 20, p95: 300 },
          { instance: 'api-1', day: '2026-09-20', n: 1000, e5: 3, e4: 10, p95: 500 }
        ],
        p95ByInstance: new Map([['api-1', 450]])
      },
      { availability_pct: 99.5, p95_ms: 2000, window_days: 30 },
      () => ({ h1: null, h6: null, h24: 0 })
    )
    expect(inst).toMatchObject({
      instance: 'api-1',
      requests: 2000,
      errors_5xx: 4,
      errors_4xx: 30,
      availability_pct: 99.8,
      p95_ms: 450,
      budget: { allowed: 10, consumed: 4, remaining_pct: 60 },
      meets: { availability: true, p95: true }
    })
    expect(inst.days.map((d) => d.day)).toEqual(['2026-09-20', '2026-09-21'])
  })
})

describe('the access line', () => {
  it('carries ids, route template, status and timing only', () => {
    const line = accessLogLine({
      method: 'PATCH',
      path: '/api/items/workflows/284212',
      status: 500,
      latency_ms: 812,
      user: '7a0411f3-c687-40e5-adf5-614157cf88ec',
      api_key_id: null,
      auth: 'session',
      collection: 'workflows',
      error: 'x'.repeat(400),
      request_id: 'req-1',
      instance: 'api-1'
    })
    expect(line).toMatchObject({
      nvr: 'api',
      method: 'PATCH',
      route: 'PATCH /api/items/workflows/:id',
      caller: 'u7A0411F3-C687-40E5-ADF5-614157CF88EC',
      status: 500,
      ms: 812,
      coll: 'workflows',
      rid: 'req-1',
      inst: 'api-1'
    })
    expect(String(line.entity)).toMatch(/workflows/)
    expect(String(line.err)).toHaveLength(300)
    expect(line).not.toHaveProperty('path')
    expect(line).not.toHaveProperty('ip')
    expect(line).not.toHaveProperty('query')
  })
  it('names an API key caller by key id', () => {
    const line = accessLogLine({
      method: 'GET',
      path: '/api/my-work',
      status: 200,
      latency_ms: 5,
      user: null,
      api_key_id: 12,
      auth: 'api_key',
      collection: null,
      error: null,
      instance: 'api-1'
    })
    expect(line.caller).toBe('k12')
    expect(line).not.toHaveProperty('err')
  })
})
