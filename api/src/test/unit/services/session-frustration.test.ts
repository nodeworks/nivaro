import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  type ApiCall,
  abandonedForms,
  buildSessions,
  countLoops,
  DEFAULT_WEIGHTS,
  emptyCounts,
  isSlow,
  overlappingRecording,
  parseWeights,
  routeP95,
  type Step,
  scoreCounts,
  scoreSessions,
  topRoute,
  validateWeights
} from '../../../services/session-frustration.js'

const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const S = 1000
const USER = '7A0411F3-C687-40E5-ADF5-614157CF88EC'

const step = (path: string, startS: number, endS: number, known = true): Step => ({
  path,
  start: T0 + startS * S,
  end: T0 + endS * S,
  known
})

describe('buildSessions', () => {
  it('groups by session and UTC day; a step lasts its duration, else until the next step', () => {
    const sessions = buildSessions([
      { session_id: 'a', user: USER, path: '/x', entered_at: new Date(T0), duration_seconds: 30 },
      {
        session_id: 'a',
        user: USER,
        path: '/y',
        entered_at: new Date(T0 + 40 * S),
        duration_seconds: null
      },
      {
        session_id: 'a',
        user: USER,
        path: '/z',
        entered_at: new Date(T0 + 100 * S),
        duration_seconds: null
      },
      {
        session_id: 'b',
        user: USER,
        path: '/q',
        entered_at: '2026-10-01T23:59:00.000Z',
        duration_seconds: 10
      },
      {
        session_id: 'b',
        user: USER,
        path: '/q',
        entered_at: '2026-10-02T00:01:00.000Z',
        duration_seconds: 10
      }
    ])
    expect(sessions.map((s) => [s.session_id, s.day])).toEqual([
      ['a', '2026-10-01'],
      ['b', '2026-10-01'],
      ['b', '2026-10-02']
    ])
    const a = sessions[0]
    expect(a.steps.map((s) => [s.end - T0, s.known])).toEqual([
      [30 * S, true],
      [100 * S, true],
      [160 * S, false]
    ])
    expect(a.start).toBe(T0)
    expect(a.end).toBe(T0 + 160 * S)
  })
})

describe('countLoops', () => {
  it('counts A→B→A→B inside the window', () => {
    expect(
      countLoops([
        step('/list', 0, 5),
        step('/collections/w/1', 5, 10),
        step('/list?page=2', 10, 15),
        step('/collections/w/1', 15, 20)
      ])
    ).toBe(1)
  })
  it('browsing different records is not a loop; nor is a slow back-and-forth', () => {
    expect(
      countLoops([
        step('/list', 0, 5),
        step('/r/1', 5, 10),
        step('/list', 10, 15),
        step('/r/2', 15, 20)
      ])
    ).toBe(0)
    expect(
      countLoops([step('/a', 0, 5), step('/b', 60, 65), step('/a', 120, 125), step('/b', 180, 185)])
    ).toBe(0)
  })
  it('counts a long ping-pong without overlap, and collapses repeats of one page', () => {
    const pingPong = ['/a', '/b', '/b', '/a', '/b', '/a', '/b'].map((p, i) =>
      step(p, i * 5, i * 5 + 5)
    )
    // collapsed: a b a b a b → loops at a-b-a-b, then (from index 3) b-a-b
    expect(countLoops(pingPong)).toBe(1)
    const longer = ['/a', '/b', '/a', '/b', '/a', '/b', '/a'].map((p, i) =>
      step(p, i * 5, i * 5 + 5)
    )
    expect(countLoops(longer)).toBe(2)
  })
})

