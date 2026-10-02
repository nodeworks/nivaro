// Traffic Map drill-down, group "nav": the `load` and `search` sources through the generic inspect
// routes, and the group's own routes (/inspect/related, /inspect/search, /inspect/load-list),
// against a table-aware mocked db (Wave 0 harness: import the group file, inject).
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Op {
  m: string
  args: unknown[]
}
const h = vi.hoisted(() => ({
  tables: new Map<string, (ops: Array<{ m: string; args: unknown[] }>) => unknown[]>(),
  queries: [] as Array<{ table: string; ops: Array<{ m: string; args: unknown[] }> }>,
  trace: null as null | Record<string, unknown>
}))

vi.mock('../../db/index.js', () => {
  const CHAIN = [
    'where',
    'whereIn',
    'whereNot',
    'whereNull',
    'whereNotNull',
    'andWhere',
    'orWhereNull',
    'whereRaw',
    'select',
    'limit',
    'orderBy',
    'join',
    'clearSelect',
    'clearOrder',
    'count'
  ]
  function builder(table: string, ops: Array<{ m: string; args: unknown[] }> = []) {
    const b: Record<string, unknown> = {}
    for (const m of CHAIN)
      b[m] = (...args: unknown[]) => {
        ops.push({ m, args })
        return b
      }
    b.clone = () => builder(table, [...ops])
    const rows = () => {
      h.queries.push({ table, ops })
      return (h.tables.get(table) ?? (() => []))(ops)
    }
    b.first = (...args: unknown[]) => {
      ops.push({ m: 'first', args })
      const r = rows()
      return Promise.resolve(ops.some((o) => o.m === 'count') ? { n: r.length } : r[0])
    }
    // biome-ignore lint/suspicious/noThenProperty: knex query builders are thenables
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => rows())
        .then(res, rej)
    return b
  }
  return {
    db: Object.assign((table: string) => builder(table), {
      client: { pool: {} },
      raw: (s: string) => s
    })
  }
})
vi.mock('../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null),
  getTrace: vi.fn((id: string) => (h.trace && h.trace.id === id ? h.trace : null))
}))
vi.mock('../settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../workflow-transitions.js', () => ({
  resolveFriendlyId: async (_c: string, id: string) => `CR26-${id}`,
  friendlyIdField: async () => null
}))
vi.mock('../items.js', () => ({ resolveAliasId: async () => null }))

import { inspectCoreRoutes } from '../../routes/traffic-map-extras/inspect-core.js'
import { inspectNavRoutes } from '../../routes/traffic-map-extras/inspect-nav.js'
import { issueFingerprint } from '../error-tracking.js'
import { advanceTo, noteRequest, resetTrafficMap } from '../traffic-map.js'
import { issueTitleMatches, relatedFor } from './nav.js'
import { statementSha } from './nav-logic.js'

const T0 = 1_800_000_000
const RID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const RID2 = '0f8fad5b-d9cb-469f-a165-000000000002'
const CHAIN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const USER = 'aaaaaaaa-0000-0000-0000-000000000001'

/** The first `m` op whose args satisfy `pred` (a where on a column, a whereIn, …). */
function op(ops: Op[], m: string, pred: (args: unknown[]) => boolean): Op | undefined {
  return ops.find((o) => o.m === m && pred(o.args))
}
const whereEq = (ops: Op[], col: string) =>
  op(ops, 'where', (a) => a[0] === col || (typeof a[0] === 'object' && a[0] != null && col in a[0]))
const whereVal = (ops: Op[], col: string): unknown => {
  const o = whereEq(ops, col)
  if (!o) return undefined
  const a = o.args
  return a[0] === col ? a[a.length - 1] : (a[0] as Record<string, unknown>)[col]
}

const logRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  method: 'GET',
  path: '/api/items/workflows/9',
  status: 200,
  user: USER,
  api_key_id: null,
  auth: 'session',
  created_at: new Date(T0 * 1000),
  chain_id: CHAIN,
  error: null,
  instance: null,
  request_id: RID,
  ...over
})

async function app() {
  const a = Fastify()
  await a.register(
    async (sub) => {
      await sub.register(inspectCoreRoutes)
      await sub.register(inspectNavRoutes)
    },
    { prefix: '/traffic-map' }
  )
  await a.ready()
  return a
}

