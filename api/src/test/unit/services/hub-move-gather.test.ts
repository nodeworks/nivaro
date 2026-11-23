import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 15: the gather step of a move plan (services/hub/move/gather.ts).
// Real SQLite with the hub tables (542–553); the deployment link, the hub-link report, the Docker
// agent and the locks are fakes. The gathered input (and the plan built from it) never holds the
// hub token, the app key, the database password or its connection.

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

const stack = vi.hoisted(() => ({ secrets: {} as Record<string, string> }))
vi.mock('../../../services/hub/docker/stack-settings.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/docker/stack-settings.js')>()
  return { ...real, openStackSecrets: () => ({ ...stack.secrets }) }
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
const Gather = await import('../../../services/hub/move/gather.js')
const { buildMovePlan } = await import('../../../services/hub/move/plan.js')
const { MoveError } = await import('../../../services/hub/move/types.js')
const Store = await import('../../../services/hub/shared/store.js')
const { sealStoredConnection } = await import('../../../services/hub/db/stored-connection.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { keyFingerprint } = await import('../../../services/app-key-fingerprint.js')
const { DeploymentLinkError } = await import('../../../services/hub/shared/deployment-client.js')
const { memoryPromoteLock, redisPromoteLock, sharedLock } = await import(
  '../../../services/hub/promote-lock.js'
)

const HUB_KEY = 'e'.repeat(64)
const APP_KEY = 'ab'.repeat(32)
const HUB_TOKEN = 'hubtoken-plain-0123456789-abcdefghijklmnop'
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }
const IDENTITY = 'pg|10.0.0.5|5432|shop'
/** An extension image pin (ruling P6-16). */
const X_PIN = `registry.example.com/ext-x@sha256:${'1'.repeat(64)}`

let seq = 0
async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

async function newDb(): Promise<number> {
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
    })
  })
}

async function newShared(o: Record<string, unknown> = {}): Promise<number> {
  const v = Store.validateSharedInput({
    key: `pool-${++seq}`,
    name: 'Pool',
    mode: 'docker',
    driver_id: dockerDriver,
    link_url: 'https://pool.internal.example.com',
    extensions: ['x'],
    extension_pins: { x: X_PIN },
    host_pattern: '*.apps.example.com',
    ...o
  })
  if (!v.ok) throw new Error(v.code)
  const id = (await Store.createShared(v.row, null)).row.id
  await db('nivaro_hub_shared_deployments')
    .where({ id })
    .update({ version_pin: '0.3.210', status: 'active' })
  return id
}

let dockerDriver = 0
let gitlabDriver = 0

async function dockerPlacement(stackName: string): Promise<number> {
  return insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: dockerDriver,
    target: JSON.stringify({ stack: stackName })
  })
}

async function sharedPlacement(sharedId: number, poolMax = 5): Promise<number> {
  return insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: sharedId,
    target: JSON.stringify({ pool_max: poolMax })
  })
}

async function newEnv(o: Record<string, unknown> = {}) {
  const appKey = `shop${++seq}`
  const appId = await insertId('nivaro_hub_apps', {
    key: appKey,
    name: 'Shop',
    extensions: JSON.stringify(['x'])
  })
  const id = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'prod',
    status: 'active',
    base_url: `https://shop${seq}.apps.example.com`,
    hostnames: '[]',
    version_pin: '0.3.210',
    extension_pins: JSON.stringify({ x: X_PIN }),
    hub_token: sealSecret(HUB_TOKEN),
    ...o
  })
  await Store.setAppKey(id, APP_KEY)
  return { id, appId, appKey }
}

function report(o: Record<string, unknown> = {}) {
  return {
    codes: [{ code: 'ROW_SCHEDULES', level: 'blocker', detail: '2 scheduled reports' }],
    key_fp: keyFingerprint(APP_KEY),
    oidc: { issuer_host: 'login.microsoftonline.com', tenant: 'corp' },
    signin_hub: false,
    db_identity: IDENTITY,
    busy: { imports: 0, exports: 0, renders: 0 },
    files: { count: 3, bytes: 300, local: 2 },
    version: '0.3.210',
    extensions: { x: '1.2.0' },
    ...o
  }
}

