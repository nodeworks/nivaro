// api/src/test/unit/services/traffic-ops.test.ts — Traffic Map group E (ops, health, capacity)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trace = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => (trace.id ? { id: trace.id, urlHint: null, userId: null } : null))
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
const aiRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'select', 'limit', 'orderBy', 'whereNot'])
    chain[m] = vi.fn(() => chain)
    // biome-ignore lint/suspicious/noThenProperty: knex query builders are thenables
  ;(chain as { then: unknown }).then = (res: (v: unknown) => unknown) => res(aiRows.rows)
  const db = Object.assign(
    vi.fn(() => chain),
    { client: { pool: { numUsed: () => 3, numPendingAcquires: () => 0, max: 10 } } }
  )
  return { db }
})

import {
  type Breaker,
  breakerExempt,
  callerBreakerCheck,
  entityBreakerHook,
  entityOfRequest,
  judgeBreaker,
  matchBreaker,
  setActiveBreakersForTest,
  validTarget
} from '../../../services/traffic-breaker.js'
import {
  attachInflightQueries,
  inflightEnd,
  inflightStart,
  listInflight,
  oldestRunning,
  pickSession,
  requestSqlStats,
  resetInflight,
  statementNeedle
} from '../../../services/traffic-inflight.js'
import { advanceTo, noteRequest, resetTrafficMap } from '../../../services/traffic-map.js'
import { addCost, callerCost, validCallerKey } from '../../../services/traffic-taps/caller-cost.js'
import {
  bestMinute,
  capacityReport,
  poolPerRps,
  projectLoad,
  seasonalRatio,
  setLogMinutesForTest
} from '../../../services/traffic-taps/capacity.js'
import {
  bootMarkers,
  epochMarkersIn,
  noteEpochMove
} from '../../../services/traffic-taps/change-markers.js'
import { type HealthSample, summarizeHealth } from '../../../services/traffic-taps/node-health.js'
import {
  FANOUT_LIMIT,
  LOAD_IDLE_S,
  normalizeApp,
  normalizeLoadId,
  normalizeScreenPath,
  screenKey,
  screensFor,
  screensReport
} from '../../../services/traffic-taps/screens.js'

const T0 = 1_800_000_000
const at = (sec: number) => sec * 1000
function req(
  headers: Record<string, string>,
  over: Partial<Parameters<typeof noteRequest>[0]> = {}
): void {
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 30,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'aaaaaaaa-0000-0000-0000-000000000001',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: at(T0),
    req: { headers },
    ...over
  })
}
const U1 = 'uAAAAAAAA-0000-0000-0000-000000000001'

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
  trace.id = null
})
afterEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.TRAFFIC_CAPACITY_RPS
  setActiveBreakersForTest([])
  resetInflight()
})

describe('#1113 screen headers', () => {
  it('turns a path into a pattern: ids, uuids, tokens and emails become :id', () => {
    expect(normalizeScreenPath('/collections/workflows/371367')).toBe('/collections/workflows/:id')
    expect(normalizeScreenPath('/records/workflows/CR26-80329?tab=1#x')).toBe(
      '/records/workflows/:id'
    )
    expect(normalizeScreenPath('/users/aaaaaaaa-1111-2222-3333-444444444444/a%40b.com/edit')).toBe(
      '/users/:id/edit'
    )
    expect(normalizeScreenPath('/Traffic-Map')).toBe('/traffic-map')
    expect(normalizeScreenPath('/collections/:collection/:id')).toBe('/collections/:collection/:id')
  })
  it('refuses junk and caps the length', () => {
    expect(normalizeScreenPath('collections')).toBeNull()
    expect(normalizeScreenPath(42)).toBeNull()
    expect(normalizeScreenPath('')).toBeNull()
    expect(normalizeScreenPath('/<script>/x')).toBe('/:id/x')
    const long = `/${Array.from({ length: 40 }, () => 'segment').join('/')}`
    expect((normalizeScreenPath(long) ?? '').length).toBeLessThanOrEqual(140)
  })
  it('app and load id are checked', () => {
    expect(normalizeApp('Admin')).toBe('admin')
    expect(normalizeApp('efp new')).toBeNull()
    expect(screenKey('efp-new', '/records/workflows/1')).toBe('efp-new /records/workflows/:id')
    expect(screenKey(undefined, '/x')).toBe('/x')
    expect(normalizeLoadId('ab12cd34')).toBe('ab12cd34')
    expect(normalizeLoadId('bad id!')).toBeNull()
    expect(normalizeLoadId('x')).toBeNull()
  })
})

