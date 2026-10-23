import { afterEach, describe, expect, it } from 'vitest'
import {
  evalEventLoop,
  evalRouteSpike,
  judgeEventLoop,
  judgeRouteSpike,
  type NodeSignals,
  normalizeEventLoopConfig,
  normalizeRouteSpikeConfig,
  readNodeSignals,
  routeKeyOf,
  SignalBook
} from '../../../services/ops-signals.js'

const T0 = Date.UTC(2026, 9, 23, 16, 0, 0) // 12:00 PM ET
const MIN = 60_000

/** One node's summary after `fill` ran against a fresh book started at `start`. */
function nodeOf(
  fill: (b: SignalBook) => void,
  opts: { start?: number; now: number; node?: string }
): NodeSignals {
  const b = new SignalBook(opts.start ?? T0)
  fill(b)
  return { ...b.summary(opts.now), node: opts.node ?? 'staging · web-1' }
}

/** `perMinute` requests on `route` every minute in [from, to). */
function steady(b: SignalBook, route: string, perMinute: number, from: number, to: number) {
  for (let t = from; t < to; t += MIN) {
    for (let i = 0; i < perMinute; i++) b.noteRequest(route, t + (i % 59) * 1000)
  }
}

describe('SignalBook', () => {
  it('keeps the highest lag per minute and marks minutes without samples', () => {
    const b = new SignalBook(T0)
    b.noteLag(120, T0 + 1000)
    b.noteLag(2300, T0 + 20_000)
    b.noteLag(40, T0 + 50_000)
    b.noteLag(900, T0 + MIN + 5000)
    const s = b.summary(T0 + 2 * MIN + 1000)
    expect(s.lag[0]).toBe(-1) // nothing sampled yet this minute
    expect(s.lag[1]).toBe(900)
    expect(s.lag[2]).toBe(2300)
    expect(s.lag).toHaveLength(10)
  })

  it('splits route counts into recent minutes and the hour before them', () => {
    const b = new SignalBook(T0)
    steady(b, 'GET /api/presence/online', 30, T0, T0 + 70 * MIN)
    const s = b.summary(T0 + 70 * MIN + 10_000)
    const r = s.routes.find((x) => x.route === 'GET /api/presence/online')
    expect(r?.recent).toEqual([0, 30, 30, 30, 30, 30, 30])
    expect(r?.baseline).toBe(60 * 30)
    expect(s.total.recent[1]).toBe(30)
    expect(s.history_minutes).toBe(70)
  })

  it('publishes only the busiest routes', () => {
    const b = new SignalBook(T0)
    for (let i = 0; i < 60; i++) b.noteRequest(`GET /api/r${i}`, T0 + 1000)
    b.noteRequest('GET /api/r0', T0 + 2000)
    const s = b.summary(T0 + MIN + 1000)
    expect(s.routes).toHaveLength(40)
    expect(s.routes[0].route).toBe('GET /api/r0')
  })
})

describe('routeKeyOf', () => {
  it('uses the Fastify route url, else the fallback template', () => {
    const fb = (m: string, p: string) => `${m} ${p.replace(/\d+/g, ':id')}`
    expect(
      routeKeyOf(
        {
          method: 'get',
          path: '/api/items/x/5',
          req: { routeOptions: { url: '/api/items/:c/:id' } }
        },
        fb
      )
    ).toBe('GET /api/items/:c/:id')
    expect(routeKeyOf({ method: 'GET', path: '/api/nope/42' }, fb)).toBe('GET /api/nope/:id')
  })
})

describe('judgeEventLoop', () => {
  it('is unknown with no published node', () => {
    expect(judgeEventLoop([], {}).status).toBe('unknown')
  })

  it('fires on the demo pattern: lag over 1 s in 3+ of 5 minutes on one node', () => {
    // 12:07–12:11 PM ET on 2026-10-23: 1306, 2367, 3315, 2966, 4367 ms.
    const stalled = nodeOf(
      (b) => {
        ;[1306, 2367, 3315, 2966, 4367].forEach((ms, i) => {
          b.noteLag(ms, T0 + (7 + i) * MIN + 1000)
        })
      },
      { now: T0 + 12 * MIN + 1000 }
    )
    const calm = nodeOf((b) => b.noteLag(150, T0 + 11 * MIN), {
      now: T0 + 12 * MIN + 1000,
      node: 'staging · web-2'
    })
    const v = judgeEventLoop([stalled, calm], {})
    expect(v.status).toBe('failing')
    expect(v.metric).toBe(4367)
    expect(v.detail).toContain('web-1')
    expect(v.detail).toContain('← stalled')
    expect(v.detail).not.toMatch(/web-2.*stalled/)
  })

  it('stays ok for a lone GC pause or two isolated stalls', () => {
    const n = nodeOf(
      (b) => {
        b.noteLag(3000, T0 + 2 * MIN)
        b.noteLag(1500, T0 + 7 * MIN)
      },
      { now: T0 + 9 * MIN + 1000 }
    )
    expect(judgeEventLoop([n], {}).status).toBe('ok')
  })

  it('honours a configured threshold and breach count', () => {
    const n = nodeOf(
      (b) => {
        b.noteLag(600, T0 + 1 * MIN)
        b.noteLag(700, T0 + 2 * MIN)
      },
      { now: T0 + 3 * MIN + 1000 }
    )
    expect(judgeEventLoop([n], { threshold_ms: 500, breach_minutes: 2 }).status).toBe('failing')
    expect(normalizeEventLoopConfig({ breach_minutes: 9, window_minutes: 4 })).toEqual({
      threshold_ms: 1000,
      breach_minutes: 4,
      window_minutes: 4
    })
  })
})

