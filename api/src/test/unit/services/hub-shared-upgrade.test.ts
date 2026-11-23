import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 5: the plan and the run of a Docker shared deployment's upgrade
// (services/hub/shared/upgrade-plan.ts, upgrade-run.ts), and the HUB_URL_PROBLEM warning on an
// environment's stack plan. Real SQLite with the hub tables (542–553); the agent, the registry,
// the deployment link, the sightings, the public names and the clock are fakes.

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
const activity = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (r: Record<string, unknown>) => {
    activity.rows.push(r)
    return null
  })
}))

// Final review I-2: a test can make the open-move check miss (a move that opened after the
// plan was gathered), to show the run's own verify still skips a name routed elsewhere.
const moveOpen = vi.hoisted(() => ({ miss: false }))
vi.mock('../../../services/hub/move-open.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/move-open.js')>()
  return {
    ...real,
    openMoveFor: async (...a: Parameters<typeof real.openMoveFor>) =>
      moveOpen.miss ? null : real.openMoveFor(...a)
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js')
]
const Store = await import('../../../services/hub/shared/store.js')
const Plan = await import('../../../services/hub/shared/upgrade-plan.js')
const Run = await import('../../../services/hub/shared/upgrade-run.js')
const { sharedLock, memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { AgentError } = await import('../../../services/hub/docker/agent-client.js')
const { sealSecret, openSecret } = await import('../../../services/hub/secrets.js')
const gather = await import('../../../services/hub/promote-gather.js')
const { buildPromotionPlan } = await import('../../../services/hub/promote-plan.js')

type AgentHealth = import('../../../services/hub/docker/agent-types.js').AgentHealth
type StackSpec = import('../../../services/hub/docker/agent-types.js').StackSpec
type Sighting = import('../../../services/hub/shared/sightings.js').Sighting

const HUB_KEY = 'e'.repeat(64)
const DIGEST = `sha256:${'a'.repeat(64)}`
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const START = Date.parse('2026-11-22T10:00:00Z')
/** A real extension pin, stored through the shared deployment's own validation. */
const EXT_PIN = `registry.example.com/acme/reports@sha256:${'5'.repeat(64)}`
const WITH_EXT = { extensions: ['reports'], extension_pins: { reports: EXT_PIN } }
const saved = {
  HUB: process.env.HUB,
  KEY: process.env.ENCRYPTION_KEY,
  HUB_URL: process.env.HUB_URL,
  NODE_ENV: process.env.NODE_ENV
}

let t = START
const now = () => t
let onSleep: (() => Promise<void> | void) | null = null
const sleep = vi.fn(async (ms: number) => {
  t += ms
  if (onSleep) await onSleep()
})

const locks = { shared: sharedLock(null), env: memoryPromoteLock }

/** A Redis that holds the key (SET NX misses) but cannot be read (round 2: holder fails closed). */
const downRedis = {
  set: async () => null,
  get: async () => {
    throw new Error('ECONNREFUSED')
  },
  del: async () => 0,
  exists: async () => {
    throw new Error('ECONNREFUSED')
  },
  eval: async () => 0
}

let seq = 0
async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

function health(over: Partial<AgentHealth> = {}): AgentHealth {
  return {
    api: 1,
    agent_version: '0.2.0',
    engine_api: '1.44',
    swarm: { manager: true, node_id: 'n1', nodes: 1 },
    images: ['nodeworks/nivaro', 'registry.example.com/acme/reports'],
    host_suffixes: ['.example.com'],
    edge: 'traefik',
    publish_ports: null,
    extensions_shared: false,
    redis_bundled: true,
    ...over
  }
}

let driverId = 0
async function newShared(
  o: Record<string, unknown> = {},
  input: Record<string, unknown> = {}
): Promise<number> {
  const key = `sh${++seq}`
  const v = Store.validateSharedInput({
    key,
    name: key,
    link_url: `https://${key}.internal.example.com`,
    mode: 'docker',
    driver_id: driverId,
    stack: key,
    host_pattern: '*.apps.example.com',
    extensions: [],
    ...input
  })
  if (!v.ok) throw new Error(v.code)
  const id = (await Store.createShared(v.row, null)).row.id
  await db('nivaro_hub_shared_deployments')
    .where({ id })
    .update({ version_pin: '0.3.209', status: 'active', ...o })
  return id
}

/** An app with environments; `placed` ones on the shared deployment. */
async function newApp(
  sharedId: number,
  envs: Array<{ key: string; placed: boolean; host?: string }>
): Promise<{ appId: number; appKey: string; envIds: number[] }> {
  const appKey = `app${++seq}`
  const appId = await insertId('nivaro_hub_apps', { key: appKey, name: appKey })
  const envIds: number[] = []
  let pos = 0
  for (const e of envs) {
    let placementId: number | null = null
    if (e.placed)
      placementId = await insertId('nivaro_hub_placements', {
        kind: 'shared',
        shared_deployment_id: sharedId,
        target: JSON.stringify({ pool_max: 5 })
      })
    envIds.push(
      await insertId('nivaro_hub_environments', {
        app_id: appId,
        key: e.key,
        position: ++pos,
        status: 'active',
        base_url: `https://${e.host ?? `${appKey}-${e.key}.apps.example.com`}`,
        hostnames: '[]',
        placement_id: placementId,
        version_pin: e.placed ? '0.3.209' : null
      })
    )
  }
  return { appId, appKey, envIds }
}

function planDeps(over: Record<string, unknown> = {}) {
  return {
    agentHealth: vi.fn(async () => health()),
    imageDigest: vi.fn(async () => DIGEST),
    client: () => ({
      appStatus: async (id: string) => ({
        id,
        version: '0.3.209',
        preflight: { status: 'ok', failing: [] as string[] },
        readiness_score: 100,
        busy: { imports: 0, exports: 0, renders: 0 },
        files: { count: 0, bytes: 0, local: 0 },
        key_fp: null,
        maintenance: false
      })
    }),
    sharedLock: locks.shared,
    envLock: locks.env,
    hubPublicUrl: () => 'https://hub.example.com',
    hubUrlWarning: () => null,
    ...over
  }
}

interface Fakes {
  applied: StackSpec[]
  sightings: Sighting[]
  schema: Record<string, { state: string; error: string | null }>
  served: Record<string, string>
  statusVersion: string
}

function runDeps(f: Fakes, over: Record<string, unknown> = {}) {
  const lines: string[] = []
  const out = { completed: null as string | null, failed: null as string | null }
  const deps = {
    ...planDeps(),
    agentApply: vi.fn(async (_d: unknown, _n: string, spec: StackSpec) => {
      f.applied.push(spec)
      return { spec_hash: 'f'.repeat(64), changed: [], unchanged: [] }
    }),
    agentStack: vi.fn(async () => ({
      name: 'x',
      owner: { shared: 'x' },
      environment: 'shared',
      spec_hash: 'f'.repeat(64),
      image: null,
      state: 'converged' as const,
      published_port: null,
      services: []
    })),
    liveSightings: vi.fn(async () => f.sightings),
    status: vi.fn(async () => ({
      version: f.statusVersion,
      instance: 'i1',
      registry: { count: 0, loaded_at: null, etag: null, stale: false, dropped: [] },
      apps: Object.entries(f.schema).map(([id, s]) => ({
        id,
        schema: { state: s.state as 'ok', version: f.statusVersion, error: s.error }
      })),
      extensions: [],
      oidc: null,
      process: {}
    })),
    readServedField: vi.fn(async (url: string) => ({
      value: f.served[url] ?? null,
      error: null
    })),
    sleep,
    now,
    startJobRun: vi.fn(async () => ({
      id: 91,
      progress: () => undefined,
      log: (l: string) => {
        lines.push(l)
      },
      complete: async (o?: string) => {
        out.completed = o ?? 'done'
      },
      fail: async (e: unknown) => {
        out.failed = (e as Error).message
      }
    })),
    renewMs: 3_600_000,
    ...over
  }
  return { deps, lines, out }
}

const fakes = (): Fakes => ({
  applied: [],
  sightings: [
    { instance: 'i1', version: '0.3.210', etag: null, at: new Date(START).toISOString() }
  ],
  schema: {},
  served: {},
  statusVersion: '0.3.210'
})

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  for (const m of migrations) await m.up(db)
  driverId = await insertId('nivaro_hub_drivers', {
    kind: 'docker',
    name: 'swarm',
    config: JSON.stringify({
      agent_url: 'https://agent.example.com',
      dns_mode: 'automatic',
      wildcard_domain: 'example.com',
      edge_target: null
    }),
    secret: sealSecret('agent-Token-Value-0123456789-abcdefghij')
  })
})

