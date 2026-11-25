import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub capacity (ideas 9, 13, 15, 16): samples, the overview's "uses most" flag, the move
// advisor's rules, the rebalance planner and its one-move-at-a-time runner, and the limits listed
// with each app. Real SQLite with the hub tables (542–553 + 567); nothing outside is called.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { db } = await import('../../../db/index.js')
const store = await import('../../../services/hub/capacity/store.js')
const sample = await import('../../../services/hub/capacity/sample.js')
const client = await import('../../../services/hub/capacity/client.js')
const overview = await import('../../../services/hub/capacity/overview.js')
const advisor = await import('../../../services/hub/capacity/advisor.js')
const rebalance = await import('../../../services/hub/capacity/rebalance.js')

import type { CapacityUsage } from '../../../services/capacity/app-usage.js'
import type { CapacitySample } from '../../../services/hub/capacity/store.js'

const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/567_hub_capacity.js')
]

beforeAll(async () => {
  for (const m of migrations) await m.up(db)
  // A second run changes nothing (guarded, additive).
  await migrations[3].up(db)
  // The real table (migration 254: no updated_by column).
  await (await import('../../../db/migrations/254_extension_settings.js')).up(db)
})
afterAll(async () => db.destroy())

const T = (min: number) => new Date(Date.UTC(2026, 10, 20, 0, 0, 0) + min * 60_000)

const row = (over: Partial<CapacitySample>): CapacitySample => ({
  sampled_at: T(0),
  scope: 'environment',
  shared_deployment_id: null,
  environment_id: null,
  tenant_id: null,
  cpu_pct: null,
  memory_mb: null,
  requests_per_min: null,
  busy_ms_per_min: null,
  errors_per_min: null,
  db_in_use: null,
  db_waiting: null,
  db_pool_max: null,
  jobs_running: null,
  jobs_waiting: null,
  storage_bytes: null,
  processes: null,
  error: null,
  ...over
})

const usage = (apps: Partial<CapacityUsage['apps'][number]>[], over: Partial<CapacityUsage> = {}) =>
  ({
    version: '0.3.215',
    at: new Date().toISOString(),
    partial: false,
    processes: [{ instance: 'p1', role: null, cpu_pct: 80, memory_mb: 900, uptime_s: 5 }],
    totals: {
      cpu_pct: 80,
      memory_mb: 900,
      requests_per_min: apps.reduce((a, x) => a + (x.requests_per_min ?? 0), 0),
      busy_ms_per_min: apps.reduce((a, x) => a + (x.busy_ms_per_min ?? 0), 0)
    },
    apps: apps.map((a) => ({
      id: 'x',
      requests_per_min: 0,
      requests_last_min: 0,
      busy_ms_per_min: 0,
      errors_per_min: 0,
      db: { in_use: 0, waiting: 0, pool_max: 5, processes: 1 },
      jobs: { running: 0, waiting: 0 },
      storage_bytes: 0,
      storage_checked_at: null,
      limits: null,
      ...a
    })),
    ...over
  }) as CapacityUsage

