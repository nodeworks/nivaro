import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub scaling against real SQLite (migrations 542–553, 565, 570, 581): the target read,
// the plan (connection math, the worker / web / SQLite / agent rules, pauses), a manual run
// through an injected agent (the shape kept, the deployed spec hash moved on), a realtime
// scale-in one replica a step, resuming a stopped run, the autoscaling tick and a shared
// deployment's per-app pools. Nothing outside is called: the agent, the locks and the figures are
// injected.

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
  return { db, migrationsDir: '/nowhere' }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const target = await import('../../../services/hub/scale/target.js')
const plan = await import('../../../services/hub/scale/plan.js')
const run = await import('../../../services/hub/scale/run.js')
const store = await import('../../../services/hub/scale/store.js')
const auto = await import('../../../services/hub/scale/auto.js')
const view = await import('../../../services/hub/scale/view.js')
const guards = await import('../../../services/hub/docker/stack-guards.js')
const { memoryPromoteLock, sharedLock } = await import('../../../services/hub/promote-lock.js')

import type {
  AgentHealth,
  StackScaleChange,
  StackSpec
} from '../../../services/hub/docker/agent-types.js'
import type { RoleChangeInput } from '../../../services/hub/scale/plan.js'
import type { RoleFigures } from '../../../services/hub/scale/shape.js'

const MIGRATIONS = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/565_hub_release_ops.js'),
  await import('../../../db/migrations/570_hub_people_owner_policy.js'),
  await import('../../../db/migrations/581_hub_scale.js')
]

const IMAGE = `nodeworks/nivaro@sha256:${'1'.repeat(64)}`
const HASH0 = 'a'.repeat(64)
const health = (version = '0.2.4'): AgentHealth =>
  ({
    api: 1,
    agent_version: version,
    engine_api: '1.45',
    swarm: { manager: true, node_id: 'n1', nodes: 1 },
    images: ['nodeworks/nivaro'],
    host_suffixes: ['.apps.corp'],
    edge: 'traefik',
    publish_ports: null,
    extensions_shared: false,
    redis_bundled: true
  }) as AgentHealth

let agentVersion = '0.2.4'
const scaleCalls: Array<{ roles: StackSpec['roles']; changes: StackScaleChange[] }> = []
let nextHash = 1

const deps = (over: Partial<Parameters<typeof run.startScale>[4]> = {}) => ({
  envLock: memoryPromoteLock,
  sharedLock: sharedLock(null),
  health: async () => health(agentVersion),
  renderCurrent: async (t: { roles: StackSpec['roles'] }, shape: unknown) => {
    const { applyScaleShape } = await import('../../../services/hub/scale/shape.js')
    const tpl = (t as unknown as { template: StackSpec['roles'] }).template
    return {
      driver: { id: 1, kind: 'docker', name: 'd', config: {}, secret: null } as never,
      spec: { roles: applyScaleShape(tpl, shape as never) } as unknown as StackSpec
    }
  },
  agentScale: async (_d: unknown, _n: string, spec: StackSpec, changes: StackScaleChange[]) => {
    scaleCalls.push({ roles: spec.roles, changes })
    const h = String(nextHash++).padStart(64, 'b')
    return { spec_hash: h, changed: [], unchanged: [], already: false }
  },
  agentStack: async () => ({ state: 'converged' }) as never,
  sleep: async () => {},
  drainMs: 0,
  pollMs: 0,
  inline: true,
  notify: { notify: async () => null, adminBase: () => 'https://hub.corp' },
  ...over
})

beforeAll(async () => {
  for (const m of MIGRATIONS) await m.up(db)
  // A second run changes nothing (guarded, additive).
  await MIGRATIONS[MIGRATIONS.length - 1].up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id')
    t.integer('role')
    t.string('status')
    t.string('account_kind')
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.integer('id')
    t.boolean('admin_access')
  })
  await db.schema.createTable('nivaro_activity', (t) => {
    t.increments('id')
    t.string('action')
    t.string('collection')
    t.string('item')
    t.text('comment')
    t.string('user')
    t.dateTime('timestamp')
    t.string('ip')
    t.string('user_agent')
    t.string('origin')
  })
})
afterAll(async () => db.destroy())