afterAll(async () => {
  for (const [k, v] of Object.entries({
    HUB: saved.HUB,
    ENCRYPTION_KEY: saved.KEY,
    HUB_URL: saved.HUB_URL,
    NODE_ENV: saved.NODE_ENV
  }))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  await db.destroy()
})

beforeEach(() => {
  t = START
  onSleep = null
  sleep.mockClear()
  activity.rows = []
})

async function refusal(
  p: Promise<unknown>
): Promise<{ code: string; statusCode: number; plan?: unknown }> {
  try {
    await p
  } catch (err) {
    return err as { code: string; statusCode: number }
  }
  throw new Error('expected a refusal')
}

const codes = (xs: { code: string }[]) => xs.map((x) => x.code)

// ── plan ───────────────────────────────────────────────────────────────────────────────────────

describe('planSharedUpgrade', () => {
  it('a clean plan: image pinned, apps listed, confirm = key, warnings name the apps', async () => {
    const id = await newShared()
    const a = await newApp(id, [{ key: 'production', placed: true }])
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(plan.blockers).toEqual([])
    expect(plan.image).toBe(`nodeworks/nivaro@${DIGEST}`)
    expect(plan.from_version).toBe('0.3.209')
    expect(plan.confirm).toBe((await Store.getShared(id))?.key)
    expect(plan.apps).toMatchObject([
      {
        env_id: a.envIds[0],
        tenant_id: Store.tenantIdFor({ key: a.appKey }, { id: a.envIds[0] }),
        blockers: []
      }
    ])
    expect(codes(plan.warnings)).toContain('APPS_AFFECTED')
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('each blocker fires on its input', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])

    const reg = await newShared({ mode: 'registered' })
    expect(
      codes((await Plan.planSharedUpgrade(reg, '0.3.210', 'upgrade', planDeps())).blockers)
    ).toContain('SHARED_NOT_HUB_DEPLOYED')

    const tok = await locks.shared.take(id, 'move')
    expect(
      codes((await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())).blockers)
    ).toContain('BUSY')
    await locks.shared.release(id, tok as string)

    const busyApp = await newApp(id, [{ key: 'staging', placed: true }])
    const etok = await locks.env.take(busyApp.envIds[0], 'move')
    const busy = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(busy.blockers.find((b) => b.code === 'BUSY')?.text).toMatch(/move/i)
    await locks.env.release(busyApp.envIds[0], etok as string)

    expect(
      codes(
        (
          await Plan.planSharedUpgrade(
            id,
            '0.3.210',
            'upgrade',
            planDeps({ imageDigest: async () => null })
          )
        ).blockers
      )
    ).toEqual(['VERSION_UNKNOWN'])

    expect(
      codes(
        (
          await Plan.planSharedUpgrade(
            id,
            '0.3.210',
            'upgrade',
            planDeps({
              agentHealth: async () => {
                throw new AgentError('AGENT_UNREACHABLE', 0, 'no answer')
              }
            })
          )
        ).blockers
      )
    ).toEqual(['AGENT_UNREACHABLE'])

    expect(
      codes(
        (
          await Plan.planSharedUpgrade(
            id,
            '0.3.210',
            'upgrade',
            planDeps({ agentHealth: async () => health({ agent_version: '0.1.0' }) })
          )
        ).blockers
      )
    ).toEqual(['AGENT_TOO_OLD'])

    expect(
      codes(
        (
          await Plan.planSharedUpgrade(
            id,
            '0.3.210',
            'upgrade',
            planDeps({ hubPublicUrl: () => 'http://hub.example' })
          )
        ).blockers
      )
    ).toEqual(['HUB_URL_UNUSABLE'])

    expect(
      codes((await Plan.planSharedUpgrade(id, '0.3.1', 'rollback', planDeps())).blockers)
    ).toEqual(['NOT_DEPLOYED_BEFORE'])
  })

  it('ORDER: the environment before this one never ran the version; a success row clears it', async () => {
    const id = await newShared()
    const a = await newApp(id, [
      { key: 'staging', placed: false },
      { key: 'production', placed: true }
    ])
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(plan.blockers).toEqual([])
    expect(plan.apps.find((x) => x.env_id === a.envIds[1])?.blockers).toEqual(['ORDER'])
    // Upgrading to the version it already runs is a re-apply: no per-app checks.
    const same = await Plan.planSharedUpgrade(id, '0.3.209', 'upgrade', planDeps())
    expect(same.apps.every((x) => x.blockers.length === 0)).toBe(true)

    await db('nivaro_hub_deploys').insert({
      app_id: a.appId,
      environment_id: a.envIds[0],
      kind: 'promote',
      version: '0.3.210',
      status: 'success'
    })
    const after = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(after.apps.find((x) => x.env_id === a.envIds[1])?.blockers).toEqual([])
    expect(after.plan_hash).not.toBe(plan.plan_hash)
  })

  it('a previous environment on the same deployment is upgraded with it: no ORDER', async () => {
    const id = await newShared()
    await newApp(id, [
      { key: 'staging', placed: true },
      { key: 'production', placed: true }
    ])
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(plan.apps.flatMap((x) => x.blockers)).toEqual([])
  })

  it('PREFLIGHT_FAILING when the app’s preflight fails on the deployment (R17)', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const plan = await Plan.planSharedUpgrade(
      id,
      '0.3.210',
      'upgrade',
      planDeps({
        client: () => ({
          appStatus: async () => ({ preflight: { status: 'fail', failing: ['db-reachable'] } })
        })
      })
    )
    expect(plan.apps[0].blockers).toEqual(['PREFLIGHT_FAILING'])
    expect(plan.apps[0].notes[0]).toContain('db-reachable')
  })

  it('a shared lock whose holder cannot be read → blocker LOCK_UNAVAILABLE, never free', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const plan = await Plan.planSharedUpgrade(
      id,
      '0.3.210',
      'upgrade',
      planDeps({ sharedLock: sharedLock(downRedis) })
    )
    expect(codes(plan.blockers)).toContain('LOCK_UNAVAILABLE')
  })

  it('a rollback never reads the current version’s preflight (review minor 5)', async () => {
    const id = await newShared({ version_pin: '0.3.210' })
    await newApp(id, [{ key: 'production', placed: true }])
    await db('nivaro_hub_shared_deploys').insert({
      shared_deployment_id: id,
      kind: 'upgrade',
      version: '0.3.209',
      status: 'success',
      plan: JSON.stringify({ image: `nodeworks/nivaro@${DIGEST}`, extensions: {} })
    })
    const appStatus = vi.fn(async () => ({ preflight: { status: 'fail', failing: ['db'] } }))
    const plan = await Plan.planSharedUpgrade(
      id,
      '0.3.209',
      'rollback',
      planDeps({ client: () => ({ appStatus }) })
    )
    expect(plan.blockers).toEqual([])
    expect(plan.apps[0].blockers).toEqual([])
    expect(appStatus).not.toHaveBeenCalled()
  })

  it('plan_hash changes when an app is added', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const one = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    await newApp(id, [{ key: 'production', placed: true }])
    const two = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(two.apps).toHaveLength(2)
    expect(two.plan_hash).not.toBe(one.plan_hash)
  })

  it('warns HUB_URL_PROBLEM and MULTI_NODE_VOLUMES', async () => {
    const id = await newShared()
    const plan = await Plan.planSharedUpgrade(
      id,
      '0.3.210',
      'upgrade',
      planDeps({
        hubUrlWarning: () => 'HUB_URL is ignored. it must be https',
        agentHealth: async () =>
          health({ swarm: { manager: true, node_id: 'n1', nodes: 3 }, volume_driver: 'local' })
      })
    )
    expect(codes(plan.warnings).sort()).toEqual(['HUB_URL_PROBLEM', 'MULTI_NODE_VOLUMES'])
  })
})

