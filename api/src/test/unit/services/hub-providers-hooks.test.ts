import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 11a: providers in the existing Hub flows, against real SQLite rows (every Hub migration up
// to 583) and fake adapters under the real type keys (hub-providers-hooks-fake.ts): carried
// changes (promotion / retirement origins and their narrow gate exceptions), the retirement's
// resource deletes (reverse dependency order; ENV_ARCHIVED refused for anyone else), smoke runs
// after a change to a serving resource, the RDS database-server link, and promotion steps of kind
// github_actions / vercel / eas_update.

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const engine = await import('../../../services/hub/providers/engine/contract.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const { hubRecordBlockers } = await import('../../../services/hub/providers/engine/gates.js')
const carried = await import('../../../services/hub/providers/hooks/carried.js')
const { servingChange } = await import('../../../services/hub/providers/hooks/serving.js')
const retireRes = await import('../../../services/hub/lifecycle/retire-resources.js')
const { gatherPlan } = await import('../../../services/hub/lifecycle/retire-plan.js')
const smoke = await import('../../../services/hub/verify/smoke.js')
const servers = await import('../../../services/hub/db/servers.js')
const promoteProviders = await import('../../../services/hub/promote-providers.js')
const { buildPromotionPlan } = await import('../../../services/hub/promote-plan.js')
const promoteRun = await import('../../../services/hub/promote-run.js')
const { makeFakeWorld } = await import('./hub-providers-hooks-fake.js')

import type { HubComponent, PlanInput } from '../../../services/hub/promote-types.js'
import type { HubActor, PlanRequest } from '../../../services/hub/providers/engine/contract.js'

const MIGRATIONS = [
  '542_hub_tables',
  '543_hub_promotions',
  '544_hub_databases',
  '545_hub_creations',
  '546_hub_stack_settings',
  '550_hub_oidc',
  '551_hub_signins',
  '552_hub_shared_deployments',
  '553_hub_moves',
  '555_hub_stack_files',
  '565_hub_release_ops',
  '566_hub_fleet',
  '567_hub_capacity',
  '568_hub_ops',
  '569_hub_data',
  '570_hub_people_owner_policy',
  '571_hub_app_templates',
  '573_hub_change_ops',
  '574_hub_verify',
  '576_hub_incidents',
  '579_hub_lifecycle',
  '582_hub_providers',
  '583_hub_provider_hooks'
]

const ADMIN_ID = '0a1b2c3d-0000-4000-8000-0000000000a1'
const ADMIN: HubActor = { id: ADMIN_ID, isAdmin: true, via: 'session' }

let world = makeFakeWorld()
let appId: number
let otherApp: number
let staging: number
let production: number
const conn: Record<string, number> = {}

const insertId = async (table: string, row: Record<string, unknown>) => {
  const [id] = await db(table).insert(row)
  return Number(id)
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('status').nullable()
    t.uuid('role').nullable()
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.uuid('id').primary()
    t.boolean('admin_access').nullable()
  })
  const role = '0a1b2c3d-0000-4000-8000-0000000000f1'
  await db('nivaro_roles').insert({ id: role, admin_access: true })
  await db('nivaro_users').insert({ id: ADMIN_ID, status: 'active', role })
  appId = await insertId('nivaro_hub_apps', { key: 'shop', name: 'Shop' })
  otherApp = await insertId('nivaro_hub_apps', { key: 'other', name: 'Other' })
  staging = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'staging',
    position: 0,
    base_url: 'https://staging.example.com'
  })
  production = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'production',
    position: 1,
    base_url: 'https://shop.example.com'
  })
  for (const p of ['aws', 'vercel', 'expo', 'github'])
    conn[p] = (
      await store.createConnection({
        provider: p,
        name: `${p} account`,
        config: {},
        secrets: { token: `test-secret-${p}-token` }
      })
    ).id
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  world = makeFakeWorld()
  registry.resetProvidersForTest()
  for (const a of world.adapters) registry.registerProvider(a)
  locks.resetMemoryResourceLocksForTest()
  deps.resetResourceEngineForTest()
  deps.configureResourceEngine({
    lock: () => locks.memoryResourceLock(),
    inline: true,
    notify: { notify: vi.fn(async () => null), adminBase: () => '', page: null }
  })
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_freezes',
    'nivaro_hub_retirements',
    'nivaro_hub_deploys',
    'nivaro_hub_smoke_suites',
    'nivaro_hub_smoke_runs',
    'nivaro_hub_db_servers',
    'nivaro_hub_databases'
  ])
    await db(t).del()
  await db('nivaro_hub_apps').update({ archived_at: null })
  await db('nivaro_hub_environments').update({ status: 'active', db_ref: null })
})

