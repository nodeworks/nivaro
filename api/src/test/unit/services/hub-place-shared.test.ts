import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 4: placing a NEW environment on a shared deployment
// (services/hub/shared/place.ts). Real SQLite with the hub tables (542–553); the deployment link
// client and the clock are fakes, sightings live in memory. Each refusal fires on its own input
// and writes nothing; the run walks refresh → replicas → schema → first admin → active.

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const stack = vi.hoisted(() => ({ key: null as string | null }))
vi.mock('../../../services/hub/docker/stack-settings.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/docker/stack-settings.js')>()
  return {
    ...real,
    openStackSecrets: (row: Parameters<typeof real.openStackSecrets>[0]) =>
      stack.key ? { ENCRYPTION_KEY: stack.key } : real.openStackSecrets(row)
  }
})

const agent = vi.hoisted(() => ({ stack: vi.fn() }))
vi.mock('../../../services/hub/docker/agent-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/docker/agent-client.js')>()),
  agentStack: agent.stack
}))

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
const Place = await import('../../../services/hub/shared/place.js')
const Store = await import('../../../services/hub/shared/store.js')
const Sightings = await import('../../../services/hub/shared/sightings.js')
const { tenantsBody } = await import('../../../services/hub/shared/tenants.js')
const { sealStoredConnection } = await import('../../../services/hub/db/stored-connection.js')
const { DeploymentLinkError } = await import('../../../services/hub/shared/deployment-client.js')
const { keyFingerprint } = await import('../../../services/app-key-fingerprint.js')
const { defaultSharedLock } = await import('../../../services/hub/promote-lock.js')
const { getPlacement } = await import('../../../services/hub/drivers.js')
const { memoryPromoteLock, PromotionError } = await import('../../../services/hub/promote-lock.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')

const HUB_KEY = 'e'.repeat(64)
const STACK_KEY = 'cd'.repeat(32)
const START = Date.parse('2026-11-22T10:00:00Z')
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

let t = START
const now = () => t
const sleep = vi.fn(async (ms: number) => {
  t += ms
})

let sharedId = 0
let seq = 0

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

async function newApp(o: Record<string, unknown> = {}): Promise<{ id: number; key: string }> {
  const key = `app${++seq}`
  const id = await insertId('nivaro_hub_apps', { key, name: key.toUpperCase(), ...o })
  return { id, key }
}

async function newEnv(appId: number, o: Record<string, unknown> = {}): Promise<number> {
  return insertId('nivaro_hub_environments', {
    app_id: appId,
    key: `env${++seq}`,
    status: 'active',
    base_url: `https://e${seq}.apps.example.com`,
    hostnames: '[]',
    ...o
  })
}

async function newDb(o: Record<string, unknown> = {}): Promise<number> {
  const name = `db${++seq}`
  return insertId('nivaro_hub_databases', {
    engine: 'pg',
    host: 'pg1.example.com',
    database_name: name,
    login_name: `${name}_app`,
    status: 'ready',
    adopted: true,
    connection: sealStoredConnection({
      engine: 'pg',
      host: 'pg1.example.com',
      port: 5432,
      database: name,
      user: `${name}_app`,
      password: `pw-${name}-Secret`,
      ssl_mode: 'require',
      trust_server_cert: false
    }),
    ...o
  })
}

/** A fake deployment link: refresh() makes the one replica hold the list as it is now. */
function fakeClient(o: { schema?: () => { state: string; error: string | null } } = {}) {
  const calls = { refresh: 0, firstAdmin: [] as Array<[string, unknown]> }
  const client = {
    refresh: vi.fn(async () => {
      calls.refresh++
      const shared = await Store.getShared(sharedId)
      if (!shared) return
      const { etag } = await tenantsBody(shared)
      await Sightings.recordSighting(sharedId, {
        instance: 'web-1',
        version: '0.3.210',
        etag,
        at: new Date(t).toISOString()
      })
    }),
    status: vi.fn(async () => ({
      version: '0.3.210',
      instance: 'web-1',
      registry: { count: 1, loaded_at: null, etag: null, stale: false, dropped: [] },
      apps: TENANTS.map((id) => ({
        id,
        schema: { version: null, ...(o.schema?.() ?? { state: 'ok', error: null }) }
      })),
      extensions: [],
      oidc: null,
      process: {}
    })),
    firstAdmin: vi.fn(async (id: string, body: unknown) => {
      calls.firstAdmin.push([id, body])
      return { user_id: 'u-1', created: true }
    }),
    // I-3: the database is looked at live before a key is generated (empty here).
    dbCheck: vi.fn(async () => ({
      reachable: true,
      ledger: null as { count: number; latest: string | null } | null,
      db_identity: null,
      error: null as string | null
    }))
  }
  return { client, calls, factory: (() => client) as never }
}
/** Tenant ids the fake status() reports. */
let TENANTS: string[] = []

