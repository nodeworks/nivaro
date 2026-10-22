// #2841 simulate down: the dependency derivation (fixture traffic → affected set) and the reads.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const fx = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  totals: {} as Record<string, number>,
  cronRows: [] as Row[],
  snapshot: { entities: [] as Row[] },
  reads: [] as string[]
}))

vi.mock('../../db/index.js', () => {
  function builder(table: string) {
    let first = false
    let cron = false
    const b: Record<string, unknown> = {}
    for (const m of [
      'where',
      'whereNotNull',
      'groupBy',
      'select',
      'count',
      'sum',
      'orderByRaw',
      'limit'
    ])
      b[m] = () => b
    b.whereRaw = (sql: string) => {
      if (sql.includes('cron:')) cron = true
      return b
    }
    b.first = () => {
      first = true
      return b
    }
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
      fx.reads.push(table)
      if (!(table in fx.tables) && !(table in fx.totals))
        return Promise.reject(new Error(`no table ${table}`)).then(ok, bad)
      const v = first
        ? table === 'nivaro_external_apis'
          ? fx.tables[table][0]
          : { n: fx.totals[table] ?? 0 }
        : cron
          ? fx.cronRows
          : fx.tables[table]
      return Promise.resolve(v).then(ok, bad)
    }
    return b
  }
  const db = Object.assign((t: string) => builder(t), { raw: (s: string) => s })
  return { db }
})
vi.mock('../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../traffic-map.js', () => ({ buildSnapshot: () => fx.snapshot }))

import {
  type BlastFacts,
  deriveSimulateDown,
  downEdgesFromMinuteKeys,
  parseDependencyNode,
  parseSimWindow,
  parseUntil,
  routeFactsFrom,
  simulateDown
} from './simulate-down.js'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

function facts(over: Partial<BlastFacts> = {}): BlastFacts {
  return {
    from: new Date(NOW - 86_400_000).toISOString(),
    to: new Date(NOW).toISOString(),
    window_h: 24,
    total_calls: 10_000,
    routes: routeFactsFrom([
      { method: 'GET', path: '/api/items/orders/12', n: 3000, err: 3, sess: 3000 },
      { method: 'GET', path: '/api/items/orders/13', n: 1000, err: 0, sess: 500 },
      { method: 'PATCH', path: '/api/items/orders/12', n: 400, err: 0, sess: 0 },
      {
        method: 'GET',
        path: '/api/files/aaaaaaaa-0000-4000-8000-000000000001',
        n: 200,
        err: 0,
        sess: 200
      },
      { method: 'GET', path: '/api/auth/login', n: 40, err: 0, sess: 0 },
      { method: 'POST', path: '/api/ai/chat', n: 60, err: 1, sess: 60 },
      { method: 'POST', path: '/api/items/invoices', n: 90, err: 0, sess: 0 }
    ]),
    jobRoutes: [
      {
        job: 'nightly-sync',
        route: 'POST /api/items/invoices',
        entity: 'items/invoices',
        calls: 90
      },
      { job: 'digest', route: 'GET /api/items/orders/:id', entity: 'items/orders', calls: 5 }
    ],
    jobs: [
      { id: 'nightly-sync', runs: 1, failed: 0 },
      { id: 'digest', runs: 24, failed: 2 },
      { id: 'prune', runs: 1, failed: 0 }
    ],
    downEdges: [
      { entity: 'items/invoices', down: 'ext:4', calls: 88 },
      { entity: 'items/invoices', down: 'mail', calls: 10 },
      { entity: 'items/orders', down: 'mail', calls: 3 },
      { entity: 'other/ai', down: 'ai:gateway-openai', calls: 60 },
      { entity: 'items/orders', down: 'redis', calls: 900 }
    ],
    ai: [{ path: '/api/ai/chat', provider: 'gateway-openai', calls: 60 }],
    outbound: [
      { apiId: 4, by: 'cron:nightly-sync', calls: 80 },
      { apiId: 4, by: 'flow:7', calls: 8 }
    ],
    screens: [
      { screen: 'admin /collections/:c', entity: 'items/orders', calls: 50 },
      { screen: 'efp-new /invoices', entity: 'items/invoices', calls: 9 }
    ],
    callers: [
      { caller: 'k3', entity: 'items/invoices', calls: 30 },
      { caller: 'uAAAA', entity: 'items/orders', calls: 70 }
    ],
    sources: ['request log'],
    notes: [],
    truncated: false,
    ...over
  }
}