const req = (
  provider: string,
  ops: PlanRequest['ops'],
  env: number | null = staging,
  app = appId
): PlanRequest => ({
  connectionId: conn[provider],
  scope: 'app',
  appId: app,
  ...(env != null ? { environmentId: env } : {}),
  ops
})

async function make(
  provider: string,
  type: string,
  fields: Record<string, unknown>,
  env: number | null = staging
) {
  const p = await engine.planResourceChange(
    req(provider, [{ action: 'create', type, fields }], env),
    ADMIN
  )
  const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
  expect(out.status).toBe('applied')
  const rows = await store.listResources({ type, appId })
  return rows[rows.length - 1]
}

async function adopt(provider: string, type: string, externalId: string, env: number | null) {
  const p = await engine.planResourceChange(
    req(provider, [{ action: 'adopt', type, externalId }], env),
    ADMIN
  )
  const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
  expect(out.status).toBe('applied')
  return (await store.listResources({ type, externalId }))[0]
}

const freeze = (o: { app_id?: number | null; source?: string | null }) =>
  insertId('nivaro_hub_freezes', {
    app_id: o.app_id ?? null,
    name: 'Freeze',
    source: o.source ?? null,
    recurrence: 'none',
    starts_at: new Date(Date.now() - 60_000),
    ends_at: new Date(Date.now() + 3_600_000)
  })

const retirement = (state: 'running' | 'done' = 'running', step = 'remove') =>
  insertId('nivaro_hub_retirements', {
    app_id: appId,
    status: 'running',
    step,
    steps: JSON.stringify([
      { key: 'freeze', state: 'done' },
      { key: 'remove', state }
    ]),
    rev: 1
  })

// ── Carried changes ──