function fakeClient(
  o: { identityOf?: (connection: string) => string | null; fail?: boolean } = {}
) {
  const dbChecks: string[] = []
  return {
    dbChecks,
    factory: () => ({
      status: vi.fn(async () => {
        if (o.fail) throw new DeploymentLinkError('LINK_UNREACHABLE')
        return {
          version: '0.3.210',
          instance: 'web-1',
          registry: { count: 0, loaded_at: null, etag: null, stale: false, dropped: [] },
          apps: [],
          extensions: ['x'],
          oidc: { issuer_host: 'login.microsoftonline.com', tenant: 'corp' },
          process: {}
        }
      }),
      appStatus: vi.fn(async (id: string) => ({
        id,
        version: '0.3.210',
        preflight: { status: 'ok', failing: [] },
        readiness_score: null,
        busy: { imports: 0, exports: 0, renders: 0 },
        files: { count: 5, bytes: 500, local: 5 },
        key_fp: keyFingerprint(APP_KEY),
        maintenance: false
      })),
      dbCheck: vi.fn(async (w: { client: string; connection: string }) => {
        dbChecks.push(w.connection)
        return {
          reachable: true,
          ledger: null,
          db_identity: o.identityOf ? o.identityOf(w.connection) : IDENTITY,
          error: null
        }
      })
    })
  }
}

const health = (o: Record<string, unknown> = {}) =>
  vi.fn(async () => ({
    api: 1,
    agent_version: '1',
    engine_api: '1.45',
    swarm: { manager: true, node_id: 'n', nodes: 1 },
    images: [],
    host_suffixes: ['example.com'],
    edge: 'traefik' as const,
    publish_ports: null,
    extensions_shared: false,
    redis_bundled: true,
    ...o
  }))

function deps(o: Record<string, unknown> = {}) {
  return {
    client: fakeClient().factory as never,
    readiness: vi.fn(async () => ({ ok: true as const, report: report() as never })),
    agentHealth: health() as never,
    lock: memoryPromoteLock,
    sharedLock: {
      take: async () => null,
      holder: async () => null,
      renew: async () => true,
      release: async () => undefined
    },
    ...o
  }
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; statusCode: number }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(MoveError)
    return err as { code: string; statusCode: number }
  }
  throw new Error('expected a refusal')
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  for (const m of migrations) await m.up(db)
  dockerDriver = await insertId('nivaro_hub_drivers', {
    kind: 'docker',
    name: 'swarm',
    config: JSON.stringify({
      agent_url: 'https://agent.example.com',
      dns_mode: 'automatic',
      wildcard_domain: 'apps.example.com',
      edge_target: null
    })
  })
  gitlabDriver = await insertId('nivaro_hub_drivers', {
    kind: 'gitlab',
    name: 'gitlab',
    config: JSON.stringify({
      api: 'https://gitlab.example.com',
      project: 'group/app',
      branch: 'main',
      pin_file: 'nivaro.version',
      deploy_job: 'deploy'
    })
  })
})

