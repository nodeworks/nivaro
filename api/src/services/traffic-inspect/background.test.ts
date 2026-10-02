// api/src/services/traffic-inspect/background.test.ts
// The four background inspect sources through the Wave 0 harness: the group file registers its
// sources, inspectCoreRoutes answers /traffic-map/inspect/<kind>/<id>, and the database is a
// table-keyed fake so each read's fallbacks (missing columns, a refused attempts list, a run
// that started long before the moment) can be exercised without one.
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type Call = { m: string; args: unknown[] }
type TableData = Row[] | ((calls: Call[]) => Row[])

/** Rows per table for the test at hand; a function sees the builder calls (for conditional answers). */
let tables: Record<string, TableData> = {}
/** Tables whose reads throw (a dropped table, a refused statement). */
let failing = new Set<string>()
/** What the stub attempts route answers. */
let attemptsReply: { status: number; body: unknown } = { status: 404, body: {} }

vi.mock('../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../flow-executor.js', () => ({ executeFlow: vi.fn() }))
vi.mock('../../plugins/api-logger.js', () => ({
  INTERNAL_DISPATCH_HEADER: 'x-nivaro-internal-dispatch',
  internalDispatchTokens: new Set<string>()
}))
vi.mock('../ai-log.js', () => ({ AI_LOG_RETENTION_DAYS: 30 }))
vi.mock('../instance-roster.js', () => ({ INSTANCE_ID: 'node0001' }))
vi.mock('../cron-descriptions.js', () => ({
  CRON_DESCRIPTIONS: { 'staged-imports': 'Imports staged rows' }
}))
vi.mock('../workflow-transitions.js', () => ({
  resolveFriendlyIds: vi.fn(async (_c: string, ids: string[]) => {
    const out = new Map<string, string>()
    for (const id of ids) out.set(id, `REC-${id}`)
    return out
  })
}))
vi.mock('../submission-detail.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../submission-detail.js')>()
  return { ...real, gatherSubmissionFacts: vi.fn() }
})
vi.mock('../traffic-taps/nodes.js', () => ({ trafficNodeTester: vi.fn(() => null) }))

import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { inspectCoreRoutes } from '../../routes/traffic-map-extras/inspect-core.js'
import { executeFlow } from '../flow-executor.js'
import { gatherSubmissionFacts, type SubmissionFacts } from '../submission-detail.js'
import { trafficNodeTester } from '../traffic-taps/nodes.js'
import { apisOfDownNode, flowDryRun, runForSource, submissionsFor } from './background.js'

const CHAIN = '0f4a2a6e-5b1c-4d3e-9a8b-7c6d5e4f3a2b'
const FLOW = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const RUN = '54b4cb84-ebda-420f-8185-eacd4fcd64db'
const USER = 'aaaaaaaa-0000-4000-8000-000000000001'

const CHAINABLE = [
  'where',
  'whereIn',
  'whereBetween',
  'whereNull',
  'whereNotNull',
  'orWhere',
  'orderBy',
  'limit',
  'offset',
  'leftJoin',
  'select',
  'first',
  'count'
]

