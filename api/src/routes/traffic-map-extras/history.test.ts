import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const searchHistory = vi.fn()
const routeRows = vi.fn()
const saveMinuteSettings = vi.fn()
const schedule = vi.fn()
vi.mock('../../services/traffic-history-reads.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    CALLER_KEY: real.CALLER_KEY,
    ENTITY_KEY: real.ENTITY_KEY,
    ROUTE_RE: real.ROUTE_RE,
    searchHistory: (...a: unknown[]) => searchHistory(...a),
    routeRows: (...a: unknown[]) => routeRows(...a),
    jobInputs: vi.fn(async () => []),
    logSteps: vi.fn(async () => []),
    peopleSteps: vi.fn(async () => ({ online: [], active: [], sampled: false })),
    timelapseMarkers: vi.fn(async () => [])
  }
})
vi.mock('../../services/traffic-minutes.js', () => {
  class MinuteSettingsUnavailableError extends Error {}
  return {
    MinuteSettingsUnavailableError,
    minuteCoverage: vi.fn(async () => ({ table: false, first: null, last: null })),
    minuteSteps: vi.fn(async () => []),
    pruneMinuteRows: vi.fn(),
    readMinuteSettings: vi.fn(async () => ({ enabled: false, retention_days: 30, edges: true })),
    saveMinuteSettings: (...a: unknown[]) => saveMinuteSettings(...a),
    startMinuteStore: vi.fn(),
    writePushedMinutes: vi.fn()
  }
})
vi.mock('../../services/instance-roster.js', () => ({
  INSTANCE_ID: 'test0001',
  listInstances: vi.fn(async () => [])
}))
vi.mock('../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../services/traffic-taps/capacity.js', () => ({
  logMinutes: () => null,
  capacityReport: () => ({
    now_rps: 10,
    ceiling: { rps: 50 },
    pool: { used: 4, max: 20 },
    projection: { pool_per_rps: 0.4 }
  })
}))
vi.mock('../../services/traffic-taps/node-health.js', () => ({
  nodeHealth: () => ({ loop: { p99: 20 } })
}))

import { historyRoutes } from './history.js'

async function app() {
  const a = Fastify()
  a.decorate('cron', { schedule, list: () => [] } as never)
  await a.register(historyRoutes)
  return a
}

afterEach(() => {
  searchHistory.mockReset()
  routeRows.mockReset()
  saveMinuteSettings.mockReset()
})

describe('history routes', () => {
  it('registers the minute-store crons', async () => {
    await app()
    const ids = schedule.mock.calls.map((c) => c[0])
    expect(ids).toContain('traffic-minutes-write')
    expect(ids).toContain('traffic-minutes-prune')
  })

  it('refuses malformed searches before reading anything', async () => {
    const a = await app()
    const bad = [
      '/history/search?kind=drop',
      '/history/search?kind=last_hit',
      '/history/search?kind=last_hit&caller=robert',
      '/history/search?kind=last_hit&route=SELECT%20*',
      '/history/search?kind=first_error&error=ab',
      '/history/search?kind=last_hit&partner=ext:1',
      '/history/search?kind=busiest_hour&entity=items/x&days=90'
    ]
    for (const url of bad) {
      const res = await a.inject({ url })
      expect(res.statusCode, url).toBe(400)
    }
    expect(searchHistory).not.toHaveBeenCalled()
  })

  it('passes a valid search through', async () => {
    searchHistory.mockResolvedValue({ kind: 'busiest_hour', hit: null, more: [], count: 0 })
    const a = await app()
    const res = await a.inject({ url: '/history/search?kind=busiest_hour&partner=ext:12&days=31' })
    expect(res.statusCode).toBe(200)
    // The route also passes the request time and a client-gone signal.
    expect(searchHistory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'busiest_hour', partner: 'ext:12', days: 31 }),
      expect.any(Number),
      expect.any(AbortSignal)
    )
  })

  it('reads one route for the histogram and the slow parameters (shared read)', async () => {
    routeRows.mockResolvedValue({
      latencies: [10, 20],
      rows: [
        { latency_ms: 10, query: null },
        { latency_ms: 20, query: 'limit=5' }
      ],
      truncated: false
    })
    const a = await app()
    const q = 'key=items/workflows&route=GET%20/api/items/workflows/:id&hours=24'
    const d = await a.inject({ url: `/history/route-latency?${q}` })
    expect(d.statusCode).toBe(200)
    expect(d.json().data.total).toBe(2)
    const s = await a.inject({ url: `/history/slow-params?${q}` })
    expect(s.statusCode).toBe(200)
    expect(s.json().data.total).toBe(2)
    expect(routeRows).toHaveBeenCalledTimes(1)
    expect(
      (await a.inject({ url: '/history/route-latency?key=x&route=GET%20/a&hours=3' })).statusCode
    ).toBe(400)
  })

  it('projects a what-if and validates it', async () => {
    const a = await app()
    const res = await a.inject({ url: '/capacity/what-if?traffic_pct=50&add_replicas=1' })
    expect(res.statusCode).toBe(200)
    const body = res.json().data
    expect(body.replicas).toEqual({ now: 1, projected: 2 })
    expect(body.projected.rps_per_replica).toBe(7.5)
    expect((await a.inject({ url: '/capacity/what-if?traffic_pct=5000' })).statusCode).toBe(400)
    expect((await a.inject({ url: '/capacity/what-if?job=nightly' })).statusCode).toBe(400)
  })

  it('saves settings through the service and maps its refusals', async () => {
    saveMinuteSettings.mockRejectedValueOnce(
      new Error('retention_days must be a whole number of days from 1 to 90')
    )
    const a = await app()
    const res = await a.inject({
      method: 'PUT',
      url: '/history/settings',
      payload: { retention_days: 0 }
    })
    expect(res.statusCode).toBe(400)
    saveMinuteSettings.mockResolvedValueOnce({ enabled: true, retention_days: 30, edges: true })
    const ok = await a.inject({
      method: 'PUT',
      url: '/history/settings',
      payload: { enabled: true }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.settings.enabled).toBe(true)
  })

  it('validates the time-lapse range', async () => {
    const a = await app()
    expect((await a.inject({ url: '/history/timelapse?range=1y' })).statusCode).toBe(400)
    const ok = await a.inject({ url: '/history/timelapse?range=24h' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.frames).toHaveLength(288)
  })
})