describe('external Redis (ruling P6-16)', () => {
  it('REDIS_URL_MISSING until the PATCH secret is written; then the run sends it as a secret', async () => {
    const id = await newShared({ settings: JSON.stringify({ redis: 'external' }) })
    expect(
      codes((await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())).blockers)
    ).toEqual(['REDIS_URL_MISSING'])
    const url = 'rediss://:Pw-0123456789@redis.internal.example.com:6380/1'
    await Run.setSharedSecrets(id, { REDIS_URL: url })
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(plan.blockers).toEqual([])
    expect(JSON.stringify(plan)).not.toContain('Pw-0123456789')
    const f = fakes()
    const { deps } = runDeps(f)
    const key = (await Store.getShared(id))?.key as string
    const out = await Run.startSharedUpgrade(
      id,
      { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key },
      'admin-1',
      deps
    )
    await Run.awaitSharedUpgrade(out.shared_deploy_id)
    expect(f.applied[0].redis).toBe('external')
    expect(f.applied[0].secrets.REDIS_URL).toBe(url)
    // The run's own secrets were added beside it, not over it.
    expect(Object.keys(await Plan.readSharedSecrets(id)).sort()).toEqual([
      'ENCRYPTION_KEY',
      'REDIS_URL',
      'SESSION_SECRET'
    ])
  })
})

describe('extension pins (ruling P6-16, review I-1)', () => {
  it('a pin stored through PATCH validation plans clean and is what the run installs', async () => {
    const id = await newShared({}, WITH_EXT)
    expect((await Store.getShared(id))?.extension_pins).toEqual({ reports: EXT_PIN })
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(plan.blockers).toEqual([])
    const f = fakes()
    const { deps } = runDeps(f)
    const key = (await Store.getShared(id))?.key as string
    const out = await Run.startSharedUpgrade(
      id,
      { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key },
      'admin-1',
      deps
    )
    await Run.awaitSharedUpgrade(out.shared_deploy_id)
    expect((await Run.readSharedDeploy(out.shared_deploy_id))?.status).toBe('success')
    expect(f.applied[0].extensions).toEqual({ reports: EXT_PIN })
    expect(f.applied[0].env.HUB_SHARED_EXTENSIONS).toBe('reports')
  })

  it('a bad pin still refuses: PATCH validation, and EXTENSION_UNPINNED for a row holding one', async () => {
    const v = Store.validateSharedInput({
      key: 'pins-bad',
      name: 'x',
      link_url: 'https://pins-bad.internal.example.com',
      extensions: ['reports'],
      extension_pins: { reports: '1.2.3' }
    })
    expect(v.ok ? 'ok' : v.code).toBe('BAD_EXTENSIONS')
    // A row written before the rule (or by hand) with a version string is never deployed.
    const id = await newShared({
      extensions: JSON.stringify(['reports']),
      extension_pins: JSON.stringify({ reports: '1.2.3' })
    })
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(codes(plan.blockers)).toEqual(['EXTENSION_UNPINNED'])
  })
})

// ── run ────────────────────────────────────────────────────────────────────────────────────────

async function start(
  id: number,
  deps: ReturnType<typeof runDeps>['deps'],
  over: Record<string, unknown> = {}
) {
  const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
  const key = (await Store.getShared(id))?.key as string
  const out = await Run.startSharedUpgrade(
    id,
    { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key, ...over },
    'admin-1',
    deps
  )
  await Run.awaitSharedUpgrade(out.shared_deploy_id)
  return { plan, out, row: await Run.readSharedDeploy(out.shared_deploy_id) }
}