function fakeRun() {
  const lines: string[] = []
  const out = { completed: null as string | null, failed: null as string | null }
  return {
    lines,
    out,
    start: vi.fn(async () => ({
      id: 77,
      progress: () => undefined,
      log: (l: string) => {
        lines.push(l)
      },
      complete: async (outcome?: string) => {
        out.completed = outcome ?? 'done'
      },
      fail: async (err: unknown) => {
        out.failed = (err as Error).message
      }
    }))
  }
}

const ADMIN = { email: 'owner@example.com', first_name: 'Ada' }

async function place(
  envId: number,
  input: Partial<Parameters<typeof Place.placeOnShared>[1]>,
  deps: Record<string, unknown> = {}
) {
  return Place.placeOnShared(
    envId,
    { shared_id: sharedId, first_admin: ADMIN, ...input } as Parameters<
      typeof Place.placeOnShared
    >[1],
    'admin-1',
    { sleep, now, ...deps } as Parameters<typeof Place.placeOnShared>[3]
  )
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; statusCode: number }> {
  try {
    await p
  } catch (err) {
    return err as { code: string; statusCode: number }
  }
  throw new Error('expected a refusal')
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  for (const m of migrations) await m.up(db)
  const v = Store.validateSharedInput({
    key: 'shared-one',
    name: 'Shared one',
    link_url: 'https://shared-one.internal.example.com',
    extensions: ['reports']
  })
  if (!v.ok) throw new Error(v.code)
  sharedId = (await Store.createShared(v.row, null)).row.id
  await db('nivaro_hub_shared_deployments')
    .where({ id: sharedId })
    .update({ version_pin: '0.3.210', status: 'active', pool_budget: 1000 })
})

afterAll(async () => {
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

beforeEach(() => {
  t = START
  sleep.mockClear()
  stack.key = null
  TENANTS = []
  Sightings._setSightingsDepsForTests({
    redis: Sightings.memorySightingsRedis(() => t),
    now: () => t
  })
})

describe('placeOnShared — the happy path', () => {
  it('places, waits for the replicas and the schema, seeds the first admin, ends active', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    const dbId = await newDb()
    const tenant = Store.tenantIdFor(app, { id: envId })
    TENANTS = [tenant]
    const fake = fakeClient()
    const run = fakeRun()
    const out = await place(
      envId,
      { database_id: dbId, pool_max: 4 },
      { client: fake.factory, startJobRun: run.start }
    )
    expect(out).toEqual({ job_run_id: 77 })
    await Place.awaitPlacement(envId)

    expect(run.out.failed).toBeNull()
    expect(run.out.completed).toMatch(/done/)
    const env = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(env.status).toBe('active')
    expect(env.db_ref).toBe(`hub-db:${dbId}`)
    expect(env.version_pin).toBe('0.3.210')
    const p = await getPlacement(Number(env.placement_id))
    expect(p).toMatchObject({
      kind: 'shared',
      shared_deployment_id: sharedId,
      driver_id: null,
      target: { pool_max: 4 }
    })
    // A new key was made (32 random bytes as hex) and stored sealed with its fingerprint.
    const key = await Store.openAppKey(envId)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(env.encryption_key_fp).toBe(keyFingerprint(key as string))
    expect(fake.calls.refresh).toBeGreaterThan(0)
    expect(fake.calls.firstAdmin).toEqual([[tenant, ADMIN]])
    // Nothing the run logged holds the key.
    expect(run.lines.join('\n')).not.toContain(key as string)
  })

  it('keeps a Docker stack-settings key, copied into the entry (a shared env reads its entry only)', async () => {
    stack.key = STACK_KEY
    const app = await newApp()
    const envId = await newEnv(app.id)
    TENANTS = [Store.tenantIdFor(app, { id: envId })]
    const fake = fakeClient()
    await place(
      envId,
      { database_id: await newDb() },
      { client: fake.factory, startJobRun: fakeRun().start }
    )
    await Place.awaitPlacement(envId)
    stack.key = 'ef'.repeat(32) // a leftover stack key changing later is never read on shared
    expect(await Store.openAppKey(envId)).toBe(STACK_KEY)
    const env = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(env.encryption_key_fp).toBe(keyFingerprint(STACK_KEY))
  })

  it('an app that already has an administrator (HAS_ADMIN) still ends active', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id, { status: 'provisioning' })
    TENANTS = [Store.tenantIdFor(app, { id: envId })]
    const fake = fakeClient()
    fake.client.firstAdmin.mockRejectedValueOnce(
      new DeploymentLinkError('FIRST_ADMIN_REFUSED', 409, 'HAS_ADMIN')
    )
    const run = fakeRun()
    await place(
      envId,
      { database_id: await newDb() },
      { client: fake.factory, startJobRun: run.start }
    )
    await Place.awaitPlacement(envId)
    expect(run.out.failed).toBeNull()
    expect((await db('nivaro_hub_environments').where({ id: envId }).first()).status).toBe('active')
  })
})