function pageCall(load: string, i: number, status = 200) {
  noteRequest({
    method: 'GET',
    path: `/api/items/workflows/${i}`,
    status,
    latencyMs: 40,
    authMethod: 'session',
    apiKeyId: null,
    userId: USER,
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000 + i * 10,
    req: {
      headers: {
        'x-nivaro-app': 'admin',
        'x-nivaro-page': '/collections/workflows/9',
        'x-nivaro-load': load
      },
      requestId: i === 1 ? RID : RID2
    }
  })
}

beforeEach(() => {
  h.tables.clear()
  h.queries.length = 0
  h.trace = null
  resetTrafficMap()
  advanceTo(T0)
})

describe('load source (#1205)', () => {
  it('400 for an id outside the load pattern, 404 when this process does not hold it', async () => {
    const a = await app()
    const bad = await a.inject({ url: '/traffic-map/inspect/load/x' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('INSPECT_ID_INVALID')
    const gone = await a.inject({ url: '/traffic-map/inspect/load/load000009' })
    expect(gone.statusCode).toBe(404)
    expect(gone.json().code).toBe('INSPECT_NOT_FOUND')
    await a.close()
  })

  it('answers a kept load as a waterfall, and its peek with an epoch-ms time', async () => {
    pageCall('load000001', 1)
    pageCall('load000001', 2, 500)
    const a = await app()
    const res = await a.inject({ url: '/traffic-map/inspect/load/load000001' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({
      load: 'load000001',
      page: '/collections/workflows/:id',
      app: 'admin',
      caller: `u${USER.toUpperCase()}`,
      calls: 2,
      dropped: 0,
      started_at: T0 * 1000 + 10 - 40,
      rum: null
    })
    expect(typeof d.instance).toBe('string')
    expect(
      d.waterfall.rows.map((r: { rid: string; offset_ms: number }) => [r.rid, r.offset_ms])
    ).toEqual([
      [RID, 0],
      [RID2, 10]
    ])
    expect(d.waterfall).toMatchObject({ total_ms: 50, errors: 1 })
    expect(d.waterfall.slowest.rid).toBe(RID)
    expect(d.ended_at - d.started_at).toBe(d.waterfall.total_ms)

    const peek = await a.inject({ url: '/traffic-map/inspect/load/load000001/peek' })
    expect(peek.json().data).toEqual({
      title: 'Page load · /collections/workflows/:id',
      lines: ['2 calls in 50 ms'],
      at: T0 * 1000 + 10 - 40
    })
    expect(typeof peek.json().data.at).toBe('number')
    await a.close()
  })

  it('/inspect/load-list: 400 without a page, the page’s newest loads with one', async () => {
    pageCall('load000001', 1)
    pageCall('load000002', 2)
    const a = await app()
    expect((await a.inject({ url: '/traffic-map/inspect/load-list' })).statusCode).toBe(400)
    const res = await a.inject({
      url: `/traffic-map/inspect/load-list?page=${encodeURIComponent('/collections/workflows/:id')}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.map((r: { load: string }) => r.load)).toEqual([
      'load000002',
      'load000001'
    ])
    await a.close()
  })
})

describe('search (#1208)', () => {
  it('refuses a credential and never echoes it; says what it takes for nothing', async () => {
    const a = await app()
    const refused = await a.inject({ url: '/traffic-map/inspect/search?q=nvk_abcdef0123456789' })
    expect(refused.json().data).toMatchObject({ q: null, type: 'refused', results: [] })
    expect(refused.body).not.toContain('nvk_abcdef')
    expect(h.queries).toHaveLength(0)
    const empty = await a.inject({ url: '/traffic-map/inspect/search?q=' })
    expect(empty.json().data).toMatchObject({ type: 'empty', results: [] })
    expect(empty.json().data.hint).toMatch(/uuid/)
    // the `search` source gives the same answer inside the panel
    const level = await a.inject({ url: '/traffic-map/inspect/search/nvk_abcdef0123456789' })
    expect(level.statusCode).toBe(200)
    expect(level.json().data.type).toBe('refused')
    await a.close()
  })

  it('a uuid resolves to the request, its chain and a kept trace', async () => {
    h.tables.set('nivaro_api_logs', (ops) => {
      if (whereVal(ops, 'request_id') === RID) return [logRow()]
      if (whereVal(ops, 'chain_id') === RID) return [{ id: 7 }]
      return []
    })
    h.trace = {
      id: RID,
      method: 'GET',
      route: '/api/items/workflows/:id',
      total_ms: 912,
      top_sql: []
    }
    const a = await app()
    const res = await a.inject({ url: `/traffic-map/inspect/search?q=${RID.toUpperCase()}` })
    const d = res.json().data
    expect(d.type).toBe('uuid')
    expect(
      d.results.map((r: { ref: { kind: string; id: string } }) => `${r.ref.kind}:${r.ref.id}`)
    ).toEqual([`request:${RID}`, `chain:${RID}`, `trace:${RID}`])
    expect(d.results[0]).toMatchObject({
      label: 'GET /api/items/workflows/9 · 200',
      ref: { at: T0 * 1000 }
    })
    await a.close()
  })

  it('an integer, an email and collection/id resolve to their levels', async () => {
    h.tables.set('nivaro_activity', (ops) =>
      whereVal(ops, 'id') === 1351
        ? [{ action: 'update', collection: 'workflows', item: '9', timestamp: new Date(T0 * 1000) }]
        : []
    )
    h.tables.set('nivaro_issues', (ops) =>
      whereVal(ops, 'id') === 1351
        ? [{ title: '[server] GET /x: boom', status: 'open', last_seen_at: new Date(T0 * 1000) }]
        : []
    )
    h.tables.set('nivaro_users', (ops) =>
      op(ops, 'whereRaw', (a) => Array.isArray(a[1]) && a[1][0] === 'rob@example.com')
        ? [{ id: USER, first_name: 'Rob', last_name: 'Lee', email: 'rob@example.com' }]
        : []
    )
    h.tables.set('nivaro_collections', (ops) =>
      whereVal(ops, 'collection') === 'workflows' ? [{ collection: 'workflows' }] : []
    )
    h.tables.set('workflows', (ops) => (whereVal(ops, 'id') === '371393' ? [{ id: 371393 }] : []))
    const a = await app()
    const int = (await a.inject({ url: '/traffic-map/inspect/search?q=1351' })).json().data
    expect(int.results.map((r: { ref: { kind: string } }) => r.ref.kind)).toEqual([
      'write',
      'issue'
    ])
    expect(int.results[0]).toMatchObject({ label: 'update workflows 9', ref: { id: '1351' } })

    const email = (
      await a.inject({ url: '/traffic-map/inspect/search?q=Rob%40Example.com' })
    ).json().data
    expect(email.results).toEqual([
      {
        ref: { kind: 'caller', id: `u${USER.toUpperCase()}`, label: 'Rob Lee' },
        label: 'Rob Lee',
        hint: 'Person · rob@example.com'
      }
    ])

    const rec = (await a.inject({ url: '/traffic-map/inspect/search?q=workflows%2F371393' })).json()
      .data
    expect(rec.results).toEqual([
      {
        ref: { kind: 'record', id: 'workflows:371393', label: 'workflows CR26-371393' },
        label: 'workflows CR26-371393',
        hint: 'Record'
      }
    ])
    await a.close()
  })
})

describe('related (#1204)', () => {
  it('400 for a kind outside the pattern or an id the level cannot have', async () => {
    const a = await app()
    const kind = await a.inject({ url: '/traffic-map/inspect/related/Bad%20Kind/1' })
    expect(kind.statusCode).toBe(400)
    const id = await a.inject({ url: '/traffic-map/inspect/related/request/nope' })
    expect(id.statusCode).toBe(400)
    expect(id.json()).toEqual({
      error: 'That is not a valid request id',
      code: 'INSPECT_ID_INVALID'
    })
    expect(
      (await a.inject({ url: '/traffic-map/inspect/related/record/nocolon' })).statusCode
    ).toBe(400)
    await a.close()
  })

  it('a request: its chain and its caller around that moment, never itself', async () => {
    const chainRows = [
      logRow(),
      logRow({ id: 2, request_id: RID2, path: '/api/items/workflows/10', status: 201 })
    ]
    h.tables.set('nivaro_api_logs', (ops) => {
      if (whereVal(ops, 'request_id') === RID) return [logRow()]
      if (whereVal(ops, 'chain_id') === CHAIN) return chainRows
      if (op(ops, 'whereIn', (a) => a[0] === 'user')) return chainRows
      return []
    })
    h.tables.set('nivaro_activity', (ops) =>
      whereVal(ops, 'chain_id') === CHAIN
        ? [
            {
              id: 44,
              action: 'update',
              collection: 'workflows',
              item: '9',
              timestamp: new Date(T0 * 1000)
            }
          ]
        : []
    )
    const a = await app()
    const res = await a.inject({
      url: `/traffic-map/inspect/related/request/${RID}?at=${T0 * 1000}&window=60`
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({ at: T0 * 1000, window: 60, load: null })
    expect(d.groups.map((g: { key: string }) => g.key)).toEqual(['chain', 'caller'])
    const [chain, caller] = d.groups
    expect(chain.refs.map((r: { kind: string; id: string }) => `${r.kind}:${r.id}`)).toEqual([
      `chain:${CHAIN}`,
      `request:${RID2}`,
      'write:44'
    ])
    expect(chain.more).toBeUndefined()
    expect(caller.refs[0]).toEqual({
      kind: 'caller',
      id: `u${USER.toUpperCase()}`,
      label: 'AAAAAAAA'
    })
    expect(caller.refs.map((r: { id: string }) => r.id)).not.toContain(RID)
    expect(caller.refs.map((r: { id: string }) => r.id)).toContain(RID2)
    // the caller window is the anchor ± 60 s
    const q = h.queries.find(
      (x) => x.table === 'nivaro_api_logs' && op(x.ops, 'whereIn', (a) => a[0] === 'user')
    )
    const from = op(q?.ops ?? [], 'andWhere', (a) => a[0] === 'created_at' && a[1] === '>=')
    expect((from?.args[2] as Date).getTime()).toBe(T0 * 1000 - 60_000)
    expect(d.notes.join(' ')).toMatch(/Page load: not known/)
    await a.close()
  })

  it('a failed request: same error by fingerprint first (no title LIKE on any dialect)', async () => {
    const failed = logRow({ status: 500, error: '{"message":"boom"}' })
    h.tables.set('nivaro_api_logs', (ops) => (whereVal(ops, 'request_id') === RID ? [failed] : []))
    const fp = issueFingerprint('server', 'GET /api/items/workflows/9', 'boom')
    h.tables.set('nivaro_issues', (ops) =>
      whereVal(ops, 'fingerprint') === fp
        ? [
            {
              id: 3,
              title: '[server] GET /api/items/workflows/9: boom',
              status: 'open',
              last_seen_at: new Date(T0 * 1000)
            }
          ]
        : []
    )
    const d = await relatedFor('request', RID, { req: {} as never, at: T0 * 1000, windowSec: 300 })
    const error = d?.groups.find((g) => g.key === 'error')
    expect(error?.refs).toEqual([
      {
        kind: 'issue',
        id: '3',
        label: 'open · [server] GET /api/items/workflows/9: boom',
        at: T0 * 1000
      }
    ])
    expect(h.queries.filter((q) => q.table === 'nivaro_issues')).toHaveLength(1)
    expect(h.queries.some((q) => q.ops.some((o) => o.args.includes('like')))).toBe(false)
  })

  it('…and by the `[server] METHOD` title in JS when the template differs from the path', async () => {
    const failed = logRow({ status: 500, error: '{"message":"boom"}' })
    h.tables.set('nivaro_api_logs', (ops) => (whereVal(ops, 'request_id') === RID ? [failed] : []))
    const at = new Date(T0 * 1000)
    h.tables.set('nivaro_issues', (ops) => {
      if (whereEq(ops, 'fingerprint')) return []
      expect(whereVal(ops, 'source')).toBe('server')
      return [
        {
          id: 5,
          title: '[server] GET /api/items/:collection/:id: boom',
          status: 'open',
          last_seen_at: at
        },
        {
          id: 6,
          title: '[server] POST /api/items/:collection: boom',
          status: 'open',
          last_seen_at: at
        },
        {
          id: 7,
          title: '[server] GET /api/items/:collection/:id: other',
          status: 'open',
          last_seen_at: at
        },
        { id: 8, title: 's GET /api/items/:collection/:id: boom', status: 'open', last_seen_at: at }
      ]
    })
    const d = await relatedFor('request', RID, { req: {} as never, at: T0 * 1000, windowSec: 300 })
    expect(d?.groups.find((g) => g.key === 'error')?.refs.map((r) => r.id)).toEqual(['5'])
    expect(h.queries.some((q) => q.ops.some((o) => o.args.includes('like')))).toBe(false)
    expect(issueTitleMatches('[server] GET /x: boom', 'get', 'boom')).toBe(true)
    expect(issueTitleMatches('[server] GET /x: boom', 'GET', 'bang')).toBe(false)
    expect(issueTitleMatches(null, 'GET', 'boom')).toBe(false)
  })

  it('a trace level is its request too: the request never lists in its own rail', async () => {
    h.tables.set('nivaro_api_logs', (ops) => {
      if (whereVal(ops, 'request_id') === RID) return [logRow()]
      if (whereVal(ops, 'chain_id') === CHAIN)
        return [logRow(), logRow({ id: 2, request_id: RID2 })]
      return []
    })
    pageCall('load000001', 1)
    pageCall('load000001', 2)
    const d = await relatedFor('trace', RID, { req: {} as never, at: null, windowSec: 300 })
    expect(d?.load).toEqual({ id: 'load000001', page: '/collections/workflows/:id', calls: 2 })
    for (const g of d?.groups ?? []) {
      expect(g.refs.map((r) => `${r.kind}:${r.id}`)).not.toContain(`request:${RID}`)
      expect(g.refs.map((r) => `${r.kind}:${r.id}`)).not.toContain(`trace:${RID}`)
    }
    expect(d?.groups.map((g) => g.key)).toEqual(['load', 'chain', 'caller'])
    expect(d?.groups[0].refs.map((r) => r.id)).toEqual(['load000001', RID2])
    expect(d?.at).toBe(T0 * 1000)
  })

  it('same statement shape: the kept trace’s top SQL as statement:<sha1> levels', async () => {
    h.tables.set('nivaro_api_logs', (ops) =>
      whereVal(ops, 'request_id') === RID ? [logRow()] : []
    )
    const sql = 'select * from workflows where id = @p0'
    h.trace = {
      id: RID,
      method: 'GET',
      route: '/api/items/workflows/:id',
      total_ms: 400,
      top_sql: [
        { sql, bindings: [9], ms: 120.4, n: 3 },
        { sql: `  select *   from workflows\n where id = @p0 `, bindings: [9], ms: 1, n: 1 },
        { sql: 'select 1', bindings: [], ms: 2, n: 1 }
      ]
    }
    const d = await relatedFor('request', RID, { req: {} as never, at: null, windowSec: 300 })
    const g = d?.groups.find((x) => x.key === 'statement')
    expect(g?.refs).toEqual([
      { kind: 'statement', id: statementSha(sql), label: `3× · 120 ms · ${sql}` },
      { kind: 'statement', id: statementSha('select 1'), label: '1× · 2 ms · select 1' }
    ])
    expect(g?.refs[0].id).toMatch(/^[0-9a-f]{40}$/)
    // the rail orders it last
    expect(d?.groups.map((x) => x.key).at(-1)).toBe('statement')
  })

  it('a record opened without an anchor centres on its newest change', async () => {
    const newest = new Date(T0 * 1000 - 3_600_000)
    h.tables.set('nivaro_activity', (ops) => {
      if (whereVal(ops, 'collection') !== 'workflows') return []
      return op(ops, 'first', () => true) && !op(ops, 'andWhere', () => true)
        ? [{ timestamp: newest }]
        : [{ id: 9, action: 'update', user: null, timestamp: newest }]
    })
    const d = await relatedFor('record', 'workflows:9', {
      req: {} as never,
      at: null,
      windowSec: 300
    })
    expect(d?.at).toBe(newest.getTime())
    expect(d?.groups.map((g) => g.key)).toEqual(['record'])
    expect(d?.groups[0].refs.map((r) => `${r.kind}:${r.id}`)).toEqual(['write:9'])
    // with an anchor the lookup is skipped
    h.queries.length = 0
    await relatedFor('record', 'workflows:9', { req: {} as never, at: T0 * 1000, windowSec: 300 })
    expect(h.queries.filter((q) => q.table === 'nivaro_activity')).toHaveLength(2)
  })
})