describe('#1113 / #1116 screens tap', () => {
  it('counts calls per screen, per caller and per entity', () => {
    const h = { 'x-nivaro-app': 'admin', 'x-nivaro-page': '/collections/workflows/12' }
    req(h)
    req(h)
    req({ 'x-nivaro-page': '/my-work' })
    req({}) // no header: not counted anywhere
    const r = screensReport(60, T0)
    const row = r.screens.find((s) => s.screen === 'admin /collections/workflows/:id')
    expect(row?.calls).toBe(2)
    expect(row?.app).toBe('admin')
    expect(row?.callers).toEqual([{ key: U1, n: 2 }])
    expect(screensFor('caller', U1, 60, T0).map((s) => s.screen)).toEqual([
      'admin /collections/workflows/:id',
      '/my-work'
    ])
    expect(screensFor('entity', 'items/workflows', 60, T0)[0].n).toBe(2)
  })
  it('groups by load id and flags a load past the limit (open or finished)', () => {
    const h = { 'x-nivaro-page': '/collections/workflows/9', 'x-nivaro-load': 'load000001' }
    for (let i = 0; i < FANOUT_LIMIT + 5; i++)
      req(h, { path: `/api/items/workflows/${i % 3}`, at: at(T0) })
    let r = screensReport(300, T0)
    let row = r.screens[0]
    expect(row.max).toBe(FANOUT_LIMIT + 5)
    expect(row.worst?.open).toBe(true)
    expect(row.over_limit).toBe(true)
    expect(r.offenders[0]).toMatchObject({ screen: '/collections/workflows/:id' })
    // quiet long enough: the load finishes and the average counts it
    advanceTo(T0 + LOAD_IDLE_S + 1)
    req(
      { 'x-nivaro-page': '/collections/workflows/9', 'x-nivaro-load': 'load000002' },
      {
        at: at(T0 + LOAD_IDLE_S + 1)
      }
    )
    r = screensReport(300, T0 + LOAD_IDLE_S + 1)
    row = r.screens[0]
    expect(row.loads).toBe(2)
    expect(row.avg).toBe(FANOUT_LIMIT + 5)
    expect(row.worst?.routes[0].route).toBe('GET /api/items/workflows/:id')
  })
  it('caps distinct screens', () => {
    for (let i = 0; i < 200; i++)
      req({
        'x-nivaro-page': `/page-${'abcdefghij'[i % 10]}x${'klmnopqrst'[Math.floor(i / 10) % 10]}y${'uvwxyz'[Math.floor(i / 100) % 6]}`
      })
    expect(screensReport(60, T0).screens.length).toBeLessThanOrEqual(60)
  })
})

describe('#1147 / #1156 in flight', () => {
  it('tracks a request, its running statement and its SQL totals, and stamps them at the end', () => {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    attachInflightQueries({ on: (ev, fn) => listeners.set(ev, fn) })
    const fake = {
      method: 'GET',
      url: '/api/items/workflows?x=1',
      raw: { url: '/api/items/workflows?x=1' },
      routeOptions: { url: '/api/items/:collection' },
      authMethod: 'api_key',
      apiKeyId: 7
    }
    trace.id = '11111111-1111-1111-1111-111111111111'
    inflightStart(fake)
    listeners.get('query')?.({
      __knexQueryUid: 'q1',
      sql: 'select * from [workflows] where [id] = @p0'
    })
    const list = listInflight()
    expect(list.total).toBe(1)
    expect(list.rows[0]).toMatchObject({ route: '/api/items/:collection', caller: 'k7' })
    expect(list.rows[0].running[0].sql).toContain('select * from [workflows]')
    expect(oldestRunning(trace.id)?.route).toBe('/api/items/:collection')
    listeners.get('query-response')?.([{}, {}, {}], { __knexQueryUid: 'q1' })
    expect(listInflight().rows[0].running).toEqual([])
    expect(listInflight({ exclude: trace.id }).rows).toEqual([])
    inflightEnd(fake)
    expect(listInflight().total).toBe(0)
    expect(requestSqlStats(fake)).toMatchObject({ queries: 1, rows: 3 })
  })
  it('ignores requests outside a trace and stays silent in cloud mode', () => {
    inflightStart({ method: 'GET', url: '/api/x', raw: {} })
    expect(listInflight().total).toBe(0)
    process.env.CLOUD_META_DB_URL = 'x'
    trace.id = '22222222-2222-2222-2222-222222222222'
    inflightStart({ method: 'GET', url: '/api/x', raw: {} })
    expect(listInflight().total).toBe(0)
  })
  it('picks exactly one session by statement text and age, never guesses', () => {
    const sql = 'select   [id]\n from [workflows] where [x] = @p0'
    expect(statementNeedle(sql)).toBe('select [id] from [workflows] where [x] = @p0')
    const c = (session_id: number, age_ms: number, text: string) => ({ session_id, age_ms, text })
    const text = '(@p0 int)select [id] from [workflows] where [x] = @p0'
    expect(pickSession([c(61, 5000, text), c(62, 100, 'select 1')], sql, 5200)).toEqual({
      status: 'found',
      session_id: 61
    })
    expect(pickSession([c(61, 5000, text)], sql, 20_000)).toEqual({ status: 'none' })
    expect(pickSession([c(40, 5000, text)], sql, 5000)).toEqual({ status: 'none' })
    expect(pickSession([c(61, 5000, text), c(63, 5400, text)], sql, 5200)).toEqual({
      status: 'ambiguous',
      sessions: [61, 63]
    })
  })
})