function fakeChain(name: string) {
  const table = name.split(' ')[0]
  const calls: Call[] = []
  const c: Record<string, unknown> = {}
  const resolve = async (): Promise<unknown> => {
    if (failing.has(table)) throw new Error(`select * from ${table} - boom`)
    const data = tables[table]
    let rows = typeof data === 'function' ? data(calls) : (data ?? [])
    if (calls.some((x) => x.m === 'count')) rows = [{ n: rows.length }]
    return calls.some((x) => x.m === 'first') ? rows[0] : rows
  }
  for (const m of CHAINABLE) {
    c[m] = (...args: unknown[]) => {
      calls.push({ m, args })
      if (m === 'where' && typeof args[0] === 'function')
        (args[0] as (q: unknown) => void).call(c, c)
      return c
    }
  }
  // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited directly, so the fake must be thenable too
  c.then = (res?: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    resolve().then(res, rej)
  c.catch = (rej: (e: unknown) => unknown) => resolve().catch(rej)
  return c
}

async function app() {
  const a = Fastify()
  await a.register(inspectCoreRoutes, { prefix: '/traffic-map' })
  a.get('/api/erp-submissions/:id/attempts', async (_req, reply) =>
    reply.code(attemptsReply.status).send(attemptsReply.body)
  )
  await a.ready()
  return a
}

async function detail(kind: string, id: string, query = '') {
  const a = await app()
  const res = await a.inject({ url: `/traffic-map/inspect/${kind}/${id}${query}` })
  await a.close()
  return res
}

async function peek(kind: string, id: string) {
  const a = await app()
  const res = await a.inject({ url: `/traffic-map/inspect/${kind}/${id}/peek` })
  await a.close()
  return res
}

beforeEach(() => {
  tables = {}
  failing = new Set()
  attemptsReply = { status: 404, body: {} }
  vi.mocked(db).mockImplementation(((name: string) => fakeChain(name)) as never)
  vi.mocked(hasColumn).mockImplementation(async () => true)
  vi.mocked(trafficNodeTester).mockImplementation(() => null)
})

afterEach(() => {
  vi.mocked(executeFlow).mockReset()
  vi.mocked(gatherSubmissionFacts).mockReset()
})

// ─── AI call ────────────────────────────────────────────────────────────────

const aiRow = {
  id: '354',
  created_at: new Date('2026-10-01T10:00:00Z'),
  request_id: 'req-1',
  user: USER,
  feature: 'traffic-map',
  route: '/api/traffic-map/explain',
  provider: 'anthropic',
  model: 'claude-4-5-haiku',
  status: 'ok',
  latency_ms: '1750',
  input_tokens: '120',
  output_tokens: '30',
  cache_read_tokens: null,
  cache_write_tokens: null,
  cost_usd: '0.0017',
  stop_reason: 'end_turn',
  tool_calls: 1,
  rounds: 2,
  request: JSON.stringify({
    system: 'Be brief.',
    tools: [{ name: 'lookup' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Why slow?' }] }]
  }),
  response: JSON.stringify({ content: [{ type: 'text', text: 'Because.' }] }),
  error: null
}

describe('ai', () => {
  it('answers the call with its prompt, answer, numbers and sibling count', async () => {
    tables.nivaro_ai_calls = [aiRow, { ...aiRow, id: '355' }]
    tables.nivaro_users = [{ id: USER, first_name: 'Dana', last_name: 'Reyes', email: 'd@x' }]
    const res = await detail('ai', '354')
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({
      id: '354',
      request_id: 'req-1',
      calls_in_request: 2,
      user: { id: USER, name: 'Dana Reyes' },
      latency_ms: 1750,
      tokens: { input: 120, output: 30, cache_read: null, cache_write: null },
      cost_usd: 0.0017,
      response_text: 'Because.',
      kept_days: 30
    })
    expect(d.request).toEqual({
      system: 'Be brief.',
      tools: ['lookup'],
      messages: [{ role: 'user', text: 'Why slow?' }]
    })
  })

  it('404 when the row is gone, 400 for an id that is not digits', async () => {
    expect((await detail('ai', '354')).statusCode).toBe(404)
    expect((await detail('ai', '354')).json().code).toBe('INSPECT_NOT_FOUND')
    const readsBefore = vi.mocked(db).mock.calls.length
    expect((await detail('ai', '0')).statusCode).toBe(400)
    expect((await detail('ai', 'abc')).statusCode).toBe(400)
    expect((await detail('ai', '99999999999999999999')).statusCode).toBe(400)
    expect(vi.mocked(db).mock.calls.length).toBe(readsBefore)
  })

  it('peeks with the time as epoch ms', async () => {
    tables.nivaro_ai_calls = [aiRow]
    const res = await peek('ai', '354')
    expect(res.json().data).toEqual({
      title: 'AI call #354 · traffic-map',
      lines: ['claude-4-5-haiku · ok', '1750 ms · $0.0017'],
      at: Date.parse('2026-10-01T10:00:00Z')
    })
  })

  it('a failed read is a 500 without the statement', async () => {
    failing.add('nivaro_ai_calls')
    const res = await detail('ai', '354')
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('INSPECT_FAILED')
    expect(res.json().error).not.toMatch(/select/i)
  })
})

// ─── Job run ────────────────────────────────────────────────────────────────

const jobRow = {
  id: 9,
  kind: 'cron',
  job_id: 'staged-imports',
  label: null,
  extension_id: null,
  status: 'completed',
  trigger_kind: 'schedule',
  triggered_by: null,
  instance: 'api',
  instance_id: 'node0001',
  lease_holder: 'node0001',
  ticks_enabled: 1,
  started_at: new Date('2026-10-01T10:00:00Z'),
  finished_at: new Date('2026-10-01T10:02:00Z'),
  duration_ms: 120000,
  progress: '{"done":3}',
  outcome: '3 rows',
  error: null,
  chain_id: CHAIN
}

const write = {
  id: 501,
  action: 'update',
  collection: 'invoices',
  item: '12',
  timestamp: new Date('2026-10-01T10:01:00Z'),
  user: null
}

describe('job', () => {
  it('lists the writes, flows and pushes on the run’s chain', async () => {
    tables.nivaro_job_runs = [jobRow]
    tables.nivaro_activity = [write, { ...write, id: 500 }]
    tables.nivaro_flow_runs = [
      {
        id: RUN,
        flow: FLOW,
        flow_name: 'Notify',
        status: 'completed',
        trigger: 'event',
        started_at: write.timestamp
      }
    ]
    tables.nivaro_erp_submissions = [
      {
        id: 77,
        external_api: 2,
        api_name: 'MDSi',
        status: 'accepted',
        collection: 'orders',
        item: '1',
        created_at: write.timestamp,
        error_class: null
      }
    ]
    const res = await detail('job', '9')
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({
      id: '9',
      job_id: 'staged-imports',
      description: 'Imports staged rows',
      registered: false,
      this_node: true,
      ticks_enabled: true,
      progress: { done: 3 },
      chain_id: CHAIN,
      writes: { via: 'chain', total: 2 }
    })
    expect(d.writes.rows.map((w: Row) => w.id)).toEqual([501, 500])
    expect(d.flows).toEqual([
      {
        id: RUN,
        flow_id: FLOW,
        flow_name: 'Notify',
        status: 'completed',
        trigger: 'event',
        started_at: '2026-10-01T10:01:00.000Z'
      }
    ])
    expect(d.submissions[0]).toMatchObject({ id: 77, api_id: 2, api_name: 'MDSi' })
  })

  it('falls back to the cron window when the run has no chain id, and to nothing when the columns are missing', async () => {
    tables.nivaro_job_runs = [{ ...jobRow, chain_id: null }]
    tables.nivaro_activity = [write]
    const windowed = (await detail('job', '9')).json().data
    expect(windowed.writes).toMatchObject({ via: 'window', total: 1 })
    expect(windowed.writes.rows[0]).toMatchObject({ id: 501, action: 'update' })

    vi.mocked(hasColumn).mockImplementation(async () => false)
    const bare = (await detail('job', '9')).json().data
    expect(bare.writes).toEqual({ rows: [], total: 0, via: 'window' })

    tables.nivaro_job_runs = [jobRow]
    const noChainCols = (await detail('job', '9')).json().data
    expect(noChainCols.writes).toEqual({ rows: [], total: 0, via: 'chain' })
    expect(noChainCols.flows).toEqual([])
    expect(noChainCols.submissions).toEqual([])
  })

  it('404 / 400 and an epoch-ms peek', async () => {
    expect((await detail('job', '9')).statusCode).toBe(404)
    expect((await detail('job', '9x')).statusCode).toBe(400)
    tables.nivaro_job_runs = [jobRow]
    const p = await peek('job', '9')
    expect(p.json().data).toEqual({
      title: 'staged-imports · run #9',
      lines: ['cron · completed · 120000 ms'],
      at: Date.parse('2026-10-01T10:00:00Z')
    })
  })
})

// ─── Flow run ───────────────────────────────────────────────────────────────

const flowRunRow = {
  id: RUN,
  flow: FLOW,
  trigger: 'event',
  status: 'error',
  started_at: new Date('2026-10-01T10:01:00Z'),
  completed_at: new Date('2026-10-01T10:01:01Z'),
  duration_ms: 1000,
  ops_run: 2,
  matched: 1,
  halted_at: 'notify',
  error_message: 'notify: mail refused',
  user: null,
  input: JSON.stringify({ key: 'sk-live-1', po: 'PO1' }),
  output: JSON.stringify({ $error: 'mail refused', session_id: 'abc' }),
  chain_id: CHAIN,
  chain_parent: 'cron:staged-imports'
}

const flowOps = [
  { id: 'op1', key: 'check', name: 'Check', type: 'condition', resolve: 'OP2', reject: null },
  { id: 'op2', key: 'notify', name: 'Notify', type: 'mail', resolve: null, reject: null }
]

describe('flow', () => {
  it('masks input and output, marks the halted and failed operations, and names the job on the chain', async () => {
    tables.nivaro_flow_runs = [flowRunRow]
    tables.nivaro_flows = [
      { id: FLOW, name: 'Notify buyers', status: 'active', trigger: 'event', description: null }
    ]
    tables.nivaro_flow_operations = flowOps
    tables.nivaro_job_runs = [{ id: 9, job_id: 'staged-imports' }]
    const res = await detail('flow', RUN.toUpperCase())
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({
      id: RUN,
      flow: { id: FLOW, name: 'Notify buyers', active: true },
      status: 'error',
      matched: true,
      halted_at: 'notify',
      error: 'notify: mail refused',
      input: { key: '••••••', po: 'PO1' },
      output: { $error: 'mail refused', session_id: '••••••' },
      job: { id: '9', job_id: 'staged-imports' },
      trace: null
    })
    expect(d.operations).toEqual([
      {
        key: 'check',
        name: 'Check',
        type: 'condition',
        next: 'notify',
        on_reject: null,
        halted: false,
        failed: false
      },
      {
        key: 'notify',
        name: 'Notify',
        type: 'mail',
        next: null,
        on_reject: null,
        halted: true,
        failed: true
      }
    ])
  })

  it('404 when the run is gone, 400 for anything but a uuid, epoch-ms peek', async () => {
    expect((await detail('flow', RUN)).statusCode).toBe(404)
    expect((await detail('flow', '123')).statusCode).toBe(400)
    tables.nivaro_flow_runs = [{ ...flowRunRow, name: 'Notify buyers' }]
    const p = await peek('flow', RUN)
    expect(p.json().data).toEqual({
      title: 'Flow run · Notify buyers',
      lines: ['event · error · 1000 ms'],
      at: Date.parse('2026-10-01T10:01:00Z')
    })
  })
})

describe('flowDryRun', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

  it('feeds the stored, unmasked payload to executeFlow in dry-run mode and masks what comes back', async () => {
    tables.nivaro_flow_runs = [flowRunRow]
    tables.nivaro_flows = [{ id: FLOW, name: 'Notify buyers' }]
    vi.mocked(executeFlow).mockImplementation(async (ctx) => {
      ctx.trace?.push({
        key: 'notify',
        name: 'Notify',
        type: 'mail',
        status: 'resolve',
        preview: { to: 'a@x', auth: 'tok' }
      })
      return { ...ctx.payload, token: 't' }
    })
    const out = await flowDryRun(RUN, { userId: USER, log })
    expect(executeFlow).toHaveBeenCalledTimes(1)
    expect(vi.mocked(executeFlow).mock.calls[0][0]).toMatchObject({
      flowId: FLOW,
      flowName: 'Notify buyers',
      trigger: 'test',
      payload: { key: 'sk-live-1', po: 'PO1' },
      dryRun: true,
      userId: USER
    })
    expect(out).toEqual({
      steps: [
        {
          key: 'notify',
          name: 'Notify',
          type: 'mail',
          status: 'resolve',
          preview: { to: 'a@x', auth: '••••••' }
        }
      ],
      output: { key: '••••••', po: 'PO1', token: '••••••' },
      error: null,
      dry_run: true,
      payload_used: 'stored'
    })
  })

  it('reports a thrown flow as the error, and an input that is not an object as an empty payload', async () => {
    tables.nivaro_flow_runs = [{ ...flowRunRow, input: '"just text"' }]
    tables.nivaro_flows = [{ id: FLOW, name: 'Notify buyers' }]
    vi.mocked(executeFlow).mockRejectedValue(new Error('condition blew up'))
    const out = await flowDryRun(RUN, { log })
    expect(vi.mocked(executeFlow).mock.calls[0][0].payload).toEqual({})
    expect(out).toMatchObject({ steps: [], error: 'condition blew up', payload_used: 'empty' })
  })

  it('null when the run or its flow is gone — nothing runs', async () => {
    expect(await flowDryRun(RUN, { log })).toBeNull()
    tables.nivaro_flow_runs = [flowRunRow]
    expect(await flowDryRun(RUN, { log })).toBeNull()
    expect(executeFlow).not.toHaveBeenCalled()
  })
})

// ─── Partner push ───────────────────────────────────────────────────────────

function facts(over: Partial<SubmissionFacts> = {}): SubmissionFacts {
  const created = new Date('2026-10-01T10:00:00Z')
  const row = {
    id: 82,
    collection: 'orders',
    item: '1001',
    external_api: 9,
    status: 'failed',
    attempts: 2,
    payload: JSON.stringify({ endpoint_path: '/api/v1/update', body: { api_key: 'k1', a: 1 } }),
    response: '{"status":"ERROR","token":"t"}',
    last_error: 'HTTP 503',
    external_ref: null,
    created_at: created,
    updated_at: created,
    error_class: 'transient',
    obligation_id: null,
    requested_by: null,
    requested_via: null,
    chain_id: CHAIN,
    chain_parent: 'flow_run:' + RUN
  }
  return {
    raw: row,
    row: { ...row },
    api: { id: 9, name: 'MDSi', owner_user: null },
    record_label: 'REC-1001',
    obligation: null,
    obligation_transition: null,
    flow: null,
    attempts: [],
    activity: [],
    call_logs: [],
    history: null,
    record_edit: null,
    newer_landed: null,
    users: [],
    ...over
  } as SubmissionFacts
}

describe('submission', () => {
  it('masks the stored payload and response, keeps the chain, and shapes the attempts the route answers', async () => {
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(facts())
    attemptsReply = {
      status: 200,
      body: {
        data: {
          attempts: [
            {
              attempt: 2,
              status: 'failed',
              http_status: 503,
              error: 'HTTP 503',
              source: 'current',
              at: '2026-10-01T10:05:00Z',
              payload: { api_key: 'k1' },
              response: null
            }
          ],
          total: 2,
          unrecorded: 1
        }
      }
    }
    const res = await detail('submission', '82')
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({
      id: '82',
      record_label: 'REC-1001',
      endpoint_path: '/api/v1/update',
      payload: { api_key: '••••••', a: 1 },
      response: { status: 'ERROR', token: '••••••' },
      chain_id: CHAIN,
      partner: { id: 9, name: 'MDSi' },
      retry: { eligible: true },
      attempts_reason: null
    })
    expect(d.attempts).toMatchObject({ total: 2, unrecorded: 1 })
    expect(d.attempts.attempts[0]).toMatchObject({
      attempt: 2,
      payload: { api_key: '••••••' },
      masked: true
    })
  })

  it('keeps the panel when the attempts list refuses, saying what it answered', async () => {
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(facts())
    attemptsReply = { status: 403, body: { error: 'Forbidden' } }
    const d = (await detail('submission', '82')).json().data
    expect(d.attempts).toBeNull()
    expect(d.attempts_reason).toBe('The attempts list answered 403')
  })

  it('404 when there are no facts, 400 for a non-numeric id, epoch-ms peek', async () => {
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(null)
    expect((await detail('submission', '82')).statusCode).toBe(404)
    expect((await detail('submission', 'abc')).statusCode).toBe(400)
    expect(gatherSubmissionFacts).toHaveBeenCalledTimes(1)
    tables.nivaro_erp_submissions = [
      {
        id: 82,
        api: 'MDSi',
        status: 'failed',
        collection: 'orders',
        item: '1001',
        last_error: 'HTTP 503',
        created_at: new Date('2026-10-01T10:00:00Z')
      }
    ]
    const p = await peek('submission', '82')
    expect(p.json().data).toEqual({
      title: 'Push #82 → MDSi',
      lines: ['failed · orders 1001', 'HTTP 503'],
      at: Date.parse('2026-10-01T10:00:00Z')
    })
  })
})

// ─── Cross-level reads ──────────────────────────────────────────────────────

describe('runForSource', () => {
  const at = Date.parse('2026-10-01T10:35:00Z')
  const recentRead = (calls: Call[]) => calls.some((c) => c.m === 'whereBetween')

  it('picks the run whose window covers the moment', async () => {
    tables.nivaro_job_runs = (calls) =>
      recentRead(calls)
        ? [
            { id: 11, started_at: new Date(at - 2 * 60_000), finished_at: new Date(at + 60_000) },
            {
              id: 10,
              started_at: new Date(at - 20 * 60_000),
              finished_at: new Date(at - 19 * 60_000)
            }
          ]
        : []
    expect(await runForSource('cron:staged-imports', at)).toEqual({
      kind: 'job',
      id: '11',
      covering: true,
      started_at: new Date(at - 2 * 60_000).toISOString()
    })
  })

  it('finds a long-running job that started well before the recent window', async () => {
    tables.nivaro_job_runs = (calls) =>
      recentRead(calls)
        ? []
        : [{ id: 7, started_at: new Date(at - 45 * 60_000), finished_at: null }]
    expect(await runForSource('cron:staged-imports', at)).toEqual({
      kind: 'job',
      id: '7',
      covering: true,
      started_at: new Date(at - 45 * 60_000).toISOString()
    })
  })

  it('ignores a run without a readable start, resolves flows, and null for nothing', async () => {
    tables.nivaro_job_runs = [{ id: 3, started_at: 'not a date', finished_at: null }]
    expect(await runForSource('cron:staged-imports', at)).toBeNull()
    tables.nivaro_flow_runs = [
      { id: RUN.toUpperCase(), started_at: new Date(at - 1000), completed_at: new Date(at - 500) }
    ]
    expect(await runForSource(`flow:${FLOW}`, at)).toMatchObject({
      kind: 'flow',
      id: RUN,
      covering: true
    })
    expect(await runForSource('import:worker', at)).toBeNull()
  })
})

describe('submissionsFor / apisOfDownNode', () => {
  it('matches by chain first, then by API inside the window, else nothing', async () => {
    tables.nivaro_erp_submissions = (calls) =>
      calls.some((c) => c.m === 'where' && c.args[0] === 's.chain_id')
        ? [{ id: 1, external_api: 2, status: 'accepted' }]
        : [{ id: 2, external_api: 2, status: 'failed' }]
    expect(await submissionsFor({ chainId: CHAIN, apiIds: [2] })).toMatchObject({
      matched_by: 'chain',
      rows: [{ id: 1 }]
    })
    tables.nivaro_erp_submissions = (calls) =>
      calls.some((c) => c.m === 'where' && c.args[0] === 's.chain_id')
        ? []
        : [{ id: 2, external_api: 2 }]
    expect(
      await submissionsFor({ chainId: CHAIN, apiIds: [2], at: 1, windowSec: 60 })
    ).toMatchObject({
      matched_by: 'api-time',
      rows: [{ id: 2 }]
    })
    expect(await submissionsFor({})).toEqual({ rows: [], matched_by: null })
  })

  it('resolves ext:<id> directly and x: nodes through the registered node’s API names', async () => {
    expect(await apisOfDownNode('ext:7')).toEqual({ ids: [7], reason: null })
    expect((await apisOfDownNode('x:efp-ops.mdsi')).reason).toMatch(/not loaded/)
    vi.mocked(trafficNodeTester).mockImplementation(() => ({ apis: null, test: () => true }))
    expect((await apisOfDownNode('x:efp-ops.mdsi')).reason).toMatch(/custom rule/)
    vi.mocked(trafficNodeTester).mockImplementation(() => ({
      apis: ['MDSi', 'mdsi-staging'],
      test: () => true
    }))
    tables.nivaro_external_apis = [
      { id: 4, name: 'mdsi' },
      { id: 5, name: 'MWF' },
      { id: 6, name: 'MDSI-Staging' }
    ]
    expect(await apisOfDownNode('x:efp-ops.mdsi')).toEqual({ ids: [4, 6], reason: null })
    tables.nivaro_external_apis = [{ id: 5, name: 'MWF' }]
    expect((await apisOfDownNode('x:efp-ops.mdsi')).reason).toMatch(/No external API/)
    expect((await apisOfDownNode('db')).reason).toMatch(/Only partner nodes/)
  })
})