describe('carried changes', () => {
  it('a plan request can never carry an origin of its own', async () => {
    const p = await engine.planResourceChange(
      {
        ...req('vercel', [{ action: 'create', type: 'vercel.project', fields: { name: 'web' } }]),
        origin: { kind: 'retirement', retirementId: 1 }
      } as never,
      ADMIN
    )
    const row = await store.readChange(p.changeId)
    expect(row?.plan?.origin).toBeUndefined()
  })

  it('a promotion carries adopt / update through a freeze, never once it ended', async () => {
    const branch = await make('expo', 'expo.branch', { name: 'release-2' }, null)
    const channel = await make('expo', 'expo.channel', { name: 'production' }, production)
    await freeze({ app_id: null })
    const update: PlanRequest['ops'] = [
      { action: 'update', resourceId: channel.id, fields: { branch: { resourceId: branch.id } } }
    ]
    // Anyone else: the freeze stops it.
    const plain = await engine.planResourceChange(req('expo', update, production), ADMIN)
    await expect(
      engine.startResourceChange(plain.changeId, { planHash: plain.planHash }, ADMIN)
    ).rejects.toMatchObject({ code: 'FROZEN' })
    // A running rollback of the environment carries it (rollbacks are exempt from freezes).
    const deployId = await insertId('nivaro_hub_deploys', {
      app_id: appId,
      environment_id: production,
      kind: 'rollback',
      version: '1.0.0',
      status: 'running'
    })
    const out = await carried.runCarriedChange({
      req: req('expo', update, production),
      actor: ADMIN,
      origin: { kind: 'promotion', deployId }
    })
    expect(out.status).toBe('applied')
    expect(world.calls.at(-1)).toMatchObject({ type: 'expo.channel', action: 'point' })
    // Not a delete, and not once the run ended.
    const del = await carried.runCarriedChange({
      req: req('expo', [{ action: 'delete', resourceId: channel.id }], production),
      actor: ADMIN,
      origin: { kind: 'promotion', deployId }
    })
    expect(del).toMatchObject({ status: 'blocked', code: 'ORIGIN_INVALID' })
    await db('nivaro_hub_deploys').where({ id: deployId }).update({ status: 'success' })
    const late = await carried.runCarriedChange({
      req: req('expo', update, production),
      actor: ADMIN,
      origin: { kind: 'promotion', deployId }
    })
    expect(late).toMatchObject({ status: 'blocked', code: 'ORIGIN_INVALID' })
  })

  it('runCarriedChange picks an applied change up again instead of planning a new one', async () => {
    const deployId = await insertId('nivaro_hub_deploys', {
      app_id: appId,
      environment_id: staging,
      kind: 'promote',
      version: '1.0.0',
      status: 'running'
    })
    const branch = await make('expo', 'expo.branch', { name: 'b1' }, null)
    const channel = await make('expo', 'expo.channel', { name: 'staging' })
    const seen: number[] = []
    const run = () =>
      carried.runCarriedChange({
        req: req('expo', [
          {
            action: 'update',
            resourceId: channel.id,
            fields: { branch: { resourceId: branch.id } }
          }
        ]),
        actor: ADMIN,
        origin: { kind: 'promotion', deployId },
        changeId: seen[0] ?? null,
        onPlanned: async (id) => {
          seen.push(id)
        }
      })
    const first = await run()
    const again = await run()
    expect(first.status).toBe('applied')
    expect(again).toEqual(first)
    expect(seen).toHaveLength(1)
  })
})

// ── Retire ──