describe('startSharedUpgrade — the run', () => {
  it('happy path: apply, replicas, schema, verify; every env pinned with a shared deploy row', async () => {
    const id = await newShared()
    const a = await newApp(id, [{ key: 'staging', placed: true }])
    const b = await newApp(id, [{ key: 'production', placed: true, host: 'crm.example.com' }])
    const f = fakes()
    const ta = Store.tenantIdFor({ key: a.appKey }, { id: a.envIds[0] })
    const tb = Store.tenantIdFor({ key: b.appKey }, { id: b.envIds[0] })
    f.schema = { [ta]: { state: 'ok', error: null }, [tb]: { state: 'ok', error: null } }
    f.served = {
      [`https://${a.appKey}-staging.apps.example.com/api/version`]: '0.3.210',
      'https://crm.example.com/api/version': '0.3.210'
    }
    const { deps, out } = runDeps(f)
    const { row } = await start(id, deps)

    expect(out.failed).toBeNull()
    expect(row?.status).toBe('success')
    const shared = await Store.getShared(id)
    expect(shared?.version_pin).toBe('0.3.210')
    expect(shared?.status).toBe('active')
    for (const envId of [a.envIds[0], b.envIds[0]]) {
      expect((await db('nivaro_hub_environments').where({ id: envId }).first()).version_pin).toBe(
        '0.3.210'
      )
      const d = await db('nivaro_hub_deploys')
        .where({ environment_id: envId, kind: 'shared' })
        .first()
      expect(d).toMatchObject({ status: 'success', version: '0.3.210', shared_deploy_id: row?.id })
    }
    // What the agent got: a shared owner, the token only as a secret, the explicit name routed.
    expect(f.applied).toHaveLength(1)
    const spec = f.applied[0]
    expect(spec.owner).toEqual({ shared: shared?.key })
    expect(spec.secrets.HUB_DEPLOYMENT_TOKEN).toMatch(TOKEN_RE)
    expect(spec.env.HUB_DEPLOYMENT_TOKEN).toBeUndefined()
    expect(spec.hostnames).toEqual(['crm.example.com'])
    expect(spec.host_pattern).toBe('*.apps.example.com')
    // The deployment's secrets were made once and kept sealed; the stored plan never holds them.
    const sealed = (await db('nivaro_hub_shared_deployments').where({ id }).first()).secrets
    const opened = JSON.parse(openSecret(sealed) as string)
    expect(opened.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(spec.secrets.SESSION_SECRET).toBe(opened.SESSION_SECRET)
    const stored = (await db('nivaro_hub_shared_deploys').where({ id: row?.id }).first()).plan
    expect(stored).not.toContain(opened.ENCRYPTION_KEY)
    expect(stored).not.toContain(spec.secrets.HUB_DEPLOYMENT_TOKEN)
    // A second run reuses the same deployment secrets.
    const again = await Run.ensureSharedSecrets(id)
    expect(again.SESSION_SECRET).toBe(opened.SESSION_SECRET)
  })

  it('wait_version leaves only once swarm converged, not just when sightings agree (review minor 6)', async () => {
    const id = await newShared()
    const f = fakes()
    const states = ['updating', 'updating', 'converged']
    const order: string[] = []
    const { deps } = runDeps(f)
    deps.agentStack = vi.fn(async () => {
      const state = states.shift() ?? 'converged'
      order.push(`stack:${state}`)
      return {
        name: 'x',
        owner: { shared: 'x' },
        environment: 'shared',
        spec_hash: 'f'.repeat(64),
        image: null,
        state: state as 'converged',
        published_port: null,
        services: []
      }
    }) as never
    const status = deps.status as unknown as (s: unknown) => Promise<unknown>
    deps.status = vi.fn(async (s: unknown) => {
      order.push('status')
      return status(s)
    }) as never
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
    const key = (await Store.getShared(id))?.key as string
    const out = await Run.startSharedUpgrade(
      id,
      { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key },
      'admin-1',
      deps
    )
    await Run.awaitSharedUpgrade(out.shared_deploy_id)
    expect((await Run.readSharedDeploy(out.shared_deploy_id))?.status).toBe('success')
    expect(order.slice(0, 4)).toEqual([
      'stack:updating',
      'stack:updating',
      'stack:converged',
      'status'
    ])
  })

  it('a rollback redeploys the image and pins its recorded run used, not the registry’s (review minor 8)', async () => {
    const OLD_IMAGE = `nodeworks/nivaro@sha256:${'7'.repeat(64)}`
    const OLD_PIN = `registry.example.com/acme/reports@sha256:${'8'.repeat(64)}`
    const id = await newShared({ version_pin: '0.3.210' }, WITH_EXT)
    const a = await newApp(id, [{ key: 'production', placed: true }])
    await db('nivaro_hub_shared_deploys').insert({
      shared_deployment_id: id,
      kind: 'upgrade',
      version: '0.3.209',
      status: 'success',
      plan: JSON.stringify({ image: OLD_IMAGE, extensions: { reports: OLD_PIN } })
    })
    const f = fakes()
    const tenant = Store.tenantIdFor({ key: a.appKey }, { id: a.envIds[0] })
    f.sightings = [
      { instance: 'i1', version: '0.3.209', etag: null, at: new Date(START).toISOString() }
    ]
    f.statusVersion = '0.3.209'
    f.schema = { [tenant]: { state: 'ok', error: null } }
    f.served = { [`https://${a.appKey}-production.apps.example.com/api/version`]: '0.3.209' }
    const { deps } = runDeps(f)
    const plan = await Plan.planSharedUpgrade(id, '0.3.209', 'rollback', deps)
    expect(plan.blockers).toEqual([])
    expect(plan.image).toBe(OLD_IMAGE)
    expect(deps.imageDigest).not.toHaveBeenCalled()
    const key = (await Store.getShared(id))?.key as string
    const out = await Run.startSharedUpgrade(
      id,
      { version: '0.3.209', kind: 'rollback', plan_hash: plan.plan_hash, confirm: key },
      'admin-1',
      deps
    )
    await Run.awaitSharedUpgrade(out.shared_deploy_id)
    const row = await Run.readSharedDeploy(out.shared_deploy_id)
    expect(row).toMatchObject({
      status: 'success',
      kind: 'rollback',
      version: '0.3.209',
      from_version: '0.3.210'
    })
    expect(f.applied[0].image).toBe(OLD_IMAGE)
    expect(f.applied[0].extensions).toEqual({ reports: OLD_PIN })
    expect((await Store.getShared(id))?.version_pin).toBe('0.3.209')
    expect(
      (await db('nivaro_hub_environments').where({ id: a.envIds[0] }).first()).version_pin
    ).toBe('0.3.209')
  })

  it('a start that breaks after its rows were written leaves nothing running (review minor 7)', async () => {
    const id = await newShared()
    const a = await newApp(id, [{ key: 'production', placed: true }])
    const { deps } = runDeps(fakes())
    deps.startJobRun = vi.fn(async () => {
      throw new Error('job runs table is gone')
    }) as never
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
    const key = (await Store.getShared(id))?.key as string
    await expect(
      Run.startSharedUpgrade(
        id,
        { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key },
        'admin-1',
        deps
      )
    ).rejects.toThrow()
    const row = await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: id }).first()
    expect(row.status).toBe('failed')
    expect(
      (
        await db('nivaro_hub_deploys')
          .where({ environment_id: a.envIds[0], kind: 'shared' })
          .first()
      ).status
    ).toBe('failed')
    expect((await Store.getShared(id))?.status).toBe('active')
    expect(await locks.shared.holder(id)).toBeNull()
    expect(await locks.env.held(a.envIds[0])).toBe(false)
  })

  it('one app’s schema failed: run failed naming that tenant, pins unchanged, others ok', async () => {
    const id = await newShared()
    const a = await newApp(id, [{ key: 'production', placed: true }])
    const b = await newApp(id, [{ key: 'production', placed: true }])
    const f = fakes()
    const ta = Store.tenantIdFor({ key: a.appKey }, { id: a.envIds[0] })
    const tb = Store.tenantIdFor({ key: b.appKey }, { id: b.envIds[0] })
    f.schema = {
      [ta]: { state: 'ok', error: null },
      [tb]: { state: 'failed', error: 'migration 552 failed: relation exists' }
    }
    const { deps, out } = runDeps(f)
    const { row } = await start(id, deps)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain(tb)
    expect(row?.error).not.toContain(ta)
    expect(out.failed).toContain('SCHEMA_FAILED')
    expect((await Store.getShared(id))?.version_pin).toBe('0.3.209')
    expect((await Store.getShared(id))?.status).toBe('active')
    for (const envId of [a.envIds[0], b.envIds[0]]) {
      expect((await db('nivaro_hub_environments').where({ id: envId }).first()).version_pin).toBe(
        '0.3.209'
      )
      expect(
        (await db('nivaro_hub_deploys').where({ environment_id: envId, kind: 'shared' }).first())
          .status
      ).toBe('failed')
    }
    // The other app's schema is still ok on the deployment: the run never touched it.
    expect(f.schema[ta].state).toBe('ok')
  })

  it('cancel during "wait version" → cancelled, pins unchanged', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const f = fakes()
    f.sightings = [
      { instance: 'i1', version: '0.3.209', etag: null, at: new Date(START).toISOString() }
    ]
    const { deps, out } = runDeps(f)
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
    const key = (await Store.getShared(id))?.key as string
    let cancelled = false
    onSleep = async () => {
      if (cancelled) return
      cancelled = true
      const running = await db('nivaro_hub_shared_deploys')
        .where({ shared_deployment_id: id, status: 'running' })
        .first('id', 'step')
      expect(running.step).toBe('wait_version')
      await Run.cancelSharedUpgrade(Number(running.id), 'admin-2', deps)
    }
    const { shared_deploy_id } = await Run.startSharedUpgrade(
      id,
      { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key },
      'admin-1',
      deps
    )
    await Run.awaitSharedUpgrade(shared_deploy_id)
    const row = await Run.readSharedDeploy(shared_deploy_id)
    expect(row?.status).toBe('cancelled')
    expect(out.completed).toMatch(/Cancelled/)
    expect((await Store.getShared(id))?.version_pin).toBe('0.3.209')
    expect(row?.apps.every((x) => x.status === 'cancelled')).toBe(true)
    // The locks are free again.
    expect(await locks.shared.holder(id)).toBeNull()
  })

  it('a shared lock holder read that fails → start refuses LOCK_UNAVAILABLE (503)', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const { deps } = runDeps(fakes(), { sharedLock: sharedLock(downRedis) })
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
    const key = (await Store.getShared(id))?.key as string
    let err: unknown = null
    try {
      await Run.startSharedUpgrade(
        id,
        { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key },
        'admin-1',
        deps
      )
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'LOCK_UNAVAILABLE', statusCode: 503 })
  })

  it('refuses a stale plan (PLAN_CHANGED with the new plan) and a wrong confirm', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const { deps } = runDeps(fakes())
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
    const key = (await Store.getShared(id))?.key as string
    const bad = await refusal(
      Run.startSharedUpgrade(
        id,
        { version: '0.3.210', plan_hash: plan.plan_hash, confirm: 'nope' },
        'a',
        deps
      )
    )
    expect(bad).toMatchObject({ code: 'CONFIRM_MISMATCH', statusCode: 400 })
    await newApp(id, [{ key: 'production', placed: true }])
    const changed = await refusal(
      Run.startSharedUpgrade(
        id,
        { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key },
        'a',
        deps
      )
    )
    expect(changed).toMatchObject({ code: 'PLAN_CHANGED', statusCode: 409 })
    expect((changed.plan as { apps: unknown[] }).apps).toHaveLength(2)
    expect(await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: id })).toEqual([])
  })

  it('the ORDER blocker clears with an override, and the override is recorded', async () => {
    const id = await newShared()
    const a = await newApp(id, [
      { key: 'staging', placed: false },
      { key: 'production', placed: true }
    ])
    const f = fakes()
    f.schema = {
      [Store.tenantIdFor({ key: a.appKey }, { id: a.envIds[1] })]: { state: 'ok', error: null }
    }
    f.served = { [`https://${a.appKey}-production.apps.example.com/api/version`]: '0.3.210' }
    const { deps, lines } = runDeps(f)
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
    const key = (await Store.getShared(id))?.key as string
    const blocked = await refusal(
      Run.startSharedUpgrade(
        id,
        { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key },
        'a',
        deps
      )
    )
    expect(blocked.code).toBe('APP_BLOCKED')
    const o = `ORDER:${a.envIds[1]}`
    const { row } = await start(id, deps, { overrides: [o] })
    expect(row?.status).toBe('success')
    expect(row?.overrides).toEqual([o])
    expect(lines.some((l) => l.includes(o))).toBe(true)
    expect(
      activity.rows.some((r) => r.action === 'hub-shared-override' && String(r.comment).includes(o))
    ).toBe(true)
  })

  it('no re-apply after a failed or interrupted run: it would quietly roll back (review minor 4)', async () => {
    // Runs that reached apply (spec_hash recorded); one that never did is the N-2 test below.
    const applied = JSON.stringify({ spec_hash: 'f'.repeat(64) })
    for (const [last, plan] of [
      ['failed', applied],
      ['interrupted', applied],
      ['cancelled', applied]
    ]) {
      const id = await newShared()
      await db('nivaro_hub_shared_deploys').insert({
        shared_deployment_id: id,
        kind: 'upgrade',
        version: '0.3.210',
        from_version: '0.3.209',
        status: last,
        plan
      })
      const { deps } = runDeps(fakes())
      const shared = await Store.getShared(id)
      expect(await Run.startSharedReapply(shared as NonNullable<typeof shared>, 'a', deps)).toEqual(
        {
          started: false,
          reason: 'LAST_RUN_FAILED'
        }
      )
      expect(
        await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: id })
      ).toHaveLength(1)
    }
  })

  it('the token rotation re-apply runs the same version with the new token', async () => {
    const id = await newShared()
    const f = fakes()
    f.sightings = [
      { instance: 'i1', version: '0.3.209', etag: null, at: new Date(START).toISOString() }
    ]
    f.statusVersion = '0.3.209'
    const { deps } = runDeps(f)
    const { token } = await Store.rotateSharedToken(id)
    const shared = await Store.getShared(id)
    const r = await Run.startSharedReapply(shared as NonNullable<typeof shared>, 'admin-1', deps)
    expect(r.started).toBe(true)
    await Run.awaitSharedUpgrade(r.shared_deploy_id as number)
    expect(f.applied[0].secrets.HUB_DEPLOYMENT_TOKEN).toBe(token)
    expect((await Run.readSharedDeploy(r.shared_deploy_id as number))?.status).toBe('success')
    const reg = await Store.getShared(await newShared({ mode: 'registered' }))
    expect(await Run.startSharedReapply(reg as NonNullable<typeof reg>, 'a', deps)).toEqual({
      started: false,
      reason: 'SHARED_NOT_HUB_DEPLOYED'
    })
  })
})