describe('#1123 / #1153 capacity', () => {
  it('best minute and seasonal ratio from per-minute counts', () => {
    const counts = new Int32Array(8 * 1440)
    counts[100] = 600
    expect(bestMinute(counts)).toEqual({ n: 600, index: 100 })
    // every earlier day: 30 req/min before t, 60 after → ratio 2
    const start = 0
    const now = 7 * 1440 + 500
    for (let d = 1; d <= 7; d++) {
      const t = now - d * 1440
      for (let i = t - 15; i < t; i++) counts[i] = 30
      for (let i = t; i < t + 15; i++) counts[i] = 60
    }
    expect(seasonalRatio(counts, start, now)).toBe(2)
    expect(seasonalRatio(new Int32Array(100), 0, 50)).toBeNull()
  })
  it('projects a rising load and says when it passes the ceiling and the pool', () => {
    const minuteRps = Array.from({ length: 15 }, (_, i) => 1 + i * 0.5)
    const p = projectLoad({
      minuteRps,
      seasonalRatio: null,
      ceilingRps: 12,
      poolPerRps: 0.5,
      poolMax: 6
    })
    expect(p.trend).toBe('rising')
    expect(p.points).toHaveLength(15)
    expect(p.points[0]).toBeGreaterThan(7)
    expect(p.minutes_to_ceiling).toBe(9)
    expect(p.minutes_to_pool_limit).toBe(9)
    const flat = projectLoad({
      minuteRps: Array(15).fill(2),
      seasonalRatio: 1,
      ceilingRps: 100,
      poolPerRps: null,
      poolMax: 10
    })
    expect(flat.trend).toBe('flat')
    expect(flat.minutes_to_ceiling).toBeNull()
    expect(flat.minutes_to_pool_limit).toBeNull()
    expect(
      projectLoad({
        minuteRps: Array(15).fill(0),
        seasonalRatio: null,
        ceilingRps: null,
        poolPerRps: null,
        poolMax: null
      }).points.every((v) => v === 0)
    ).toBe(true)
  })
  it('pool use per req/s needs enough busy samples', () => {
    expect(poolPerRps([{ used: 2, rps: 4 }])).toBeNull()
    expect(
      poolPerRps([
        { used: 2, rps: 4 },
        { used: 2, rps: 4 },
        { used: 2, rps: 4 }
      ])
    ).toBe(0.5)
  })
  it('headroom: configured ceiling wins, else the measured busiest minute', () => {
    for (let s = 0; s < 60; s++) req({}, { at: at(T0 - s) })
    process.env.TRAFFIC_CAPACITY_RPS = '10'
    let r = capacityReport(T0)
    expect(r.now_rps).toBe(1)
    expect(r.ceiling).toMatchObject({ rps: 10, source: 'configured' })
    expect(r.headroom_pct).toBe(10)
    delete process.env.TRAFFIC_CAPACITY_RPS
    const counts = new Int32Array(7 * 1440 + 2)
    counts[3] = 300
    setLogMinutesForTest({
      start: Math.floor(T0 / 60) - 7 * 1440,
      counts,
      at: Date.now(),
      instanceFiltered: true
    })
    r = capacityReport(T0)
    expect(r.ceiling).toMatchObject({ rps: 5, source: 'measured', instance_filtered: true })
    expect(r.headroom_pct).toBe(20)
    expect(r.pool).toMatchObject({ used: 3, max: 10 })
    setLogMinutesForTest(null)
  })
})