describe('retire', () => {
  async function appParts() {
    const project = await make('vercel', 'vercel.project', { name: 'shop-web' }, null)
    const dpl = world.seed('vercel.deployment', 'dpl_1', { project: project.external_id })
    const deployment = await adopt('vercel', 'vercel.deployment', dpl, staging)
    const rds = await make('aws', 'aws.rds_instance', { name: 'shop-db', engine: 'postgres' })
    return { project, deployment, rds }
  }

  it('lists the managed resources in the plan and deletes them children first, app-level last', async () => {
    const { project, deployment, rds } = await appParts()
    const plan = await gatherPlan(appId)
    expect(plan.resources?.map((r) => r.id).sort()).toEqual(
      [project.id, deployment.id, rds.id].sort()
    )
    // vercel.deployment cannot be deleted at the provider: only the RDS instance, then the project.
    await db('nivaro_hub_resources').where({ id: deployment.id }).update({ deleted_at: new Date() })
    const retId = await retirement()
    // The app is archived and the retirement's own freeze is on: both are let through for it.
    await db('nivaro_hub_apps').where({ id: appId }).update({ archived_at: new Date() })
    await db('nivaro_hub_environments').where({ id: staging }).update({ status: 'archived' })
    await freeze({ app_id: appId, source: `retire:${retId}` })
    const saved: unknown[] = []
    const n = await retireRes.deleteAppResources({
      retirementId: retId,
      plan: await gatherPlan(appId),
      by: ADMIN_ID,
      detail: {},
      save: async (d) => {
        saved.push(JSON.parse(JSON.stringify(d)))
      }
    })
    expect(n).toBe(2)
    expect(world.calls.filter((c) => c.kind === 'delete').map((c) => c.type)).toEqual([
      'aws.rds_instance',
      'vercel.project'
    ])
    expect(await store.listResources({ appId })).toEqual([])
    expect(saved.at(-1)).toMatchObject({
      [`${conn.aws}:${staging}`]: { status: 'applied' },
      [`${conn.vercel}:app`]: { status: 'applied' }
    })
  })

  it('anyone else is refused ENV_ARCHIVED on the retired app', async () => {
    const { rds } = await appParts()
    await db('nivaro_hub_apps').where({ id: appId }).update({ archived_at: new Date() })
    const p = await engine.planResourceChange(
      req('aws', [{ action: 'delete', resourceId: rds.id }]),
      ADMIN
    )
    await expect(
      engine.startResourceChange(
        p.changeId,
        { planHash: p.planHash, confirm: p.needsConfirm ?? '' },
        ADMIN
      )
    ).rejects.toMatchObject({ code: 'ENV_ARCHIVED' })
    // Nor an update, even carried by the retirement (it only deletes).
    const retId = await retirement()
    const up = await carried.runCarriedChange({
      req: req('aws', [{ action: 'update', resourceId: rds.id, fields: { engine: 'mysql' } }]),
      actor: ADMIN,
      origin: { kind: 'retirement', retirementId: retId },
      confirmed: true
    })
    expect(up).toMatchObject({ status: 'blocked', code: 'ORIGIN_INVALID' })
    expect(world.calls.filter((c) => c.kind !== 'create')).toEqual([])
  })

  it('a retirement not removing now, or another freeze, stops the deletes', async () => {
    await appParts()
    const idle = await retirement('done')
    await expect(
      retireRes.deleteAppResources({
        retirementId: idle,
        plan: await gatherPlan(appId),
        by: ADMIN_ID,
        detail: {},
        save: async () => undefined
      })
    ).rejects.toMatchObject({ code: 'ORIGIN_INVALID' })
    const retId = await retirement()
    await freeze({ app_id: appId, source: 'incident:7' })
    await expect(
      retireRes.deleteAppResources({
        retirementId: retId,
        plan: await gatherPlan(appId),
        by: ADMIN_ID,
        detail: {},
        save: async () => undefined
      })
    ).rejects.toMatchObject({ code: 'FROZEN' })
    expect(world.calls.filter((c) => c.kind === 'delete')).toEqual([])
  })
})

// ── Smoke ──

describe('smoke after a resource change', () => {
  it('servingChange: a non-noop op on a serving type, never a carried change', () => {
    const op = (type: string, kind = 'update') => ({ type, kind })
    expect(servingChange({ ops: [op('aws.route53_record')] })).toBe(true)
    expect(servingChange(JSON.stringify({ ops: [op('vercel.deployment')] }))).toBe(true)
    expect(servingChange({ ops: [op('aws.rds_instance', 'noop')] })).toBe(false)
    expect(servingChange({ ops: [op('vercel.project')] })).toBe(false)
    expect(
      servingChange({ ops: [op('aws.load_balancer')], origin: { kind: 'promotion', deployId: 1 } })
    ).toBe(false)
  })

  it('queues the suite once per applied change to a serving resource (resource-change:<id>)', async () => {
    await db('nivaro_hub_smoke_suites').insert({
      environment_id: staging,
      enabled: true,
      on_fail: 'notify',
      settle_seconds: 0,
      checks: JSON.stringify([{ id: 'aaaaaaaa', kind: 'http', name: 'Home', path: '/' }]),
      updated_at: new Date(Date.now() - 60_000)
    })
    const rds = await make('aws', 'aws.rds_instance', { name: 'db-1' })
    await make('vercel', 'vercel.project', { name: 'not-serving' })
    expect(await smoke.queueNewRuns()).toBe(1)
    expect(await smoke.queueNewRuns()).toBe(0)
    const runs = await db('nivaro_hub_smoke_runs').select('source_key', 'trigger_kind')
    const change = (await store.listChanges({})).find(
      (c) => c.plan?.ops[0]?.type === 'aws.rds_instance'
    )
    expect(runs).toEqual([
      { source_key: `resource-change:${change?.id}`, trigger_kind: 'resource' }
    ])
    expect(rds.id).toBeGreaterThan(0)
  })
})

