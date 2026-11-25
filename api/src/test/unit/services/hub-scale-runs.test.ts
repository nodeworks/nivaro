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
  await import('../../../db/migrations/576_hub_incidents.js'),
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
    expect(p.connections.total).toEqual({ from: 568, to: 710 })
    // production (medium: web 2 + worker 1) × (20 + 10 + 1 probe)
    expect(p.connections.servers[0]).toMatchObject({ others: 93, after: 803, fits: true })
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
    expect(await auto.evaluateTarget('environment', 1, d2)).toBe('held')
    const skipped = (await store.listRuns('environment', 1, 10)).filter(
      (x) => x.status === 'skipped'
    )
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ error_code: 'FROZEN' })
    expect(skipped[0].reason).toMatch(/^Autoscaling paused: A release freeze is on/)
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
    expect(d?.now.connections.total.from).toBe(568)
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
    // The dedicated stacks on the same server count as others: 8 × 71 + 3 × 31 (each process has its probe connection).
    expect(p.connections.servers[0]).toMatchObject({ others: 661, to: 56 })
    expect(p.confirm).toBe('shared-eu')
  })
})

// ─── review fixes ─────────────────────────────────────────────────────────────

/** A fake swarm: what the agent says the stack runs, moved by the scale calls it accepts. */
function swarm() {
  const live = { hash: HASH0, web: 3, realtime: 2 }
  const status = () =>
    ({
      state: 'converged',
      spec_hash: live.hash,
      services: [
        { role: 'web', replicas: { desired: live.web, running: live.web } },
        { role: 'realtime', replicas: { desired: live.realtime, running: live.realtime } }
      ]
    }) as never
  const apply = (changes: StackScaleChange[]) => {
    for (const c of changes) {
      if (c.role === 'web' && c.replicas !== undefined) live.web = c.replicas
      if (c.role === 'realtime' && c.replicas !== undefined) live.realtime = c.replicas
    }
    live.hash = String(nextHash++).padStart(64, 'c')
    return live.hash
  }
  return { live, status, apply }
}

const cancelled = { notices: 0 }
const countingNotify = {
  notify: async () => {
    cancelled.notices++
    return null
  },
  adminBase: () => 'https://hub.corp'
}

async function planAndStart(
  roles: RoleChangeInput[],
  d: ReturnType<typeof deps>,
  envId = 1
): Promise<number> {
  const t = await target.environmentTarget(envId, async () => health())
  const p = await plan.planScale(t as never, roles, 'manual', d)
  expect(p.blockers).toEqual([])
  const s = await run.startScale(
    'environment',
    envId,
    { roles, plan_hash: p.plan_hash, confirm: p.confirm ?? undefined },
    { by: null, source: 'manual' },
    d
  )
  return s.run_id
}

describe('review: the lock is checked before every write to the stack', () => {
  it('a lock lost during a realtime drain sends no further step', async () => {
    await store.writeShape(
      'environment',
      1,
      [{ role: 'realtime', replicas: 4, cpus: 1, memory_mb: 1024 }],
      null
    )
    let renews = 0
    const lock = {
      ...memoryPromoteLock,
      renew: async (envId: number, token: string) => {
        renews++
        // The first step's checks pass; from the drain on, the lock is someone else's.
        return renews <= 3 ? memoryPromoteLock.renew(envId, token) : false
      },
      renewStrict: undefined
    }
    const id = await planAndStart([{ role: 'realtime', replicas: 1 }], deps({ envLock: lock }))
    expect(scaleCalls).toHaveLength(1)
    expect(await store.readRun(id)).toMatchObject({
      status: 'interrupted',
      error_code: 'LOCK_LOST'
    })
    expect(await memoryPromoteLock.held(1)).toBe(false)
  })

  it('a stale run is resumed once, however many ticks ask at the same time', async () => {
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
      steps: [{ to, status: 'pending' }],
      plan_hash: null,
      started_by: null
    })
    await db(store.SCALE_RUNS)
      .where({ id })
      .update({ heartbeat_at: new Date(Date.now() - 10 * 60_000) })
    // A second tick racing the first: the stale heartbeat is claimed by one of them only.
    const before = new Date(Date.now() - run.STALE_MS)
    expect(await store.claimStaleRun(id, before, new Date())).toBe(true)
    expect(await store.claimStaleRun(id, before, new Date())).toBe(false)
    expect(await run.resumeStaleRuns(deps())).toBe(0)
  })
})