async function seed() {
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_environments',
    'nivaro_hub_drivers',
    'nivaro_hub_placements',
    'nivaro_hub_stack_settings',
    'nivaro_hub_deploys',
    'nivaro_hub_db_servers',
    'nivaro_hub_databases',
    'nivaro_hub_shared_deployments',
    'nivaro_hub_shared_deploys',
    'nivaro_hub_moves',
    'nivaro_hub_freezes',
    store.SCALE_ROLES,
    store.SCALE_RUNS
  ])
    await db(t).del()
  await db('nivaro_hub_apps').insert([
    { id: 1, key: 'acme', name: 'Acme' },
    { id: 2, key: 'beta', name: 'Beta' }
  ])
  await db('nivaro_hub_drivers').insert({
    id: 1,
    kind: 'docker',
    name: 'swarm',
    config: JSON.stringify({ agent_url: 'https://agent.corp:8443' })
  })
  await db('nivaro_hub_placements').insert([
    { id: 1, kind: 'dedicated', driver_id: 1, target: JSON.stringify({ stack: 'acme-st' }) },
    { id: 2, kind: 'dedicated', driver_id: 1, target: JSON.stringify({ stack: 'acme-prod' }) }
  ])
  await db('nivaro_hub_db_servers').insert({
    id: 1,
    name: 'sql1',
    engine: 'mssql',
    host: 'sql1.corp',
    max_connections: 2000
  })
  await db('nivaro_hub_databases').insert([
    { id: 1, server_id: 1, engine: 'mssql', host: 'sql1.corp', database_name: 'acme_st' },
    { id: 2, server_id: 1, engine: 'mssql', host: 'sql1.corp', database_name: 'acme_prod' },
    { id: 3, server_id: 1, engine: 'mssql', host: 'sql1.corp', database_name: 'beta' }
  ])
  await db('nivaro_hub_environments').insert([
    {
      id: 1,
      app_id: 1,
      key: 'staging',
      position: 1,
      base_url: 'https://acme-staging.apps.corp',
      placement_id: 1,
      version_pin: '0.3.215',
      db_ref: 'hub-db:1'
    },
    {
      id: 2,
      app_id: 1,
      key: 'production',
      position: 2,
      base_url: 'https://acme.apps.corp',
      placement_id: 2,
      version_pin: '0.3.215',
      db_ref: 'hub-db:2'
    }
  ])
  await db('nivaro_hub_stack_settings').insert([
    { environment_id: 1, size: 'large', redis: 'bundled', settings: '{}' },
    { environment_id: 2, size: 'medium', redis: 'bundled', settings: '{"DB_POOL_MAX":"20"}' }
  ])
  const step = (name: string) =>
    JSON.stringify({
      steps: [
        {
          driver: 'docker',
          stack: { name, extensions: {}, size: 'large' },
          deployedImage: IMAGE,
          deployedSpecHash: HASH0
        }
      ]
    })
  await db('nivaro_hub_deploys').insert([
    {
      environment_id: 1,
      app_id: 1,
      kind: 'promote',
      version: '0.3.215',
      status: 'success',
      plan: step('acme-st'),
      started_at: new Date(Date.now() - 3600_000)
    },
    {
      environment_id: 2,
      app_id: 1,
      kind: 'promote',
      version: '0.3.215',
      status: 'success',
      plan: step('acme-prod'),
      started_at: new Date(Date.now() - 3600_000)
    }
  ])
}

beforeEach(async () => {
  agentVersion = '0.2.4'
  scaleCalls.length = 0
  nextHash = 1
  await seed()
})

const web = (to: RoleFigures[]) => to.find((r) => r.role === 'web')