describe('placeOnShared — the run stops', () => {
  it('schema failed: the job run fails with the app error text; the env stays provisioning', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    TENANTS = [Store.tenantIdFor(app, { id: envId })]
    const fake = fakeClient({
      schema: () => ({ state: 'failed', error: 'migration 512 failed: column already exists' })
    })
    const run = fakeRun()
    await place(
      envId,
      { database_id: await newDb() },
      { client: fake.factory, startJobRun: run.start }
    )
    await Place.awaitPlacement(envId)
    expect(run.out.completed).toBeNull()
    expect(run.out.failed).toContain('SCHEMA_FAILED')
    expect(run.out.failed).toContain('migration 512 failed: column already exists')
    expect(fake.calls.firstAdmin).toEqual([])
    const env = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(env.status).toBe('provisioning')
    // Placed: placing again retries (a placement that never had a success deploy).
    expect((await getPlacement(Number(env.placement_id)))?.kind).toBe('shared')
    fake.client.status.mockImplementation(async () => ({
      version: '0.3.210',
      instance: 'web-1',
      registry: { count: 1, loaded_at: null, etag: null, stale: false, dropped: [] },
      apps: TENANTS.map((id) => ({ id, schema: { state: 'ok', version: null, error: null } })),
      extensions: [],
      oidc: null,
      process: {}
    }))
    const again = fakeRun()
    await place(
      envId,
      { database_id: Number(String(env.db_ref).slice(7)) },
      { client: fake.factory, startJobRun: again.start }
    )
    await Place.awaitPlacement(envId)
    expect(again.out.failed).toBeNull()
    const after = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(after.status).toBe('active')
    // The earlier shared placement went (no environment names it any more).
    expect(await getPlacement(Number(env.placement_id))).toBeNull()
  })

  it('no replica takes the new list within 2 minutes: REPLICAS_BEHIND, env stays provisioning', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    TENANTS = [Store.tenantIdFor(app, { id: envId })]
    const fake = fakeClient()
    // A replica seen with an old list, and a refresh that never reaches it.
    await Sightings.recordSighting(sharedId, {
      instance: 'web-2',
      version: '0.3.210',
      etag: `"${'0'.repeat(64)}"`,
      at: new Date(t).toISOString()
    })
    fake.client.refresh.mockRejectedValue(new DeploymentLinkError('LINK_UNREACHABLE'))
    const run = fakeRun()
    await place(
      envId,
      { database_id: await newDb() },
      { client: fake.factory, startJobRun: run.start }
    )
    await Place.awaitPlacement(envId)
    expect(run.out.failed).toContain('REPLICAS_BEHIND')
    expect(t - START).toBeGreaterThanOrEqual(Place.REPLICAS_WAIT_MS)
    expect(fake.client.status).not.toHaveBeenCalled()
    expect((await db('nivaro_hub_environments').where({ id: envId }).first()).status).toBe(
      'provisioning'
    )
  })
})