// ── heal ───────────────────────────────────────────────────────────────────────────────────────

describe('healSharedDeploys', () => {
  it('a stale heartbeat on restart → interrupted; place-run rows (no shared_deploy_id) untouched', async () => {
    const id = await newShared({ status: 'upgrading' })
    const a = await newApp(id, [{ key: 'production', placed: true }])
    const old = new Date(START - 10 * 60_000)
    const sdId = await insertId('nivaro_hub_shared_deploys', {
      shared_deployment_id: id,
      kind: 'upgrade',
      version: '0.3.210',
      from_version: '0.3.209',
      status: 'running',
      step: 'wait_version',
      plan: JSON.stringify({ prior_status: 'active' }),
      started_at: old,
      heartbeat_at: old
    })
    const mirror = await insertId('nivaro_hub_deploys', {
      app_id: a.appId,
      environment_id: a.envIds[0],
      kind: 'shared',
      version: '0.3.210',
      status: 'running',
      shared_deploy_id: sdId,
      heartbeat_at: old
    })
    // A place-shared run's own row (Task 4): kind shared, no shared_deploy_id — place.ts heals it.
    const placeRow = await insertId('nivaro_hub_deploys', {
      app_id: a.appId,
      environment_id: a.envIds[0],
      kind: 'shared',
      version: '0.3.209',
      status: 'running',
      heartbeat_at: old
    })
    // A fresh one is left alone.
    const fresh = await insertId('nivaro_hub_shared_deploys', {
      shared_deployment_id: await newShared(),
      kind: 'upgrade',
      version: '0.3.210',
      status: 'running',
      heartbeat_at: new Date(START - 30_000)
    })

    const n = await Run.healSharedDeploys({
      sharedId: undefined,
      deps: { now, sharedLock: locks.shared }
    })
    expect(n).toBe(1)
    expect((await db('nivaro_hub_shared_deploys').where({ id: sdId }).first()).status).toBe(
      'interrupted'
    )
    expect((await db('nivaro_hub_deploys').where({ id: mirror }).first()).status).toBe(
      'interrupted'
    )
    expect((await db('nivaro_hub_deploys').where({ id: placeRow }).first()).status).toBe('running')
    expect((await db('nivaro_hub_shared_deploys').where({ id: fresh }).first()).status).toBe(
      'running'
    )
    expect((await Store.getShared(id))?.status).toBe('active')
  })

  it('a shared lock that cannot be read keeps the row (never healed as if free)', async () => {
    const id = await newShared({ status: 'upgrading' })
    const sdId = await insertId('nivaro_hub_shared_deploys', {
      shared_deployment_id: id,
      kind: 'upgrade',
      version: '0.3.210',
      status: 'running',
      heartbeat_at: new Date(START - 10 * 60_000)
    })
    expect(
      await Run.healSharedDeploys({
        sharedId: id,
        deps: { now, sharedLock: sharedLock(downRedis) }
      })
    ).toBe(0)
    expect((await db('nivaro_hub_shared_deploys').where({ id: sdId }).first()).status).toBe(
      'running'
    )
  })

  it('a held shared lock keeps the row (its runner may be alive in another process)', async () => {
    const id = await newShared({ status: 'upgrading' })
    const sdId = await insertId('nivaro_hub_shared_deploys', {
      shared_deployment_id: id,
      kind: 'upgrade',
      version: '0.3.210',
      status: 'running',
      heartbeat_at: new Date(START - 10 * 60_000)
    })
    const tok = await locks.shared.take(id, 'shared')
    expect(
      await Run.healSharedDeploys({ sharedId: id, deps: { now, sharedLock: locks.shared } })
    ).toBe(0)
    expect((await db('nivaro_hub_shared_deploys').where({ id: sdId }).first()).status).toBe(
      'running'
    )
    await locks.shared.release(id, tok as string)
  })
})

