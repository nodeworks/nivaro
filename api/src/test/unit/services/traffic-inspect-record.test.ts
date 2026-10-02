// api/src/test/unit/services/traffic-inspect-record.test.ts
// Traffic Map drill-down group "record" (chain, recording, record, write, issue) through the
// Wave 0 harness: the generic inspect routes + the group's own route, with the database mocked.
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Call = [string, unknown[]]
interface Q {
  table: string
  calls: Call[]
}
type Handler = (q: Q) => unknown[] | Promise<unknown[]>

const h = vi.hoisted(() => ({ handlers: {} as Record<string, Handler> }))

vi.mock('../../../db/index.js', () => {
  const BUILD = [
    'where',
    'whereIn',
    'whereNot',
    'whereNull',
    'whereNotNull',
    'whereBetween',
    'whereRaw',
    'orderBy',
    'limit',
    'leftJoin',
    'count'
  ]
  const make = (raw: string) => {
    const table = raw.split(' as ')[0]
    const q: Q = { table, calls: [] }
    const self: Record<string, unknown> = {}
    for (const m of BUILD)
      self[m] = (...a: unknown[]) => {
        q.calls.push([m, a])
        return self
      }
    const run = async () => {
      const fn = h.handlers[table]
      return fn ? fn(q) : []
    }
    self.select = (...a: unknown[]) => {
      q.calls.push(['select', a])
      return run()
    }
    self.first = (...a: unknown[]) => {
      q.calls.push(['first', a])
      return run().then((rows) => rows[0])
    }
    return self
  }
  return { db: Object.assign((t: string) => make(t), { raw: vi.fn() }) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/chain-columns.js', () => ({
  hasChainColumns: vi.fn(async () => true)
}))
vi.mock('../../../services/event-path/index.js', () => ({ buildChainPath: vi.fn() }))
vi.mock('../../../services/mail-types.js', () => ({
  labelledChanges: vi.fn(async (_c: string, delta: Record<string, unknown>) =>
    Object.keys(delta).map((field) => ({ field, label: field, old: null, new: delta[field] }))
  )
}))
vi.mock('../../../services/queues.js', () => ({ getLabels: vi.fn(async () => ({})) }))
vi.mock('../../../services/items.js', () => {
  class CollectionNotFoundError extends Error {}
  class ForbiddenError extends Error {}
  class ItemNotFoundError extends Error {}
  class RouteOnlyCollectionError extends Error {}
  return {
    CollectionNotFoundError,
    ForbiddenError,
    ItemNotFoundError,
    RouteOnlyCollectionError,
    readOne: vi.fn(async () => ({ id: 12, title: 'Hello' }))
  }
})

import { inspectCoreRoutes } from '../../../routes/traffic-map-extras/inspect-core.js'
import { inspectRecordRoutes } from '../../../routes/traffic-map-extras/inspect-record.js'
import { issueFingerprint } from '../../../services/error-tracking.js'
import { buildChainPath } from '../../../services/event-path/index.js'
import {
  CollectionNotFoundError,
  ForbiddenError,
  ItemNotFoundError,
  readOne
} from '../../../services/items.js'
import { inspectKinds } from '../../../services/traffic-inspect.js'