describe('abandonedForms', () => {
  const w = (atS: number, method: string, path: string) => ({ at: T0 + atS * S, method, path })
  it('a new-record form held 10 s+ without a POST to its collection is abandoned', () => {
    expect(abandonedForms([step('/collections/orders/new', 0, 30)], [])).toEqual({
      count: 1,
      routes: ['/collections/orders/new']
    })
    expect(
      abandonedForms([step('/collections/orders/new', 0, 30)], [w(25, 'POST', '/api/items/orders')])
    ).toEqual({ count: 0, routes: [] })
  })
  it('an edit form needs a minute; a PATCH to that item, or a write a few seconds after leaving, saves it', () => {
    expect(abandonedForms([step('/collections/orders/42', 0, 50)], []).count).toBe(0)
    expect(abandonedForms([step('/collections/orders/42', 0, 90)], []).routes).toEqual([
      '/collections/orders/:id'
    ])
    expect(
      abandonedForms(
        [step('/collections/orders/42', 0, 90)],
        [w(93, 'PATCH', '/api/items/orders/42')]
      ).count
    ).toBe(0)
  })
  it('a write to another collection or another item does not save it', () => {
    const writes = [w(10, 'PATCH', '/api/items/orders/43'), w(20, 'POST', '/api/items/customers')]
    expect(abandonedForms([step('/collections/orders/42', 0, 90)], writes).count).toBe(1)
  })
  it('unknown dwell, lists and the classic browser never count', () => {
    expect(abandonedForms([step('/collections/orders/42', 0, 600, false)], []).count).toBe(0)
    expect(abandonedForms([step('/collections/orders', 0, 600)], []).count).toBe(0)
    expect(abandonedForms([step('/collections/orders/classic', 0, 600)], []).count).toBe(0)
  })
})

describe('slow actions', () => {
  const call = (latency: number, path = '/api/items/orders/1', method = 'GET'): ApiCall => ({
    user: USER,
    at: T0,
    method,
    path,
    latency_ms: latency
  })
  it('p95 per method + route pattern, only with enough samples', () => {
    const calls = [
      ...Array.from({ length: 19 }, (_, i) => call(100 + i, `/api/items/orders/${i}`)),
      call(5000, '/api/items/orders/99')
    ]
    const p95 = routeP95(calls)
    expect(p95.get('GET /api/items/orders/:id')).toBe(118)
    expect(routeP95(calls.slice(0, 10)).size).toBe(0)
    expect(isSlow(call(5000), p95)).toBe(true)
    // Above p95 but under the 1 s floor: not a slow action.
    expect(isSlow(call(500), p95)).toBe(false)
    // Another method is another route.
    expect(isSlow(call(5000, '/api/items/orders/1', 'PATCH'), p95)).toBe(false)
  })
})

describe('scoreCounts', () => {
  it('is 0 with nothing, saturates toward 100, and caps each component', () => {
    expect(scoreCounts(emptyCounts()).score).toBe(0)
    const oneError = scoreCounts({ ...emptyCounts(), client_errors: 1 })
    expect(oneError.score).toBe(Math.round(100 * (1 - Math.exp(-8 / 25))))
    expect(oneError.points.client_errors).toBe(8)
    const lots = scoreCounts({ ...emptyCounts(), rage_clicks: 5, client_errors: 3, loops: 2 })
    expect(lots.score).toBeGreaterThan(90)
    expect(lots.score).toBeLessThanOrEqual(100)
    expect(scoreCounts({ ...emptyCounts(), slow_actions: 500 }).points.slow_actions).toBe(20)
  })
  it('weights steer it; zero turns a component off', () => {
    const w = { ...DEFAULT_WEIGHTS, client_errors: 0 }
    expect(scoreCounts({ ...emptyCounts(), client_errors: 4 }, w).score).toBe(0)
  })
})

describe('weights', () => {
  it('parses settings JSON, keeping defaults for anything missing or out of range', () => {
    expect(parseWeights(null)).toEqual(DEFAULT_WEIGHTS)
    expect(parseWeights('not json')).toEqual(DEFAULT_WEIGHTS)
    expect(parseWeights('{"rage_clicks": 10, "loops": -1, "scale": 50, "x": 3}')).toEqual({
      ...DEFAULT_WEIGHTS,
      rage_clicks: 10,
      scale: 50
    })
  })
  it('validates an edit strictly', () => {
    expect(validateWeights({ rage_clicks: 9 })).toEqual({ ...DEFAULT_WEIGHTS, rage_clicks: 9 })
    expect(validateWeights({ bogus: 1 })).toHaveProperty('error')
    expect(validateWeights({ loops: 101 })).toHaveProperty('error')
    expect(validateWeights({ loops: 'x' })).toHaveProperty('error')
    expect(validateWeights({ scale: 0 })).toHaveProperty('error')
    expect(validateWeights([1])).toHaveProperty('error')
  })
})