describe('parsing', () => {
  it('takes dependencies only', () => {
    expect(parseDependencyNode('db')).toEqual({ id: 'db', kind: 'db' })
    expect(parseDependencyNode('redis')?.kind).toBe('cache')
    expect(parseDependencyNode('signin')?.kind).toBe('signin')
    expect(parseDependencyNode('ai:gateway-openai')?.kind).toBe('ai')
    expect(parseDependencyNode('ext:4')).toEqual({ id: 'ext:4', kind: 'partner', apiId: 4 })
    expect(parseDependencyNode('webhook:hook-1')?.kind).toBe('channel')
    expect(parseDependencyNode('items/orders')).toBeNull()
    expect(parseDependencyNode('ai:../x')).toBeNull()
    expect(parseDependencyNode('k7')).toBeNull()
  })
  it('windows default to 24 h; bad ones are refused', () => {
    expect(parseSimWindow(undefined)).toBe('24h')
    expect(parseSimWindow('7d')).toBe('7d')
    expect(parseSimWindow('30d')).toBeNull()
  })
  it('until is clamped to the request log and never the future', () => {
    expect(parseUntil(undefined, NOW)).toBeNull()
    expect(parseUntil(new Date(NOW + 5000).toISOString(), NOW)).toBeNull()
    expect(parseUntil(new Date(NOW - 3600_000).toISOString(), NOW)).toBe(NOW - 3600_000)
    expect(parseUntil(String((NOW - 30 * 86_400_000) / 1000), NOW)).toBe(NOW - 14 * 86_400_000)
    expect(parseUntil('nonsense', NOW)).toBeNull()
  })
  it('folds request paths into route templates', () => {
    const r = routeFactsFrom([
      { method: 'GET', path: '/api/items/orders/1', n: 2, err: 1, sess: 2 },
      { method: 'GET', path: '/api/items/orders/2', n: 3, err: 0, sess: 1 }
    ])
    expect(r).toEqual([
      {
        route: 'GET /api/items/orders/:id',
        entity: 'items/orders',
        down: ['db'],
        calls: 5,
        errors: 1,
        session: 3
      }
    ])
  })
  it('reads minute-history entity → downstream keys', () => {
    expect(
      downEdgesFromMinuteKeys([
        { key: 'e:items/orders>d:ext:4', n: '7' },
        { key: 'c:k1>e:items/orders', n: 3 }
      ])
    ).toEqual([{ entity: 'items/orders', down: 'ext:4', calls: 7 }])
  })
})

describe('deriveSimulateDown', () => {
  it('database down: every database route, every job, people and keys reaching them', () => {
    const b = deriveSimulateDown(parseDependencyNode('db')!, facts(), 'SQL Server', '24h')
    expect(b.routes.map((r) => r.route)).toEqual([
      'GET /api/items/orders/:id',
      'PATCH /api/items/orders/:id',
      'POST /api/items/invoices',
      'POST /api/ai/chat',
      'GET /api/auth/login'
    ])
    expect(b.routes.every((r) => r.strength === 'direct')).toBe(true)
    expect(b.routes[0].per_min).toBeCloseTo(4000 / 1440, 2)
    // file downloads touch the file store only
    expect(b.routes.some((r) => r.route.includes('/files/'))).toBe(false)
    expect(b.jobs.map((j) => [j.id, j.strength])).toEqual(
      expect.arrayContaining([
        ['nightly-sync', 'direct'],
        ['digest', 'direct'],
        ['prune', 'direct']
      ])
    )
    expect(b.callers.find((c) => c.key === 'k3')?.strength).toBe('indirect')
    expect(b.callers.find((c) => c.key === 'cron:digest')?.strength).toBe('direct')
    expect(b.screens.map((s) => s.screen)).toEqual(['admin /collections/:c', 'efp-new /invoices'])
    expect(b.claims.fails.length).toBeGreaterThan(0)
    expect(b.totals.share_of_calls).toBeCloseTo(4590 / 10_000, 3)
  })

  it('Redis down: only session-signed calls fail; cache hits are not shaded; jobs stop', () => {
    const b = deriveSimulateDown(parseDependencyNode('redis')!, facts(), 'Redis', '24h')
    const orders = b.routes.find((r) => r.route === 'GET /api/items/orders/:id')
    expect(orders).toMatchObject({ calls: 3500, strength: 'direct', share: 0.875 })
    // a write made only with keys/tokens keeps working
    expect(b.routes.some((r) => r.route.startsWith('PATCH'))).toBe(false)
    expect(
      b.jobs.every((j) => j.why === 'stops firing on the clock' || j.strength === 'indirect')
    ).toBe(true)
    expect(b.claims.degrades.map((c) => c.source)).toContain('api/src/plugins/rate-limit.ts')
    expect(b.claims.keeps.length).toBeGreaterThan(0)
  })

  it('a partner down: routes feeding it direct, the job pushing to it direct, the rest indirect', () => {
    const b = deriveSimulateDown(parseDependencyNode('ext:4')!, facts(), 'Fusion', '24h')
    expect(b.routes.map((r) => r.route)).toEqual(['POST /api/items/invoices'])
    expect(b.jobs.find((j) => j.id === 'nightly-sync')).toMatchObject({
      strength: 'direct',
      calls: 170
    })
    expect(b.jobs.some((j) => j.id === 'prune')).toBe(false)
    expect(b.callers.find((c) => c.key === 'flow:7')?.strength).toBe('direct')
    expect(b.screens.map((s) => s.screen)).toEqual(['efp-new /invoices'])
    // email fed by invoices AND orders: not only through the affected route, so not listed
    expect(b.downstream).toEqual([])
  })

  it('AI down: the routes asking it; mail fed only by affected routes becomes indirect', () => {
    const ai = deriveSimulateDown(parseDependencyNode('ai')!, facts(), 'AI', '24h')
    expect(ai.routes.map((r) => r.route)).toEqual(['POST /api/ai/chat'])
    const inv = deriveSimulateDown(
      parseDependencyNode('ext:4')!,
      facts({ downEdges: facts().downEdges.filter((e) => e.entity !== 'items/orders') }),
      'Fusion',
      '24h'
    )
    expect(inv.downstream).toEqual([{ id: 'mail', strength: 'indirect', calls: 10 }])
    expect(inv.totals.channels).toBeGreaterThanOrEqual(1)
  })

  it('sign-in provider down: the sign-in routes only', () => {
    const b = deriveSimulateDown(parseDependencyNode('signin')!, facts(), 'Sign-in', '24h')
    expect(b.routes.map((r) => r.route)).toEqual(['GET /api/auth/login'])
    expect(b.jobs).toEqual([])
  })

  it('no traffic: empty lists, null share, and a note about screens', () => {
    const b = deriveSimulateDown(
      parseDependencyNode('store')!,
      facts({ routes: [], total_calls: 0, screens: [], downEdges: [], jobRoutes: [] }),
      'File storage',
      '1h'
    )
    expect(b.routes).toEqual([])
    expect(b.totals.share_of_calls).toBeNull()
    expect(b.notes.join(' ')).toMatch(/live map/)
  })
})