const RID = '8ba289a0-81fd-4d13-b56f-567cdb2d2a56'
const U = '7a0411f3-c687-40e5-adf5-614157cf88ec'
const REC = '264bee7b-87d3-4452-81c9-ce6fbf672de5'
const CHAIN = '0f8fad5b-d9cb-469f-a165-70867728950e'
const T = Date.parse('2026-10-01T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const ROUTE = 'PATCH /api/items/:collection/:id'
const fp = (message: string) => issueFingerprint('server', ROUTE, message)

const on = (table: string, fn: Handler) => {
  h.handlers[table] = fn
}
const has = (q: Q, method: string, first: unknown) =>
  q.calls.some((c) => c[0] === method && c[1][0] === first)

async function app() {
  const a = Fastify()
  await a.register(inspectCoreRoutes, { prefix: '/traffic-map' })
  await a.register(inspectRecordRoutes, { prefix: '/traffic-map' })
  await a.ready()
  return a
}
const get = async (url: string) => {
  const a = await app()
  const res = await a.inject({ url })
  await a.close()
  return res
}

beforeEach(() => {
  for (const k of Object.keys(h.handlers)) delete h.handlers[k]
  vi.mocked(readOne).mockReset()
  vi.mocked(readOne).mockResolvedValue({ id: 12, title: 'Hello' })
  vi.mocked(buildChainPath).mockReset()
})

describe('registration', () => {
  it('registers the five kinds of the group', () => {
    for (const k of ['chain', 'recording', 'record', 'write', 'issue'])
      expect(inspectKinds()).toContain(k)
  })
  it('validId is strict per kind → 400, never a source call', async () => {
    const bad = [
      '/traffic-map/inspect/chain/nope',
      '/traffic-map/inspect/recording/for:someone',
      '/traffic-map/inspect/record/workflows',
      `/traffic-map/inspect/record/${encodeURIComponent('items/x:1')}`,
      '/traffic-map/inspect/write/0',
      '/traffic-map/inspect/write/abc',
      '/traffic-map/inspect/issue/rid:xyz',
      '/traffic-map/inspect/issue/-1'
    ]
    for (const url of bad) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(400)
      expect(res.json().code, url).toBe('INSPECT_ID_INVALID')
    }
  })
})

describe('issue for a request', () => {
  const issues = [
    { id: 55, title: `[server] ${ROUTE}: Deadlock victim`, fingerprint: fp('Deadlock victim') },
    { id: 40, title: `[server] ${ROUTE}: Validation failed`, fingerprint: fp('Validation failed') }
  ]
  const logRow = (error: string | null, status = 500) => ({
    method: 'PATCH',
    path: '/api/items/workflows/12',
    status,
    created_at: iso(T),
    error,
    user: U
  })
  let issueQuery: Q | null = null
  beforeEach(() => {
    issueQuery = null
    on('nivaro_issues', (q) => {
      const byId = q.calls.find((c) => c[0] === 'where' && c[1][0] === 'id')
      if (byId) {
        const row = issues.find((i) => i.id === byId[1][1])
        return row
          ? [
              {
                ...row,
                status: 'open',
                severity: 'high',
                source: 'server',
                occurrence_count: 3,
                created_at: iso(T - 86_400_000),
                last_seen_at: iso(T),
                raised_by: 'b2c3d4e5-0000-4000-8000-000000000001',
                details: `Route: ${ROUTE}\n\nError: x\n    at y (z.ts:1:1)`
              }
            ]
          : []
      }
      issueQuery = q
      return issues
    })
  })

  it('two open issues on one route: the one whose fingerprint matches the error wins', async () => {
    on('nivaro_api_logs', () => [logRow('{"error":"Validation failed"}')])
    const res = await get(`/traffic-map/inspect/issue/rid:${RID}`)
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.id).toBe(40)
    expect(d.matched_request).toEqual({ id: RID, user: U, at: T, matched_by: 'fingerprint' })
    expect(d.stack).toMatch(/at y/)
    // Only open or acknowledged issues are candidates (closed and resolved are not).
    expect(issueQuery && has(issueQuery, 'whereIn', 'status')).toBe(true)
    expect(issueQuery?.calls.find((c) => c[0] === 'whereIn')?.[1][1]).toEqual([
      'open',
      'acknowledged'
    ])
  })

  it('falls back to the route alone and says so when no message matches', async () => {
    on('nivaro_api_logs', () => [logRow('{"message":"Something new"}')])
    const d = (await get(`/traffic-map/inspect/issue/rid:${RID}`)).json().data
    expect(d.id).toBe(55)
    expect(d.matched_request.matched_by).toBe('route')
  })

  it('a bare 500 with no body matches the "HTTP 500" message', async () => {
    on('nivaro_issues', (q) =>
      has(q, 'where', 'id')
        ? [{ id: 9, title: `[server] ${ROUTE}: HTTP 500`, status: 'open', occurrence_count: 1 }]
        : [{ id: 9, title: `[server] ${ROUTE}: HTTP 500`, fingerprint: fp('HTTP 500') }]
    )
    on('nivaro_api_logs', () => [logRow(null)])
    const d = (await get(`/traffic-map/inspect/issue/rid:${RID}`)).json().data
    expect(d.id).toBe(9)
    expect(d.matched_request.matched_by).toBe('fingerprint')
  })

  it('answers plainly (200, none) when the log row is missing, not a 5xx, or unmatched', async () => {
    on('nivaro_api_logs', () => [])
    // A fresh request (or one with no known time) is probably not flushed yet: pending.
    let d = (await get(`/traffic-map/inspect/issue/rid:${RID}`)).json().data
    expect(d).toMatchObject({ none: true, request_id: RID, pending: true })
    expect(d.reason).toMatch(/not in the API log yet/)
    d = (await get(`/traffic-map/inspect/issue/rid:${RID}?at=${Date.now() - 5_000}`)).json().data
    expect(d.pending).toBe(true)
    d = (await get(`/traffic-map/inspect/issue/rid:${RID}?at=${T}`)).json().data
    expect(d.pending).toBe(false)
    expect(d.reason).toMatch(/never flushed, or older/)

    on('nivaro_api_logs', () => [logRow('{"error":"nope"}', 404)])
    d = (await get(`/traffic-map/inspect/issue/rid:${RID}`)).json().data
    expect(d.reason).toMatch(/Only server errors/)

    on('nivaro_api_logs', () => [{ ...logRow('{"error":"x"}'), path: '/api/other' }])
    d = (await get(`/traffic-map/inspect/issue/rid:${RID}`)).json().data
    expect(d.reason).toMatch(/No open issue matches/)
  })

  it('by id: 404 when gone; the peek carries epoch ms', async () => {
    expect((await get('/traffic-map/inspect/issue/77')).statusCode).toBe(404)
    const peek = (await get('/traffic-map/inspect/issue/40/peek')).json().data
    expect(peek.title).toBe('Issue #40')
    expect(peek.at).toBe(T)
    const direct = (await get('/traffic-map/inspect/issue/40')).json().data
    expect(direct.matched_request).toBeNull()
    expect(direct.created_at).toBe(iso(T - 86_400_000))
  })
})