// ── HUB_URL_PROBLEM on an environment's stack plan (X-7) ───────────────────────────────────────

describe('env stack plan: HUB_URL_PROBLEM', () => {
  it('HUB_URL=http://hub.example in production → the stack plan warns HUB_URL_PROBLEM', async () => {
    const appId = await insertId('nivaro_hub_apps', { key: `dedi${++seq}`, name: 'Dedicated' })
    const placementId = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: driverId,
      target: JSON.stringify({ stack: `dedi-${seq}` })
    })
    const envId = await insertId('nivaro_hub_environments', {
      app_id: appId,
      key: 'production',
      position: 1,
      status: 'active',
      base_url: `https://dedi${seq}.apps.example.com`,
      hostnames: '[]',
      placement_id: placementId,
      hub_managed: true
    })
    const noGitlab = () => {
      throw new Error('no GitLab here')
    }
    const deps = {
      readStatus: async () => ({
        state: 'ok' as const,
        version: null,
        preflight: null,
        checked_at: '2026-11-22T00:00:00.000Z',
        source: 'public' as const
      }),
      imageDigest: async () => DIGEST,
      ctxFor: noGitlab,
      latestCommitMatching: noGitlab,
      commitExistsOn: noGitlab,
      readFile: noGitlab,
      findPipeline: noGitlab,
      jobNamed: noGitlab,
      resolveCommit: noGitlab,
      readServedField: noGitlab,
      gitlabDeployedVersions: async () => [],
      isLocked: async () => false,
      stack: {
        agentHealth: async () => health(),
        agentStack: async () => null
      },
      listImageVersions: async () => ({ versions: ['0.3.210'], error: null })
    } as unknown as import('../../../services/hub/promote-gather.js').GatherDeps
    process.env.HUB_URL = 'http://hub.example'
    process.env.NODE_ENV = 'production'
    try {
      const input = await gather.gatherPlanInput(
        envId,
        { kind: 'promote', version: '0.3.210' },
        deps
      )
      const f = Object.values(input.stacks ?? {})[0]
      expect(f?.warnings?.map((w) => w.code)).toEqual(['HUB_URL_PROBLEM'])
      const plan = buildPromotionPlan(input)
      expect(plan.warnings?.map((w) => w.code)).toEqual(['HUB_URL_PROBLEM'])
      expect(plan.lines.some((l) => l.startsWith('warning HUB_URL_PROBLEM'))).toBe(true)
    } finally {
      process.env.HUB_URL = saved.HUB_URL ?? ''
      if (saved.HUB_URL === undefined) delete process.env.HUB_URL
      process.env.NODE_ENV = saved.NODE_ENV ?? 'test'
    }
    // Without a problem the facts carry no warnings key at all (older plans stay byte-equal).
    const input = await gather.gatherPlanInput(envId, { kind: 'promote', version: '0.3.210' }, deps)
    expect(Object.values(input.stacks ?? {})[0]?.warnings).toBeUndefined()
  })
})

// ── parked wave (Task 5 round 2 N-2..N-5) ──────────────────────────────────────────────────────

describe('re-apply after a run that never reached apply (N-2)', () => {
  it('a failed / interrupted run with no spec_hash does not block; one that applied still does', async () => {
    for (const [status, error] of [
      ['failed', 'START_FAILED: the run could not be started; nothing was applied.'],
      ['failed', 'AGENT_UNREACHABLE: The Hub agent does not answer.'],
      ['interrupted', 'LOCK_LOST: The run lost its lock; plan again.'],
      ['cancelled', 'CANCELLED: Cancelled.']
    ]) {
      const id = await newShared()
      await db('nivaro_hub_shared_deploys').insert({
        shared_deployment_id: id,
        kind: 'upgrade',
        version: '0.3.210',
        from_version: '0.3.209',
        status,
        error,
        plan: JSON.stringify({ plan: { version: '0.3.210' } })
      })
      const f = fakes()
      f.sightings = [
        { instance: 'i1', version: '0.3.209', etag: null, at: new Date(START).toISOString() }
      ]
      f.statusVersion = '0.3.209'
      const { deps } = runDeps(f)
      const shared = await Store.getShared(id)
      const r = await Run.startSharedReapply(shared as NonNullable<typeof shared>, 'a', deps)
      expect(r, `${status} ${error}`).toMatchObject({ started: true })
      await Run.awaitSharedUpgrade(r.shared_deploy_id as number)
    }
    // An older run that applied and failed, then a newer one that never applied: still refused
    // (the stack may run the older run's version).
    const id = await newShared()
    for (const plan of [JSON.stringify({ spec_hash: 'f'.repeat(64) }), null])
      await db('nivaro_hub_shared_deploys').insert({
        shared_deployment_id: id,
        kind: 'upgrade',
        version: '0.3.210',
        from_version: '0.3.209',
        status: 'failed',
        plan
      })
    const { deps } = runDeps(fakes())
    const shared = await Store.getShared(id)
    expect(await Run.startSharedReapply(shared as NonNullable<typeof shared>, 'a', deps)).toEqual({
      started: false,
      reason: 'LAST_RUN_FAILED'
    })
  })
})