describe('review: the Hub record follows what swarm runs', () => {
  it('the agent applied, then the Hub timed out: the record matches live and Apply now does not scale back', async () => {
    const sw = swarm()
    let t0 = 0
    const d = deps({
      agentScale: async (_d, _n, spec, changes) => {
        scaleCalls.push({ roles: spec.roles, changes })
        return { spec_hash: sw.apply(changes), changed: [], unchanged: [], already: false }
      },
      // Swarm never says converged: the run times out waiting.
      agentStack: async () => ({ ...(sw.status() as object), state: 'updating' }) as never,
      now: () => (t0 += 60_000),
      settleMs: 120_000
    })
    const id = await planAndStart([{ role: 'web', replicas: 5 }], d)
    const r = await store.readRun(id)
    expect(r).toMatchObject({
      status: 'failed',
      error_code: 'SETTLE_TIMEOUT',
      spec_hash: sw.live.hash
    })
    expect((await store.readScaleShape('environment', 1))?.web?.replicas).toBe(5)
    // What Apply now / a promotion renders: the kept shape (web 5), and the hash it expects.
    const after = await target.environmentTarget(1, async () => health())
    expect(web(after?.roles as never)?.replicas).toBe(5)
    const dep = await guards.deployedStack(1, 'acme-st')
    expect(dep.state === 'ok' && dep.specHash).toBe(sw.live.hash)
  })

  it('the agent call failed but swarm took it (a new live hash): adopted', async () => {
    const sw = swarm()
    const { AgentError } = await import('../../../services/hub/docker/agent-client.js')
    const d = deps({
      agentScale: async (_d, _n, _spec, changes) => {
        sw.apply(changes)
        throw new AgentError('AGENT_UNREACHABLE', 0, 'timeout')
      },
      agentStack: async () => sw.status()
    })
    const id = await planAndStart([{ role: 'web', replicas: 6 }], d)
    expect(await store.readRun(id)).toMatchObject({ status: 'failed', spec_hash: sw.live.hash })
    expect((await store.readScaleShape('environment', 1))?.web?.replicas).toBe(6)
  })

  it('a later scale refused SPEC_MISMATCH adopts what runs and tries once more', async () => {
    const sw = swarm()
    sw.live.web = 4 // someone's earlier change the Hub never recorded
    const { AgentError } = await import('../../../services/hub/docker/agent-client.js')
    let calls = 0
    const d = deps({
      agentScale: async (_d, _n, spec, changes) => {
        calls++
        scaleCalls.push({ roles: spec.roles, changes })
        if (calls === 1) throw new AgentError('SPEC_MISMATCH', 409, 'x')
        return { spec_hash: sw.apply(changes), changed: [], unchanged: [], already: false }
      },
      agentStack: async () => sw.status()
    })
    const id = await planAndStart([{ role: 'web', replicas: 6 }], d)
    expect(await store.readRun(id)).toMatchObject({ status: 'success' })
    expect(calls).toBe(2)
    // The retry is rendered from what runs (web 4), not from the stale record (web 3).
    expect(scaleCalls[1].roles.find((x) => x.role === 'web')?.replicas).toBe(4)
  })

  it('swarm rolled one role back: the run puts the stack back to the numbers before it', async () => {
    let n = 0
    const d = deps({
      agentScale: async (_d, _n, spec, changes) => {
        scaleCalls.push({ roles: spec.roles, changes })
        return {
          spec_hash: String(++n).padStart(64, 'd'),
          changed: [],
          unchanged: [],
          already: false
        }
      },
      agentStack: async (_d, _n, expect) =>
        ({
          state: expect === String(1).padStart(64, 'd') ? 'rolled_back' : 'converged',
          spec_hash: expect ? null : HASH0,
          services: []
        }) as never
    })
    const id = await planAndStart([{ role: 'web', replicas: 5, memory_mb: 4096 }], d)
    const r = await store.readRun(id)
    expect(r?.error_code).toBe('SWARM_ROLLED_BACK')
    expect(r?.error).toMatch(/put every role back/)
    expect(scaleCalls).toHaveLength(2)
    expect(scaleCalls[1].changes).toEqual([{ role: 'web', replicas: 3, memory_mb: 3072 }])
    expect(await store.readScaleShape('environment', 1)).toBeNull()
  })

  it('a cancel asked during the last step is cleared when the run succeeds', async () => {
    const d = deps({
      agentScale: async (_d, _n, spec, changes) => {
        scaleCalls.push({ roles: spec.roles, changes })
        await db(store.SCALE_RUNS)
          .where({ status: 'running' })
          .update({ error_code: 'CANCEL_REQUESTED' })
        return { spec_hash: 'e'.repeat(64), changed: [], unchanged: [], already: false }
      }
    })
    const id = await planAndStart([{ role: 'web', replicas: 4 }], d)
    expect(await store.readRun(id)).toMatchObject({ status: 'success', error_code: null })
  })
})