describe('the target', () => {
  it('a large dedicated stack: template + kept shape, pools, server, production rule', async () => {
    const t = await target.environmentTarget(1, async () => health())
    expect(t?.unusable).toBeNull()
    expect(t?.roles.map((r) => `${r.role}×${r.replicas}`)).toEqual([
      'web×3',
      'worker×1',
      'realtime×2',
      'importer×1',
      'exporter×1'
    ])
    expect(t?.production).toBe(false)
    expect(t?.pools).toEqual({ main: 60, background: 10 })
    expect(t?.server).toMatchObject({ id: 1, max_connections: 2000 })
    const prod = await target.environmentTarget(2, async () => health())
    expect(prod?.production).toBe(true)
    expect(prod?.pools).toEqual({ main: 20, background: 10 })
  })
})

describe('the plan', () => {
  it('web 3 → 5: the connection math counts the other stacks on the server', async () => {
    const t = await target.environmentTarget(1, async () => health())
    const p = await plan.planScale(t as never, [{ role: 'web', replicas: 5 }], 'manual', deps())
    expect(p.blockers).toEqual([])
    expect(p.changes).toEqual([{ role: 'web', replicas: 5 }])
    expect(p.connections.total).toEqual({ from: 560, to: 700 })
    // production (medium: web 2 + worker 1) × (20 + 10)
    expect(p.connections.servers[0]).toMatchObject({ others: 90, after: 790, fits: true })
    expect(p.confirm).toBeNull()
  })

  it('refuses past the server limit, the worker, below one web, an old agent, SQLite', async () => {
    await db('nivaro_hub_db_servers').update({ max_connections: 650 })
    const t = await target.environmentTarget(1, async () => health())
    const codes = async (changes: RoleChangeInput[], d = deps()) =>
      (await plan.planScale(t as never, changes, 'manual', d)).blockers.map((b) => b.code)
    expect(await codes([{ role: 'web', replicas: 5 }])).toEqual(['DB_CONNECTIONS'])
    // Fewer processes always pass, even on a crowded server.
    expect(await codes([{ role: 'web', replicas: 2 }])).toEqual([])
    expect(await codes([{ role: 'worker', replicas: 2 }])).toContain('REPLICAS_FIXED')
    expect(await codes([{ role: 'web', replicas: 0 }])).toContain('BELOW_MIN')
    expect(await codes([{ role: 'web', cpus: 99 }])).toContain('LIMIT_BAD')
    agentVersion = '0.2.3'
    expect(await codes([{ role: 'web', replicas: 2 }])).toContain('AGENT_TOO_OLD')
    agentVersion = '0.2.4'
    await db('nivaro_hub_databases').where({ id: 1 }).update({ engine: 'sqlite' })
    const lite = await target.environmentTarget(1, async () => health())
    expect(
      (
        await plan.planScale(lite as never, [{ role: 'web', replicas: 4 }], 'manual', deps())
      ).blockers.map((b) => b.code)
    ).toContain('SQLITE_ONE_PROCESS')
  })

  it('a production environment asks for its key; an open move blocks', async () => {
    const t = await target.environmentTarget(2, async () => health())
    const p = await plan.planScale(t as never, [{ role: 'web', replicas: 3 }], 'manual', deps())
    expect(p.confirm).toBe('production')
    await db('nivaro_hub_moves').insert({
      environment_id: 2,
      app_id: 1,
      kind: 'to_shared',
      routing: 'automatic',
      status: 'running',
      from_placement_id: 2,
      to_placement_id: 1,
      steps: '[]'
    })
    const p2 = await plan.planScale(t as never, [{ role: 'web', replicas: 3 }], 'manual', deps())
    expect(p2.blockers.map((b) => b.code)).toContain('MOVE_OPEN')
  })

  it('a freeze only warns a person; it pauses automatic scaling', async () => {
    await db('nivaro_hub_freezes').insert({
      app_id: 1,
      name: 'Month end',
      recurrence: 'none',
      starts_at: new Date(Date.now() - 60_000),
      ends_at: new Date(Date.now() + 3 * 3600_000)
    })
    const t = await target.environmentTarget(1, async () => health())
    const manual = await plan.planScale(
      t as never,
      [{ role: 'web', replicas: 4 }],
      'manual',
      deps()
    )
    expect(manual.blockers).toEqual([])
    expect(manual.warnings.map((w) => w.code)).toContain('FROZEN')
    const a = await plan.planScale(t as never, [{ role: 'web', replicas: 4 }], 'auto', deps())
    expect(a.blockers.map((b) => b.code)).toContain('FROZEN')
  })
})

