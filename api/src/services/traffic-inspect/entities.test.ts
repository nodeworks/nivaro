// api/src/services/traffic-inspect/entities.test.ts
// The "entities" inspect group through the Wave 0 routes: every kind answers 200 for something
// that exists and 404 (or 400 for an id it refuses) for something that does not.
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../partner-dependencies.js', () => ({ callerDependencies: vi.fn(async () => null) }))
vi.mock('../../plugins/socketio.js', () => ({
  usersOnPath: () => [{ id: 'b2c3d4e5-0000-4000-8000-000000000002', name: 'Beth', since: 1 }]
}))

import { db } from '../../db/index.js'
import { inspectCoreRoutes } from '../../routes/traffic-map-extras/inspect-core.js'
import { inspectEntitiesRoutes } from '../../routes/traffic-map-extras/inspect-entities.js'
import { bustDefinitionCache } from '../definition-cache.js'
import { setActiveBreakersForTest } from '../traffic-breaker.js'
import { inspectSource } from '../traffic-inspect.js'
import { callerDetail } from './entities-caller.js'
import './entities.js'

type Row = Record<string, unknown>
type FirstAnswer = Row | undefined | ((wheres: unknown[][]) => Row | undefined)

/** A thenable knex builder per table; records where / whereIn calls. */
const calls: Array<{ table: string; m: string; args: unknown[] }> = []
function tables(rows: Record<string, Row[]>, first: Record<string, FirstAnswer> = {}) {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {}
    const wheres: unknown[][] = []
    for (const m of [
      'where',
      'whereIn',
      'whereNull',
      'whereNot',
      'whereRaw',
      'orWhereNot',
      'orWhereRaw',
      'leftJoin',
      'orderBy',
      'limit',
      'select'
    ])
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, m, args })
        if (m.startsWith('where')) wheres.push(args)
        if (typeof args[0] === 'function') (args[0] as (b: unknown) => void)(chain)
        return chain
      })
    chain.first = vi.fn(() => {
      const f = first[table]
      const p = Promise.resolve(typeof f === 'function' ? f(wheres) : f)
      return Object.assign(p, { catch: p.catch.bind(p) })
    })
    chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(rows[table] ?? []).catch(fn)
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows[table] ?? []).then(res, rej)
    return chain
  })
}

const ctx = { req: {} as never, at: null, windowSec: 300 }
const UUID = '7A0411F3-C687-40E5-ADF5-614157CF88EC'

let app: FastifyInstance
const get = (path: string) => app.inject({ url: `/traffic-map/inspect/${path}` })

beforeAll(async () => {
  app = Fastify({ logger: false })
  await app.register(inspectCoreRoutes, { prefix: '/traffic-map' })
  await app.ready()
})
afterAll(() => app.close())

beforeEach(() => {
  calls.length = 0
  tables({})
  bustDefinitionCache()
  setActiveBreakersForTest([])
})

describe('entities inspect sources', () => {
  it('register every kind with strict id validation', () => {
    const cases: Record<string, [string[], string[]]> = {
      caller: [
        ['k12', 'cron', 'cron:job-a'],
        ['k', 'x1', "cron:'"]
      ],
      entity: [['items/workflows'], ['nope/x', 'items/a b']],
      query: [
        ['project-budgets', '4'],
        ['a b', "x'"]
      ],
      widget: [['5'], ['0', 'x']],
      page: [
        ['/collections/:id', 'admin /x'],
        ['/collections/12', 'x']
      ],
      down: [
        ['db', 'ext:3', 'x:efp-ops.mdsi'],
        ['ext:x y', '']
      ]
    }
    for (const [kind, [ok, bad]] of Object.entries(cases)) {
      const s = inspectSource(kind)
      expect(s, kind).toBeTruthy()
      for (const id of ok) expect(s?.validId(id), `${kind} ${id}`).toBe(true)
      for (const id of bad) expect(s?.validId(id), `${kind} ${id}`).toBe(false)
    }
  })
})