describe('review: automatic runs back off and pause', () => {
  beforeEach(async () => {
    // One active Hub administrator to tell.
    await db('nivaro_roles').del()
    await db('nivaro_users').del()
    await db('nivaro_roles').insert({ id: 1, admin_access: true })
    await db('nivaro_users').insert({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      role: 1,
      status: 'active',
      account_kind: null
    })
  })
  const ruleWeb = async () => {
    const { checkRule } = await import('../../../services/hub/scale/rules.js')
    const r = checkRule(
      {
        enabled: true,
        min: 2,
        max: 8,
        sustain: 1,
        cooldown_out_min: 0,
        step_every_min: 1,
        metrics: [{ metric: 'cpu_pct', out_above: 70, in_below: 20 }]
      },
      'web'
    )
    if (!r.ok) throw new Error(r.error)
    await store.setRule('environment', 1, 'web', r.rule, 'u1')
  }
  const hot = async () => ({
    ok: true as const,
    usage: {
      version: '0.3.215',
      at: new Date().toISOString(),
      partial: false,
      processes: [{ instance: 'w1', role: 'web', cpu_pct: 190, memory_mb: 1000, uptime_s: 1 }],
      totals: { cpu_pct: 190, memory_mb: 1000, requests_per_min: 1, busy_ms_per_min: 1 },
      apps: []
    }
  })
  const failAuto = async (at: number) =>
    store.insertRun({
      target_kind: 'environment',
      target_id: 1,
      stack: 'acme-st',
      source: 'auto',
      status: 'failed',
      reason: 'x',
      figures: null,
      from: [],
      to: [],
      steps: [],
      plan_hash: null,
      started_by: null,
      error_code: 'SPEC_MISMATCH',
      at: new Date(at)
    })

  it('waits 10, then 20 minutes after failures; the third pauses the rule with one notice; Resume rule lifts it', async () => {
    await ruleWeb()
    const now = Date.now()
    await failAuto(now - 5 * 60_000)
    expect(
      await auto.evaluateTarget('environment', 1, { ...deps(), readUsage: hot, now: () => now })
    ).toBe('held')
    await failAuto(now - 60_000)
    // Newest failure 11 minutes before, 2 in a row: 20 minutes.
    expect(
      await auto.evaluateTarget('environment', 1, {
        ...deps(),
        readUsage: hot,
        now: () => now + 10 * 60_000
      })
    ).toBe('held')
    await failAuto(now)
    cancelled.notices = 0
    const d = { ...deps({ notify: countingNotify }), readUsage: hot, now: () => now }
    expect(await auto.evaluateTarget('environment', 1, d)).toBe('skipped')
    expect(cancelled.notices).toBeGreaterThan(0)
    const told = cancelled.notices
    // Paused: nothing more, no second notice.
    expect(await auto.evaluateTarget('environment', 1, d)).toBe('none')
    expect(cancelled.notices).toBe(told)
    const role = (await store.readRoles('environment', 1)).find((r) => r.role === 'web')
    expect(role?.state.paused_at).toBeTruthy()
    await store.resumeRule('environment', 1, 'web', 'u1', new Date(now + 1000))
    expect(
      await auto.evaluateTarget('environment', 1, {
        ...deps(),
        readUsage: hot,
        now: () => now + 2000
      })
    ).toBe('started')
  })

  it('the at-max notice is told once while the stack is paused', async () => {
    const { checkRule } = await import('../../../services/hub/scale/rules.js')
    const r = checkRule(
      {
        enabled: true,
        min: 2,
        max: 3,
        sustain: 1,
        metrics: [{ metric: 'cpu_pct', out_above: 70, in_below: 20 }]
      },
      'web'
    )
    if (!r.ok) throw new Error(r.error)
    await store.setRule('environment', 1, 'web', r.rule, 'u1')
    const now = Date.now()
    const hits = [now - 50 * 60_000, now - 30 * 60_000, now - 15 * 60_000].map((x) =>
      new Date(x).toISOString()
    )
    const cur = (await store.readRoles('environment', 1)).find((x) => x.role === 'web')
    await store.saveState('environment', 1, 'web', Object.assign({}, cur?.state, { max_hits: hits }) as never)
    await db('nivaro_hub_freezes').insert({
      app_id: 1,
      name: 'Month end',
      recurrence: 'none',
      starts_at: new Date(now - 60_000),
      ends_at: new Date(now + 3 * 3600_000)
    })
    cancelled.notices = 0
    const d = { ...deps({ notify: countingNotify }), readUsage: hot, now: () => now }
    await auto.evaluateTarget('environment', 1, d)
    const once = cancelled.notices
    expect(once).toBeGreaterThan(0)
    await auto.evaluateTarget('environment', 1, { ...d, now: () => now + 60_000 })
    await auto.evaluateTarget('environment', 1, { ...d, now: () => now + 120_000 })
    expect(cancelled.notices).toBe(once)
  })

  it('editing a rule keeps its last change (the cooldown holds)', async () => {
    await ruleWeb()
    await store.noteChange('environment', 1, ['web'], new Date('2026-11-25T10:00:00Z'))
    await ruleWeb()
    expect(
      (await store.readRoles('environment', 1)).find((r) => r.role === 'web')?.state.last_change_at
    ).toBe('2026-11-25T10:00:00.000Z')
  })
})

