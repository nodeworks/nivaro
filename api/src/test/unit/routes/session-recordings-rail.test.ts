import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Route-harness idiom (external-apis-logs.test.ts): mock the admin gate and
// the db module before importing the route, then answer each table's query
// chain with canned rows. The rail service runs for real.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  }),
  requireAuth: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'test-user' }
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))

import { db } from '../../../db/index.js'
import { sessionRecordingRoutes } from '../../../routes/session-recordings.js'
import { RAIL_CAPS } from '../../../services/session-replay-rail.js'

const REC_ID = '264bee7b-87d3-4452-81c9-ce6fbf672de5'
const USER = '7A0411F3-C687-40E5-ADF5-614157CF88EC'
const START = new Date('2026-10-01T12:00:00.000Z')
const END = new Date('2026-10-01T12:10:00.000Z')

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
          return (...a: unknown[]) => (calls.push(['first', a]), Promise.resolve(first))
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

const rec = {
  id: REC_ID,
  user: USER,
  app: null,
  started_at: START,
  ended_at: END,
  last_event_at: END
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(sessionRecordingRoutes)
  return app
}

afterEach(() => vi.clearAllMocks())

describe('GET /:id/events-rail (#1356)', () => {
  it('joins the four sources into one time-sorted rail, without query strings', async () => {
    const logs = chain([
      {
        method: 'get',
        path: '/api/items/workflows?access_token=secret',
        status: 503,
        latency_ms: 812.4,
        created_at: new Date('2026-10-01T12:03:00.000Z')
      }
    ])
    const issues = chain([
      {
        id: 7,
        title: '[client] /environments: Invalid time value',
        created_at: new Date('2026-09-30T08:00:00.000Z'),
        last_seen_at: new Date('2026-10-01T12:09:00.000Z'),
        recording_id: REC_ID.toUpperCase(),
        recording_offset_ms: 60_000
      }
    ])
    const journeys = chain([
      {
        path: '/environments',
        entered_at: new Date('2026-10-01T12:00:30.000Z'),
        duration_seconds: 42
      }
    ])
    const history = chain([
      {
        id: 3,
        timestamp: new Date('2026-10-01T12:05:00.000Z'),
        collection: 'workflows',
        item: '371367',
        from_label: 'Draft',
        to_label: 'Review'
      }
    ])
    mockTables({
      nivaro_session_recordings: chain([], rec),
      nivaro_api_logs: logs,
      nivaro_issues: issues,
      nivaro_admin_journeys: journeys,
      'nivaro_workflow_history as h': history
    })

    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: `/${REC_ID}/events-rail` })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.started_at).toBe(START.toISOString())
    expect(d.truncated).toBe(false)
    expect(d.items.map((i: { kind: string }) => i.kind)).toEqual([
      'route',
      'error',
      'request',
      'transition'
    ])
    const [route, error, request, transition] = d.items
    expect(route).toMatchObject({ label: '/environments · 42 s on page' })
    // Linked to THIS recording: placed at started_at + offset, not created_at.
    expect(error).toMatchObject({
      at: '2026-10-01T12:01:00.000Z',
      label: '/environments: Invalid time value',
      href: '/issues/7'
    })
    expect(request).toMatchObject({ status: 503, label: 'GET /api/items/workflows → 503 · 812 ms' })
    expect(res.body).not.toContain('access_token')
    expect(transition).toMatchObject({
      label: 'workflows 371367: Draft → Review',
      href: '/collections/workflows/371367'
    })

    // Window: started_at − 5 s … ended_at + 5 s, the person's own rows only,
    // and the recorder's own uploads are not on the rail.
    const between = logs.calls.find(([m]) => m === 'whereBetween')?.[1]
    expect(between).toEqual([
      'created_at',
      [new Date('2026-10-01T11:59:55.000Z'), new Date('2026-10-01T12:10:05.000Z')]
    ])
    expect(logs.calls).toContainEqual(['where', ['user', USER]])
    expect(logs.calls).toContainEqual(['limit', [RAIL_CAPS.request + 1]])
    await app.close()
  })

  it('caps a kind and says so', async () => {
    const many = Array.from({ length: RAIL_CAPS.request + 1 }, (_, i) => ({
      method: 'GET',
      path: '/api/items/x',
      status: 200,
      latency_ms: 5,
      created_at: new Date(START.getTime() + i * 100)
    }))
    mockTables({
      nivaro_session_recordings: chain([], rec),
      nivaro_api_logs: chain(many),
      nivaro_issues: chain([]),
      nivaro_admin_journeys: chain([]),
      'nivaro_workflow_history as h': chain([])
    })
    const app = buildApp()
    const d = (await app.inject({ method: 'GET', url: `/${REC_ID}/events-rail` })).json().data
    expect(d.items).toHaveLength(RAIL_CAPS.request)
    expect(d.truncated).toBe(true)
    expect(d.truncated_kinds).toEqual(['request'])
    await app.close()
  })

  it('a source that fails (older install) drops that kind only', async () => {
    mockTables({
      nivaro_session_recordings: chain([], rec),
      nivaro_api_logs: chain([
        { method: 'GET', path: '/api/x', status: 200, latency_ms: 3, created_at: START }
      ]),
      nivaro_issues: chain(new Error("Invalid column name 'recording_id'")),
      nivaro_admin_journeys: chain(new Error("Invalid object name 'nivaro_admin_journeys'")),
      'nivaro_workflow_history as h': chain([])
    })
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: `/${REC_ID}/events-rail` })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.items).toHaveLength(1)
    await app.close()
  })

  it('an error clip reaches back over its buffer', async () => {
    const logs = chain([])
    mockTables({
      nivaro_session_recordings: chain([], { ...rec, app: 'error-clip' }),
      nivaro_api_logs: logs,
      nivaro_issues: chain([]),
      nivaro_admin_journeys: chain([]),
      'nivaro_workflow_history as h': chain([])
    })
    const app = buildApp()
    await app.inject({ method: 'GET', url: `/${REC_ID}/events-rail` })
    const between = logs.calls.find(([m]) => m === 'whereBetween')?.[1] as [string, Date[]]
    expect(between[1][0]).toEqual(new Date('2026-10-01T11:58:55.000Z'))
    await app.close()
  })

  it('404s an unknown recording', async () => {
    mockTables({ nivaro_session_recordings: chain([], undefined) })
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: `/${REC_ID}/events-rail` })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