afterAll(async () => {
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

beforeEach(() => {
  stack.secrets = {}
})

describe('checkMoveTarget', () => {
  it('takes a shared or a dedicated target and refuses everything else with a 400', () => {
    expect(Gather.checkMoveTarget({ kind: 'shared', shared_id: 3, pool_max: 4 })).toEqual({
      kind: 'shared',
      shared_id: 3,
      pool_max: 4
    })
    expect(Gather.checkMoveTarget({ kind: 'dedicated', placement_id: '9' })).toEqual({
      kind: 'dedicated',
      placement_id: 9
    })
    for (const bad of [
      null,
      { kind: 'shared' },
      { kind: 'shared', shared_id: 3, pool_max: 21 },
      { kind: 'shared', shared_id: 3, pool_max: 2.5 },
      { kind: 'dedicated', placement_id: -1 },
      { kind: 'other' }
    ]) {
      let err: unknown = null
      try {
        Gather.checkMoveTarget(bad)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(MoveError)
      expect((err as { statusCode: number }).statusCode).toBe(400)
    }
  })

  it('a pool_max of 1 passes the input check; the plan blocks it (POOL_TOO_SMALL)', () => {
    expect(Gather.checkMoveTarget({ kind: 'shared', shared_id: 3, pool_max: 1 })).toMatchObject({
      pool_max: 1
    })
  })
})

describe('gatherMovePlanInput — to_shared from a Docker stack', () => {
  it('gathers both sides and the plan has only the readiness blocker', async () => {
    const sharedId = await newShared()
    const dbId = await newDb()
    const placement = await dockerPlacement('shop-prod')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${dbId}` })
    const d = deps()
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId, pool_max: 4 },
      d
    )
    expect(input.kind).toBe('to_shared')
    expect(input.from).toMatchObject({ kind: 'docker', stack: 'shop-prod', edge: 'traefik' })
    expect(input.to).toMatchObject({ kind: 'shared', edge: 'traefik' })
    expect(input.app_key).toEqual({ known: true, fp: keyFingerprint(APP_KEY) })
    expect(input.database).toEqual({ id: dbId, ready: true })
    expect(input.source).toMatchObject({
      reachable: true,
      version: '0.3.210',
      db_identity: IDENTITY
    })
    expect(input.target_facts).toMatchObject({
      reachable: true,
      version: '0.3.210',
      pool: { used: 0, budget: 60, asked: 4 },
      db: { reachable: true, identity: IDENTITY }
    })
    expect(d.readiness).toHaveBeenCalledWith(expect.anything(), HUB_TOKEN)

    const plan = buildMovePlan(input)
    expect(plan.blockers.map((b) => b.code)).toEqual(['ROW_SCHEDULES'])
    expect(plan.routing).toBe('automatic')
    expect(plan.route).toEqual([
      { side: 'source', op: 'drop_host', host: `shop${seq}.apps.example.com` }
    ])

    // Never a token, a key or a connection.
    for (const text of [JSON.stringify(input), JSON.stringify(plan)]) {
      expect(text).not.toContain(HUB_TOKEN)
      expect(text).not.toContain(APP_KEY)
      expect(text).not.toContain('Secret')
      expect(text).not.toContain('postgres://')
    }
  })

  it('a key entry that cannot be opened reads as unreadable, not unknown (M-9)', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-uk')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    await db('nivaro_hub_environments').where({ id: e.id }).update({ encryption_key: 'not-sealed' })
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps()
    )
    expect(input.app_key).toEqual({ known: false, fp: null, unreadable: true })
  })

  it('extension pins: a Docker source reads its own, a GitLab source has none (P6-16)', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-px')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    // M-B: what the stack last deployed, not the configured pins (a pin edited, not applied yet).
    const DEPLOYED = `registry.example.com/ext-x@sha256:${'3'.repeat(64)}`
    const deployed = async (plan: string) =>
      insertId('nivaro_hub_deploys', {
        app_id: e.appId,
        environment_id: e.id,
        kind: 'promote',
        version: '0.3.210',
        status: 'success',
        plan
      })
    const read = async () =>
      (await Gather.gatherMovePlanInput(e.id, { kind: 'shared', shared_id: sharedId }, deps()))
        .source.extension_pins
    // No recorded deploy: unknown.
    expect(await read()).toBeNull()
    await deployed(
      JSON.stringify({ steps: [{ driver: 'docker', stack: { extensions: { x: DEPLOYED } } }] })
    )
    expect(await read()).toEqual({ x: DEPLOYED })
    // The newest deploy's plan cannot be read: unknown, never the older build.
    await deployed('{not json')
    expect(await read()).toBeNull()
    const g = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: gitlabDriver,
      target: JSON.stringify({ branch: 'deploy' })
    })
    const gl = await newEnv({ placement_id: g, db_ref: `hub-db:${await newDb()}` })
    const glInput = await Gather.gatherMovePlanInput(
      gl.id,
      { kind: 'shared', shared_id: sharedId },
      deps()
    )
    expect(glInput.source.extension_pins).toBeNull()
  })

  it('no hub token → NOT_HUB_LINKED (the link is never called)', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-a')
    const e = await newEnv({
      placement_id: placement,
      hub_token: null,
      db_ref: `hub-db:${await newDb()}`
    })
    const d = deps()
    const plan = buildMovePlan(
      await Gather.gatherMovePlanInput(e.id, { kind: 'shared', shared_id: sharedId }, d)
    )
    expect(plan.blockers.map((b) => b.code)).toContain('NOT_HUB_LINKED')
    expect(plan.blockers.map((b) => b.code)).not.toContain('LINK_UNREACHABLE')
    expect(d.readiness).not.toHaveBeenCalled()
  })

  it('a ready record whose connection cannot be opened → DB_UNREACHABLE_FROM_TARGET (never a pass)', async () => {
    const sharedId = await newShared()
    const dbId = await newDb()
    await db('nivaro_hub_databases').where({ id: dbId }).update({ connection: null })
    const placement = await dockerPlacement('shop-nc')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${dbId}` })
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps()
    )
    expect(input.target_facts.db).toEqual({
      reachable: false,
      identity: null,
      error: 'CONNECTION_UNREADABLE'
    })
    expect(buildMovePlan(input).blockers.map((b) => b.code)).toContain('DB_UNREACHABLE_FROM_TARGET')
  })

  it('a docker shared target whose agent cannot be read → multi_node_unread (N-2)', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-mn')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps({
        agentHealth: vi.fn(async () => {
          throw new Error('agent down')
        })
      })
    )
    expect(input.target_facts.multi_node).toBeNull()
    expect(input.target_facts.multi_node_unread).toBe(true)
    expect(buildMovePlan(input).warnings.map((w) => w.code)).toContain('MULTI_NODE_UNVERIFIED')
  })

  it('a target whose link is down → TARGET_UNREACHABLE', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-b')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const plan = buildMovePlan(
      await Gather.gatherMovePlanInput(
        e.id,
        { kind: 'shared', shared_id: sharedId },
        deps({ client: fakeClient({ fail: true }).factory })
      )
    )
    expect(plan.blockers.map((b) => b.code)).toContain('TARGET_UNREACHABLE')
  })

  it("another app's database reporting the same identity on the target → DB_IDENTITY_SHARED", async () => {
    const sharedId = await newShared()
    // Another app already placed there, on its own database record.
    const other = await newEnv({
      placement_id: await sharedPlacement(sharedId),
      db_ref: `hub-db:${await newDb()}`
    })
    const placement = await dockerPlacement('shop-c')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const fake = fakeClient()
    const plan = buildMovePlan(
      await Gather.gatherMovePlanInput(
        e.id,
        { kind: 'shared', shared_id: sharedId },
        deps({ client: fake.factory })
      )
    )
    const b = plan.blockers.find((x) => x.code === 'DB_IDENTITY_SHARED')
    expect(b?.text).toContain(`${other.appKey}/prod`)
    expect(fake.dbChecks.length).toBe(2)
  })

  it('the tenant list cannot be read → GATHER_FAILED (never "no other apps")', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-tf')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps({
        tenants: async () => {
          throw new Error('db down')
        }
      })
    )
    expect(buildMovePlan(input).blockers.map((b) => b.code)).toContain('GATHER_FAILED')
  })

  it('apps past the cap and a failed check count as unchecked → DB_IDENTITY_UNCHECKED', async () => {
    const sharedId = await newShared()
    for (let i = 0; i < 3; i++)
      await newEnv({
        placement_id: await sharedPlacement(sharedId, 2),
        db_ref: `hub-db:${await newDb()}`
      })
    const placement = await dockerPlacement('shop-cap')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const base = fakeClient().factory()
    let others = 0
    const client = {
      ...base,
      dbCheck: vi.fn(async (w: { client: string; connection: string }) => {
        if (base.dbCheck.mock.calls.length === 0) return base.dbCheck(w) // this app's own check
        others++
        if (others === 1) throw new DeploymentLinkError('LINK_UNREACHABLE')
        return base.dbCheck(w)
      })
    }
    // Own check first (dbCheck spy counts), then others: cap 2 → one past the cap, one failed.
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps({ client: (() => client) as never, identity: { max: 2, parallel: 1, budgetMs: 5_000 } })
    )
    expect(input.target_facts.identity_unchecked).toBe(2)
    const plan = buildMovePlan(input)
    expect(plan.warnings.map((w) => w.code)).toContain('DB_IDENTITY_UNCHECKED')
    expect(plan.checklist.find((c) => c.id === 'db_identity_checked')?.required).toBe(true)
  })

  it('the identity pass has one total budget; what is left past it counts as unchecked', async () => {
    const sharedId = await newShared()
    for (let i = 0; i < 2; i++)
      await newEnv({
        placement_id: await sharedPlacement(sharedId, 2),
        db_ref: `hub-db:${await newDb()}`
      })
    const placement = await dockerPlacement('shop-slow')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const base = fakeClient().factory()
    let calls = 0
    const client = {
      ...base,
      dbCheck: vi.fn(async (w: { client: string; connection: string }) => {
        calls++
        if (calls === 1) return base.dbCheck(w)
        return new Promise<never>(() => undefined) // hangs
      })
    }
    const started = Date.now()
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps({ client: (() => client) as never, identity: { budgetMs: 50 } })
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(input.target_facts.identity_unchecked).toBe(2)
  })

  it('distinct identities on the target → no DB_IDENTITY_SHARED; pool counts the other app', async () => {
    const sharedId = await newShared()
    const otherDb = await newDb()
    const { database_name } = await db('nivaro_hub_databases')
      .where({ id: otherDb })
      .first('database_name')
    const otherName = new RegExp(`/${database_name}(\\?|$)`)
    await newEnv({ placement_id: await sharedPlacement(sharedId, 7), db_ref: `hub-db:${otherDb}` })
    const placement = await dockerPlacement('shop-d')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps({
        client: fakeClient({
          identityOf: (c) => (otherName.test(c) ? 'pg|10.0.0.6|5432|other' : IDENTITY)
        }).factory
      })
    )
    expect(input.target_facts.identity_shared_with).toEqual([])
    expect(input.target_facts.pool).toEqual({ used: 7, budget: 60, asked: 5 })
  })

  it('the same external Redis db and prefix on both sides → REDIS_SHARED (Task 5 sealed secrets)', async () => {
    const sharedId = await newShared({ settings: { redis: 'external' } })
    const shared = await Store.getShared(sharedId)
    // Task 5's format: one sealed JSON of plain values.
    await db('nivaro_hub_shared_deployments')
      .where({ id: sharedId })
      .update({
        secrets: sealSecret(JSON.stringify({ REDIS_URL: 'redis://:pw@redis1.example.com:6379/2' }))
      })
    const placement = await dockerPlacement('shop-e')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    await db('nivaro_hub_stack_settings').insert({
      environment_id: e.id,
      size: 'small',
      redis: 'external',
      settings: JSON.stringify({ REDIS_CHANNEL_PREFIX: `nvr-shared-${shared?.key}:` })
    })
    stack.secrets = { REDIS_URL: 'redis://:other@redis1.example.com:6379/2' }
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps()
    )
    const plan = buildMovePlan(input)
    expect(plan.blockers.map((b) => b.code)).toContain('REDIS_SHARED')
    expect(plan.warnings.map((w) => w.code)).not.toContain('REDIS_UNVERIFIED')
    expect(JSON.stringify(input)).not.toContain('redis1.example.com')
    expect(JSON.stringify(input)).not.toContain(':pw@')
  })

  it('the same Redis host with another prefix → no REDIS_SHARED, nothing unverified', async () => {
    const sharedId = await newShared({ settings: { redis: 'external' } })
    await db('nivaro_hub_shared_deployments')
      .where({ id: sharedId })
      .update({
        secrets: sealSecret(JSON.stringify({ REDIS_URL: 'redis://redis1.example.com:6379/2' }))
      })
    const placement = await dockerPlacement('shop-e2')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    await db('nivaro_hub_stack_settings').insert({
      environment_id: e.id,
      size: 'small',
      redis: 'external',
      settings: JSON.stringify({})
    })
    stack.secrets = { REDIS_URL: 'redis://redis1.example.com:6379/2' }
    const plan = buildMovePlan(
      await Gather.gatherMovePlanInput(e.id, { kind: 'shared', shared_id: sharedId }, deps())
    )
    expect(plan.blockers.map((b) => b.code)).not.toContain('REDIS_SHARED')
    expect(plan.warnings.map((w) => w.code)).not.toContain('REDIS_UNVERIFIED')
    expect(plan.warnings.map((w) => w.code)).not.toContain('STORAGE_UNVERIFIED')
  })

  it('external Redis with no REDIS_URL the Hub can read → REDIS_UNVERIFIED', async () => {
    const sharedId = await newShared({ settings: { redis: 'external' } })
    const placement = await dockerPlacement('shop-e3')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    await db('nivaro_hub_stack_settings').insert({
      environment_id: e.id,
      size: 'small',
      redis: 'bundled',
      settings: JSON.stringify({})
    })
    const plan = buildMovePlan(
      await Gather.gatherMovePlanInput(e.id, { kind: 'shared', shared_id: sharedId }, deps())
    )
    expect(plan.warnings.map((w) => w.code)).toContain('REDIS_UNVERIFIED')
    expect(plan.checklist.find((c) => c.id === 'redis_separate')?.required).toBe(true)
  })

  it('a GitLab source: Redis unknown → REDIS_UNVERIFIED; storage known from its readiness report', async () => {
    const sharedId = await newShared()
    const g = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: gitlabDriver,
      target: JSON.stringify({ branch: 'deploy' })
    })
    const e = await newEnv({ placement_id: g, db_ref: `hub-db:${await newDb()}` })
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps()
    )
    expect(input.source.storage_provider).toBe('local')
    const plan = buildMovePlan(input)
    expect(plan.warnings.map((w) => w.code)).toContain('REDIS_UNVERIFIED')
    expect(plan.warnings.map((w) => w.code)).not.toContain('STORAGE_UNVERIFIED')
  })

  it('a lock read that fails reads as unreadable, never as free (M-1)', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-lk')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps({
        lock: { ...memoryPromoteLock, holder: async () => null, held: async () => 'unknown' },
        sharedLock: {
          take: async () => null,
          holder: async () => {
            throw new Error('redis down')
          },
          renew: async () => true,
          release: async () => undefined
        }
      })
    )
    expect(input.locks.env).toBe('unreadable')
    expect(input.locks.shared[0].holder).toBe('unreadable')
  })

  it('real Redis locks whose holder cannot be read show as unreadable in the plan (round 2)', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-rd')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const down = {
      set: async () => null,
      get: async () => {
        throw new Error('ECONNREFUSED')
      },
      del: async () => 0,
      exists: async () => 1,
      eval: async () => 0
    }
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps({ lock: redisPromoteLock(down), sharedLock: sharedLock(down) })
    )
    expect(input.locks.env).toBe('unreadable')
    expect(input.locks.shared[0].holder).toBe('unreadable')
    const plan = buildMovePlan(input)
    expect(plan.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['BUSY', 'SHARED_BUSY'])
    )
  })

  it('a lock held on the environment → BUSY; ownLocks ignores a move holder', async () => {
    const sharedId = await newShared()
    const placement = await dockerPlacement('shop-f')
    const e = await newEnv({ placement_id: placement, db_ref: `hub-db:${await newDb()}` })
    const token = await memoryPromoteLock.take(e.id, 'move')
    try {
      const busy = buildMovePlan(
        await Gather.gatherMovePlanInput(e.id, { kind: 'shared', shared_id: sharedId }, deps())
      )
      expect(busy.blockers.map((b) => b.code)).toContain('BUSY')
      const own = buildMovePlan(
        await Gather.gatherMovePlanInput(
          e.id,
          { kind: 'shared', shared_id: sharedId },
          deps({ ownLocks: true })
        )
      )
      expect(own.blockers.map((b) => b.code)).not.toContain('BUSY')
    } finally {
      if (token) await memoryPromoteLock.release(e.id, token)
    }
  })
})