describe('review: connections are reserved and never judged blind', () => {
  it('two plans at once on one server: the second counts the first one’s open run', async () => {
    // Acme production (env 2) shares sql1 with staging (env 1).
    let release: () => void = () => {}
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const d = deps({
      inline: false,
      agentScale: async (_d, _n, spec, changes) => {
        scaleCalls.push({ roles: spec.roles, changes })
        await blocked
        return { spec_hash: 'f'.repeat(64), changed: [], unchanged: [], already: false }
      }
    })
    const first = await planAndStart([{ role: 'web', replicas: 6 }], d)
    const prod = await target.environmentTarget(2, async () => health())
    const p = await plan.planScale(prod as never, [{ role: 'web', replicas: 3 }], 'manual', deps())
    // Staging counts at its open run's target (web 6: 11 processes × 71), not its kept 8 × 71.
    expect(p.connections.servers[0].others).toBe(11 * 71)
    release()
    await new Promise((r) => setTimeout(r, 20))
    await db(store.SCALE_RUNS).where({ id: first }).update({ status: 'success' })
  })

  it('an unknown limit: autoscaling never adds processes, a person may with the key, fewer always passes', async () => {
    await db('nivaro_hub_db_servers').update({ max_connections: null })
    const t = await target.environmentTarget(1, async () => health())
    const auto1 = await plan.planScale(t as never, [{ role: 'web', replicas: 5 }], 'auto', deps())
    expect(auto1.blockers.map((b) => b.code)).toContain('DB_LIMIT_UNKNOWN')
    const manual = await plan.planScale(
      t as never,
      [{ role: 'web', replicas: 5 }],
      'manual',
      deps()
    )
    expect(manual.blockers).toEqual([])
    expect(manual.warnings.map((w) => w.code)).toContain('DB_LIMIT_UNKNOWN')
    expect(manual.confirm).toBe('staging')
    const fewer = await plan.planScale(t as never, [{ role: 'web', replicas: 2 }], 'auto', deps())
    expect(fewer.blockers).toEqual([])
  })

  it('a manual change outside an enabled rule warns that autoscaling moves it back', async () => {
    const { checkRule } = await import('../../../services/hub/scale/rules.js')
    const r = checkRule(
      {
        enabled: true,
        min: 2,
        max: 4,
        metrics: [{ metric: 'cpu_pct', out_above: 70, in_below: 20 }]
      },
      'web'
    )
    if (!r.ok) throw new Error(r.error)
    await store.setRule('environment', 1, 'web', r.rule, 'u1')
    const t = await target.environmentTarget(1, async () => health())
    const p = await plan.planScale(t as never, [{ role: 'web', replicas: 6 }], 'manual', deps())
    expect(p.warnings.find((w) => w.code === 'AUTOSCALE_WILL_MOVE')?.text).toMatch(/back to 4/)
  })
})