describe('a manual run', () => {
  it('is bound to its plan, keeps the new numbers and moves the deployed spec hash on', async () => {
    const t = await target.environmentTarget(1, async () => health())
    const p = await plan.planScale(t as never, [{ role: 'web', replicas: 5 }], 'manual', deps())
    await expect(
      run.startScale(
        'environment',
        1,
        { roles: [{ role: 'web', replicas: 5 }], plan_hash: 'nope' },
        { by: null, source: 'manual' },
        deps()
      )
    ).rejects.toMatchObject({ code: 'PLAN_CHANGED' })
    const started = await run.startScale(
      'environment',
      1,
      { roles: [{ role: 'web', replicas: 5 }], plan_hash: p.plan_hash },
      { by: null, source: 'manual' },
      deps()
    )
    const r = await store.readRun(started.run_id)
    expect(r).toMatchObject({ status: 'success', source: 'manual', step_index: 1 })
    expect(r?.reason).toBe('Changed by hand: web 3 → 5.')
    expect(scaleCalls).toHaveLength(1)
    // The agent got the spec as it ran (web 3) and only the change.
    expect(scaleCalls[0].roles.find((x) => x.role === 'web')?.replicas).toBe(3)
    expect(scaleCalls[0].changes).toEqual([{ role: 'web', replicas: 5 }])
    expect(await store.readScaleShape('environment', 1)).toEqual({
      web: { replicas: 5, cpus: 2, memory_mb: 3072 }
    })
    const after = await target.environmentTarget(1, async () => health())
    expect(web(after?.roles as never)?.replicas).toBe(5)
    const d = await guards.deployedStack(1, 'acme-st')
    expect(d.state === 'ok' && d.specHash).toBe(r?.spec_hash)
    // The lock is free again.
    expect(await memoryPromoteLock.held(1)).toBe(false)
  })

  it('a realtime scale-in goes one replica a step, each from the spec the step before left', async () => {
    await store.writeShape(
      'environment',
      1,
      [{ role: 'realtime', replicas: 4, cpus: 1, memory_mb: 1024 }],
      null
    )
    const t = await target.environmentTarget(1, async () => health())
    const p = await plan.planScale(
      t as never,
      [{ role: 'realtime', replicas: 1 }],
      'manual',
      deps()
    )
    expect(p.steps).toHaveLength(3)
    expect(p.warnings.map((w) => w.code)).toContain('REALTIME_DRAIN')
    await run.startScale(
      'environment',
      1,
      { roles: [{ role: 'realtime', replicas: 1 }], plan_hash: p.plan_hash },
      { by: null, source: 'manual' },
      deps()
    )
    expect(scaleCalls.map((c) => c.roles.find((x) => x.role === 'realtime')?.replicas)).toEqual([
      4, 3, 2
    ])
    expect(scaleCalls.map((c) => c.changes[0].replicas)).toEqual([3, 2, 1])
    expect((await store.readScaleShape('environment', 1))?.realtime?.replicas).toBe(1)
  })

  it('a failed agent call fails the run and keeps the old numbers', async () => {
    const t = await target.environmentTarget(1, async () => health())
    const p = await plan.planScale(t as never, [{ role: 'web', replicas: 4 }], 'manual', deps())
    const { AgentError } = await import('../../../services/hub/docker/agent-client.js')
    const started = await run.startScale(
      'environment',
      1,
      { roles: [{ role: 'web', replicas: 4 }], plan_hash: p.plan_hash },
      { by: null, source: 'manual' },
      deps({
        agentScale: async () => {
          throw new AgentError('SPEC_MISMATCH', 409, 'x')
        }
      })
    )
    expect(await store.readRun(started.run_id)).toMatchObject({
      status: 'failed',
      error_code: 'SPEC_MISMATCH'
    })
    expect(await store.readScaleShape('environment', 1)).toBeNull()
  })
})