describe('judgeRouteSpike', () => {
  const NOW = T0 + 70 * MIN + 10_000
  const ROUTE = 'GET /api/presence/online'

  /** 250 people's ordinary traffic: ~120 req/s spread over many routes. */
  function normalTraffic(b: SignalBook, until: number, from = T0) {
    steady(b, ROUTE, 600, from, until) // 10 req/s
    steady(b, 'GET /api/items/:collection', 2400, from, until) // 40 req/s
    steady(b, 'GET /api/items/:collection/:id', 1800, from, until) // 30 req/s
    steady(b, 'POST /api/presence/ping', 1000, from, until)
    steady(b, 'PATCH /api/items/:collection/:id', 1400, from, until)
  }

  it('stays quiet on steady 250-person traffic (~120 req/s total)', () => {
    const a = nodeOf((b) => normalTraffic(b, T0 + 70 * MIN), { now: NOW })
    const c = nodeOf((b) => normalTraffic(b, T0 + 70 * MIN), { now: NOW, node: 'staging · web-2' })
    const v = judgeRouteSpike([a, c], {})
    expect(v.status).toBe('ok')
  })

  it('stays quiet on a morning sign-in wave (every route grows together)', () => {
    const n = nodeOf(
      (b) => {
        steady(b, ROUTE, 30, T0, T0 + 60 * MIN)
        steady(b, 'GET /api/items/:collection', 120, T0, T0 + 60 * MIN)
        // Everyone arrives: every route ×20 at once.
        steady(b, ROUTE, 600, T0 + 60 * MIN, T0 + 70 * MIN)
        steady(b, 'GET /api/items/:collection', 2400, T0 + 60 * MIN, T0 + 70 * MIN)
      },
      { now: NOW }
    )
    expect(judgeRouteSpike([n], {}).status).toBe('ok')
    // Without the share guard the same wave fires.
    expect(judgeRouteSpike([n], { share_factor: 0 }).status).toBe('failing')
  })

  it('fires when one route swallows the traffic (the presence refetch storm)', () => {
    const n = nodeOf(
      (b) => {
        normalTraffic(b, T0 + 66 * MIN)
        // 12:06 PM: presence/online jumps to ~60 req/s, the rest unchanged.
        steady(b, ROUTE, 3600, T0 + 66 * MIN, T0 + 70 * MIN)
        steady(b, 'GET /api/items/:collection', 2400, T0 + 66 * MIN, T0 + 70 * MIN)
      },
      { now: NOW }
    )
    const v = judgeRouteSpike([n], {})
    expect(v.status).toBe('failing')
    expect(v.detail).toContain(ROUTE)
    expect(v.metric).toBe(60)
  })

  it('sums a route across nodes before judging it', () => {
    const make = (node: string) =>
      nodeOf(
        (b) => {
          steady(b, 'GET /api/items/:collection', 1200, T0, T0 + 70 * MIN)
          steady(b, ROUTE, 60, T0, T0 + 66 * MIN)
          steady(b, ROUTE, 720, T0 + 66 * MIN, T0 + 70 * MIN) // 12 req/s per node
        },
        { now: NOW, node }
      )
    // One node alone (12 req/s) is under the 20 req/s floor; two together (24 req/s) are not.
    expect(judgeRouteSpike([make('a')], {}).status).toBe('ok')
    expect(judgeRouteSpike([make('a'), make('b')], {}).status).toBe('failing')
  })

  it('leaves young processes out of the comparison but counts them for a ceiling', () => {
    const young = nodeOf((b) => steady(b, ROUTE, 3000, T0 + 60 * MIN, T0 + 70 * MIN), {
      start: T0 + 60 * MIN,
      now: NOW
    })
    expect(judgeRouteSpike([young], {}).status).toBe('unknown')
    const v = judgeRouteSpike([young], { ceiling_rps: 40 })
    expect(v.status).toBe('failing')
    expect(v.detail).toContain('ceiling')
  })

  it('normalizes config with conservative defaults', () => {
    expect(normalizeRouteSpikeConfig({})).toEqual({
      factor: 5,
      min_rps: 20,
      sustain_minutes: 2,
      share_factor: 2,
      min_history_minutes: 15,
      ceiling_rps: null
    })
    expect(
      normalizeRouteSpikeConfig({ sustain_minutes: 40, ceiling_rps: '' }).sustain_minutes
    ).toBe(6)
  })
})

describe('readNodeSignals', () => {
  it('reads live summaries and drops stale or foreign values', async () => {
    const live = nodeOf(() => {}, { now: T0 })
    const store = new Map<string, string>([
      ['nvr:ops-signals:a', JSON.stringify(live)],
      ['nvr:ops-signals:b', JSON.stringify({ ...live, at: T0 - 10 * MIN })],
      ['nvr:ops-signals:c', 'not json'],
      ['nvr:ops-signals:d', JSON.stringify({ v: 2 })]
    ])
    const redis = {
      async scan() {
        return ['0', [...store.keys()]]
      },
      async mget(keys: string[]) {
        return keys.map((k) => store.get(k) ?? null)
      }
    } as any
    const out = await readNodeSignals(redis, T0 + 1000)
    expect(out).toHaveLength(1)
    expect(await readNodeSignals(null)).toEqual([])
  })
})

describe('cloud mode', () => {
  afterEach(() => {
    delete process.env.CLOUD_META_DB_URL
  })
  it('answers unknown instead of judging shared process state', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect((await evalEventLoop({})).status).toBe('unknown')
    expect((await evalRouteSpike({})).detail).toMatch(/cloud mode/)
  })
})
