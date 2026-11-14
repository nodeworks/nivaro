import { describe, expect, it } from 'vitest'
import {
  callsBehind,
  callWindowMs,
  deviceMix,
  replayAt,
  requestWindows,
  summarisePages,
  type TimingRow,
  visitForTiming
} from './slow-screens-logic.js'
import type { Visit } from './traffic-inspect/people-ux-logic.js'

const T0 = Date.UTC(2026, 10, 10, 15, 0, 0)

const timing = (
  page: string,
  ms: number,
  at: number,
  extra: Partial<TimingRow> = {}
): TimingRow => ({
  page,
  app: 'admin',
  kind: 'route',
  ms,
  ttfb_ms: null,
  at,
  browser: 'Chrome 126',
  os: 'Windows',
  screen: 'desktop',
  ...extra
})

const visit = (page: string, start: number, end = start + 60_000): Visit => ({
  user: 'U1',
  session: 's',
  page,
  app: 'admin',
  start,
  end
})

describe('summarisePages', () => {
  it('ranks pages by p95, with how often, median, worst and the slowest visits', () => {
    const rows = [
      ...[100, 120, 140, 160, 9000].map((ms, i) =>
        timing('/collections/:c/:id', ms, T0 + i * 1000)
      ),
      ...[2000, 2100, 2200].map((ms, i) =>
        timing('/dashboards/:id', ms, T0 + i * 1000, { kind: 'load' })
      ),
      timing('/', 50, T0)
    ]
    const pages = summarisePages(rows)
    expect(pages.map((p) => p.page)).toEqual(['/collections/:c/:id', '/dashboards/:id', '/'])
    const record = pages[0]
    expect(record).toMatchObject({
      n: 5,
      moves: 5,
      loads: 0,
      median_ms: 140,
      p95_ms: 9000,
      worst_ms: 9000
    })
    expect(record.slow_visits.map((v) => v.ms)).toEqual([9000, 160, 140])
    expect(pages[1]).toMatchObject({ loads: 3, median_ms: 2100 })
  })

  it('splits a page by browser and screen size', () => {
    const rows = [
      timing('/a', 100, T0),
      timing('/a', 300, T0, { browser: 'Safari 17', os: 'iOS', screen: 'phone' }),
      timing('/a', 500, T0, { browser: 'Safari 17', os: 'iOS', screen: 'phone' })
    ]
    const [p] = summarisePages(rows)
    expect(p.devices[0]).toMatchObject({
      browser: 'Safari 17',
      screen: 'phone',
      n: 2,
      median_ms: 500
    })
    expect(deviceMix(rows)).toEqual({
      browsers: [
        { name: 'Safari 17 · iOS', n: 2 },
        { name: 'Chrome 126 · Windows', n: 1 }
      ],
      screens: [
        { name: 'phone', n: 2 },
        { name: 'desktop', n: 1 }
      ]
    })
  })
})

describe('calls behind a page', () => {
  const visits = [visit('/a', T0), visit('/a', T0 + 600_000)]

  it('reads only the first seconds of each visit, merged into few windows', () => {
    expect(callWindowMs(200)).toBe(5_000)
    expect(callWindowMs(12_000)).toBe(13_500)
    expect(callWindowMs(120_000)).toBe(30_000)
    expect(
      requestWindows([
        { visits, windowMs: 5_000 },
        { visits: [visit('/b', T0 + 2_000)], windowMs: 5_000 }
      ])
    ).toEqual([
      [T0, T0 + 7_000],
      [T0 + 600_000, T0 + 605_000]
    ])
  })

  it('ranks the calls made while the page loaded, slowest first, leaving out beacons', () => {
    const req = (at: number, path: string, latency: number, status = 200) => ({
      at,
      method: 'GET',
      path,
      status,
      latency_ms: latency
    })
    const calls = callsBehind(
      visits,
      [
        req(T0 + 100, '/api/items/orders/:id', 4000),
        req(T0 + 600_200, '/api/items/orders/:id', 6000),
        req(T0 + 300, '/api/collections', 80),
        req(T0 + 400, '/api/rum', 5),
        req(T0 + 500, '/api/comments', 300, 500),
        // after the load window: browsing, not loading
        req(T0 + 20_000, '/api/items/slow-report', 30_000)
      ],
      5_000
    )
    expect(calls.map((c) => c.path)).toEqual([
      '/api/items/orders/:id',
      '/api/comments',
      '/api/collections'
    ])
    expect(calls[0]).toMatchObject({ n: 2, visits: 2, worst_ms: 6000, errors: 0 })
    expect(calls[1].errors).toBe(1)
  })
})

describe('slow visit → replay', () => {
  it('ties a timing to the visit it measured and finds the recording running then', () => {
    const own = [visit('/a', T0), visit('/a', T0 + 120_000), visit('/b', T0 + 125_000)]
    // beacon arrived 8 s after a 3 s route change that began at T0 + 120 s
    const t = timing('/a', 3_000, T0 + 131_000)
    expect(visitForTiming(own, t)?.start).toBe(T0 + 120_000)
    expect(visitForTiming(own, timing('/c', 100, T0))).toBeNull()

    const recordings = [
      { id: 'old', started_at: T0 - 3_600_000, ended_at: T0 - 1_000 },
      { id: 'live', started_at: T0 + 60_000, ended_at: null }
    ]
    expect(replayAt(recordings, T0 + 120_000, T0 + 200_000)).toEqual({
      recording_id: 'live',
      offset_ms: 58_000
    })
    expect(replayAt(recordings, T0 + 10_000, T0 + 200_000)).toBeNull()
  })
})