describe('store', () => {
  beforeEach(async () => {
    await db(store.SAMPLES).del()
    await db(store.LIMITS).del()
  })

  it('stores and reads samples back (bigint storage as a number), prunes past 31 days', async () => {
    const now = new Date()
    await store.insertSamples([
      row({ sampled_at: now, environment_id: 5, storage_bytes: 5_000_000_000 }),
      row({ sampled_at: new Date(now.getTime() - 40 * 86_400_000), environment_id: 5 })
    ])
    expect(await store.pruneSamples(now)).toBe(1)
    const [s] = await store.samplesSince(new Date(now.getTime() - 60_000), { envIds: [5] })
    expect(s.storage_bytes).toBe(5_000_000_000)
    expect(s.sampled_at).toBeInstanceOf(Date)
  })

  it('prunes more rows than one statement may name (2,100 parameters) in batches', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000)
    await store.insertSamples(
      Array.from({ length: 2500 }, (_, i) => row({ sampled_at: old, environment_id: i }))
    )
    expect(await store.pruneSamples()).toBe(2500)
  })

  it('limits: set, change, clear (an empty set removes the row)', async () => {
    expect(await store.setLimits(9, { jobs: 2 }, 'x')).toBe(true)
    expect(await store.setLimits(9, { jobs: 2 }, 'x')).toBe(false)
    expect(await store.setLimits(9, { jobs: 3, storage_mb: 100 }, 'x')).toBe(true)
    expect(await store.getLimits(9)).toEqual({ jobs: 3, storage_mb: 100 })
    expect(await store.setLimits(9, {}, 'x')).toBe(true)
    expect(await db(store.LIMITS).count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('settings: stored values within bounds, the rest default', async () => {
    await store.writeSettings(store.normalizeSettings({ most_share: 0.7, fits: { max_rpm: -5 } }))
    const s = await store.readSettings()
    expect(s.most_share).toBe(0.7)
    expect(s.fits.max_rpm).toBe(store.DEFAULT_SETTINGS.fits.max_rpm)
  })
})

describe('client', () => {
  it('checks the answer shape', () => {
    expect(client.parseUsage({ apps: 'x' })).toBeNull()
    const u = client.parseUsage(usage([{ id: 'a', requests_per_min: 3 }]))
    expect(u?.apps[0].requests_per_min).toBe(3)
    expect(client.parseUsage({ ...usage([]), apps: [{ id: 5 }] })).toBeNull()
  })

  it('reads a shared deployment with its derived bearer, retries 401 with the previous token', async () => {
    const seen: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>).Authorization)
      seen.push(auth)
      return seen.length === 1
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify(usage([{ id: 'a' }])), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const r = await client.readSharedUsage(
      { id: 1, link_url: 'https://pool.example.com' },
      { fetch, tokens: async () => ({ current: 'c'.repeat(43), previous: 'p'.repeat(43) }) }
    )
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(2)
    // Never the token itself.
    expect(seen.join()).not.toContain('c'.repeat(43))
  })

  it('a missing route is NO_USAGE_ROUTE (an older app), a refusal LINK_REFUSED', async () => {
    const f = (status: number) =>
      (async () => new Response('{}', { status })) as unknown as typeof globalThis.fetch
    const tokens = async () => ({ current: 'c'.repeat(43), previous: null })
    const link = { id: 1, link_url: 'https://pool.example.com' }
    expect(await client.readSharedUsage(link, { fetch: f(404), tokens })).toEqual({
      ok: false,
      code: 'NO_USAGE_ROUTE'
    })
    expect(await client.readSharedUsage(link, { fetch: f(401), tokens })).toEqual({
      ok: false,
      code: 'LINK_REFUSED'
    })
  })
})

describe('sample', () => {
  it('splits deployment CPU by answering time; a failed read leaves a gap row with its code', () => {
    const rows = sample.sharedRows(
      T(0),
      { id: 2, pool_budget: 40 },
      [
        { env_id: 10, tenant_id: 'a-e10' },
        { env_id: 11, tenant_id: 'b-e11' },
        { env_id: 12, tenant_id: 'c-e12' }
      ],
      {
        ok: true,
        usage: usage([
          { id: 'a-e10', busy_ms_per_min: 300, requests_per_min: 30 },
          { id: 'b-e11', busy_ms_per_min: 100, requests_per_min: 10 }
        ])
      }
    )
    expect(rows[0]).toMatchObject({ scope: 'shared', cpu_pct: 80, db_pool_max: 40, processes: 1 })
    expect(rows[1]).toMatchObject({ environment_id: 10, cpu_pct: 60, requests_per_min: 30 })
    expect(rows[2]).toMatchObject({ environment_id: 11, cpu_pct: 20 })
    expect(rows[3]).toMatchObject({ environment_id: 12, error: 'NOT_LISTED' })
    const failed = sample.sharedRows(
      T(0),
      { id: 2, pool_budget: 40 },
      [{ env_id: 10, tenant_id: 'a' }],
      {
        ok: false,
        code: 'LINK_REFUSED'
      }
    )
    expect(failed.map((r) => r.error)).toEqual(['LINK_REFUSED', 'LINK_REFUSED'])
    expect(failed[1].requests_per_min).toBeNull()
  })

  it('runs over every side and stores the rows', async () => {
    const stored: CapacitySample[] = []
    const out = await sample.runCapacitySample({
      now: () => T(0),
      listShared: async () =>
        [
          { id: 2, key: 'pool', status: 'active', pool_budget: 40 },
          { id: 3, key: 'old', status: 'retired', pool_budget: 40 }
        ] as never,
      tenantsOf: async () =>
        [{ placedHere: true, env: { id: 10, key: 'prod' }, app: { key: 'a' } }] as never,
      readShared: async () => ({ ok: true, usage: usage([{ id: 'a-e10', requests_per_min: 5 }]) }),
      dedicated: async () => [
        { id: 20, base_url: 'https://d', hub_token: null, tenant_id: 'd-e20' }
      ],
      readLinked: async () => ({ ok: false, code: 'NO_TOKEN' }),
      insert: async (r) => {
        stored.push(...r)
      },
      prune: async () => 0
    })
    expect(out).toEqual({ shared: 1, environments: 2, failed: 1, pruned: 0 })
    expect(stored.map((r) => [r.scope, r.environment_id, r.error])).toEqual([
      ['shared', null, null],
      ['environment', 10, null],
      ['environment', 20, 'NO_TOKEN']
    ])
  })
})