describe('gatherMovePlanInput — to_dedicated and between_shared', () => {
  it('to_dedicated: reads the source on its deployment; a stack-settings key mismatch and a used placement block', async () => {
    const sharedId = await newShared()
    const target = await dockerPlacement('shop-back')
    await newEnv({ placement_id: target })
    const e = await newEnv({
      placement_id: await sharedPlacement(sharedId),
      db_ref: `hub-db:${await newDb()}`
    })
    await db('nivaro_hub_stack_settings').insert({
      environment_id: e.id,
      size: 'small',
      redis: 'bundled',
      settings: JSON.stringify({})
    })
    stack.secrets = { ENCRYPTION_KEY: 'cd'.repeat(32) }
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'dedicated', placement_id: target },
      deps()
    )
    expect(input.kind).toBe('to_dedicated')
    expect(input.source).toMatchObject({ reachable: true, version: '0.3.210' })
    const plan = buildMovePlan(input)
    const codes = plan.blockers.map((b) => b.code)
    expect(codes).toContain('APP_KEY_MISMATCH')
    expect(codes).toContain('TARGET_IN_USE')
    expect(plan.steps[3]).toBe('deploy_target')
  })

  it('between_shared: a source whose status cannot be read marks its issuer unread (M-10)', async () => {
    const a = await newShared()
    const b = await newShared()
    const e = await newEnv({
      placement_id: await sharedPlacement(a),
      db_ref: `hub-db:${await newDb()}`
    })
    const ok = fakeClient().factory()
    const broken = {
      ...ok,
      status: vi.fn(async () => {
        throw new DeploymentLinkError('LINK_UNREACHABLE')
      })
    }
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: b },
      deps({ client: ((s: { id: number }) => (s.id === a ? broken : ok)) as never })
    )
    expect(input.source.oidc_unread).toBe(true)
    expect(buildMovePlan(input).warnings.map((w) => w.code)).toContain('ISSUER_UNVERIFIED')
  })

  it('between_shared onto the same deployment → SAME_PLACEMENT; a retired target → SHARED_NOT_ACTIVE', async () => {
    const a = await newShared()
    const b = await newShared()
    await db('nivaro_hub_shared_deployments').where({ id: b }).update({ status: 'retired' })
    const e = await newEnv({
      placement_id: await sharedPlacement(a),
      db_ref: `hub-db:${await newDb()}`
    })
    const same = buildMovePlan(
      await Gather.gatherMovePlanInput(e.id, { kind: 'shared', shared_id: a }, deps())
    )
    expect(same.kind).toBe('between_shared')
    expect(same.blockers.map((x) => x.code)).toContain('SAME_PLACEMENT')
    const retired = buildMovePlan(
      await Gather.gatherMovePlanInput(e.id, { kind: 'shared', shared_id: b }, deps())
    )
    expect(retired.blockers.map((x) => x.code)).toContain('SHARED_NOT_ACTIVE')
  })
})

