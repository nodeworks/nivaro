import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../routes/custom-queries.js', () => ({ capturedPlanFor: () => null }))
vi.mock('../partner-dependencies.js', () => ({ callerDependencies: vi.fn(async () => null) }))
vi.mock('../../plugins/socketio.js', () => ({ usersOnPath: () => [] }))

import { db } from '../../db/index.js'
import { inspectEntitiesRoutes } from '../../routes/traffic-map-extras/inspect-entities.js'
import { setActiveBreakersForTest } from '../traffic-breaker.js'
import { inspectSource } from '../traffic-inspect.js'
import { callerDetail } from './entities-caller.js'
import './entities.js'

/** A thenable knex builder per table; records where / whereIn calls. */
const calls: Array<{ table: string; m: string; args: unknown[] }> = []
function tables(rows: Record<string, unknown[]>, first: Record<string, unknown> = {}) {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of [
      'where',
      'whereIn',
      'whereNull',
      'orWhereNot',
      'whereNot',
      'leftJoin',
      'orderBy',
      'limit',
      'select'
    ])
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, m, args })
        if (typeof args[0] === 'function') (args[0] as (b: unknown) => void)(chain)
        return chain
      })
    chain.first = vi.fn(() => {
      const p = Promise.resolve(first[table])
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

beforeEach(() => {
  calls.length = 0
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

  it('caller: reads an API key, its requests and refusals, never the key hash', async () => {
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
    const d = (await callerDetail('k12', ctx)) as Record<string, any>
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
    expect(JSON.stringify(d)).not.toContain('SECRET')
    expect(
      calls.some(
        (c) =>
          c.table === 'nivaro_api_logs' &&
          c.m === 'where' &&
          c.args[0] === 'api_key_id' &&
          c.args[1] === 12
      )
    ).toBe(true)
  })

  it('caller: a cron source reads its job runs, not the API log', async () => {
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
    const app = Fastify({ logger: false })
    await app.register(inspectEntitiesRoutes)
    expect((await app.inject({ url: '/inspect/caller-deps?key=nope' })).statusCode).toBe(400)
    const res = await app.inject({ url: '/inspect/caller-deps?key=cron:x' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toBeNull()
    const res2 = await app.inject({ url: '/inspect/caller-deps?key=k3' })
    expect(res2.json().data).toEqual({ found: false })
  })
})
