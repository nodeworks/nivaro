// Traffic Map drill-down #1191 / #1213: keep-next arms through request-trace, capture bodies,
// the relay, and the routes that arm them.
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(1) }))

import { inspectCoreRoutes } from '../../routes/traffic-map-extras/inspect-core.js'
import { inspectRequestRoutes } from '../../routes/traffic-map-extras/inspect-request.js'
import { logActivity } from '../activity.js'
import {
  beginTrace,
  clearTraces,
  finishTrace,
  getTrace,
  type KeepNextInfo
} from '../request-trace.js'
import {
  captureBody,
  chainForGraphqlRequest,
  inspectBook,
  inspectKeepNext,
  type RelayMessage,
  receiveRelay,
  resetInspectCapture,
  setRelayPublisherForTests
} from './request-capture.js'
import { statementSha } from './request-logic.js'
import { resetStatementShapes, statementShapeOf } from './request-statements.js'

const RID = '0f0c3099-bcbf-499e-9066-a1de51cbabc5'

function info(over: Partial<KeepNextInfo> = {}): KeepNextInfo {
  return {
    id: RID,
    method: 'POST',
    route: '/api/items/:collection',
    url: '/api/items/workflows?x=1&token=abc',
    status: 200,
    user: '7A0411F3-C687-40E5-ADF5-614157CF88EC',
    total_ms: 12,
    request: {
      authMethod: 'session',
      headers: { 'content-type': 'application/json' },
      body: { name: 'A', password: 'hunter2' }
    },
    ...over
  }
}

function armCapture(spec: { route?: string; caller?: string; entity?: string }, count = 5) {
  const now = Date.now()
  inspectBook().arm({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    kind: 'capture',
    spec: { route: spec.route ?? null, caller: spec.caller ?? null, entity: spec.entity ?? null },
    total: count,
    remaining: count,
    createdAt: now,
    expiresAt: now + 60_000,
    by: null,
    node: 'local'
  })
}

beforeEach(() => {
  resetInspectCapture()
  resetStatementShapes()
  clearTraces()
})
afterEach(() => setRelayPublisherForTests(null))

describe('inspectKeepNext', () => {
  it('does nothing without arms', () => {
    expect(inspectKeepNext(info())).toBe(false)
  })
  it('keeps and captures a matching session write with credentials masked', () => {
    armCapture({ entity: 'items/workflows' })
    const sent: RelayMessage[] = []
    setRelayPublisherForTests((m) => sent.push(m))
    expect(inspectKeepNext(info())).toBe(true)
    const v = inspectBook().view('aaaaaaaa-0000-4000-8000-000000000001')
    expect(v?.entries).toHaveLength(1)
    const e = v?.entries[0]
    expect(e?.route).toBe('POST /api/items/workflows')
    expect(e?.body).toContain('"name":"A"')
    expect(e?.body).not.toContain('hunter2')
    expect(e?.query).toBe('x=1&token=••••••')
    expect(sent).toHaveLength(1)
    expect(sent[0].t).toBe('kept')
    expect(inspectBook().captured(RID)?.entry.body).toContain('••••••')
  })
  it('matches a caller key and never the page’s own polling', () => {
    armCapture({ caller: 'u7A0411F3-C687-40E5-ADF5-614157CF88EC' })
    expect(inspectKeepNext(info({ url: '/api/traffic-map/snapshot' }))).toBe(false)
    expect(inspectKeepNext(info())).toBe(true)
  })
  it('remembers the chain of an internally dispatched GraphQL request', () => {
    inspectKeepNext(
      info({ url: '/api/graphql', request: { chainId: 'CD40C1C4-125F-4D20-933C-783C1A7175BD' } })
    )
    expect(chainForGraphqlRequest(RID)?.chainId).toBe('CD40C1C4-125F-4D20-933C-783C1A7175BD')
  })
})

describe('captureBody', () => {
  it('says why there is no body', () => {
    expect(captureBody(null, 'GET').note).toMatch(/GET/)
    expect(
      captureBody({ body: {}, headers: { 'content-type': 'multipart/form-data' } }, 'POST').note
    ).toMatch(/Multipart/)
  })
})

describe('relay', () => {
  it('arms from a peer and counts the peer’s kept entries', () => {
    const now = Date.now()
    receiveRelay({
      t: 'arm',
      node: 'peer',
      arm: {
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        kind: 'trace',
        spec: { route: 'GET /api/x', caller: null, entity: null },
        total: 2,
        remaining: 2,
        createdAt: now,
        expiresAt: now + 60_000,
        by: null,
        node: 'peer'
      }
    })
    receiveRelay({
      t: 'kept',
      node: 'peer',
      armId: 'bbbbbbbb-0000-4000-8000-000000000002',
      entry: {
        rid: RID,
        at: now,
        ms: 5,
        route: 'GET /api/x',
        method: 'GET',
        path: '/api/x',
        status: 200,
        node: 'peer'
      }
    })
    const v = inspectBook().view('bbbbbbbb-0000-4000-8000-000000000002')
    expect(v?.remaining).toBe(1)
    expect(v?.entries[0].node).toBe('peer')
    receiveRelay({ t: 'stop', node: 'peer', armId: 'bbbbbbbb-0000-4000-8000-000000000002' })
    const stopped = inspectBook().view('bbbbbbbb-0000-4000-8000-000000000002')
    expect(stopped?.done).toBe(true)
    expect(stopped?.entries).toHaveLength(1)
  })
})

