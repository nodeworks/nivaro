// api/src/test/unit/services/traffic-inspect-request.test.ts
// Traffic Map drill-down Task 3: the DB-backed request-group sources (request, trace, compare)
// and the compare-candidates route, driven through the Wave 0 inspect routes with a knex stub.
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Call = [string, unknown[]]
/** What the stubbed database answers a query with, given the builder calls it recorded. */
let answer: (table: string, calls: Call[]) => Array<Record<string, unknown>> = () => []
const queries: Array<{ table: string; calls: Call[] }> = []

vi.mock('../../../db/index.js', () => {
  const METHODS = [
    'leftJoin',
    'select',
    'where',
    'orWhere',
    'whereIn',
    'whereNot',
    'whereNull',
    'whereNotNull',
    'whereBetween',
    'whereRaw',
    'orderBy',
    'limit'
  ]
  const chain = (table: string) => {
    const calls: Call[] = []
    queries.push({ table, calls })
    const q: Record<string, unknown> = {}
    for (const m of METHODS)
      q[m] = (...args: unknown[]) => {
        calls.push([m, args])
        // where(b => …): run the grouping callback against the same recorder.
        for (const a of args) if (typeof a === 'function') (a as (b: unknown) => void)(q)
        return q
      }
    q.first = async () => answer(table, calls)[0]
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited directly, so the stub must be thenable
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => answer(table, calls))
        .then(res, rej)
    return q
  }
  return { db: Object.assign((table: string) => chain(table), { raw: vi.fn() }) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(1) }))

import { inspectCoreRoutes } from '../../../routes/traffic-map-extras/inspect-core.js'
import { inspectRequestRoutes } from '../../../routes/traffic-map-extras/inspect-request.js'
import {
  beginTrace,
  clearTraces,
  currentTraceMeta,
  finishTrace
} from '../../../services/request-trace.js'
import {
  inspectBook,
  inspectKeepNext,
  resetInspectCapture
} from '../../../services/traffic-inspect/request-capture.js'
import { statementSha } from '../../../services/traffic-inspect/request-logic.js'
import { resetStatementShapes } from '../../../services/traffic-inspect/request-statements.js'

const RID = '0f0c3099-bcbf-499e-9066-a1de51cbabc5'
const RID2 = 'ebbd2957-21bb-45b6-accf-00ba9447c023'
const CHAIN = 'cd40c1c4-125f-4d20-933c-783c1a7175bd'
const T0 = Date.parse('2026-10-01T10:00:00.000Z')

/** The recorded call `method` whose first argument is `arg`. */
const has = (calls: Call[], method: string, arg: unknown) =>
  calls.some(([m, a]) => m === method && a[0] === arg)
const call = (calls: Call[], method: string) => calls.find(([m]) => m === method)?.[1]

function logRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9,
    request_id: RID,
    method: 'GET',
    path: '/api/items/work_flows/5',
    query: 'fields=id',
    status: 200,
    latency_ms: 40,
    created_at: new Date(T0),
    auth: 'session',
    ip: '127.0.0.1',
    user_agent: 'Chrome',
    error: null,
    request_body: null,
    instance: null,
    chain_id: null,
    chain_parent: null,
    user: 'U1',
    api_key_id: null,
    first_name: 'Robert',
    last_name: 'Lee',
    email: 'r@x.y',
    api_key_name: null,
    graphql_operation: null,
    graphql_kind: null,
    ...over
  }
}

/** A /graphql root-alias row: no request id, a chain id, the operation stamped on it. */
const gqlRow = (over: Record<string, unknown> = {}) =>
  logRow({
    id: 31,
    request_id: null,
    method: 'POST',
    path: '/graphql',
    chain_id: CHAIN.toUpperCase(),
    graphql_operation: 'workflows',
    graphql_kind: 'query',
    user: null,
    api_key_id: 12,
    api_key_name: 'Partner',
    ...over
  })

/** Keep a fast trace for a request of `url` through a trace-next arm; returns its request id. */
function keepTrace(url: string): string {
  const now = Date.now()
  inspectBook().arm({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    kind: 'trace',
    spec: { route: 'GET /api/items/work_flows/:id', caller: null, entity: null },
    total: 20,
    remaining: 20,
    createdAt: now,
    expiresAt: now + 60_000,
    by: null,
    node: 'local'
  })
  beginTrace(url, { authMethod: 'session' })
  const id = currentTraceMeta()?.id as string
  finishTrace({ method: 'GET', route: '/api/items/:collection/:id', url, status: 200, user: null })
  return id
}