describe('placeOnShared — refusals (nothing written)', () => {
  async function expectRefused(
    envId: number,
    input: Record<string, unknown>,
    code: string,
    status = 409
  ) {
    const before = await db('nivaro_hub_environments').where({ id: envId }).first()
    const err = await refusal(
      place(envId, input, { client: fakeClient().factory, startJobRun: fakeRun().start })
    )
    expect(err.code).toBe(code)
    expect(err.statusCode).toBe(status)
    const after = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(after.placement_id).toBe(before.placement_id)
    expect(after.db_ref).toBe(before.db_ref)
    expect(after.status).toBe(before.status)
  }

  it('USE_MOVE: an environment that has served (a success deploy, a done creation, a status)', async () => {
    const app = await newApp()
    const served = await newEnv(app.id)
    await db('nivaro_hub_deploys').insert({
      app_id: app.id,
      environment_id: served,
      kind: 'promote',
      version: '0.3.200',
      status: 'success',
      started_at: new Date()
    })
    await expectRefused(served, { database_id: await newDb() }, 'USE_MOVE')
    const created = await newEnv(app.id)
    await db('nivaro_hub_creations').insert({
      app_id: app.id,
      environment_id: created,
      status: 'done',
      steps: '[]',
      version: '0.3.200',
      first_admin: '{}'
    })
    await expectRefused(created, { database_id: await newDb() }, 'USE_MOVE')
    const suspended = await newEnv(app.id, { status: 'suspended' })
    await expectRefused(suspended, { database_id: await newDb() }, 'USE_MOVE')
  })

  it('CREATION_RUNNING: a creation still under way', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id, { status: 'provisioning' })
    await db('nivaro_hub_creations').insert({
      app_id: app.id,
      environment_id: envId,
      status: 'waiting',
      steps: '[]',
      version: '0.3.200',
      first_admin: '{}'
    })
    await expectRefused(envId, { database_id: await newDb() }, 'CREATION_RUNNING')
  })

  it('DATABASE_NOT_READY and DATABASE_IN_USE', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    await expectRefused(
      envId,
      { database_id: await newDb({ status: 'requested' }) },
      'DATABASE_NOT_READY'
    )
    const taken = await newDb()
    await newEnv(app.id, { db_ref: `hub-db:${taken}` })
    await expectRefused(envId, { database_id: taken }, 'DATABASE_IN_USE')
    await expectRefused(envId, { database_id: 99999 }, 'NOT_FOUND', 404)
  })

  it('EXTENSION_NOT_ALLOWED: the app uses one the deployment does not load', async () => {
    const app = await newApp({ extensions: JSON.stringify(['reports', 'efp-ops']) })
    const envId = await newEnv(app.id)
    await expectRefused(envId, { database_id: await newDb() }, 'EXTENSION_NOT_ALLOWED')
  })

  it('SIGNIN_VIA_HUB: the app signs in through the Hub', async () => {
    const app = await newApp({ signin_mode: 'hub' })
    const envId = await newEnv(app.id)
    await expectRefused(envId, { database_id: await newDb() }, 'SIGNIN_VIA_HUB')
  })

  it('POOL_TOO_SMALL under 2, BAD_POOL over 20, POOL_BUDGET past the budget', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    await expectRefused(envId, { database_id: await newDb(), pool_max: 1 }, 'POOL_TOO_SMALL', 400)
    await expectRefused(envId, { database_id: await newDb(), pool_max: 21 }, 'BAD_POOL', 400)
    // A placed app takes its pool_max; a shared placement no environment uses takes nothing.
    const other = await newApp()
    const pid = await insertId('nivaro_hub_placements', {
      kind: 'shared',
      shared_deployment_id: sharedId,
      target: JSON.stringify({ pool_max: 9 })
    })
    const before = await Place.sharedPoolUsed(sharedId)
    await newEnv(other.id, { placement_id: pid })
    expect(await Place.sharedPoolUsed(sharedId)).toBe(before + 9)
    const used = await Place.sharedPoolUsed(sharedId)
    await db('nivaro_hub_shared_deployments')
      .where({ id: sharedId })
      .update({ pool_budget: used + 4 })
    try {
      await expectRefused(envId, { database_id: await newDb(), pool_max: 5 }, 'POOL_BUDGET')
    } finally {
      await db('nivaro_hub_shared_deployments')
        .where({ id: sharedId })
        .update({ pool_budget: 1000 })
    }
  })

  it('SHARED_RETIRED, SHARED_BUSY (upgrading, or the shared lock held), NOT_FOUND', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    await db('nivaro_hub_shared_deployments').where({ id: sharedId }).update({ status: 'retired' })
    await expectRefused(envId, { database_id: await newDb() }, 'SHARED_RETIRED')
    await db('nivaro_hub_shared_deployments')
      .where({ id: sharedId })
      .update({ status: 'upgrading' })
    await expectRefused(envId, { database_id: await newDb() }, 'SHARED_BUSY')
    await db('nivaro_hub_shared_deployments').where({ id: sharedId }).update({ status: 'active' })
    const lock = defaultSharedLock()
    const token = (await lock.take(sharedId, 'shared')) as string
    try {
      const err = await refusal(
        place(envId, { database_id: await newDb() }, { client: fakeClient().factory })
      )
      expect(err.code).toBe('SHARED_BUSY')
      expect((err as unknown as Error).message).toMatch(/upgrade or rollback/)
    } finally {
      await lock.release(sharedId, token)
    }
    await expectRefused(envId, { database_id: await newDb(), shared_id: 4242 }, 'NOT_FOUND', 404)
  })

  it('bad input answers 400 before anything is read', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    await expectRefused(envId, { database_id: 'x' }, 'BAD_DATABASE', 400)
    await expectRefused(
      envId,
      { database_id: await newDb(), first_admin: { email: 'nope' } },
      'BAD_FIRST_ADMIN',
      400
    )
  })
})