describe('simulateDown (reads)', () => {
  beforeEach(() => {
    fx.reads = []
    fx.tables = {
      nivaro_api_logs: [
        {
          method: 'GET',
          path: '/api/items/orders/1',
          graphql_operation: null,
          n: 10,
          err: 0,
          sess: 10
        }
      ],
      nivaro_job_runs: [{ job_id: 'digest', status: 'error', n: 2 }],
      nivaro_traffic_minutes: [{ key: 'e:items/orders>d:ext:4', n: 5 }],
      nivaro_ai_calls: [],
      nivaro_outbound_log: [{ api_id: 4, triggered_by: 'cron:digest', n: 3 }],
      nivaro_external_apis: [{ name: 'Fusion' }]
    }
    fx.totals = { nivaro_api_logs: 25 }
    fx.cronRows = [
      { chain_parent: 'cron:digest', method: 'GET', path: '/api/items/orders/1', n: 4 }
    ]
    fx.snapshot = {
      entities: [
        {
          key: 'items/orders',
          down: { db: 10 },
          callers: [{ key: 'uAAAA', n: 6 }],
          ext: { screens: [{ screen: 'admin /x', n: 6 }] }
        }
      ]
    }
  })

  it('gathers every source once and answers a partner', async () => {
    const b = await simulateDown(parseDependencyNode('ext:4')!, '24h', { fresh: true })
    expect(b?.label).toBe('Fusion')
    expect(b?.routes.map((r) => r.route)).toEqual(['GET /api/items/orders/:id'])
    expect(b?.jobs[0]).toMatchObject({ id: 'digest', strength: 'direct', runs: 2, failed: 2 })
    expect(b?.screens).toEqual([{ screen: 'admin /x', calls: 6, entities: ['items/orders'] }])
    expect(b?.sources).toEqual(
      expect.arrayContaining(['request log', 'job runs', 'minute history', 'partner call log'])
    )
    expect(b?.totals.share_of_calls).toBe(0.4)
  })

  it('a missing table becomes a note, not a failure; facts are reused across nodes', async () => {
    delete (fx.tables as Record<string, unknown>).nivaro_ai_calls
    const a = await simulateDown(parseDependencyNode('db')!, '6h', { fresh: true })
    expect(a?.notes).toContain('The AI call log could not be read.')
    const n = fx.reads.length
    const r = await simulateDown(parseDependencyNode('redis')!, '6h')
    expect(fx.reads.length).toBe(n)
    expect(r?.routes[0].strength).toBe('direct')
  })

  it('an unknown partner answers null', async () => {
    fx.tables.nivaro_external_apis = []
    expect(await simulateDown(parseDependencyNode('ext:99')!, '24h', { fresh: true })).toBeNull()
  })

  it('a window in the past skips the live map', async () => {
    const b = await simulateDown(parseDependencyNode('db')!, '1h', {
      until: Date.now() - 3 * 3600_000,
      fresh: true
    })
    expect(b?.screens).toEqual([])
    expect(b?.sources).not.toContain('live map (this server)')
  })
})