async function app() {
  const a = Fastify()
  a.decorateRequest('user', undefined)
  a.addHook('onRequest', async (req) => {
    ;(req as unknown as { user: { id: string } }).user = { id: 'ADMIN' }
  })
  await a.register(
    async (f) => {
      await f.register(inspectCoreRoutes)
      await f.register(inspectRequestRoutes)
    },
    { prefix: '/traffic-map' }
  )
  await a.ready()
  return a
}

beforeEach(() => {
  queries.length = 0
  answer = () => []
  resetInspectCapture()
  resetStatementShapes()
  clearTraces()
})
afterEach(() => vi.restoreAllMocks())

describe('request source', () => {
  it('finds the row by request id, with its neighbours, and peeks with an epoch-ms time', async () => {
    answer = (_t, calls) => {
      if (has(calls, 'where', 'l.request_id')) return [logRow()]
      if (has(calls, 'whereNot', 'l.id'))
        return [
          {
            request_id: RID2,
            method: 'POST',
            path: '/graphql',
            status: 200,
            latency_ms: 12,
            created_at: new Date(T0 + 1500),
            graphql_operation: 'units'
          }
        ]
      return []
    }
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/request/${RID}` })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.matched_by).toBe('request_id')
    expect(d.pending).toBe(false)
    expect(d.row).toMatchObject({
      route: 'GET /api/items/work_flows/:id',
      entity: 'items/work_flows',
      record: 'work_flows:5',
      caller: { key: 'uU1', label: 'Robert Lee', kind: 'user' }
    })
    expect(d.trace).toMatchObject({ kept: false, code: 'fast' })
    // The neighbour query is bound to the same caller, ±5 s.
    const nq = queries.find((q) => q.calls.some(([m, a]) => m === 'whereNot' && a[0] === 'l.id'))
    expect(nq && has(nq.calls, 'where', 'l.user')).toBe(true)
    expect(d.neighbours).toHaveLength(1)
    // A root-/graphql neighbour reads as the map spells it.
    expect(d.neighbours[0].route).toBe('POST /api/graphql · units')

    const peek = await a.inject({ url: `/traffic-map/inspect/request/${RID}/peek` })
    expect(peek.json().data).toEqual({
      title: 'GET /api/items/work_flows/5',
      lines: ['200 · 40 ms', 'Robert Lee'],
      at: T0
    })
    await a.close()
  })

  it('falls back to the /graphql row of the same chain (chain_time) and spells its route /api/graphql', async () => {
    inspectKeepNext({
      id: RID,
      method: 'POST',
      route: '/api/graphql',
      url: '/api/graphql',
      status: 200,
      user: null,
      total_ms: 5,
      request: { chainId: CHAIN.toUpperCase() }
    })
    answer = (_t, calls) => (has(calls, 'where', 'l.chain_id') ? [gqlRow()] : [])
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/request/${RID}` })
    const d = res.json().data
    expect(d.matched_by).toBe('chain_time')
    expect(d.row.route).toBe('POST /api/graphql · workflows')
    expect(d.row.chain_id).toBe(CHAIN)
    expect(d.row.caller).toEqual({ key: 'k12', label: 'Partner', kind: 'api_key' })
    const cq = queries.find((q) => has(q.calls, 'where', 'l.chain_id'))
    expect(call(cq?.calls ?? [], 'whereIn')).toEqual(['l.path', ['/graphql', '/api/graphql']])
    await a.close()
  })

  it('falls back to the only request-id-less /graphql row around `at` (time), never to one of two', async () => {
    let rows = [gqlRow()]
    answer = (_t, calls) =>
      has(calls, 'whereNull', 'l.request_id') && has(calls, 'whereBetween', 'l.created_at')
        ? rows
        : []
    const a = await app()
    const one = await a.inject({ url: `/traffic-map/inspect/request/${RID}?at=${T0 + 300}` })
    expect(one.json().data.matched_by).toBe('time')
    rows = [gqlRow(), gqlRow({ id: 32 })]
    const two = await a.inject({ url: `/traffic-map/inspect/request/${RID}?at=${T0 + 300}` })
    const d = two.json().data
    expect(d.row).toBeNull()
    expect(d.pending).toBe(false)
    expect(d.missing).toMatch(/Not in the API log/)
    const old = await a.inject({
      url: `/traffic-map/inspect/request/${RID}?at=${T0 - 30 * 86_400_000}`
    })
    expect(old.json().data.missing).toMatch(/Older than API log retention/)
    // No anchor: a fresh request may still be in the logger's batch.
    const fresh = await a.inject({ url: `/traffic-map/inspect/request/${RID}` })
    expect(fresh.json().data).toMatchObject({ pending: true, missing: null, row: null })
    await a.close()
  })

  it('resolves a chain id to the newest root-/graphql row of that chain (chain)', async () => {
    answer = (_t, calls) =>
      has(calls, 'where', 'l.chain_id') && has(calls, 'whereNull', 'l.request_id') ? [gqlRow()] : []
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/request/${CHAIN}` })
    expect(res.json().data.matched_by).toBe('chain')
    const cq = queries.find((q) => has(q.calls, 'where', 'l.chain_id'))
    expect(cq?.calls).toContainEqual(['where', ['l.chain_id', CHAIN]])
    expect(cq?.calls).toContainEqual(['where', ['l.path', '/graphql']])
    await a.close()
  })
})

describe('trace source', () => {
  it('answers the kept waterfall with statement ids, and an epoch-ms peek', async () => {
    const id = keepTrace('/api/items/work_flows/5?x=1')
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/trace/${id}` })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.kept).toBe(true)
    expect(d.trace.id).toBe(id)
    expect(d.config).toMatchObject({ slow_ms: expect.any(Number), capacity: expect.any(Number) })
    for (const s of d.trace.top_sql) expect(s.sha).toBe(statementSha(s.sql))
    const peek = await a.inject({ url: `/traffic-map/inspect/trace/${id}/peek` })
    expect(peek.json().data.title).toBe('GET /api/items/:collection/:id')
    expect(peek.json().data.at).toBe(Date.parse(d.trace.ts))
    await a.close()
  })

  it('says why a trace is absent from the log row (fast, other instance)', async () => {
    answer = (_t, calls) => (has(calls, 'where', 'l.request_id') ? [logRow()] : [])
    const a = await app()
    const fast = await a.inject({ url: `/traffic-map/inspect/trace/${RID}` })
    expect(fast.json().data).toMatchObject({
      kept: false,
      code: 'fast',
      route: 'GET /api/items/work_flows/:id',
      caller: { key: 'uU1' }
    })
    answer = (_t, calls) =>
      has(calls, 'where', 'l.request_id') ? [logRow({ instance: 'elsewhere' })] : []
    const other = await a.inject({ url: `/traffic-map/inspect/trace/${RID}` })
    expect(other.json().data).toMatchObject({ kept: false, code: 'other_instance' })
    expect(other.json().data.reason).toMatch(/"elsewhere"/)
    const peek = await a.inject({ url: `/traffic-map/inspect/trace/${RID}/peek` })
    expect(peek.json().data.lines[0]).toMatch(/Not kept/)
    await a.close()
  })
})