describe('gatherMovePlanInput — time (N-1)', () => {
  it('the identity pass budget is 15 s', () => {
    expect(Gather.IDENTITY_CHECK_BUDGET_MS).toBe(15_000)
  })

  it('the link calls of each shared side start together, not one after another', async () => {
    const a = await newShared()
    const b = await newShared()
    const e = await newEnv({
      placement_id: await sharedPlacement(a),
      db_ref: `hub-db:${await newDb()}`
    })
    const base = fakeClient().factory()
    const events: string[] = []
    const slow =
      <T>(name: string, fn: () => Promise<T>) =>
      async () => {
        events.push(`start:${name}`)
        await new Promise((r) => setTimeout(r, 30))
        events.push(`end:${name}`)
        return fn()
      }
    const clientFor = (s: { id: number }) => {
      const side = s.id === a ? 'src' : 'tgt'
      return {
        status: slow(`${side}.status`, () => base.status()),
        appStatus: (id: string) => slow(`${side}.appStatus`, () => base.appStatus(id))(),
        dbCheck: (w: { client: string; connection: string }) =>
          slow(`${side}.dbCheck`, () => base.dbCheck(w))()
      }
    }
    await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: b },
      deps({ client: clientFor as never })
    )
    const firstEnd = events.findIndex((x) => x.startsWith('end:'))
    const startedBefore = events.slice(0, firstEnd)
    for (const n of ['src.status', 'src.appStatus', 'src.dbCheck', 'tgt.status', 'tgt.dbCheck'])
      expect(startedBefore).toContain(`start:${n}`)
  })
})