describe('REDIS_URL stored, not applied (N-3)', () => {
  it('marked from the PATCH until a run that rendered that URL succeeds; never the value', async () => {
    const id = await newShared({ settings: JSON.stringify({ redis: 'external' }) })
    expect(await Run.redisUrlNotApplied(id)).toBe(false)
    const url1 = 'rediss://:Pw-One-0123456789@redis.internal.example.com:6380/1'
    await Run.setSharedSecrets(id, { REDIS_URL: url1 })
    expect(await Run.redisUrlNotApplied(id)).toBe(true)
    // A run that rendered it but failed (swarm rolled back) does not clear the mark.
    const failing = runDeps(fakes())
    failing.deps.agentStack = vi.fn(async () => ({
      name: 'x',
      owner: { shared: 'x' },
      environment: 'shared',
      spec_hash: 'f'.repeat(64),
      image: null,
      state: 'rolled_back' as const,
      published_port: null,
      services: []
    })) as never
    expect((await start(id, failing.deps)).row?.status).toBe('failed')
    expect(await Run.redisUrlNotApplied(id)).toBe(true)
    // A successful run clears it; the stored plan holds no URL.
    await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: id }).del()
    const { row } = await start(id, runDeps(fakes()).deps)
    expect(row?.status).toBe('success')
    expect(await Run.redisUrlNotApplied(id)).toBe(false)
    const stored = (await db('nivaro_hub_shared_deploys').where({ id: row?.id }).first()).plan
    expect(stored).not.toContain('Pw-One')
    // A new URL is pending again until the next successful apply.
    await Run.setSharedSecrets(id, { REDIS_URL: url1.replace('One', 'Two') })
    expect(await Run.redisUrlNotApplied(id)).toBe(true)
  })
})

describe('a stack stuck degraded (N-4)', () => {
  const stackAt = (state: string) => ({
    name: 'x',
    owner: { shared: 'x' },
    environment: 'shared',
    spec_hash: 'f'.repeat(64),
    image: null,
    state: state as 'degraded',
    published_port: null,
    services: []
  })

  it('fails after a few minutes of steady degraded, naming degraded, not after 30 minutes', async () => {
    const id = await newShared()
    const { deps, out } = runDeps(fakes())
    deps.agentStack = vi.fn(async () => stackAt('degraded')) as never
    const { row } = await start(id, deps)
    expect(row?.status).toBe('failed')
    expect(row?.error).toMatch(/^SWARM_DEGRADED: /)
    expect(row?.error).toMatch(/degraded/)
    expect(out.failed).toMatch(/SWARM_DEGRADED/)
    expect(t - START).toBeLessThan(10 * 60_000)
    expect((await Store.getShared(id))?.version_pin).toBe('0.3.209')
  })

  it('a short degraded spell that converges still succeeds', async () => {
    const id = await newShared()
    const { deps } = runDeps(fakes())
    const states = ['degraded', 'degraded', 'updating', 'degraded', 'converged']
    deps.agentStack = vi.fn(async () => stackAt(states.shift() ?? 'converged')) as never
    expect((await start(id, deps)).row?.status).toBe('success')
  })

  it('degraded spells broken by updating never fail early: the version wait decides', async () => {
    const id = await newShared()
    const f = fakes()
    // Never seen on the version: the run waits out the version timeout.
    f.sightings = [
      { instance: 'i1', version: '0.3.209', etag: null, at: new Date(START).toISOString() }
    ]
    const { deps } = runDeps(f)
    let n = 0
    // degraded, then updating, alternating: never steady long enough to fail early.
    deps.agentStack = vi.fn(async () => stackAt(n++ % 2 ? 'updating' : 'degraded')) as never
    const { row } = await start(id, deps)
    expect(row?.error).toMatch(/^VERSION_TIMEOUT: /)
  })
})

describe('a start whose job run began but could not be linked (N-5)', () => {
  it('fails the job run too, not only the deploy rows', async () => {
    const id = await newShared()
    const { deps, out } = runDeps(fakes())
    await db.raw(
      `CREATE TRIGGER parked_b_job_link BEFORE UPDATE OF job_run_id ON nivaro_hub_shared_deploys
       BEGIN SELECT RAISE(ABORT, 'job link refused'); END`
    )
    try {
      await expect(start(id, deps)).rejects.toThrow()
    } finally {
      await db.raw('DROP TRIGGER parked_b_job_link')
    }
    const row = await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: id }).first()
    expect(row.status).toBe('failed')
    expect(out.failed).toMatch(/^START_FAILED: /)
    expect((await Store.getShared(id))?.status).toBe('active')
  })
})