describe('caller', () => {
  it('reads an API key, its requests and refusals, never the key hash', async () => {
    const at = new Date()
    tables(
      {
        nivaro_api_logs: [
          {
            method: 'GET',
            path: '/api/items/x/1',
            status: 200,
            latency_ms: 10,
            created_at: at,
            request_id: 'r1'
          },
          {
            method: 'GET',
            path: '/api/items/x/2',
            status: 403,
            latency_ms: 5,
            created_at: at,
            error: '{"error":"no","code":"API_KEY_SCOPE_MISSING"}',
            request_id: null
          }
        ]
      },
      {
        nivaro_api_keys: {
          id: 12,
          name: 'Partner',
          scopes: '[{"collection":"x","actions":["read"]}]',
          ip_allowlist: '["10.0.0.1"]',
          rate_limit_per_minute: 60,
          is_active: true,
          key_hash: 'SECRET'
        }
      }
    )
    setActiveBreakersForTest([
      {
        kind: 'caller',
        target: 'k12',
        mode: 'refuse',
        limit: null,
        until: Date.now() + 60_000,
        reason: 'storm',
        by: null,
        by_name: 'Rob',
        at: Date.now()
      }
    ])
    const res = await get('caller/k12?window=60')
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.label).toBe('Partner')
    expect(d.summary.total).toBe(2)
    expect(d.summary.errors).toBe(1)
    expect(d.auth_failures).toEqual([
      { code: 'API_KEY_SCOPE_MISSING', status: 403, message: 'no', n: 1 }
    ])
    expect(d.recent[0].request_id).toBe('r1')
    expect(d.key_info.rate_limit_per_minute).toBe(60)
    expect(d.key_info.ip_allowlist).toEqual(['10.0.0.1'])
    expect(d.breakers).toHaveLength(1)
    expect(res.body).not.toContain('SECRET')
    expect(
      calls.some(
        (c) =>
          c.table === 'nivaro_api_logs' &&
          c.m === 'where' &&
          c.args[0] === 'api_key_id' &&
          c.args[1] === 12
      )
    ).toBe(true)
    const peek = await get('caller/k12/peek')
    expect(peek.json().data).toEqual({
      title: 'Partner',
      lines: ['API key · active', 'Limit 60/min']
    })
  })

  it('a key or person that does not exist and made no request → 404', async () => {
    const key = await get('caller/k99')
    expect(key.statusCode).toBe(404)
    expect(key.json().code).toBe('INSPECT_NOT_FOUND')
    const person = await get(`caller/u${UUID}`)
    expect(person.statusCode).toBe(404)
    expect(person.json().code).toBe('INSPECT_NOT_FOUND')
  })

  it('a person who left requests but has no user row any more still answers', async () => {
    tables({
      nivaro_api_logs: [
        { method: 'GET', path: '/api/me', status: 200, latency_ms: 3, created_at: new Date() }
      ]
    })
    const res = await get(`caller/u${UUID.toLowerCase()}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ key: `u${UUID}`, kind: 'person', person: null })
    expect(res.json().data.summary.total).toBe(1)
  })

  it('the anonymous bucket reads requests with no user and no key', async () => {
    tables({
      nivaro_api_logs: [
        {
          method: 'POST',
          path: '/api/auth/login',
          status: 401,
          latency_ms: 3,
          created_at: new Date()
        }
      ]
    })
    const res = await get('caller/anon')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.logged).toBe(true)
    expect(res.json().data.summary.total).toBe(1)
    expect(
      calls.some(
        (c) => c.table === 'nivaro_api_logs' && c.m === 'whereNull' && c.args[0] === 'user'
      )
    ).toBe(true)
    expect(
      calls.some(
        (c) => c.table === 'nivaro_api_logs' && c.m === 'orWhereNot' && c.args[0] === 'auth'
      )
    ).toBe(true)
  })

  it('a cron source reads its job runs, not the API log', async () => {
    tables({
      nivaro_job_runs: [{ id: 9, status: 'completed', started_at: new Date(), duration_ms: 4 }]
    })
    const d = (await callerDetail('cron:outbox-worker', ctx)) as Record<string, any>
    expect(d.logged).toBe(false)
    expect(d.runs.kind).toBe('job')
    expect(d.runs.runs[0].id).toBe('9')
    expect(calls.some((c) => c.table === 'nivaro_api_logs')).toBe(false)
  })

  it('caller-deps route: refuses a bad key, answers null for sources', async () => {
    const a = Fastify({ logger: false })
    await a.register(inspectEntitiesRoutes)
    expect((await a.inject({ url: '/inspect/caller-deps?key=nope' })).statusCode).toBe(400)
    const res = await a.inject({ url: '/inspect/caller-deps?key=cron:x' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toBeNull()
    const res2 = await a.inject({ url: '/inspect/caller-deps?key=k3' })
    expect(res2.json().data).toEqual({ found: false })
    await a.close()
  })
})

describe('entity', () => {
  it('reads a collection: label, history from the log, failed requests and writes', async () => {
    const at = new Date(Date.now() - 60_000)
    tables(
      {
        nivaro_api_logs: [
          {
            method: 'GET',
            path: '/api/items/workflows/9',
            status: 404,
            latency_ms: 5,
            auth: 'api_key',
            api_key_id: 2,
            created_at: at,
            request_id: 'r9'
          }
        ],
        nivaro_activity: [
          { id: 77, action: 'update', item: '9', user: null, timestamp: at, origin: 'person' }
        ]
      },
      { nivaro_collections: { display_name: 'Workflows' } }
    )
    const res = await get(`entity/${encodeURIComponent('items/workflows')}?window=60`)
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({ key: 'items/workflows', label: 'Workflows', history_hours: 1 })
    expect(d.history.totals.req).toBe(1)
    expect(d.recent_errors[0]).toMatchObject({ caller: 'k2', request_id: 'r9' })
    expect(d.recent_writes[0]).toMatchObject({ id: 77, action: 'update', item: '9' })
    expect(d.history_anchor_note).toBeNull()
    const peek = await get(`entity/${encodeURIComponent('items/workflows')}/peek`)
    expect(peek.json().data).toEqual({ title: 'Workflows', lines: ['items lane'] })
  })

  it('anchored 3 h back: the history widens to reach the anchor; far back it says so', async () => {
    const at3h = Date.now() - 3 * 3600_000
    const near = await get(`entity/${encodeURIComponent('items/workflows')}?at=${at3h}&window=300`)
    expect(near.statusCode).toBe(200)
    expect(near.json().data.history_hours).toBe(6)
    expect(near.json().data.history_anchor_note).toBeNull()
    const at2d = Date.now() - 48 * 3600_000
    const far = await get(`entity/${encodeURIComponent('items/workflows')}?at=${at2d}&window=300`)
    expect(far.json().data.history_hours).toBe(24)
    expect(far.json().data.history_anchor_note).toMatch(/older than 24 h/)
  })

  it('the socket lane keeps off the log; a malformed id is refused', async () => {
    const res = await get(`entity/${encodeURIComponent('socket/record.join')}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().data.history).toBeNull()
    expect(res.json().data.history_note).toMatch(/Socket events/)
    expect(calls.some((c) => c.table === 'nivaro_api_logs')).toBe(false)
    const bad = await get(`entity/${encodeURIComponent('items/a b')}`)
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('INSPECT_ID_INVALID')
  })
})