describe('recording', () => {
  const rec = {
    id: REC,
    user: U,
    app: 'admin',
    origin: null,
    started_at: iso(T - 60_000),
    ended_at: null,
    last_event_at: iso(T + 30_000),
    event_count: 120,
    byte_size: 4096,
    truncated: false,
    first_name: 'Beth',
    last_name: null,
    email: null
  }
  beforeEach(() => {
    on('nivaro_settings', () => [{ session_recording_enabled: true, error_replay_enabled: true }])
  })

  it('a purged recording uuid is a 404 and a null peek', async () => {
    on('nivaro_session_recordings', () => [])
    const res = await get(`/traffic-map/inspect/recording/${REC}`)
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('INSPECT_NOT_FOUND')
    expect((await get(`/traffic-map/inspect/recording/${REC}/peek`)).json()).toEqual({
      data: null
    })
  })

  it('seeks to the anchor and peeks with epoch ms', async () => {
    on('nivaro_session_recordings', () => [rec])
    const d = (await get(`/traffic-map/inspect/recording/${REC}?at=${T}`)).json().data
    expect(d.none).toBe(false)
    expect(d.offset_ms).toBe(60_000)
    expect(d.recording.user_name).toBe('Beth')
    const peek = (await get(`/traffic-map/inspect/recording/${REC}/peek`)).json().data
    expect(peek.title).toBe('Recording · Beth')
    expect(peek.at).toBe(T - 60_000)
  })

  it('for:<user> with nothing covering the moment is a 200 with the reason', async () => {
    on('nivaro_session_recordings', () => [])
    on('nivaro_users', () => [{ id: U, first_name: 'Beth', last_name: 'Ng', email: null }])
    const d = (await get(`/traffic-map/inspect/recording/for:${U}?at=${T}`)).json().data
    expect(d).toMatchObject({ none: true, user: U, user_name: 'Beth Ng', recording_on: true })
    expect(d.reason).toMatch(/No recording of this person/)
    const peek = (await get(`/traffic-map/inspect/recording/for:${U}/peek`)).json().data
    expect(peek.title).toBe('Recording of Beth Ng')
  })

  it('GET /inspect/recording-for: 400 on a bad user or time, the pick, 500 when the lookup fails', async () => {
    let res = await get(`/traffic-map/inspect/recording-for?user=beth&at=${T}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INSPECT_ID_INVALID')
    res = await get(`/traffic-map/inspect/recording-for?user=${U}&at=soon`)
    expect(res.statusCode).toBe(400)

    on('nivaro_session_recordings', () => [rec])
    res = await get(`/traffic-map/inspect/recording-for?user=${U}&at=${T}`)
    expect(res.json()).toEqual({
      data: { found: true, recording_id: REC, offset_ms: 60_000, clip: false, distance_ms: 0 }
    })

    on('nivaro_session_recordings', () => [])
    res = await get(`/traffic-map/inspect/recording-for?user=${U}&at=${T}`)
    expect(res.json().data).toMatchObject({ found: false, none: true })

    on('nivaro_session_recordings', () => {
      throw new Error("Invalid object name 'nivaro_session_recordings'.")
    })
    res = await get(`/traffic-map/inspect/recording-for?user=${U}&at=${T}`)
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('INSPECT_FAILED')
  })
})

describe('record', () => {
  const touch = {
    id: 5,
    action: 'update',
    timestamp: iso(T - 10_000),
    comment: null,
    first_name: 'Robert',
    last_name: 'Lee',
    origin: 'person',
    chain_id: CHAIN
  }
  it('reads the record as the caller and lists the writes near the moment', async () => {
    on('nivaro_activity', (q) => (has(q, 'count', '* as n') ? [{ n: 1 }] : [touch]))
    const d = (await get(`/traffic-map/inspect/record/workflows:12?at=${T}`)).json().data
    expect(readOne).toHaveBeenCalledWith(undefined, 'workflows', '12')
    expect(d).toMatchObject({
      collection: 'workflows',
      item: '12',
      exists: true,
      reason: null,
      values: { id: 12, title: 'Hello' },
      touches_in_window: 1,
      touches_total: 1,
      touches_note: null
    })
    expect(d.touches[0]).toMatchObject({
      id: 5,
      action: 'update',
      who: 'Robert Lee',
      chain_id: CHAIN
    })
    const peek = (await get('/traffic-map/inspect/record/workflows:12/peek')).json().data
    expect(peek.lines[1]).toBe('last update by Robert Lee')
    expect(peek.at).toBe(T - 10_000)
  })

  it('maps each readOne refusal to a reason instead of failing', async () => {
    on('nivaro_activity', (q) => (has(q, 'count', '* as n') ? [{ n: 0 }] : []))
    vi.mocked(readOne).mockRejectedValueOnce(new ItemNotFoundError())
    on('nivaro_trash', () => [{ id: 1 }])
    let d = (await get('/traffic-map/inspect/record/workflows:12')).json().data
    expect(d.exists).toBe(false)
    expect(d.reason).toMatch(/in the trash/)
    expect(d.touches_note).toMatch(/Nobody has written/)

    vi.mocked(readOne).mockRejectedValueOnce(new ItemNotFoundError())
    on('nivaro_trash', () => [])
    d = (await get('/traffic-map/inspect/record/workflows:12')).json().data
    expect(d.reason).toMatch(/No such record/)

    vi.mocked(readOne).mockRejectedValueOnce(new ForbiddenError())
    d = (await get('/traffic-map/inspect/record/workflows:12')).json().data
    expect(d.reason).toMatch(/Your role cannot read/)

    vi.mocked(readOne).mockRejectedValueOnce(new CollectionNotFoundError())
    d = (await get('/traffic-map/inspect/record/nivaro_users:1')).json().data
    expect(d.reason).toMatch(/system table/)

    vi.mocked(readOne).mockRejectedValueOnce(new Error('connection reset'))
    const res = await get('/traffic-map/inspect/record/workflows:12')
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('INSPECT_FAILED')
  })
})

describe('write', () => {
  const row = {
    id: 7,
    action: 'update',
    user: U,
    timestamp: iso(T),
    ip: '10.0.0.1',
    user_agent: 'x',
    collection: 'workflows',
    item: '12',
    comment: null,
    first_name: 'Robert',
    last_name: 'Lee',
    origin: 'person',
    chain_id: null,
    auth_method: 'session',
    api_key_id: null
  }
  const revisions = (q: Q) =>
    has(q, 'where', 'activity')
      ? [{ id: 9, data: '{"amount":5}', delta: '{"amount":5}' }]
      : [{ data: '{"amount":3}' }]

  it('a missing activity row is a 404; the peek carries epoch ms', async () => {
    on('nivaro_activity', () => [])
    expect((await get('/traffic-map/inspect/write/7')).statusCode).toBe(404)
    on('nivaro_activity', () => [row])
    const peek = (await get('/traffic-map/inspect/write/7/peek')).json().data
    expect(peek).toEqual({
      title: 'update workflows 12',
      lines: ['Robert Lee', 'origin person'],
      at: T
    })
  })

  it('shows the field changes only when the caller may read the record', async () => {
    on('nivaro_activity', () => [row])
    on('nivaro_revisions', revisions)
    let d = (await get('/traffic-map/inspect/write/7')).json().data
    expect(d.changes).toEqual([{ field: 'amount', label: 'amount', old: null, new: 5 }])
    expect(d.changes_note).toBeNull()
    expect(d.request_note).toMatch(/no chain id/)

    vi.mocked(readOne).mockRejectedValueOnce(new ForbiddenError())
    d = (await get('/traffic-map/inspect/write/7')).json().data
    expect(d.changes).toEqual([])
    expect(d.changes_note).toMatch(/Your role cannot read this record/)

    vi.mocked(readOne).mockRejectedValueOnce(new ItemNotFoundError())
    d = (await get('/traffic-map/inspect/write/7')).json().data
    expect(d.changes).toEqual([])
    expect(d.changes_note).toMatch(/row filter/)

    // A deleted record cannot be read by anyone: its delete write still shows what it held.
    on('nivaro_activity', () => [{ ...row, action: 'delete' }])
    vi.mocked(readOne).mockRejectedValueOnce(new ItemNotFoundError())
    d = (await get('/traffic-map/inspect/write/7')).json().data
    expect(d.changes).toEqual([{ field: 'amount', label: 'amount', old: null, new: null }])
  })
})

describe('chain', () => {
  const path = {
    root: { key: `request:${CHAIN}`, at: iso(T), kind: 'request' },
    steps: [],
    nodes: []
  }
  it('404 when no path can be built, else the path with its starting request', async () => {
    vi.mocked(buildChainPath).mockResolvedValueOnce(null as never)
    expect((await get(`/traffic-map/inspect/chain/${CHAIN}`)).statusCode).toBe(404)

    vi.mocked(buildChainPath).mockResolvedValueOnce(path as never)
    on('nivaro_api_logs', () => [
      { id: 31, created_at: iso(T), request_id: RID, method: 'POST', path: '/api/x', status: 200 }
    ])
    const d = (await get(`/traffic-map/inspect/chain/${CHAIN.toUpperCase()}`)).json().data
    expect(d.chain_id).toBe(CHAIN)
    expect(d.request).toEqual({ log_id: '31', request_id: RID, at: iso(T) })
    expect(d.request_note).toBeNull()
  })
  it('peeks with the root request and the write count, at as epoch ms', async () => {
    on('nivaro_api_logs', () => [
      { method: 'POST', path: '/api/x', status: 200, created_at: iso(T) }
    ])
    on('nivaro_activity', () => [{ n: '2' }])
    const peek = (await get(`/traffic-map/inspect/chain/${CHAIN}/peek`)).json().data
    expect(peek).toEqual({
      title: `Path ${CHAIN.slice(0, 8)}`,
      lines: ['POST /api/x · 200', '2 writes'],
      at: T
    })
  })
})