describe('overview', () => {
  it('flags the app that uses most of its deployment, only with two apps or more', () => {
    const at = T(0)
    const samples = [
      row({
        scope: 'shared',
        shared_deployment_id: 1,
        sampled_at: at,
        requests_per_min: 100,
        busy_ms_per_min: 1000,
        db_in_use: 4
      }),
      row({
        shared_deployment_id: 1,
        environment_id: 10,
        sampled_at: at,
        requests_per_min: 80,
        busy_ms_per_min: 700,
        db_in_use: 2
      }),
      row({
        shared_deployment_id: 1,
        environment_id: 11,
        sampled_at: at,
        requests_per_min: 20,
        busy_ms_per_min: 300,
        db_in_use: 1
      }),
      row({ environment_id: 30, sampled_at: at, requests_per_min: 5, memory_mb: 400 })
    ]
    const o = overview.buildOverview({
      now: at,
      settings: store.DEFAULT_SETTINGS,
      shared: [{ id: 1, key: 'pool', name: 'Pool', status: 'active', pool_budget: 40 }],
      samples,
      labels: new Map(),
      limits: new Map([[10, { jobs: 2 }]])
    })
    const apps = o.shared[0].apps
    expect(apps.map((a) => [a.env_id, a.uses_most])).toEqual([
      [10, true],
      [11, false]
    ])
    expect(apps[0].share).toEqual({ requests: 0.8, busy: 0.7, db: 0.5 })
    expect(apps[0].limits).toEqual({ jobs: 2 })
    expect(o.dedicated.map((d) => d.env_id)).toEqual([30])
    expect(o.shared[0].trend).toHaveLength(1)
  })

  it('a trend leaves error rows out as gaps', () => {
    const t = overview.trendOf(
      [
        row({ sampled_at: T(0), requests_per_min: 10 }),
        row({ sampled_at: T(15), error: 'TIMEOUT' })
      ],
      overview.HOUR_MS
    )
    expect(t).toEqual([expect.objectContaining({ requests_per_min: 10, samples: 1 })])
  })
})