describe('query', () => {
  const row = {
    id: 4,
    name: 'Project budgets',
    slug: 'project-budgets',
    sql_text: 'select 1',
    params: '[]',
    cache_ttl: 60,
    enabled: true
  }

  it('reads a saved query by slug with its cache row and plan slot', async () => {
    tables({}, { nivaro_custom_queries: row })
    const res = await get('query/project-budgets')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      id: 4,
      slug: 'project-budgets',
      name: 'Project budgets',
      sql_text: 'select 1',
      entity: 'queries/project-budgets',
      plan: null
    })
    const peek = await get('query/project-budgets/peek')
    expect(peek.json().data).toEqual({
      title: 'Project budgets',
      lines: ['/project-budgets', 'Cached 60s']
    })
  })

  it('an all-digit id is a slug first, the numeric id only when no such slug exists', async () => {
    tables(
      {},
      {
        nivaro_custom_queries: (wheres) =>
          wheres.some((w) => w[0] === 'slug' && w[1] === '12')
            ? { ...row, id: 40, slug: '12', name: 'Slug twelve' }
            : wheres.some((w) => w[0] === 'id' && w[1] === 12)
              ? { ...row, id: 12, slug: 'twelfth', name: 'Query twelve' }
              : undefined
      }
    )
    expect((await get('query/12')).json().data.name).toBe('Slug twelve')
    tables(
      {},
      {
        nivaro_custom_queries: (wheres) =>
          wheres.some((w) => w[0] === 'id' && w[1] === 12)
            ? { ...row, id: 12, slug: 'twelfth', name: 'Query twelve' }
            : undefined
      }
    )
    expect((await get('query/12')).json().data.name).toBe('Query twelve')
  })

  it('no such query → 404', async () => {
    const res = await get('query/nope')
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('INSPECT_NOT_FOUND')
    expect((await get('query/nope/peek')).json()).toEqual({ data: null })
  })
})