describe('scoreSessions', () => {
  it('assigns each signal to one session of that person and explains the score', () => {
    const sessions = buildSessions([
      {
        session_id: 's1',
        user: USER,
        path: '/collections/orders/new',
        entered_at: new Date(T0),
        duration_seconds: 60
      },
      {
        session_id: 's1',
        user: USER,
        path: '/queues',
        entered_at: new Date(T0 + 60 * S),
        duration_seconds: 60
      },
      // A second tab open at the same time
      {
        session_id: 's2',
        user: USER,
        path: '/dashboard',
        entered_at: new Date(T0 + 30 * S),
        duration_seconds: 60
      },
      {
        session_id: 's3',
        user: 'OTHER',
        path: '/queues',
        entered_at: new Date(T0),
        duration_seconds: 600
      }
    ])
    const scored = scoreSessions(sessions, {
      rage: [{ user: USER.toLowerCase(), at: T0 + 70 * S }],
      dead: [{ user: USER, at: T0 + 80 * S }],
      errors: [{ user: USER, at: T0 + 40 * S }],
      calls: [],
      recordings: [
        { id: 'rec-short', user: USER, start: T0 + 100 * S, end: T0 + 110 * S },
        { id: 'rec-long', user: USER, start: T0 - 10 * S, end: T0 + 200 * S },
        { id: 'rec-other', user: 'OTHER', start: T0, end: T0 + 999 * S }
      ]
    })
    const by = Object.fromEntries(scored.map((s) => [s.session.session_id, s]))
    expect(by.s1.counts).toEqual({
      rage_clicks: 1,
      dead_clicks: 1,
      client_errors: 1,
      loops: 0,
      slow_actions: 0,
      abandoned_forms: 1
    })
    expect(by.s1.score).toBe(
      Math.round(100 * (1 - Math.exp(-(6 + 3 + 8 + 5) / DEFAULT_WEIGHTS.scale)))
    )
    expect(by.s1.abandoned_routes).toEqual(['/collections/orders/new'])
    expect(by.s1.recording_id).toBe('rec-long')
    expect(by.s1.top_route).toBe('/collections/orders/new')
    // The error falls inside both tabs; it counts once, for the first.
    expect(by.s2.counts.client_errors).toBe(0)
    expect(by.s3.score).toBe(0)
    expect(by.s3.recording_id).toBe('rec-other')
  })

  it('a POST while the new form is open saves it, and slow calls count', () => {
    const sessions = buildSessions([
      {
        session_id: 's1',
        user: USER,
        path: '/collections/orders/new',
        entered_at: new Date(T0),
        duration_seconds: 60
      }
    ])
    const fast = Array.from({ length: 30 }, (_, i) => ({
      user: 'SOMEONE',
      at: T0,
      method: 'GET',
      path: `/api/items/orders/${i}`,
      latency_ms: 100
    }))
    const scored = scoreSessions(sessions, {
      rage: [],
      dead: [],
      errors: [],
      calls: [
        ...fast,
        {
          user: USER,
          at: T0 + 10 * S,
          method: 'GET',
          path: '/api/items/orders/7',
          latency_ms: 4000
        },
        { user: USER, at: T0 + 20 * S, method: 'POST', path: '/api/items/orders', latency_ms: 50 },
        // The recorder's own uploads are never actions
        {
          user: USER,
          at: T0 + 21 * S,
          method: 'POST',
          path: '/api/session-recordings/x/events',
          latency_ms: 9000
        }
      ],
      recordings: []
    })
    expect(scored[0].counts.abandoned_forms).toBe(0)
    expect(scored[0].counts.slow_actions).toBe(1)
  })
})

describe('helpers', () => {
  it('topRoute is the pattern with the most time', () => {
    expect(topRoute([step('/a/1', 0, 10), step('/b', 10, 20), step('/a/2', 20, 35)])).toBe('/a/:id')
  })
  it('overlappingRecording needs real overlap', () => {
    const [s] = buildSessions([
      { session_id: 's', user: USER, path: '/x', entered_at: new Date(T0), duration_seconds: 10 }
    ])
    expect(
      overlappingRecording(s, [{ id: 'r', user: USER, start: T0 + 20 * S, end: T0 + 30 * S }])
    ).toBeNull()
  })
})