describe('resume', () => {
  it('a run whose process stopped goes on from its step', async () => {
    const t = await target.environmentTarget(1, async () => health())
    const from = t?.roles.map((r) => ({
      role: r.role,
      replicas: r.replicas,
      cpus: r.cpus ?? null,
      memory_mb: r.memory_mb ?? null
    })) as RoleFigures[]
    const to = from.map((r) => (r.role === 'web' ? { ...r, replicas: 4 } : r))
    const id = await store.insertRun({
      target_kind: 'environment',
      target_id: 1,
      stack: 'acme-st',
      source: 'manual',
      status: 'running',
      reason: 'x',
      figures: null,
      from,
      to,
      steps: [{ to, status: 'applying' }],
      plan_hash: null,
      started_by: null
    })
    await db(store.SCALE_RUNS)
      .where({ id })
      .update({ heartbeat_at: new Date(Date.now() - 10 * 60_000) })
    expect(await run.resumeStaleRuns(deps())).toBe(1)
    expect(await store.readRun(id)).toMatchObject({ status: 'success' })
    expect(scaleCalls[0].changes).toEqual([{ role: 'web', replicas: 4 }])
  })
})

describe('the autoscaling tick', () => {
  const usage = (cpu: number) => async () => ({
    ok: true as const,
    usage: {
      version: '0.3.215',
      at: new Date().toISOString(),
      partial: false,
      processes: [
        { instance: 'w1', role: 'web', cpu_pct: cpu, memory_mb: 1000, uptime_s: 1 },
        { instance: 'w2', role: 'web', cpu_pct: cpu, memory_mb: 1000, uptime_s: 1 }
      ],
      totals: { cpu_pct: cpu * 2, memory_mb: 2000, requests_per_min: 600, busy_ms_per_min: 1 },
      apps: []
    }
  })

  it('starts a change with the rule’s reason and figures; pinned and paused roles do not move', async () => {
    const { checkRule } = await import('../../../services/hub/scale/rules.js')
    const r = checkRule(
      {
        enabled: true,
        min: 2,
        max: 6,
        sustain: 1,
        metrics: [{ metric: 'cpu_pct', out_above: 70, in_below: 20 }]
      },
      'web'
    )
    if (!r.ok) throw new Error(r.error)
    await store.setRule('environment', 1, 'web', r.rule, 'u1')
    // CPU 180 % of one core on a 2-CPU limit = 90 % of the limit.
    expect(await auto.evaluateTarget('environment', 1, { ...deps(), readUsage: usage(180) })).toBe(
      'started'
    )
    const [latest] = await store.listRuns('environment', 1, 1)
    expect(latest).toMatchObject({ source: 'auto', status: 'success' })
    expect(latest.reason).toMatch(/web 3 → 4: CPU \(% of the limit\) 90 > 70/)
    expect((latest.figures as { roles: { web: { cpu_pct: number } } }).roles.web.cpu_pct).toBe(90)

    // Pinned: left alone.
    await store.setPinned('environment', 1, 'web', true, 'u1')
    expect(await auto.evaluateTarget('environment', 1, { ...deps(), readUsage: usage(180) })).toBe(
      'none'
    )
    await store.setPinned('environment', 1, 'web', false, 'u1')

    // A freeze: logged as skipped, nothing started, at most once per 30 minutes.
    await db('nivaro_hub_freezes').insert({
      app_id: 1,
      name: 'Month end',
      recurrence: 'none',
      starts_at: new Date(Date.now() - 60_000),
      ends_at: new Date(Date.now() + 3 * 3600_000)
    })
    const later = () => Date.now() + 60 * 60_000
    const d2 = { ...deps(), readUsage: usage(180), now: later }
    expect(await auto.evaluateTarget('environment', 1, d2)).toBe('skipped')
    expect(await auto.evaluateTarget('environment', 1, d2)).toBe('skipped')
    const skipped = (await store.listRuns('environment', 1, 10)).filter(
      (x) => x.status === 'skipped'
    )
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ error_code: 'FROZEN' })
    expect(skipped[0].reason).toMatch(/would have: web 4 → 5/)
  })

  it('the scaling view lists the stack with its rule and runs', async () => {
    const o = await view.scaleOverview()
    const t = o.targets.find((x) => x.kind === 'environment' && x.id === 1)
    expect(t?.roles.find((r) => r.role === 'web')).toMatchObject({ replicas: 3, scalable: true })
    expect(t?.roles.find((r) => r.role === 'worker')).toMatchObject({ scalable: false })
    const d = await view.scaleDetail('environment', 1, {
      health: async () => health(),
      agentStack: async () =>
        ({
          state: 'converged',
          spec_hash: HASH0,
          services: [
            { role: 'web', replicas: { desired: 3, running: 2 } },
            { role: 'worker', replicas: { desired: 1, running: 1 } }
          ]
        }) as never
    })
    expect(d?.roles.find((r) => r.role === 'web')?.running).toEqual({ desired: 3, running: 2 })
    expect(d?.now.connections.total.from).toBe(560)
    expect(d?.now.blockers).toEqual([])
  })
})