describe('compare source', () => {
  it('compares a logged call with one that is neither logged nor traced', async () => {
    answer = (_t, calls) =>
      calls.some(([m, a]) => m === 'where' && a[0] === 'l.request_id' && a[1] === RID)
        ? [logRow({ query: 'fields=id&sort=name' })]
        : []
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/compare/${RID},${RID2}` })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.a.row.request_id).toBe(RID)
    expect(d.a.absence).toMatchObject({ kept: false, code: 'fast' })
    expect(d.b.row).toBeNull()
    expect(d.b.trace).toBeNull()
    expect(d.b.absence).toMatchObject({ code: 'unknown' })
    expect(d.diff.ms).toEqual({ a: 40, b: null, delta: null, pct: null })
    expect(d.diff.sql.comparable).toBe(false)
    expect(d.diff.params).toEqual([
      { name: 'fields', a: 'id', b: null, change: 'removed' },
      { name: 'sort', a: 'name', b: null, change: 'removed' }
    ])
    await a.close()
  })

  it('is a 404 when neither side exists, and uses a kept trace for a side without a row', async () => {
    const a = await app()
    const none = await a.inject({ url: `/traffic-map/inspect/compare/${RID},${RID2}` })
    expect(none.statusCode).toBe(404)
    const id = keepTrace('/api/items/work_flows/7?fields=name')
    const res = await a.inject({ url: `/traffic-map/inspect/compare/${RID},${id}` })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.a.row).toBeNull()
    expect(d.b.trace.id).toBe(id)
    expect(d.diff.ms.b).toBe(d.b.trace.total_ms)
    expect(d.diff.params).toEqual([{ name: 'fields', a: null, b: 'name', change: 'added' }])
    await a.close()
  })
})

describe('compare candidates', () => {
  it('filters the log by the route template with escaped LIKE around the request’s own time', async () => {
    answer = (_t, calls) => {
      if (calls.some(([m, a]) => m === 'where' && a[0] === 'l.request_id' && a[1] === RID))
        return [logRow()]
      if (has(calls, 'whereRaw', "l.path LIKE ? ESCAPE '\\'"))
        return [
          {
            id: 10,
            request_id: RID2.toUpperCase(),
            method: 'GET',
            path: '/api/items/work_flows/8',
            status: 200,
            latency_ms: 900,
            created_at: new Date(T0 - 60_000),
            user: 'U1',
            api_key_id: null
          },
          {
            // Same prefix, a different route (an extra segment): not a candidate.
            id: 11,
            request_id: '11111111-1111-4111-8111-111111111111',
            method: 'GET',
            path: '/api/items/work_flows/8/children',
            status: 200,
            latency_ms: 9,
            created_at: new Date(T0 - 1000),
            user: 'U2',
            api_key_id: null
          },
          {
            // Logged before request ids existed, not a root /graphql row: nothing names it.
            id: 12,
            request_id: null,
            chain_id: null,
            method: 'GET',
            path: '/api/items/work_flows/9',
            status: 200,
            latency_ms: 9,
            created_at: new Date(T0 - 2000),
            user: 'U2',
            api_key_id: null
          }
        ]
      return []
    }
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/compare-candidates/${RID}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({
      route: 'GET /api/items/work_flows/:id',
      candidates: [
        {
          request_id: RID2,
          by_chain: false,
          path: '/api/items/work_flows/8',
          status: 200,
          latency_ms: 900,
          created_at: new Date(T0 - 60_000).toISOString(),
          same_caller: true,
          traced: false
        }
      ]
    })
    const cq = queries.find((q) => has(q.calls, 'whereRaw', "l.path LIKE ? ESCAPE '\\'"))
    expect(call(cq?.calls ?? [], 'whereRaw')?.[1]).toEqual(['/api/items/work\\_flows/%'])
    // Anchored on the request's own time, not on now.
    expect(call(cq?.calls ?? [], 'whereBetween')).toEqual([
      'l.created_at',
      [new Date(T0 - 3600_000), new Date(T0 + 3600_000)]
    ])
    expect(cq?.calls).toContainEqual(['where', ['l.method', 'GET']])
    expect(cq?.calls).toContainEqual(['whereNot', ['l.id', 9]])

    const bad = await a.inject({ url: '/traffic-map/inspect/compare-candidates/nope' })
    expect(bad.statusCode).toBe(400)
    answer = () => []
    const gone = await a.inject({ url: `/traffic-map/inspect/compare-candidates/${RID2}` })
    expect(gone.statusCode).toBe(404)
    await a.close()
  })

  it('names root-/graphql candidates by their chain id, under either spelling of the path', async () => {
    answer = (_t, calls) => {
      if (has(calls, 'where', 'l.chain_id') && has(calls, 'whereNull', 'l.request_id'))
        return [gqlRow()]
      if (has(calls, 'where', 'l.graphql_operation'))
        return [
          {
            id: 40,
            request_id: null,
            chain_id: '22222222-2222-4222-8222-222222222222',
            method: 'POST',
            path: '/graphql',
            status: 200,
            latency_ms: 300,
            created_at: new Date(T0 + 30_000),
            user: null,
            api_key_id: 12,
            graphql_operation: 'workflows'
          },
          {
            id: 41,
            request_id: RID2,
            chain_id: null,
            method: 'POST',
            path: '/api/graphql',
            status: 200,
            latency_ms: 80,
            created_at: new Date(T0 + 5_000),
            user: 'U1',
            api_key_id: null,
            graphql_operation: 'workflows'
          }
        ]
      return []
    }
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/compare-candidates/${CHAIN}` })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.route).toBe('POST /api/graphql · workflows')
    // Nearest first.
    expect(d.candidates.map((c: { request_id: string }) => c.request_id)).toEqual([
      RID2,
      '22222222-2222-4222-8222-222222222222'
    ])
    expect(d.candidates[1]).toMatchObject({ by_chain: true, same_caller: true })
    const cq = queries.find((q) => has(q.calls, 'where', 'l.graphql_operation'))
    expect(call(cq?.calls ?? [], 'whereIn')).toEqual(['l.path', ['/graphql', '/api/graphql']])
    expect(cq?.calls).toContainEqual(['whereNotNull', ['l.chain_id']])
    await a.close()
  })
})