describe('gatherMovePlanInput — refusals before a plan', () => {
  it('no such environment, no placement, not a move, a shared placement named as dedicated', async () => {
    expect(
      (await refusal(Gather.gatherMovePlanInput(999999, { kind: 'shared', shared_id: 1 }, deps())))
        .code
    ).toBe('NOT_FOUND')
    const loose = await newEnv()
    expect(
      (
        await refusal(
          Gather.gatherMovePlanInput(loose.id, { kind: 'shared', shared_id: 1 }, deps())
        )
      ).code
    ).toBe('NO_PLACEMENT')
    const g = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: gitlabDriver,
      target: JSON.stringify({ branch: 'deploy' })
    })
    const dedicated = await newEnv({ placement_id: await dockerPlacement('shop-g') })
    expect(
      (
        await refusal(
          Gather.gatherMovePlanInput(dedicated.id, { kind: 'dedicated', placement_id: g }, deps())
        )
      ).code
    ).toBe('NOT_A_MOVE')
    const sharedP = await sharedPlacement(await newShared())
    expect(
      (
        await refusal(
          Gather.gatherMovePlanInput(
            dedicated.id,
            { kind: 'dedicated', placement_id: sharedP },
            deps()
          )
        )
      ).code
    ).toBe('BAD_TARGET')
  })
})