describe('#1142 / #1101 node health', () => {
  it('folds samples in the window', () => {
    const s = (atSec: number, over: Partial<HealthSample> = {}): HealthSample => ({
      at: atSec,
      loop_p50: 1,
      loop_p99: 4,
      loop_max: 9,
      gc_count: 2,
      gc_ms: 3,
      gc_max: 2,
      emits: 5,
      emit_ms_max: 8,
      emit_ms: [1, 2, 8],
      unjournaled: 0,
      ...over
    })
    const sum = summarizeHealth(
      [s(T0 - 700), s(T0 - 30, { loop_p99: 40, loop_max: 120, unjournaled: 2 }), s(T0 - 5)],
      60,
      T0,
      6
    )
    expect(sum.loop.max).toBe(120)
    expect(sum.loop.p99).toBe(4)
    expect(sum.gc).toMatchObject({ count: 4, ms: 6, max: 2, per_min: 4 })
    expect(sum.journal).toMatchObject({ emits: 10, max_ms: 8, unjournaled: 2 })
    expect(Math.max(...sum.loop.series)).toBe(40)
  })
})

describe('#1093 change markers', () => {
  it('boots in range; a version change reads as a deploy', () => {
    const boots = [
      {
        started_at: '2026-10-01T10:00:00.000Z',
        ready_at: '2026-10-01T10:00:05.000Z',
        version: '0.2.8'
      },
      {
        started_at: '2026-10-01T11:00:00.000Z',
        ready_at: '2026-10-01T11:00:05.000Z',
        version: '0.2.9'
      },
      { started_at: '2026-10-01T12:00:00.000Z', ready_at: null, version: '0.2.9' }
    ]
    const m = bootMarkers(
      boots,
      Date.parse('2026-10-01T10:30:00Z'),
      Date.parse('2026-10-01T13:00:00Z')
    )
    expect(m.map((x) => x.kind)).toEqual(['deploy', 'boot'])
    expect(m[0].label).toBe('Deployed 0.2.9 (was 0.2.8)')
    // restarts within two minutes fold into one marker
    const burst = bootMarkers(
      [0, 30, 60, 400].map((s) => ({
        started_at: new Date(Date.parse('2026-10-01T12:00:00Z') + s * 1000).toISOString(),
        ready_at: null
      })),
      0,
      Date.parse('2026-10-02T00:00:00Z')
    )
    expect(burst.map((x) => x.label)).toEqual(['API restarted ×3', 'API restarted'])
  })
  it('epoch moves within 30 s fold into one marker', () => {
    noteEpochMove(1000, 1)
    noteEpochMove(5000, 2)
    noteEpochMove(60_000, 3)
    const m = epochMarkersIn(0, 100_000)
    expect(m.map((x) => x.at)).toEqual([1000, 60_000])
    expect(m[0].label).toBe('Configuration changed (epoch 2)')
    expect(epochMarkersIn(2000, 3000)).toEqual([])
  })
})

describe('#1122 caller cost', () => {
  it('adds requests to a caller hour and joins AI spend per hour', async () => {
    resetTrafficMap()
    advanceTo(T0)
    const sql = { queries: 4, sql_ms: 120, rows: 50 }
    const fake = { headers: {}, __nvrSql: sql }
    req({}, { req: fake, latencyMs: 200 })
    req({}, { req: fake, latencyMs: 100, status: 500 })
    aiRows.rows = [{ created_at: new Date(at(T0)), cost_usd: '0.25' }]
    const r = await callerCost(U1, T0)
    expect(r.hours).toHaveLength(1)
    expect(r.hours[0]).toMatchObject({
      req: 2,
      error: 1,
      ms: 300,
      db_ms: 240,
      queries: 8,
      rows: 100,
      ai_usd: 0.25,
      ai_calls: 1
    })
    expect(r.totals.ai_usd).toBe(0.25)
    expect(validCallerKey('k12')).toBe(true)
    expect(validCallerKey("u1'; drop")).toBe(false)
    const k = await callerCost('k12', T0)
    expect(k.ai_note).toMatch(/owner/)
  })
  it('caps the callers it keeps', () => {
    const s = { callers: new Map() }
    for (let i = 0; i < 320; i++)
      addCost(s, `k${i}`, T0 + i, { error: false, ms: 1, db_ms: 0, queries: 0, rows: 0 })
    expect(s.callers.size).toBe(300)
    expect(s.callers.has('k0')).toBe(false)
  })
})