describe('downgrade needs confirm (ruling P6-29, B2)', () => {
  it('isSharedDowngrade compares semver-aware and treats an unparseable version as a downgrade', () => {
    const d = Plan.isSharedDowngrade
    expect(d('0.3.210', '0.3.209')).toBe(true)
    expect(d('0.3.210', '0.3.21')).toBe(true)
    expect(d('0.3.9', '0.3.10')).toBe(false)
    expect(d('1.0.0', '0.99.99')).toBe(true)
    expect(d('0.3.210', '0.3.210')).toBe(false)
    expect(d('0.3.210', '0.3.211')).toBe(false)
    // Pre-releases come before their release.
    expect(d('0.3.210', '0.3.210-rc.1')).toBe(true)
    expect(d('0.3.210-rc.1', '0.3.210')).toBe(false)
    expect(d('0.3.210-rc.10', '0.3.210-rc.9')).toBe(true)
    expect(d('0.3.210-rc.1', '0.3.210-rc.2')).toBe(false)
    expect(d('v0.3.210', '0.3.211')).toBe(false)
    // Unparseable either side: the flag is required.
    expect(d('latest', '0.3.211')).toBe(true)
    expect(d('0.3.210', 'next')).toBe(true)
    expect(d('0.3', '0.3.211')).toBe(true)
    // Nothing deployed yet: nothing to go down from.
    expect(d(null, '0.3.211')).toBe(false)
  })

  it('an upgrade to an older version → 409 DOWNGRADE_NEEDS_CONFIRM unless downgrade: true', async () => {
    const id = await newShared({ version_pin: '0.3.211' })
    const { deps } = runDeps(fakes())
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
    expect(plan.downgrade).toBe(true)
    expect(codes(plan.warnings)).toContain('DOWNGRADE')
    const key = (await Store.getShared(id))?.key as string
    const body = { version: '0.3.210', plan_hash: plan.plan_hash, confirm: key }
    const refused = await refusal(Run.startSharedUpgrade(id, body, 'admin-1', deps))
    expect(refused).toMatchObject({ code: 'DOWNGRADE_NEEDS_CONFIRM', statusCode: 409 })
    expect(await db('nivaro_hub_shared_deploys').where({ shared_deployment_id: id })).toHaveLength(
      0
    )
    expect(await locks.shared.holder(id)).toBeNull()
    for (const bad of ['yes', 1])
      expect(
        await refusal(Run.startSharedUpgrade(id, { ...body, downgrade: bad }, 'admin-1', deps))
      ).toMatchObject({ code: 'BAD_DOWNGRADE', statusCode: 400 })
    const out = await Run.startSharedUpgrade(id, { ...body, downgrade: true }, 'admin-1', deps)
    await Run.awaitSharedUpgrade(out.shared_deploy_id)
    expect((await Run.readSharedDeploy(out.shared_deploy_id))?.kind).toBe('upgrade')
  })

  it('a newer or the same version needs no flag; an unparseable current version does', async () => {
    const id = await newShared()
    const { deps } = runDeps(fakes())
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', deps)
    expect(plan.downgrade).toBe(false)
    expect(codes(plan.warnings)).not.toContain('DOWNGRADE')
    const odd = await newShared({ version_pin: 'nightly' })
    const oddPlan = await Plan.planSharedUpgrade(odd, '0.3.210', 'upgrade', deps)
    expect(oddPlan.downgrade).toBe(true)
    const key = (await Store.getShared(odd))?.key as string
    expect(
      await refusal(
        Run.startSharedUpgrade(
          odd,
          { version: '0.3.210', plan_hash: oddPlan.plan_hash, confirm: key },
          'admin-1',
          deps
        )
      )
    ).toMatchObject({ code: 'DOWNGRADE_NEEDS_CONFIRM' })
  })

  it('a rollback to the recorded previous build needs no flag', async () => {
    const id = await newShared({ version_pin: '0.3.210' })
    await db('nivaro_hub_shared_deploys').insert({
      shared_deployment_id: id,
      kind: 'upgrade',
      version: '0.3.209',
      status: 'success',
      plan: JSON.stringify({ image: `nodeworks/nivaro@sha256:${'7'.repeat(64)}`, extensions: {} })
    })
    const f = fakes()
    f.sightings = [
      { instance: 'i1', version: '0.3.209', etag: null, at: new Date(START).toISOString() }
    ]
    f.statusVersion = '0.3.209'
    const { deps } = runDeps(f)
    const plan = await Plan.planSharedUpgrade(id, '0.3.209', 'rollback', deps)
    expect(plan.downgrade).toBe(false)
    const key = (await Store.getShared(id))?.key as string
    const out = await Run.startSharedUpgrade(
      id,
      { version: '0.3.209', kind: 'rollback', plan_hash: plan.plan_hash, confirm: key },
      'admin-1',
      deps
    )
    await Run.awaitSharedUpgrade(out.shared_deploy_id)
    expect((await Run.readSharedDeploy(out.shared_deploy_id))?.status).toBe('success')
  })
})

describe('final review I-2: an open move into the deployment', () => {
  async function movingIn(id: number) {
    const appKey = `app${++seq}`
    const appId = await insertId('nivaro_hub_apps', { key: appKey, name: appKey })
    const from = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: driverId,
      target: JSON.stringify({ stack: `stk${seq}` })
    })
    const to = await insertId('nivaro_hub_placements', {
      kind: 'shared',
      shared_deployment_id: id,
      target: JSON.stringify({ pool_max: 5 })
    })
    const envId = await insertId('nivaro_hub_environments', {
      app_id: appId,
      key: 'production',
      status: 'maintenance',
      base_url: `https://${appKey}.apps.example.com`,
      hostnames: '[]',
      placement_id: from,
      version_pin: '0.3.209'
    })
    const moveId = await insertId('nivaro_hub_moves', {
      app_id: appId,
      environment_id: envId,
      from_placement_id: from,
      to_placement_id: to,
      kind: 'to_shared',
      routing: 'manual',
      status: 'interrupted',
      steps: '[]',
      placed_at: new Date(START)
    })
    return { appKey, envId, moveId }
  }

  it('an interrupted to_shared move with placed_at set → the plan is blocked MOVE_OPEN', async () => {
    const id = await newShared()
    await newApp(id, [{ key: 'production', placed: true }])
    const m = await movingIn(id)
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    expect(codes(plan.blockers)).toContain('MOVE_OPEN')
    expect(plan.blockers.find((b) => b.code === 'MOVE_OPEN')?.text).toContain(`move ${m.moveId}`)
    // Listed (maintenance, not placed) all the same.
    expect(plan.apps.find((a) => a.env_id === m.envId)).toMatchObject({
      placed: false,
      status: 'maintenance'
    })
  })

  it('verify checks only apps placed here: a name a move still routes elsewhere never fails it', async () => {
    const id = await newShared()
    const a = await newApp(id, [{ key: 'staging', placed: true }])
    const m = await movingIn(id)
    const f = fakes()
    const ta = Store.tenantIdFor({ key: a.appKey }, { id: a.envIds[0] })
    const tm = Store.tenantIdFor({ key: m.appKey }, { id: m.envId })
    f.schema = { [ta]: { state: 'ok', error: null }, [tm]: { state: 'ok', error: null } }
    // The moving app's name still answers its dedicated side's version.
    f.served = {
      [`https://${a.appKey}-staging.apps.example.com/api/version`]: '0.3.210',
      [`https://${m.appKey}.apps.example.com/api/version`]: '0.3.209'
    }
    const { deps, out } = runDeps(f)
    moveOpen.miss = true
    try {
      const { row } = await start(id, deps)
      expect(out.failed).toBeNull()
      expect(row?.status).toBe('success')
    } finally {
      moveOpen.miss = false
    }
    const urls = deps.readServedField.mock.calls.map((c) => String(c[0]))
    expect(urls).not.toContain(`https://${m.appKey}.apps.example.com/api/version`)
  })
})

describe('final review I-4: an app needs an extension the deployment does not load', () => {
  it('per-app blocker EXTENSION_MISSING, never overridable; a re-apply is not started', async () => {
    const id = await newShared()
    const a = await newApp(id, [{ key: 'production', placed: true }])
    await db('nivaro_hub_apps')
      .where({ id: a.appId })
      .update({ extensions: JSON.stringify(['efp-ops']) })
    const plan = await Plan.planSharedUpgrade(id, '0.3.210', 'upgrade', planDeps())
    const row = plan.apps.find((x) => x.env_id === a.envIds[0])
    expect(row?.blockers).toContain('EXTENSION_MISSING')
    expect(row?.notes.join(' ')).toContain('efp-ops')
    expect(plan.overridable).not.toContain('EXTENSION_MISSING')
    const key = (await Store.getShared(id))?.key as string
    const err = await refusal(
      Run.startSharedUpgrade(
        id,
        {
          version: '0.3.210',
          plan_hash: plan.plan_hash,
          confirm: key,
          overrides: [`EXTENSION_MISSING:${a.envIds[0]}`]
        },
        'admin-1',
        runDeps(fakes()).deps
      )
    )
    expect(err.code).toBe('APP_BLOCKED')
    // Same version (a re-apply): still checked — the apply would strip the extension.
    const same = await Plan.planSharedUpgrade(id, '0.3.209', 'upgrade', planDeps())
    expect(same.apps.find((x) => x.env_id === a.envIds[0])?.blockers).toContain('EXTENSION_MISSING')
    const sh = await Store.getShared(id)
    expect(
      await Run.startSharedReapply(sh as NonNullable<typeof sh>, 'admin-1', runDeps(fakes()).deps)
    ).toEqual({ started: false, reason: 'APP_BLOCKED' })
  })
})