describe('review: incidents pause autoscaling', () => {
  it('an open incident for the app (or this environment) pauses it; a resolved one or another app does not', async () => {
    const { incidentOpenFor } = await import('../../../services/hub/scale/pause.js')
    await db('nivaro_hub_incidents').del()
    expect(await incidentOpenFor({ appIds: [1], envIds: [1] })).toBe(false)
    const base = { title: 'Down', severity: 'sev1', opened_at: new Date() }
    await db('nivaro_hub_incidents').insert({
      ...base,
      app_id: 1,
      environment_id: 2,
      status: 'open'
    })
    expect(await incidentOpenFor({ appIds: [1], envIds: [1] })).toBe(false)
    expect(await incidentOpenFor({ appIds: [1], envIds: [2] })).toBe(true)
    await db('nivaro_hub_incidents').insert({
      ...base,
      app_id: 2,
      environment_id: null,
      status: 'open'
    })
    expect(await incidentOpenFor({ appIds: [1], envIds: [1] })).toBe(false)
    await db('nivaro_hub_incidents').insert({
      ...base,
      app_id: 1,
      environment_id: null,
      status: 'resolved'
    })
    expect(await incidentOpenFor({ appIds: [1], envIds: [1] })).toBe(false)
    await db('nivaro_hub_incidents').insert({
      ...base,
      app_id: 1,
      environment_id: null,
      status: 'open'
    })
    expect(await incidentOpenFor({ appIds: [1], envIds: [1] })).toBe(true)
    const t = await target.environmentTarget(1, async () => health())
    const p = await plan.planScale(t as never, [{ role: 'web', replicas: 4 }], 'auto', deps())
    expect(p.blockers.map((b) => b.code)).toContain('INCIDENT_OPEN')
    await db('nivaro_hub_incidents').del()
  })

  it('a stopped automatic run does not resume into a freeze that began meanwhile', async () => {
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
      source: 'auto',
      status: 'running',
      reason: 'x',
      figures: null,
      from,
      to,
      steps: [{ to, status: 'pending' }],
      plan_hash: null,
      started_by: null
    })
    await db(store.SCALE_RUNS)
      .where({ id })
      .update({ heartbeat_at: new Date(Date.now() - 10 * 60_000) })
    await db('nivaro_hub_freezes').insert({
      app_id: 1,
      name: 'Month end',
      recurrence: 'none',
      starts_at: new Date(Date.now() - 60_000),
      ends_at: new Date(Date.now() + 3600_000)
    })
    expect(await run.resumeStaleRuns(deps())).toBe(0)
    expect(await store.readRun(id)).toMatchObject({ status: 'interrupted', error_code: 'PAUSED' })
    expect(scaleCalls).toHaveLength(0)
  })
})