describe('advisor rules', () => {
  const s = { ...store.DEFAULT_SETTINGS, min_samples: 4 }
  const quiet = [0, 15, 30, 45, 60].map((m) =>
    row({
      sampled_at: T(m),
      requests_per_min: 5,
      memory_mb: 300,
      db_in_use: 1,
      storage_bytes: 10 ** 8
    })
  )

  it('percentile is nearest-rank', () => {
    expect(advisor.percentile([1, 2, 3, 4, 100], 0.95)).toBe(100)
    expect(advisor.percentile([1, 2, 3, 4, 100], 0.5)).toBe(3)
    expect(advisor.percentile([null], 0.5)).toBeNull()
  })

  it('fits shared: quiet, small, no blockers — with reasons', () => {
    expect(advisor.fitsShared(quiet, s, [])?.map((r) => r.code)).toEqual([
      'QUIET',
      'SMALL',
      'STORAGE',
      'NO_BLOCKERS'
    ])
    expect(advisor.fitsShared(quiet, s, ['EXEC_SCRIPT_FLOWS'])).toBeNull()
    expect(advisor.fitsShared(quiet, s, null)).toBeNull() // blockers unknown: no advice
    expect(advisor.fitsShared(quiet.slice(0, 2), s, [])).toBeNull() // too few samples
    const busy = quiet.map((r) => ({ ...r, requests_per_min: 500 }))
    expect(advisor.fitsShared(busy, s, [])).toBeNull()
  })

  it('outgrew shared: a sustained share over the threshold on a deployment of two apps or more', () => {
    const totals = quiet.map((r) =>
      row({
        scope: 'shared',
        shared_deployment_id: 1,
        sampled_at: r.sampled_at,
        requests_per_min: 10,
        busy_ms_per_min: 100,
        db_in_use: 4
      })
    )
    const mine = quiet.map((r) =>
      row({
        shared_deployment_id: 1,
        environment_id: 10,
        sampled_at: r.sampled_at,
        requests_per_min: 9,
        busy_ms_per_min: 90,
        db_in_use: 3
      })
    )
    const two = new Map(totals.map((t) => [t.sampled_at.getTime(), 2]))
    expect(advisor.outgrewShared(mine, totals, two, s)?.[0].code).toBe('SUSTAINED_SHARE')
    const alone = new Map(totals.map((t) => [t.sampled_at.getTime(), 1]))
    expect(advisor.outgrewShared(mine, totals, alone, s)).toBeNull()
  })

  it('picks the active deployment with the most room and links a pre-filled plan', () => {
    const t = advisor.pickTarget(
      [
        { id: 1, key: 'a', status: 'active', pool_budget: 40 },
        { id: 2, key: 'b', status: 'active', pool_budget: 40 },
        { id: 3, key: 'c', status: 'retired', pool_budget: 99 }
      ],
      new Map([
        [1, row({ db_in_use: 30 })],
        [2, row({ db_in_use: 4 })]
      ])
    )
    expect(t).toEqual({ id: 2, key: 'b' })
    expect(advisor.planPath(4, 21, 'shared:2')).toBe('/hub?app=4&move=21&to=shared%3A2')
  })
})

describe('rebalance planner', () => {
  const dep = (id: number, loads: number[], budget = 40, movable = true) => ({
    id,
    key: `d${id}`,
    pool_budget: budget,
    apps: loads.map((load, i) => ({
      env_id: id * 100 + i,
      label: `e${id}${i}`,
      load,
      pool: 5,
      movable
    }))
  })

  it('moves the app nearest half the gap from the busiest to the quietest', () => {
    const { moves, before, after } = rebalance.balanceMoves([
      dep(1, [500, 300, 100, 50]),
      dep(2, [50])
    ])
    expect(before).toEqual({ 1: 950, 2: 50 })
    // Gap 900: the 500 app is nearest half of it (450).
    expect(moves[0]).toMatchObject({ env_id: 100, from_shared_id: 1, to_shared_id: 2 })
    expect(Math.abs(after[1] - after[2])).toBeLessThan(950 - 50)
  })

  it('never past the target budget, never an app that cannot move, stops when even', () => {
    expect(rebalance.balanceMoves([dep(1, [500, 300]), dep(2, [10], 5)]).moves).toEqual([])
    expect(rebalance.balanceMoves([dep(1, [500, 300], 40, false), dep(2, [10])]).moves).toEqual([])
    expect(rebalance.balanceMoves([dep(1, [100]), dep(2, [100])]).moves).toEqual([])
  })

  it('load = mean answering time, else mean requests', () => {
    expect(rebalance.loadOf([row({ busy_ms_per_min: 100 }), row({ busy_ms_per_min: 300 })])).toBe(
      200
    )
    expect(rebalance.loadOf([row({ requests_per_min: 4 })])).toBe(4)
  })

  it('window: plain, past midnight, whole day', () => {
    const at = new Date(Date.UTC(2026, 0, 1, 23, 30))
    expect(rebalance.inWindow(at, '22:00', '23:59', 'UTC')).toBe(true)
    expect(rebalance.inWindow(at, '01:00', '05:00', 'UTC')).toBe(false)
    expect(rebalance.inWindow(at, '23:00', '02:00', 'UTC')).toBe(true)
    expect(rebalance.inWindow(new Date(Date.UTC(2026, 0, 1, 1)), '23:00', '02:00', 'UTC')).toBe(
      true
    )
    expect(rebalance.inWindow(at, '00:00', '00:00', 'UTC')).toBe(true)
    // 23:30 UTC is 18:30 in New York (January).
    expect(rebalance.inWindow(at, '18:00', '19:00', 'America/New_York')).toBe(true)
  })
})