describe('parseReadiness', () => {
  it('reads a report, drops an unknown warning, refuses an unknown blocker', () => {
    expect(Gather.parseReadiness(report())?.codes).toEqual([
      { code: 'ROW_SCHEDULES', level: 'blocker', detail: '2 scheduled reports' }
    ])
    expect(
      Gather.parseReadiness(
        report({ codes: [{ code: 'SOMETHING_NEW', level: 'warning', detail: 'x' }] })
      )?.codes
    ).toEqual([])
    expect(
      Gather.parseReadiness(
        report({ codes: [{ code: 'SOMETHING_NEW', level: 'blocker', detail: 'x' }] })
      )
    ).toBeNull()
    expect(Gather.parseReadiness(report({ key_fp: 'nope' }))).toBeNull()
    // A malformed issuer tenant rejects the report; it never reads as "no tenant" (M-7).
    expect(
      Gather.parseReadiness(report({ oidc: { issuer_host: 'login.example.com', tenant: 123 } }))
    ).toBeNull()
    expect(
      Gather.parseReadiness(
        report({ oidc: { issuer_host: 'login.example.com', tenant: 'x'.repeat(200) } })
      )
    ).toBeNull()
    expect(
      Gather.parseReadiness(report({ oidc: { issuer_host: 'login.example.com' } }))?.oidc
    ).toEqual({ issuer_host: 'login.example.com', tenant: null })
    expect(Gather.parseReadiness(report({ files: null }))).toBeNull()
    expect(Gather.parseReadiness({})).toBeNull()
  })
})