describe('#1157 circuit breaker', () => {
  const now = Date.now()
  const b = (over: Partial<Breaker>): Breaker => ({
    kind: 'entity',
    target: 'items/workflows',
    mode: 'refuse',
    limit: null,
    until: now + 60_000,
    reason: 'incident',
    by: null,
    by_name: null,
    at: now,
    ...over
  })
  it('costs nothing and matches nothing with no breaker set', async () => {
    expect(matchBreaker('entity', 'items/workflows')).toBeNull()
    const reply = { code: vi.fn(), header: vi.fn(), send: vi.fn() }
    expect(
      await entityBreakerHook(
        { method: 'GET', raw: { url: '/api/items/workflows' }, url: '' },
        reply as never
      )
    ).toBe(false)
  })
  it('refuses an entity with 503 and the code; exempt paths pass', async () => {
    setActiveBreakersForTest([b({})])
    const sent: unknown[] = []
    const reply = {
      code: vi.fn(() => reply),
      header: vi.fn(() => reply),
      send: vi.fn((x: unknown) => sent.push(x))
    }
    expect(
      await entityBreakerHook(
        { method: 'GET', raw: { url: '/api/items/workflows/3?x=1' }, url: '' },
        reply as never
      )
    ).toBe(true)
    expect(reply.code).toHaveBeenCalledWith(503)
    expect((sent[0] as { code: string }).code).toBe('TRAFFIC_BREAKER_OPEN')
    expect(
      await entityBreakerHook(
        { method: 'GET', raw: { url: '/api/items/regions' }, url: '' },
        reply as never
      )
    ).toBe(false)
    for (const p of [
      '/api/auth/me',
      '/api/traffic-map/snapshot',
      '/api/health',
      '/api/version',
      '/api/ready',
      '/'
    ])
      expect(breakerExempt(p)).toBe(true)
    expect(breakerExempt('/api/items/x')).toBe(false)
  })
  it('expired breakers never match', () => {
    setActiveBreakersForTest([b({ until: now - 1 })])
    expect(matchBreaker('entity', 'items/workflows')).toBeNull()
  })
  it('limit mode counts per minute in Redis and answers 429 past the limit', async () => {
    let n = 0
    const redis = {
      incr: vi.fn(async () => ++n),
      expire: vi.fn(async () => 1),
      hgetall: vi.fn(),
      hset: vi.fn(),
      hdel: vi.fn()
    }
    const lim = b({ mode: 'limit', limit: 2 })
    setActiveBreakersForTest([lim], redis)
    expect(await judgeBreaker(lim)).toBeNull()
    expect(await judgeBreaker(lim)).toBeNull()
    const v = await judgeBreaker(lim)
    expect(v?.status).toBe(429)
    expect(redis.expire).toHaveBeenCalledTimes(1)
    redis.incr.mockRejectedValueOnce(new Error('down'))
    expect(await judgeBreaker(lim)).toBeNull() // fail open
  })
  it('caller breakers throw once per request, keyed by key or person', async () => {
    setActiveBreakersForTest([b({ kind: 'caller', target: 'k12' })])
    const r = { raw: { url: '/api/items/x' }, url: '', authMethod: 'api_key', apiKeyId: 12 }
    await expect(callerBreakerCheck(r)).rejects.toMatchObject({
      statusCode: 503,
      code: 'TRAFFIC_BREAKER_OPEN'
    })
    await expect(callerBreakerCheck(r)).rejects.toMatchObject({ statusCode: 503 })
    await expect(
      callerBreakerCheck({
        raw: { url: '/api/auth/me' },
        url: '',
        authMethod: 'api_key',
        apiKeyId: 12
      })
    ).resolves.toBeUndefined()
    await expect(
      callerBreakerCheck({ raw: { url: '/api/items/x' }, url: '', user: { id: 'abc' } })
    ).resolves.toBeUndefined()
  })
  it('targets and entities are validated / classified', () => {
    expect(validTarget('entity', 'items/workflows')).toBe(true)
    expect(validTarget('entity', 'items')).toBe(false)
    expect(validTarget('caller', 'k12')).toBe(true)
    expect(validTarget('caller', 'uabc')).toBe(false)
    expect(entityOfRequest('GET', '/api/items/workflows/12?x=1')).toBe('items/workflows')
  })
})