describe('rebalance runs', () => {
  const by = 'aaaaaaaa-0000-4000-8000-000000000001'
  beforeEach(async () => {
    for (const t of [
      store.REBALANCES,
      'nivaro_hub_apps',
      'nivaro_hub_environments',
      'nivaro_hub_placements',
      'nivaro_hub_shared_deployments',
      'nivaro_hub_moves'
    ])
      await db(t).del()
    await db('nivaro_hub_apps').insert({ id: 1, key: 'acme', name: 'Acme', extensions: '[]' })
    for (const [id, key] of [
      [1, 'pool-a'],
      [2, 'pool-b']
    ] as const)
      await db('nivaro_hub_shared_deployments').insert({
        id,
        key,
        name: key,
        mode: 'registered',
        link_url: `https://${key}.example.com`,
        status: 'active'
      })
    await db('nivaro_hub_placements').insert([
      { id: 31, kind: 'shared', shared_deployment_id: 1, target: '{}' },
      { id: 32, kind: 'shared', shared_deployment_id: 1, target: '{}' }
    ])
    await db('nivaro_hub_environments').insert([
      {
        id: 21,
        app_id: 1,
        key: 'dev',
        position: 0,
        status: 'active',
        base_url: 'https://d.x',
        hostnames: '[]',
        placement_id: 31
      },
      {
        id: 22,
        app_id: 1,
        key: 'qa',
        position: 1,
        status: 'active',
        base_url: 'https://q.x',
        hostnames: '[]',
        placement_id: 32
      }
    ])
  })

  const planOf = (hash: string, over: Record<string, unknown> = {}) =>
    ({
      kind: 'between_shared',
      routing: 'automatic',
      steps: [],
      route: [],
      manual_request: null,
      version: '0.3.215',
      hostnames: [],
      files: { count: 0, bytes: 0, first_pull: 'full' },
      blockers: [],
      warnings: [],
      checklist: [],
      plan_hash: hash,
      ...over
    }) as never
  const okDeps = {
    openMove: async () => false,
    planFor: async (env: number) => planOf((env === 21 ? 'a' : 'b').repeat(64))
  }

  const startBody = (over: Record<string, unknown> = {}) => ({
    shared_ids: [1, 2],
    moves: [
      {
        env_id: 21,
        to_shared_id: 2,
        plan_hash: 'a'.repeat(64),
        checklist: { callbacks_registered: true }
      },
      { env_id: 22, to_shared_id: 2, plan_hash: 'b'.repeat(64), checklist: {} }
    ],
    window: { start: '00:00', end: '00:00', tz: 'UTC' },
    confirm: 'rebalance',
    ...over
  })

  it('refuses a bad start (confirm, window, a move not on the deployments, a second run)', async () => {
    await expect(
      rebalance.createRebalance(startBody({ confirm: 'x' }), by, okDeps)
    ).rejects.toMatchObject({ code: 'CONFIRM_MISMATCH' })
    await expect(
      rebalance.createRebalance(
        startBody({ window: { start: '9', end: '10:00', tz: 'UTC' } }),
        by,
        okDeps
      )
    ).rejects.toMatchObject({ code: 'BAD_WINDOW' })
    await expect(
      rebalance.createRebalance(
        startBody({ moves: [{ env_id: 21, to_shared_id: 1, plan_hash: 'a'.repeat(64) }] }),
        by,
        okDeps
      )
    ).rejects.toMatchObject({ code: 'BAD_MOVES' })
    await expect(
      rebalance.createRebalance(startBody(), by, { ...okDeps, openMove: async () => true })
    ).rejects.toMatchObject({ code: 'MOVE_OPEN' })
    const id = await rebalance.createRebalance(startBody(), by, okDeps)
    expect(id).toBeGreaterThan(0)
    await expect(rebalance.createRebalance(startBody(), by, okDeps)).rejects.toMatchObject({
      code: 'REBALANCE_OPEN'
    })
  })

  it('runs one move at a time, moves on after success, stops at the first failure', async () => {
    const id = await rebalance.createRebalance(startBody(), by, okDeps)
    const started: unknown[] = []
    let status = 'running'
    const deps = {
      now: () => new Date(),
      confirmText: async (env: number) => `acme/${env === 21 ? 'dev' : 'qa'}`,
      start: async (env: number, body: unknown) => {
        started.push({ env, body })
        return { move_id: 100 + started.length }
      },
      moveStatus: async () => status
    }
    const step = async () => rebalance.tickRebalance((await rebalance.readRebalance(id))!, deps)
    expect(await step()).toBe('started')
    expect(started[0]).toMatchObject({
      env: 21,
      body: {
        to: { kind: 'shared', shared_id: 2, pool_max: 5 },
        plan_hash: 'a'.repeat(64),
        confirm: 'acme/dev',
        checklist: { callbacks_registered: true }
      }
    })
    expect(await step()).toBe('waiting-move')
    status = 'success'
    expect(await step()).toBe('moved')
    expect(await step()).toBe('started')
    expect(started).toHaveLength(2)
    status = 'rolled_back'
    expect(await step()).toBe('failed')
    const r = await rebalance.readRebalance(id)
    expect(r?.status).toBe('failed')
    expect(r?.error).toContain('was rolled back')
    expect(r?.moves.map((m) => m.result)).toEqual(['success', 'failed'])
  })

  it('outside its window it starts nothing; a refused start (PLAN_CHANGED) stops the run', async () => {
    const id = await rebalance.createRebalance(
      startBody({ window: { start: '01:00', end: '02:00', tz: 'UTC' } }),
      by,
      okDeps
    )
    const { MoveError } = await import('../../../services/hub/move/run.js')
    const deps = {
      now: () => new Date(Date.UTC(2026, 0, 1, 12)),
      confirmText: async () => 'acme/dev',
      start: async () => {
        throw new MoveError('PLAN_CHANGED', 'The plan changed since you checked it.')
      }
    }
    const tick = async () => rebalance.tickRebalance((await rebalance.readRebalance(id))!, deps)
    expect(await tick()).toBe('outside-window')
    deps.now = () => new Date(Date.UTC(2026, 0, 1, 1, 30))
    expect(await tick()).toBe('failed')
    expect((await rebalance.readRebalance(id))?.error).toContain('PLAN_CHANGED')
  })

  it('cancel: at once with no move under way, after it otherwise', async () => {
    const id = await rebalance.createRebalance(startBody(), by, okDeps)
    expect((await rebalance.cancelRebalance(id)).status).toBe('cancelled')
    await expect(rebalance.cancelRebalance(id)).rejects.toMatchObject({ code: 'ENDED' })
    const id2 = await rebalance.createRebalance(startBody(), by, okDeps)
    const deps = {
      confirmText: async () => 'acme/dev',
      start: async () => ({ move_id: 9 }),
      moveStatus: async () => 'success'
    }
    await rebalance.tickRebalance((await rebalance.readRebalance(id2))!, deps)
    expect((await rebalance.cancelRebalance(id2)).status).toBe('cancelling')
    expect(await rebalance.tickRebalance((await rebalance.readRebalance(id2))!, deps)).toBe(
      'cancelled'
    )
  })

  it('refuses at start a move the planner now refuses, a changed plan, or manual routing', async () => {
    await expect(
      rebalance.createRebalance(startBody(), by, {
        ...okDeps,
        planFor: async () => planOf('a'.repeat(64), { routing: 'manual' })
      })
    ).rejects.toMatchObject({ code: 'MANUAL_ROUTE' })
    await expect(
      rebalance.createRebalance(startBody(), by, {
        ...okDeps,
        planFor: async () => planOf('f'.repeat(64))
      })
    ).rejects.toMatchObject({ code: 'PLAN_CHANGED' })
    await expect(
      rebalance.createRebalance(startBody(), by, {
        ...okDeps,
        planFor: async (env: number) =>
          planOf((env === 21 ? 'a' : 'b').repeat(64), {
            blockers: [{ code: 'SQLITE', text: 'x' }]
          })
      })
    ).rejects.toMatchObject({ code: 'PLAN_BLOCKED' })
  })

  it('a Cancel while a start is under way waits for that move (never says cancelled over it)', async () => {
    const id = await rebalance.createRebalance(startBody(), by, okDeps)
    let cancelled: string | null = null
    const deps = {
      confirmText: async () => 'acme/dev',
      // The cancel lands while startMove is still planning.
      start: async () => {
        cancelled = (await rebalance.cancelRebalance(id)).status
        return { move_id: 55 }
      },
      moveStatus: async () => 'running'
    }
    expect(await rebalance.tickRebalance((await rebalance.readRebalance(id))!, deps)).toBe(
      'started'
    )
    expect(cancelled).toBe('cancelling')
    const r = await rebalance.readRebalance(id)
    expect(r).toMatchObject({ status: 'cancelling', current_move_id: 55 })
    expect(r?.moves[0]).toMatchObject({ move_id: 55, result: 'running' })
  })

  it('an overlapping tick leaves a claimed start alone; a stale claim adopts the move it made', async () => {
    const id = await rebalance.createRebalance(startBody(), by, okDeps)
    await db(store.REBALANCES)
      .where({ id })
      .update({ current_move_id: rebalance.STARTING, heartbeat_at: new Date() })
    const deps = { movedSince: async () => 77 }
    expect(await rebalance.tickRebalance((await rebalance.readRebalance(id))!, deps)).toBe(
      'starting'
    )
    await db(store.REBALANCES)
      .where({ id })
      .update({ heartbeat_at: new Date(Date.now() - 10 * 60_000) })
    expect(await rebalance.tickRebalance((await rebalance.readRebalance(id))!, deps)).toBe(
      'recovered'
    )
    expect((await rebalance.readRebalance(id))?.current_move_id).toBe(77)
    // A run whose tick was overtaken writes nothing.
    const stale = (await rebalance.readRebalance(id))!
    await db(store.REBALANCES).where({ id }).update({ status: 'cancelling' })
    expect(await rebalance.tickRebalance(stale, { moveStatus: async () => 'failed' })).toBe(
      'changed-meanwhile'
    )
    expect((await rebalance.readRebalance(id))?.status).toBe('cancelling')
  })

  it('plans with the move planner and leaves out moves that cannot run', async () => {
    const tenants = [21, 22].map((id) => ({
      placedHere: true,
      env: { id, key: id === 21 ? 'dev' : 'qa', status: 'active' },
      app: { key: 'acme' },
      placement: { target: {} }
    }))
    const samples = [21, 22].map((id) =>
      row({ shared_deployment_id: 1, environment_id: id, busy_ms_per_min: id === 21 ? 400 : 300 })
    )
    const p = await rebalance.planRebalance([1, 2], 3, {
      tenantsOf: async (s) => (s.id === 1 ? (tenants as never) : []),
      samples: async () => samples,
      openMove: async () => false,
      planFor: async () => ({
        kind: 'between_shared',
        routing: 'manual',
        steps: [],
        route: [],
        manual_request: null,
        version: '0.3.215',
        hostnames: [],
        files: { count: 0, bytes: 0, first_pull: 'full' },
        blockers: [],
        warnings: [],
        checklist: [],
        plan_hash: 'c'.repeat(64)
      })
    })
    expect(p.moves).toHaveLength(1)
    expect(p.moves[0].cannot_run).toContain('manual')
    expect(p.shared.map((s) => s.load_before)).toEqual([700, 0])
    await expect(rebalance.planRebalance([1], 3)).rejects.toMatchObject({ code: 'BAD_SHARED' })
  })
})
