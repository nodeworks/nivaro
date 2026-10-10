import { gzipSync } from 'node:zlib'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Route-harness idiom (session-recordings-rail.test.ts): mock the admin gate
// and the db module, answer each table's query chain with canned rows. The
// gate refuses unless the test sends x-test-admin, so every endpoint is
// checked for admin-only.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(
    async (
      req: { headers: Record<string, unknown>; user?: { id: string }; isAdmin?: boolean },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } }
    ) => {
      if (req.headers['x-test-admin'] !== '1') return reply.code(403).send({ error: 'Forbidden' })
      req.user = { id: 'test-admin' }
      req.isAdmin = true
    }
  ),
  requireAuth: vi.fn(async () => {})
}))
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(vi.fn(), { raw: vi.fn((sql: string) => sql) })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))

import { db } from '../../../db/index.js'
import { dayRange, sessionReplayInsightRoutes } from '../../../routes/session-replay-insights.js'

type Calls = Array<[string, unknown[]]>

/** A knex-ish chain: every builder method records itself and returns the chain; awaiting it yields `rows`. */
function chain(rows: unknown[] | Error, first?: unknown) {
  const calls: Calls = []
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          const p = rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)
          return p.then.bind(p)
        }
        if (prop === 'first')
          return (...a: unknown[]) => {
            calls.push(['first', a])
            return Promise.resolve(first)
          }
        return (...a: unknown[]) => {
          calls.push([prop, a])
          return proxy
        }
      }
    }
  )
  return { proxy, calls }
}

function mockTables(tables: Record<string, ReturnType<typeof chain>>) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const t = tables[table]
    if (!t) throw new Error(`unexpected table: ${table}`)
    return t.proxy
  }) as never)
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(sessionReplayInsightRoutes)
  return app
}

const ADMIN = { 'x-test-admin': '1' }
const REC = '264BEE7B-87D3-4452-81C9-CE6FBF672DE5'
const T0 = Date.parse('2026-10-01T12:00:00.000Z')

afterEach(() => vi.clearAllMocks())

describe('admin gating', () => {
  it.each([
    '/heat/routes',
    '/heat?route=/queues',
    '/heat/frame?route=/queues',
    '/worst',
    '/frustration-weights'
  ])('GET %s is admin-only', async (url) => {
    mockTables({})
    const res = await buildApp().inject({ method: 'GET', url })
    expect(res.statusCode).toBe(403)
    expect(db).not.toHaveBeenCalled()
  })
  it('PUT /frustration-weights is admin-only', async () => {
    mockTables({})
    const res = await buildApp().inject({
      method: 'PUT',
      url: '/frustration-weights',
      payload: { weights: { loops: 1 } }
    })
    expect(res.statusCode).toBe(403)
    expect(db).not.toHaveBeenCalled()
  })
})

describe('GET /worst (#1388)', () => {
  it('lists the highest scores in the range with the person, and drops expired recording links', async () => {
    const scores = chain([
      {
        session_id: 'sock-1',
        user: 'U-1',
        user_name: 'Ada Lovelace',
        day: '2026-10-01',
        session_start: new Date('2026-10-01T09:00:00.000Z'),
        session_end: new Date('2026-10-01T09:30:00.000Z'),
        score: 81,
        components: JSON.stringify({ counts: { rage_clicks: 2 }, points: { rage_clicks: 12 } }),
        top_route: '/queues',
        recording_id: REC
      },
      {
        session_id: 'sock-2',
        user: 'U-2',
        user_name: '',
        day: '2026-10-01',
        session_start: new Date('2026-10-01T10:00:00.000Z'),
        session_end: new Date('2026-10-01T10:05:00.000Z'),
        score: 40,
        components: 'not json',
        top_route: null,
        recording_id: 'gone-gone'
      }
    ])
    mockTables({
      'nivaro_session_scores as s': scores,
      nivaro_session_recordings: chain([{ id: REC.toLowerCase() }])
    })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/worst?from=2026-10-01&to=2026-10-01&limit=999&min_score=30',
      headers: ADMIN
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d[0]).toMatchObject({
      session_id: 'sock-1',
      user_name: 'Ada Lovelace',
      score: 81,
      components: { counts: { rage_clicks: 2 } },
      recording_id: REC
    })
    expect(d[1]).toMatchObject({ user_name: null, components: {}, recording_id: null })
    expect(scores.calls).toContainEqual(['limit', [200]])
    expect(scores.calls).toContainEqual(['where', ['s.score', '>=', 30]])
    expect(scores.calls).toContainEqual(['orderBy', ['s.score', 'desc']])
  })
})

describe('frustration weights', () => {
  it('GET answers the stored weights over the defaults', async () => {
    mockTables({ nivaro_settings: chain([], { frustration_weights: '{"loops": 9}' }) })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/frustration-weights',
      headers: ADMIN
    })
    expect(res.json().data.weights.loops).toBe(9)
    expect(res.json().data.defaults.loops).toBe(3)
  })
  it('PUT validates and stores JSON; null resets', async () => {
    const settings = chain([], { frustration_weights: null })
    mockTables({ nivaro_settings: settings })
    const bad = await buildApp().inject({
      method: 'PUT',
      url: '/frustration-weights',
      headers: ADMIN,
      payload: { weights: { loops: 500 } }
    })
    expect(bad.statusCode).toBe(400)
    const ok = await buildApp().inject({
      method: 'PUT',
      url: '/frustration-weights',
      headers: ADMIN,
      payload: { weights: { loops: 7 } }
    })
    expect(ok.statusCode).toBe(200)
    const update = settings.calls.find(([m]) => m === 'update')?.[1][0] as {
      frustration_weights: string
    }
    expect(JSON.parse(update.frustration_weights).loops).toBe(7)
    await buildApp().inject({
      method: 'PUT',
      url: '/frustration-weights',
      headers: ADMIN,
      payload: { weights: null }
    })
    expect(settings.calls.filter(([m]) => m === 'update').at(-1)?.[1][0]).toEqual({
      frustration_weights: null
    })
  })
})