describe('readSharedReadiness', () => {
  it('refuses plain http to anything but this machine or a .test name before sending the token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(
      await Gather.readSharedReadiness({ base_url: 'http://shop.example.com' }, HUB_TOKEN)
    ).toEqual({
      ok: false,
      code: 'BAD_BASE_URL'
    })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('an answer bigger than 256 KB is refused, not read whole (M-8)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify(report({ pad: 'x'.repeat(300 * 1024) })), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    expect(
      await Gather.readSharedReadiness({ base_url: 'https://shop.example.com' }, HUB_TOKEN)
    ).toEqual({ ok: false, code: 'TOO_LARGE' })
    spy.mockRestore()
  })

  it('maps 404 to HUB_LINK_MISSING and 401 to HUB_LINK_REFUSED', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    spy.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    expect(
      await Gather.readSharedReadiness({ base_url: 'https://shop.example.com' }, HUB_TOKEN)
    ).toEqual({
      ok: false,
      code: 'HUB_LINK_MISSING'
    })
    spy.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    expect(
      await Gather.readSharedReadiness({ base_url: 'https://shop.example.com' }, HUB_TOKEN)
    ).toEqual({
      ok: false,
      code: 'HUB_LINK_REFUSED'
    })
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify(report()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const ok = await Gather.readSharedReadiness({ base_url: 'https://shop.example.com' }, HUB_TOKEN)
    expect(ok.ok).toBe(true)
    const [url, init] = spy.mock.calls.at(-1) as [string, RequestInit]
    expect(url).toBe('https://shop.example.com/api/hub-link/shared-readiness')
    expect(url).not.toContain(HUB_TOKEN)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${HUB_TOKEN}`)
    expect(init.redirect).toBe('error')
    spy.mockRestore()
  })
})

// ── parked wave (T15 round 4, T18 R3-6) ───────────────────────────────────────────────────────

describe('parked wave', () => {
  it('a deployedBuild read that throws → the source pins are unknown and the plan warns', async () => {
    const sharedId = await newShared()
    const e = await newEnv({
      placement_id: await dockerPlacement('shop-throw'),
      db_ref: `hub-db:${await newDb()}`
    })
    const deployedBuild = vi.fn(async () => {
      throw new Error('deploys table unreadable')
    })
    const input = await Gather.gatherMovePlanInput(
      e.id,
      { kind: 'shared', shared_id: sharedId },
      deps({ deployedBuild })
    )
    expect(deployedBuild).toHaveBeenCalled()
    expect(input.source.extension_pins).toBeNull()
    const plan = buildMovePlan(input)
    expect(plan.warnings.map((w) => w.code)).toContain('EXTENSION_PIN_UNVERIFIED')
    expect(plan.checklist.map((c) => c.id)).toContain('extension_builds_same')
  })

  it("R3-6: another environment's open move onto the placement → TARGET_IN_USE; a finished one is not", async () => {
    const sharedId = await newShared()
    const target = await dockerPlacement('shop-kept')
    const other = await newEnv({ placement_id: await sharedPlacement(sharedId) })
    const move = await insertId('nivaro_hub_moves', {
      app_id: other.appId,
      environment_id: other.id,
      from_placement_id: await sharedPlacement(sharedId),
      to_placement_id: target,
      kind: 'to_dedicated',
      routing: 'automatic',
      status: 'running',
      steps: '[]'
    })
    const e = await newEnv({
      placement_id: await sharedPlacement(sharedId),
      db_ref: `hub-db:${await newDb()}`
    })
    const gather = async () =>
      Gather.gatherMovePlanInput(e.id, { kind: 'dedicated', placement_id: target }, deps())
    const input = await gather()
    expect(input.target_facts.in_use_by).toBe(`${other.appKey}/prod`)
    expect(buildMovePlan(input).blockers.map((b) => b.code)).toContain('TARGET_IN_USE')
    for (const status of ['waiting', 'interrupted']) {
      await db('nivaro_hub_moves').where({ id: move }).update({ status })
      expect((await gather()).target_facts.in_use_by).toBe(`${other.appKey}/prod`)
    }
    await db('nivaro_hub_moves').where({ id: move }).update({ status: 'rolled_back' })
    expect((await gather()).target_facts.in_use_by).toBeNull()
  })
})