describe('a shared deployment', () => {
  it('counts each app’s pool per process on its server', async () => {
    await db('nivaro_hub_shared_deployments').insert({
      id: 1,
      key: 'shared-eu',
      name: 'Shared EU',
      mode: 'docker',
      driver_id: 1,
      stack: 'shared-eu',
      version_pin: '0.3.215',
      link_url: 'https://shared-eu.apps.corp',
      pool_budget: 40,
      status: 'active'
    })
    await db('nivaro_hub_placements').insert({
      id: 3,
      kind: 'shared',
      shared_deployment_id: 1,
      target: JSON.stringify({ pool_max: 8 })
    })
    await db('nivaro_hub_environments').insert({
      id: 3,
      app_id: 2,
      key: 'production',
      position: 1,
      base_url: 'https://beta.apps.corp',
      placement_id: 3,
      version_pin: '0.3.215',
      db_ref: 'hub-db:3'
    })
    await db('nivaro_hub_shared_deploys').insert({
      shared_deployment_id: 1,
      kind: 'upgrade',
      version: '0.3.215',
      status: 'success',
      plan: JSON.stringify({
        plan: {
          roles: [
            { role: 'web', replicas: 2 },
            { role: 'worker', replicas: 1 },
            { role: 'importer', replicas: 1 },
            { role: 'exporter', replicas: 1 }
          ]
        },
        image: IMAGE,
        extensions: {}
      })
    })
    const t = await target.sharedTarget(1)
    expect(t?.unusable).toBeNull()
    expect(t?.apps).toEqual([
      expect.objectContaining({
        env_id: 3,
        pool_max: 8,
        server: expect.objectContaining({ id: 1 })
      })
    ])
    const p = await plan.planScale(t as never, [{ role: 'web', replicas: 4 }], 'manual', deps())
    expect(p.connections.kind).toBe('shared')
    expect(p.connections.total).toEqual({ from: 40, to: 56 })
    // The dedicated stacks on the same server count as others: 8 × 70 + 3 × 30.
    expect(p.connections.servers[0]).toMatchObject({ others: 650, to: 56 })
    expect(p.confirm).toBe('shared-eu')
  })
})