describe('dayRange', () => {
  it('defaults to the last 30 UTC days', () => {
    expect(dayRange(undefined, undefined, Date.parse('2026-10-10T05:00:00Z'))).toEqual({
      from: '2026-09-11',
      to: '2026-10-10'
    })
  })
  it('refuses unreal days, reversed and over-long ranges', () => {
    expect(dayRange('2026-02-31', '2026-03-01')).toHaveProperty('error')
    expect(dayRange('2026-10-02', '2026-10-01')).toHaveProperty('error')
    expect(dayRange('2020-01-01', '2026-10-01')).toHaveProperty('error')
  })
})

describe('GET /heat/routes', () => {
  it('sums clicks and visits per route, busiest first', async () => {
    const heat = chain([
      { app: 'admin', route: '/queues', kind: 'click', n: '3' },
      { app: 'admin', route: '/queues', kind: 'scroll', n: 2 },
      { app: 'admin', route: '/collections/:c/:id', kind: 'click', n: 9 }
    ])
    mockTables({ nivaro_replay_heat: heat })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/heat/routes?from=2026-10-01&to=2026-10-07',
      headers: ADMIN
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([
      { app: 'admin', route: '/collections/:c/:id', clicks: 9, visits: 0 },
      { app: 'admin', route: '/queues', clicks: 3, visits: 2 }
    ])
    expect(heat.calls).toContainEqual(['where', ['day', '>=', '2026-10-01']])
    expect(heat.calls).toContainEqual(['where', ['day', '<=', '2026-10-07']])
  })

  it('400s on a bad range', async () => {
    mockTables({})
    const res = await buildApp().inject({
      method: 'GET',
      url: '/heat/routes?from=yesterday',
      headers: ADMIN
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /heat', () => {
  it('answers cells, elements, scroll depth and the frame pointer', async () => {
    const heat = chain([
      {
        kind: 'click',
        selector: 'button',
        x_bucket: 3,
        y_bucket: 4,
        depth_bucket: null,
        viewport: 'md',
        n: 5
      },
      {
        kind: 'scroll',
        selector: null,
        x_bucket: null,
        y_bucket: null,
        depth_bucket: 6,
        viewport: 'md',
        n: 2
      }
    ])
    const frames = chain([], { recording_id: REC, at_ms: String(T0), width: 1280, height: 720 })
    const recordings = chain([], { id: REC })
    mockTables({
      nivaro_replay_heat: heat,
      nivaro_replay_heat_frames: frames,
      nivaro_session_recordings: recordings
    })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/heat?app=admin&route=/queues&from=2026-10-01&to=2026-10-02',
      headers: ADMIN
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.clicks).toEqual([{ x: 3, y: 4, count: 5 }])
    expect(d.selectors).toEqual([{ selector: 'button', count: 5 }])
    expect(d.scroll).toEqual([{ depth: 6, visits: 2 }])
    expect(d.frame).toEqual({ recording_id: REC, at_ms: T0, width: 1280, height: 720 })
    expect(heat.calls).toContainEqual(['where', [{ app: 'admin', route: '/queues' }]])
  })

  it('a frame whose recording expired is not offered', async () => {
    mockTables({
      nivaro_replay_heat: chain([]),
      nivaro_replay_heat_frames: chain([], { recording_id: REC, at_ms: T0, width: 1, height: 1 }),
      nivaro_session_recordings: chain([], undefined)
    })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/heat?route=/queues',
      headers: ADMIN
    })
    expect(res.json().data.frame).toBeNull()
  })

  it('refuses a route that is not a pattern', async () => {
    mockTables({})
    const res = await buildApp().inject({
      method: 'GET',
      url: '/heat?route=queues',
      headers: ADMIN
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /heat/frame', () => {
  it('answers the snapshot and DOM changes up to the frame moment, decoding gzip chunks', async () => {
    const node = { type: 0, id: 1, childNodes: [] }
    const chunk1 = [
      { type: 4, timestamp: T0, data: { href: 'https://a/queues', width: 1280, height: 720 } },
      { type: 2, timestamp: T0 + 1, data: { node } },
      { type: 3, timestamp: T0 + 2, data: { source: 1, positions: [] } }
    ]
    const chunk2 = [
      {
        type: 3,
        timestamp: T0 + 3,
        data: { source: 0, adds: [], removes: [], texts: [], attributes: [] }
      },
      {
        type: 3,
        timestamp: T0 + 50,
        data: { source: 0, adds: [], removes: [], texts: [], attributes: [] }
      }
    ]
    const gz = (v: unknown) => `gz:${gzipSync(Buffer.from(JSON.stringify(v))).toString('base64')}`
    mockTables({
      nivaro_replay_heat_frames: chain([], {
        recording_id: REC,
        at_ms: T0 + 10,
        width: 1280,
        height: 720
      }),
      nivaro_session_recordings: chain([], { id: REC }),
      nivaro_session_events: chain([{ events: gz(chunk1) }, { events: JSON.stringify(chunk2) }])
    })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/heat/frame?route=/queues',
      headers: ADMIN
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.viewport).toBe('md')
    expect(d.events.map((e: { timestamp: number }) => e.timestamp)).toEqual([T0, T0 + 1, T0 + 3])
  })

  it('404s when the route has no frame', async () => {
    mockTables({ nivaro_replay_heat_frames: chain([], undefined) })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/heat/frame?route=/queues',
      headers: ADMIN
    })
    expect(res.statusCode).toBe(404)
  })
})