describe('widget', () => {
  it('reads a widget and its bound query', async () => {
    tables(
      {},
      {
        nivaro_widgets: {
          id: 5,
          name: 'Budget table',
          widget_type: 'table',
          is_active: true,
          config: '{"query_id":4,"table":{"columns":[{},{}]}}'
        },
        nivaro_custom_queries: {
          id: 4,
          slug: 'project-budgets',
          name: 'Project budgets',
          cache_ttl: 0
        }
      }
    )
    const res = await get('widget/5')
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({ id: 5, name: 'Budget table', type: 'table', entity: 'widgets/5' })
    expect(d.query).toMatchObject({ id: 4, slug: 'project-budgets' })
    expect(d.config_lines).toEqual([{ label: 'Columns', value: '2' }])
    expect((await get('widget/5/peek')).json().data).toEqual({
      title: 'Budget table',
      lines: ['table']
    })
  })

  it('a bound query that was deleted is said so; no such widget → 404', async () => {
    tables(
      {},
      { nivaro_widgets: { id: 6, name: 'Orphan', widget_type: 'table', config: '{"query_id":99}' } }
    )
    expect((await get('widget/6')).json().data.query).toEqual({ id: 99, missing: true })
    bustDefinitionCache()
    tables({})
    const res = await get('widget/999')
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('INSPECT_NOT_FOUND')
  })
})

describe('page', () => {
  it('answers for a literal screen with who is on it; a real id in the path is refused', async () => {
    const res = await get(`page/${encodeURIComponent('admin /traffic-map')}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      id: 'admin /traffic-map',
      app: 'admin',
      path: '/traffic-map',
      present_note: null,
      present: [{ name: 'Beth' }]
    })
    const pattern = await get(`page/${encodeURIComponent('/collections/:id')}`)
    expect(pattern.json().data.present).toEqual([])
    expect(pattern.json().data.present_note).toMatch(/without an id/)
    const bad = await get(`page/${encodeURIComponent('/collections/12')}`)
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('INSPECT_ID_INVALID')
    expect((await get(`page/${encodeURIComponent('/traffic-map')}/peek`)).json().data).toEqual({
      title: '/traffic-map',
      lines: ['any app', 'No calls seen']
    })
  })
})

describe('down', () => {
  it("the map's own node answers with its note; a partner with its summary and submissions", async () => {
    const own = await get('down/db')
    expect(own.statusCode).toBe(200)
    expect(own.json().data).toMatchObject({ id: 'db', label: 'SQL Server', partner: null })
    expect(own.json().data.history.note).toMatch(/attribution/)

    tables(
      {
        nivaro_erp_submissions: [{ id: 31, status: 'failed', attempts: 2, error_class: 'http' }]
      },
      {
        nivaro_external_apis: {
          id: 3,
          name: 'MDSI',
          base_url: 'https://u:p@api.mdsi.example/v1?key=s',
          enabled: true,
          auth_config: '{"token":"SECRET"}'
        }
      }
    )
    const ext = await get('down/ext:3')
    expect(ext.statusCode).toBe(200)
    const d = ext.json().data
    expect(d.partner).toMatchObject({
      id: 3,
      name: 'MDSI',
      base_url: 'https://api.mdsi.example/v1'
    })
    expect(d.partner_missing).toBe(false)
    expect(d.submissions[0]).toMatchObject({ id: 31, status: 'failed', attempts: 2 })
    expect(ext.body).not.toContain('SECRET')
    expect((await get('down/ext:3/peek')).json().data).toEqual({
      title: 'MDSI',
      lines: ['Partner API · enabled']
    })
  })

  it('a node nobody logs and a partner id with nothing behind it → 404', async () => {
    const unknown = await get('down/zzz')
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().code).toBe('INSPECT_NOT_FOUND')
    const gone = await get('down/ext:999')
    expect(gone.statusCode).toBe(404)
  })

  it('a deleted partner whose outbound log still has rows stays readable', async () => {
    tables({
      nivaro_outbound_log: [
        {
          method: 'POST',
          path: '/orders/1',
          status: 500,
          ok: false,
          duration_ms: 40,
          created_at: new Date(Date.now() - 60_000)
        }
      ]
    })
    const res = await get('down/ext:8')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ partner: null, partner_missing: true })
    expect(res.json().data.history.totals).toEqual({ req: 1, error: 1 })
  })
})