describe('request-trace keep-next hook', () => {
  it('keeps a fast request’s trace when an arm matches, and records its statement shapes', () => {
    armCapture({ route: 'GET /api/items/workflows/:id' }, 1)
    const req = { authMethod: 'session' }
    beginTrace('/api/items/workflows/5', req)
    finishTrace({
      method: 'GET',
      route: '/api/items/:collection/:id',
      url: '/api/items/workflows/5',
      status: 200,
      user: null
    })
    const kept = inspectBook().view('aaaaaaaa-0000-4000-8000-000000000001')?.entries[0]
    expect(kept).toBeDefined()
    expect(getTrace(kept?.rid as string)).not.toBeNull()
    // The next one is fast and the arm is spent: not kept.
    beginTrace('/api/items/workflows/6', req)
    finishTrace({
      method: 'GET',
      route: '/api/items/:collection/:id',
      url: '/api/items/workflows/6',
      status: 200,
      user: null
    })
    expect(inspectBook().view('aaaaaaaa-0000-4000-8000-000000000001')?.entries).toHaveLength(1)
    expect(statementShapeOf(statementSha('select nothing'))).toBeNull()
  })
})

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

describe('routes', () => {
  it('arms trace-next, polls it, and logs the activity row', async () => {
    const a = await app()
    const bad = await a.inject({
      method: 'POST',
      url: '/traffic-map/inspect/trace-next',
      payload: {}
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('ARM_INVALID')
    const res = await a.inject({
      method: 'POST',
      url: '/traffic-map/inspect/trace-next',
      payload: { route: 'GET /api/items/workflows/:id', count: 2, ttlSec: 60 }
    })
    expect(res.statusCode).toBe(200)
    const id = res.json().data.id as string
    expect(vi.mocked(logActivity)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'traffic-trace-next' })
    )
    const poll = await a.inject({ method: 'GET', url: `/traffic-map/inspect/trace-next/${id}` })
    expect(poll.json().data).toMatchObject({ remaining: 2, traces: [] })
    const gone = await a.inject({
      method: 'GET',
      url: '/traffic-map/inspect/trace-next/cccccccc-0000-4000-8000-000000000003'
    })
    expect(gone.statusCode).toBe(404)
    const junk = await a.inject({ method: 'GET', url: '/traffic-map/inspect/trace-next/abc' })
    expect(junk.statusCode).toBe(400)
    await a.close()
  })
  it('arms a capture, which the capture source then shows', async () => {
    const a = await app()
    const res = await a.inject({
      method: 'POST',
      url: '/traffic-map/inspect/capture',
      payload: { entity: 'items/workflows', count: 3 }
    })
    expect(res.statusCode).toBe(200)
    const id = res.json().data.id as string
    expect(vi.mocked(logActivity)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'traffic-capture' })
    )
    const detail = await a.inject({ method: 'GET', url: `/traffic-map/inspect/capture/${id}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data).toMatchObject({ kind: 'capture', total: 3, entries: [] })
    // The generic inspect routes still answer beside the static ones.
    const unknown = await a.inject({
      method: 'GET',
      url: '/traffic-map/inspect/capture/cccccccc-0000-4000-8000-000000000003'
    })
    expect(unknown.json().code).toBe('INSPECT_NOT_FOUND')
    const statement = await a.inject({ method: 'GET', url: '/traffic-map/inspect/statement/xyz' })
    expect(statement.json().code).toBe('INSPECT_ID_INVALID')
    await a.close()
  })
})

describe('statement shapes', () => {
  it('keeps one representative per shape with the routes that ran it', async () => {
    const { noteTraceStatements, MAX_SHAPES, statementShapeCount } = await import(
      './request-statements.js'
    )
    const rec = (id: string, url: string, sql: string, ms: number) => ({
      id,
      method: 'GET',
      route: '/api/items/:collection/:id',
      url,
      status: 200,
      user: null,
      total_ms: 50,
      spans: [],
      ts: new Date().toISOString(),
      queries: 3,
      sql_ms: ms,
      top_sql: [{ sql, bindings: [5], ms, n: 2 }],
      wide: []
    })
    const sql = 'select * from [workflows] where id = @p0'
    noteTraceStatements(rec('r1', '/api/items/workflows/5', sql, 20))
    noteTraceStatements(
      rec('r2', '/api/items/units/7?x=1', 'select *  from [workflows]  where id = @p0', 40)
    )
    noteTraceStatements(rec('r2', '/api/items/units/7', sql, 40))
    const s = statementShapeOf(statementSha(sql))
    expect(s?.traces).toBe(2)
    expect(s?.calls).toBe(4)
    expect(s?.avg_ms).toBe(15)
    expect(s?.routes.map((r) => r.route).sort()).toEqual([
      'GET /api/items/units/:id',
      'GET /api/items/workflows/:id'
    ])
    expect(s?.routes.find((r) => r.route.includes('units'))?.entity).toBe('items/units')
    for (let i = 0; i < MAX_SHAPES + 10; i++)
      noteTraceStatements(rec(`x${i}`, '/api/x', `select ${i}`, 1))
    expect(statementShapeCount()).toBe(MAX_SHAPES)
  })
})