// ── Database servers linked to RDS ──

describe('database servers and RDS', () => {
  it('a server takes its host and port from the RDS instance; a wrong type or engine is refused', async () => {
    const rds = await make('aws', 'aws.rds_instance', { name: 'pg-main', engine: 'postgres' })
    const checked = servers.validateServerInput({
      name: 'RDS main',
      engine: 'pg',
      provision_mode: 'manual',
      resource_id: rds.id
    })
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    const made = await servers.createServer(checked.row)
    expect(made).toMatchObject({ host: 'pg-main.rds.example', port: 5432, resource_id: rds.id })
    const project = await make('vercel', 'vercel.project', { name: 'x' })
    await expect(
      servers.resolveServerResource({ ...checked.row, resource_id: project.id })
    ).rejects.toMatchObject({ code: 'BAD_RESOURCE' })
    await expect(
      servers.resolveServerResource({ ...checked.row, engine: 'mysql2' })
    ).rejects.toMatchObject({ code: 'ENGINE_MISMATCH' })
    expect(
      servers.validateServerInput({ name: 'x', engine: 'pg', resource_id: 'nope' })
    ).toMatchObject({
      ok: false,
      code: 'BAD_RESOURCE'
    })
  })

  it('deleting the instance is refused while another app’s database is on its server', async () => {
    const rds = await make('aws', 'aws.rds_instance', { name: 'pg-shared', engine: 'postgres' })
    const serverId = await insertId('nivaro_hub_db_servers', {
      name: 'shared rds',
      engine: 'pg',
      host: 'pg-shared.rds.example',
      provision_mode: 'manual',
      resource_id: rds.id
    })
    const mine = await insertId('nivaro_hub_databases', {
      server_id: serverId,
      engine: 'pg',
      host: 'h',
      database_name: 'shop_staging',
      status: 'ready'
    })
    await db('nivaro_hub_environments')
      .where({ id: staging })
      .update({ db_ref: `hub-db:${mine}` })
    expect(await hubRecordBlockers([rds], appId)).toEqual([])
    const theirs = await insertId('nivaro_hub_databases', {
      server_id: serverId,
      engine: 'pg',
      host: 'h',
      database_name: 'other_prod',
      status: 'ready'
    })
    const otherEnv = await insertId('nivaro_hub_environments', {
      app_id: otherApp,
      key: 'production',
      position: 0,
      base_url: 'https://other.example.com',
      db_ref: `hub-db:${theirs}`
    })
    const p = await engine.planResourceChange(
      req('aws', [{ action: 'delete', resourceId: rds.id }]),
      ADMIN
    )
    expect(p.blockers.map((b) => b.code)).toContain('SHARED_IN_USE')
    await db('nivaro_hub_environments').where({ id: otherEnv }).del()
  })
})

// ── Promote ──

const component = (over: Partial<HubComponent>): HubComponent => ({
  id: 1,
  placement_id: 1,
  position: 1,
  name: 'web',
  kind: 'vercel',
  driver_id: 0,
  source_branch: 'main',
  target_branch: null,
  before_job: null,
  deploy_job: null,
  verify_url: null,
  verify_field: 'version',
  ...over
})