describe('fix round 1', () => {
  const placeDeploys = (envId: number) =>
    db('nivaro_hub_deploys').where({ environment_id: envId, kind: 'shared' }).orderBy('id')

  it('I-1: a successful place leaves a shared success row; placing again → 409 ALREADY_PLACED', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    TENANTS = [Store.tenantIdFor(app, { id: envId })]
    const fake = fakeClient()
    await place(
      envId,
      { database_id: await newDb() },
      { client: fake.factory, startJobRun: fakeRun().start }
    )
    await Place.awaitPlacement(envId)
    const rows = await placeDeploys(envId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'success', version: '0.3.210', shared_deploy_id: null })
    expect(JSON.parse(rows[0].plan)).toMatchObject({ place: { shared_id: sharedId } })
    const before = await db('nivaro_hub_environments').where({ id: envId }).first()
    const placements = await db('nivaro_hub_placements').count({ n: '*' }).first()
    const err = await refusal(
      place(
        envId,
        { database_id: await newDb() },
        { client: fake.factory, startJobRun: fakeRun().start }
      )
    )
    expect(err).toMatchObject({ code: 'ALREADY_PLACED', statusCode: 409 })
    const after = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(after).toMatchObject({
      status: 'active',
      placement_id: before.placement_id,
      db_ref: before.db_ref,
      encryption_key_fp: before.encryption_key_fp
    })
    expect(await db('nivaro_hub_placements').count({ n: '*' }).first()).toEqual(placements)
  })

  it('I-2: a stack that came up although its deploy never succeeded → 409 STACK_RUNNING', async () => {
    const app = await newApp()
    const stackName = `stk${++seq}`
    const driverId = await insertId('nivaro_hub_drivers', {
      kind: 'docker',
      name: `swarm${++seq}`,
      config: JSON.stringify({
        agent_url: 'https://agent.example.com',
        dns_mode: 'automatic',
        wildcard_domain: 'apps.example.com',
        edge_target: null
      }),
      secret: sealSecret('agent-Token-Value-0123456789-abcdefghij')
    })
    const pid = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: driverId,
      target: JSON.stringify({ stack: stackName })
    })
    const envId = await newEnv(app.id, { placement_id: pid })
    const env = await db('nivaro_hub_environments').where({ id: envId }).first('key')
    await db('nivaro_hub_deploys').insert({
      app_id: app.id,
      environment_id: envId,
      kind: 'promote',
      version: '0.3.210',
      status: 'failed',
      plan: JSON.stringify({ steps: [{ driver: 'docker', stack: { name: stackName } }] }),
      started_at: new Date(t)
    })
    agent.stack.mockResolvedValueOnce({
      name: stackName,
      owner: { app: app.key },
      environment: env.key,
      state: 'converged',
      services: []
    })
    const before = await db('nivaro_hub_environments').where({ id: envId }).first()
    const err = await refusal(
      place(envId, { database_id: await newDb() }, { client: fakeClient().factory })
    )
    expect(err).toMatchObject({ code: 'STACK_RUNNING', statusCode: 409 })
    const after = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(after.placement_id).toBe(before.placement_id)
    expect(await getPlacement(pid)).not.toBeNull()
  })

  it('I-3: no key known and the database holds a Nivaro install → 409 APP_KEY_UNKNOWN', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    const fake = fakeClient()
    fake.client.dbCheck.mockResolvedValueOnce({
      reachable: true,
      ledger: { count: 512, latest: '551_hub_signins' },
      db_identity: null,
      error: null
    })
    const err = await refusal(
      place(envId, { database_id: await newDb() }, { client: fake.factory })
    )
    expect(err).toMatchObject({ code: 'APP_KEY_UNKNOWN', statusCode: 409 })
    expect((err as unknown as Error).message).toMatch(/encryption key/)
    const env = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(env).toMatchObject({ encryption_key: null, placement_id: null, db_ref: null })
    // The database cannot be looked at: the same refusal (never "assume empty").
    fake.client.dbCheck.mockRejectedValueOnce(new DeploymentLinkError('LINK_UNREACHABLE'))
    expect(
      (await refusal(place(envId, { database_id: await newDb() }, { client: fake.factory }))).code
    ).toBe('APP_KEY_UNKNOWN')
    // Unreachable from the deployment: the same.
    fake.client.dbCheck.mockResolvedValueOnce({
      reachable: false,
      ledger: null,
      db_identity: null,
      error: 'timeout'
    })
    expect(
      (await refusal(place(envId, { database_id: await newDb() }, { client: fake.factory }))).code
    ).toBe('APP_KEY_UNKNOWN')
  })

  it('I-3: an empty database (no migrations rows) gets a generated key; a known key never asks', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    TENANTS = [Store.tenantIdFor(app, { id: envId })]
    const fake = fakeClient()
    fake.client.dbCheck.mockResolvedValueOnce({
      reachable: true,
      ledger: { count: 0, latest: null },
      db_identity: null,
      error: null
    })
    const run = fakeRun()
    await place(
      envId,
      { database_id: await newDb() },
      { client: fake.factory, startJobRun: run.start }
    )
    await Place.awaitPlacement(envId)
    expect(fake.client.dbCheck).toHaveBeenCalledTimes(1)
    const key = (await Store.openAppKey(envId)) as string
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(fake.client.dbCheck.mock.calls)).not.toContain(key)
    expect(run.lines.join('\n')).not.toContain(key)

    const known = await newEnv(app.id)
    await Store.setAppKey(known, STACK_KEY)
    TENANTS = [Store.tenantIdFor(app, { id: known })]
    const fake2 = fakeClient()
    await place(
      known,
      { database_id: await newDb() },
      { client: fake2.factory, startJobRun: fakeRun().start }
    )
    await Place.awaitPlacement(known)
    expect(fake2.client.dbCheck).not.toHaveBeenCalled()
    expect(await Store.openAppKey(known)).toBe(STACK_KEY)
  })

  it('M-1: a write that fails leaves no generated key behind', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    const dbId = await newDb()
    const real = defaultSharedLock()
    // The database starts dropping between the checks and the write.
    const racing = {
      ...real,
      take: async (id: number, holder: 'place') => {
        await db('nivaro_hub_databases').where({ id: dbId }).update({ status: 'dropping' })
        return real.take(id, holder)
      }
    }
    const err = await refusal(
      place(envId, { database_id: dbId }, { client: fakeClient().factory, sharedLock: racing })
    )
    expect(err.code).toBe('DATABASE_DROPPING')
    const env = await db('nivaro_hub_environments').where({ id: envId }).first()
    expect(env).toMatchObject({ encryption_key: null, encryption_key_fp: null, placement_id: null })
  })

  it('M-5: an archived environment takes no pool', async () => {
    const other = await newApp()
    const pid = await insertId('nivaro_hub_placements', {
      kind: 'shared',
      shared_deployment_id: sharedId,
      target: JSON.stringify({ pool_max: 7 })
    })
    const before = await Place.sharedPoolUsed(sharedId)
    const envId = await newEnv(other.id, { placement_id: pid, status: 'archived' })
    expect(await Place.sharedPoolUsed(sharedId)).toBe(before)
    await db('nivaro_hub_environments').where({ id: envId }).update({ placement_id: null })
  })

  it('interrupted: a lost lock ends the run interrupted; a stale run row is healed; place again resumes', async () => {
    const app = await newApp()
    const envId = await newEnv(app.id)
    TENANTS = [Store.tenantIdFor(app, { id: envId })]
    const fake = fakeClient({ schema: () => ({ state: 'running', error: null }) })
    const lost = { ...memoryPromoteLock, renew: async () => false }
    const run = fakeRun()
    await place(
      envId,
      { database_id: await newDb() },
      { client: fake.factory, startJobRun: run.start, lock: lost, renewMs: 1 }
    )
    // The renewal timer runs on real time: let it fire while the fake schema wait sleeps.
    fake.client.status.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return {
        version: '0.3.210',
        instance: 'web-1',
        registry: { count: 1, loaded_at: null, etag: null, stale: false, dropped: [] },
        apps: TENANTS.map((id) => ({
          id,
          schema: { state: 'running', version: null, error: null }
        })),
        extensions: [],
        oidc: null,
        process: {}
      }
    })
    await Place.awaitPlacement(envId)
    expect(run.out.failed).toContain('INTERRUPTED')
    expect((await placeDeploys(envId)).at(-1)).toMatchObject({ status: 'interrupted' })

    // A run row a dead process left `running` (no heartbeat, lock free) is healed at boot.
    const stale = Number(
      (
        (await db('nivaro_hub_deploys')
          .insert({
            app_id: app.id,
            environment_id: envId,
            kind: 'shared',
            version: '0.3.210',
            status: 'running',
            plan: JSON.stringify({ place: { shared_id: sharedId, shared: 'shared-one' } }),
            started_at: new Date(t - 3_600_000)
          })
          .returning('id')) as Array<{ id: number } | number>
      ).map((r) => (typeof r === 'object' ? r.id : r))[0]
    )
    // A shared-deploy mirror row (Task 5's) is never touched here.
    const mirror = Number(
      (
        (await db('nivaro_hub_deploys')
          .insert({
            app_id: app.id,
            environment_id: envId,
            kind: 'shared',
            version: '0.3.210',
            status: 'running',
            shared_deploy_id: 99,
            started_at: new Date(t - 3_600_000)
          })
          .returning('id')) as Array<{ id: number } | number>
      ).map((r) => (typeof r === 'object' ? r.id : r))[0]
    )
    expect(await Place.recoverInterruptedPlacements({ lock: memoryPromoteLock })).toBe(1)
    const st = async (id: number) => (await db('nivaro_hub_deploys').where({ id }).first()).status
    expect(await st(stale)).toBe('interrupted')
    expect(await st(mirror)).toBe('running')
    await db('nivaro_hub_deploys').where({ id: mirror }).del()

    // Still provisioning, never served: placing again resumes and ends active.
    expect((await db('nivaro_hub_environments').where({ id: envId }).first()).status).toBe(
      'provisioning'
    )
    const env = await db('nivaro_hub_environments').where({ id: envId }).first()
    const again = fakeClient()
    await place(
      envId,
      { database_id: Number(String(env.db_ref).slice(7)) },
      { client: again.factory, startJobRun: fakeRun().start }
    )
    await Place.awaitPlacement(envId)
    expect((await db('nivaro_hub_environments').where({ id: envId }).first()).status).toBe('active')
  })
})