describe('promote through provider components', () => {
  it('gathers what each kind makes live, and what stops it', async () => {
    const project = await make('vercel', 'vercel.project', { name: 'web' }, null)
    const target = { id: production, key: 'production' } as never
    const facts = async (
      c: HubComponent,
      kind: 'promote' | 'rollback' = 'promote',
      prev: HubComponent[] = []
    ) =>
      (
        await promoteProviders.gatherProviderFacts({
          kind,
          target,
          components: [c],
          previousComponents: prev,
          recorded: () => null
        })
      )[c.position]
    // vercel: nothing adopted on production yet → blocked, then the adopted build is picked.
    const v = component({ kind: 'vercel', resource_id: project.id })
    expect((await facts(v)).problem).toMatch(/adopt the build/)
    const dpl = world.seed('vercel.deployment', 'dpl_9', { project: project.external_id })
    const row = await adopt('vercel', 'vercel.deployment', dpl, production)
    expect(await facts(v)).toMatchObject({ ref: String(row.id), problem: null })
    // rollback without a record → blocked
    expect((await facts(v, 'rollback')).problem).toMatch(/no record/)
    // github_actions: the branch
    world.seed('github.workflow', 'acme/shop#deploy.yml', { workflow: 'deploy.yml' })
    const wf = await adopt('github', 'github.workflow', 'acme/shop#deploy.yml', null)
    expect(
      await facts(
        component({ kind: 'github_actions', resource_id: wf.id, target_branch: 'release' })
      )
    ).toMatchObject({ ref: 'release', refLabel: 'branch release' })
    // eas_update: the branch the previous environment's channel points at (app-level branch).
    const branch = await make('expo', 'expo.branch', { name: 'rc' }, null)
    const prevChannel = await make('expo', 'expo.channel', {
      name: 'staging',
      branch: { resourceId: branch.id }
    })
    const prodChannel = await make('expo', 'expo.channel', { name: 'production' }, production)
    const eas = component({ kind: 'eas_update', name: 'app', resource_id: prodChannel.id })
    expect(
      await facts(eas, 'promote', [
        component({ kind: 'eas_update', name: 'app', resource_id: prevChannel.id })
      ])
    ).toMatchObject({ ref: String(branch.id), problem: null })
    expect((await facts(eas, 'promote', [])).problem).toMatch(/previous environment/)
    // A resource of another environment never serves this one.
    expect(
      (await facts(component({ kind: 'eas_update', resource_id: prevChannel.id }))).problem
    ).toMatch(/another environment/)
  })

  it('plans provider steps bound in the hash, blocks a step that cannot say what it makes live', () => {
    const input = {
      app: { id: appId, key: 'shop' },
      target: {
        id: production,
        key: 'production',
        hub_managed: true,
        base_url: 'https://shop.example.com'
      },
      previous: { id: staging, key: 'staging' },
      components: [
        component({
          kind: 'vercel',
          resource_id: 5,
          verify_url: 'https://shop.example.com/api/version'
        })
      ],
      kind: 'promote',
      version: '1.2.0',
      targetVersion: '1.1.0',
      previousVersion: '1.2.0',
      previousDeployedVersions: ['1.2.0'],
      targetDeployedVersions: ['1.1.0'],
      sources: {},
      frontendServed: {},
      frontendOnSource: {},
      sourceOnTarget: {},
      digest: null,
      slimDigest: null,
      running: false,
      targetState: 'ok',
      drivers: {},
      providers: {
        1: {
          connectionId: 3,
          resourceId: 5,
          ref: '77',
          refLabel: 'deployment dpl_9',
          problem: null
        }
      }
    } as unknown as PlanInput
    const plan = buildPromotionPlan(input)
    expect(plan.blockers).toEqual([])
    expect(plan.steps[0]).toMatchObject({
      driver: 'provider',
      want: '1.2.0',
      provider: { kind: 'vercel', connectionId: 3, resourceId: 5, ref: '77' }
    })
    expect(plan.lines.join('\n')).toMatch(/make live on Vercel deployment dpl_9/)
    const moved = buildPromotionPlan({
      ...input,
      providers: {
        1: {
          connectionId: 3,
          resourceId: 5,
          ref: '78',
          refLabel: 'deployment dpl_10',
          problem: null
        }
      }
    })
    expect(moved.plan_hash).not.toBe(plan.plan_hash)
    const blocked = buildPromotionPlan({
      ...input,
      providers: {
        1: { connectionId: null, resourceId: null, ref: null, refLabel: null, problem: 'web: nope' }
      }
    })
    expect(blocked.blockers).toEqual([{ code: 'PROVIDER_NOT_READY', text: 'web: nope' }])
  })

  it('runs a provider step through one carried change and records what it made live', async () => {
    const project = await make('vercel', 'vercel.project', { name: 'web' }, null)
    const dpl = world.seed('vercel.deployment', 'dpl_live', { project: project.external_id })
    const row = await adopt('vercel', 'vercel.deployment', dpl, production)
    const deployId = await insertId('nivaro_hub_deploys', {
      app_id: appId,
      environment_id: production,
      kind: 'promote',
      version: '1.2.0',
      status: 'running',
      started_by: ADMIN_ID
    })
    const step = promoteProviders.providerStepFor(
      component({ kind: 'vercel', resource_id: project.id }),
      {
        connectionId: conn.vercel,
        resourceId: project.id,
        ref: String(row.id),
        refLabel: 'deployment dpl_live',
        problem: null
      },
      '1.2.0'
    )
    const events: unknown[] = []
    const out = await promoteRun.executePlan(
      { ok: true, blockers: [], lines: [], steps: [step], plan_hash: 'h' },
      {
        deployId,
        version: '1.2.0',
        kind: 'promote',
        targetKey: 'production',
        gitCtx: async () => ({}) as never,
        envId: production
      },
      {
        onEvent: (e) => {
          events.push(e)
        },
        deps: { sleep: async () => undefined }
      }
    )
    expect(out).toMatchObject({ status: 'success' })
    expect(world.calls.at(-1)).toMatchObject({
      type: 'vercel.deployment',
      action: 'promote',
      ext: 'dpl_live'
    })
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'deployed', sha: String(row.id) })
    )
    const changes = await store.listChanges({})
    expect(changes.filter((c) => c.plan?.origin).map((c) => c.plan?.origin)).toEqual([
      { kind: 'promotion', deployId }
    ])
    // A dispatch of an app-level workflow is carried at app level by the same promotion.
    world.seed('github.workflow', 'acme/shop#deploy.yml', { workflow: 'deploy.yml' })
    const wf = await adopt('github', 'github.workflow', 'acme/shop#deploy.yml', null)
    const gh = promoteProviders.providerStepFor(
      component({ kind: 'github_actions', resource_id: wf.id, source_branch: 'main' }),
      {
        connectionId: conn.github,
        resourceId: wf.id,
        ref: 'main',
        refLabel: 'branch main',
        problem: null
      },
      '1.2.0'
    )
    const r = await promoteRun.providerStepRun(
      gh,
      {
        deployId,
        version: '1.2.0',
        kind: 'promote',
        targetKey: 'production',
        gitCtx: async () => ({}) as never
      },
      { signal: new AbortController().signal, log: () => undefined }
    )
    expect(r.changeId).toBeGreaterThan(0)
    expect(world.calls.at(-1)).toMatchObject({
      type: 'github.workflow',
      action: 'dispatch',
      data: { ref: 'main', inputs: JSON.stringify({ version: '1.2.0' }) }
    })
  })

  it('a provider component names a managed resource of its type and of the placement’s app', async () => {
    const placement = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: 0,
      target: '{}'
    })
    await db('nivaro_hub_environments')
      .where({ id: production })
      .update({ placement_id: placement })
    const project = await make('vercel', 'vercel.project', { name: 'web' }, null)
    expect(
      await promoteProviders.providerComponentProblem(placement, 'vercel', project.id)
    ).toBeNull()
    expect(
      await promoteProviders.providerComponentProblem(placement, 'eas_update', project.id)
    ).toMatch(/expo.channel/)
    expect(await promoteProviders.providerComponentProblem(placement, 'vercel', undefined)).toMatch(
      /resource_id/
    )
    const theirs = await make('vercel', 'vercel.project', { name: 'theirs' }, null)
    await db('nivaro_hub_resources').where({ id: theirs.id }).update({ app_id: otherApp })
    expect(await promoteProviders.providerComponentProblem(placement, 'vercel', theirs.id)).toMatch(
      /another app/
    )
    await db('nivaro_hub_environments').where({ id: production }).update({ placement_id: null })
  })
})
