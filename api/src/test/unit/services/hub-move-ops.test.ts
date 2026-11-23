import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 16: the real MoveOps (services/hub/move/ops.ts) against fake clients.
// Real SQLite with the hub tables; the deployment link and the hub link are fakes passed through
// the ops' deps; replica sightings live in memory with a fake clock.

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

vi.mock('../../../services/hub/gitlab-write.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/gitlab-write.js')>()),
  latestCommitMatching: vi.fn(async () => ({ sha: 'f'.repeat(40), subject: 'release 0.3.210' }))
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
const { defaultMoveOps } = await import('../../../services/hub/move/ops.js')
const { readMove } = await import('../../../services/hub/move/rows.js')
const Sightings = await import('../../../services/hub/shared/sightings.js')
const { tenantsBody } = await import('../../../services/hub/shared/tenants.js')
const Store = await import('../../../services/hub/shared/store.js')
const { sealStoredConnection } = await import('../../../services/hub/db/stored-connection.js')
const { MOVE_STEPS } = await import('../../../services/hub/move/plan.js')
type MovePlan = import('../../../services/hub/move/types.js').MovePlan

const HUB_KEY = 'e'.repeat(64)
const TICKET = `nvt_${'K'.repeat(43)}`
const PASSWORD = 'pw-Secret-Value-123'
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

let t = Date.parse('2026-11-22T10:00:00Z')
/** R2-M-8: the Docker fake's stack stays updating while this is set. */
let converging = false
const now = () => t
const sleep = vi.fn(async (ms: number) => {
  t += ms
})

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

let seq = 0
async function setup(fromShared: boolean) {
  const n = ++seq
  const mk = (key: string, url: string) =>
    insertId('nivaro_hub_shared_deployments', {
      key: `${key}${n}`,
      name: key,
      mode: 'registered',
      link_url: url,
      status: 'active',
      version_pin: '0.3.210'
    })
  const a = await mk('src', 'https://src.internal.example.com')
  const b = await mk('dst', 'https://dst.internal.example.com')
  const pa = await insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: a,
    target: '{}'
  })
  const pb = await insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: b,
    target: '{}'
  })
  const driver = await insertId('nivaro_hub_drivers', {
    kind: 'gitlab',
    name: `gl${n}`,
    config: JSON.stringify({ api_url: 'https://gitlab.example.com', project: 'x/y' })
  })
  const pd = await insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: driver,
    target: '{}'
  })
  const dbId = await insertId('nivaro_hub_databases', {
    engine: 'pg',
    host: 'pg1.example.com',
    database_name: `db${n}`,
    login_name: `db${n}_app`,
    status: 'ready',
    adopted: true,
    connection: sealStoredConnection({
      engine: 'pg',
      host: 'pg1.example.com',
      port: 5432,
      database: `db${n}`,
      user: `db${n}_app`,
      password: PASSWORD,
      ssl_mode: 'require',
      trust_server_cert: false
    })
  })
  const appId = await insertId('nivaro_hub_apps', { key: `acme${n}`, name: 'Acme' })
  const envId = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'prod',
    status: 'maintenance',
    base_url: `https://acme${n}.example.com`,
    hostnames: '[]',
    placement_id: fromShared ? pa : pd,
    db_ref: `hub-db:${dbId}`
  })
  await Store.setAppKey(envId, 'ab'.repeat(32))
  const plan: MovePlan = {
    kind: fromShared ? 'between_shared' : 'to_shared',
    routing: 'automatic',
    steps: [...MOVE_STEPS.between_shared],
    route: [],
    manual_request: null,
    version: '0.3.210',
    hostnames: [],
    files: { count: 0, bytes: 0, first_pull: 'full' },
    blockers: [],
    warnings: [],
    checklist: [],
    plan_hash: 'f'.repeat(64)
  }
  const moveId = await insertId('nivaro_hub_moves', {
    app_id: appId,
    environment_id: envId,
    from_placement_id: fromShared ? pa : pd,
    to_placement_id: pb,
    kind: plan.kind,
    routing: 'automatic',
    status: 'running',
    steps: JSON.stringify({
      list: [],
      phase: 'forward',
      addresses: {
        source_link_base: fromShared ? null : 'https://src-direct.example.com',
        source_link_public: false,
        pull_source: fromShared
          ? 'https://src.internal.example.com'
          : 'https://src-direct.example.com',
        target_link_base: null,
        target_publish_host: null,
        target_temp_host: null
      }
    }),
    plan: JSON.stringify(plan),
    placed_at: new Date(t)
  })
  const move = (await readMove(moveId)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
  const tenant = Store.tenantIdFor({ key: `acme${n}` }, { id: envId })
  return { a, b, envId, move, plan, tenant }
}

/** A fake deployment client per shared deployment id; every call recorded. */
function clients() {
  const calls: Array<[number, string, unknown?]> = []
  const conf = {
    schema: 'ok' as 'ok' | 'failed' | 'pending',
    keyFp: null as string | null,
    pullStates: ['running', 'done'] as Array<'running' | 'done' | 'failed'>,
    dbIdentity: 'pg|pg1|5432|acme' as string | null
  }
  const make = (shared: { id: number }) => ({
    status: vi.fn(async () => {
      calls.push([shared.id, 'status'])
      return {
        apps: [
          {
            id: TENANT,
            schema: {
              state: conf.schema,
              version: null,
              error: conf.schema === 'failed' ? 'boom' : null
            }
          }
        ]
      }
    }),
    appStatus: vi.fn(async () => {
      calls.push([shared.id, 'appStatus'])
      return {
        busy: { imports: 0, exports: 0, renders: 0 },
        preflight: { status: 'ok', failing: [] },
        key_fp: conf.keyFp
      }
    }),
    refresh: vi.fn(async () => {
      calls.push([shared.id, 'refresh'])
    }),
    fileTicket: vi.fn(async () => {
      calls.push([shared.id, 'fileTicket'])
      return { ticket: TICKET, expires_at: 'x' }
    }),
    revokeTicket: vi.fn(async (_tid: string, tk: string) => {
      calls.push([shared.id, 'revokeTicket', tk === TICKET])
      return { revoked: true }
    }),
    pullFiles: vi.fn(
      async (
        _tid: string,
        req: { source: string; ticket: string; mode: string; objects?: boolean }
      ) => {
        calls.push([
          shared.id,
          'pullFiles',
          {
            source: req.source,
            mode: req.mode,
            ticket: req.ticket === TICKET,
            ...(req.objects ? { objects: true } : {})
          }
        ])
        return { run_id: 'run-1' }
      }
    ),
    pullStatus: vi.fn(async () => {
      const state = conf.pullStates.shift() ?? 'done'
      calls.push([shared.id, 'pullStatus', state])
      return {
        state,
        total: 1,
        copied: 1,
        skipped: 0,
        failed: 0,
        missing: [],
        bytes: 1,
        error: null
      }
    }),
    dbCheck: vi.fn(async (q: { connection: string }) => {
      calls.push([shared.id, 'dbCheck', q.connection.includes(PASSWORD)])
      return { reachable: true, ledger: null, db_identity: conf.dbIdentity, error: null }
    })
  })
  return { calls, conf, factory: (s: { id: number }) => make(s) as never }
}
let TENANT = ''

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  for (const m of migrations) await m.up(db)
})

afterAll(async () => {
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

beforeEach(() => {
  t = Date.parse('2026-11-22T10:00:00Z')
  sleep.mockClear()
  Sightings._setSightingsDepsForTests({ redis: Sightings.memorySightingsRedis(now), now })
})

describe('waitReplicas', () => {
  it('none seen → keeps waiting, then fails REPLICAS_BEHIND after 3 min (never "done")', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const c = clients()
    const ops = defaultMoveOps(w.move, w.plan, { client: c.factory, sleep, now })
    const err = await ops.waitReplicas(w.b).catch((e) => e)
    expect(err.code).toBe('REPLICAS_BEHIND')
    expect(err.message).toMatch(/No replica/)
    expect(t - Date.parse('2026-11-22T10:00:00Z')).toBeGreaterThanOrEqual(3 * 60_000)
  })

  it('a Redis failure is never "every replica holds it"', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const broken = {
      hset: async () => {
        throw new Error('redis down')
      },
      hgetall: async () => {
        throw new Error('redis down')
      }
    }
    Sightings._setSightingsDepsForTests({ redis: broken as never, now })
    const ops = defaultMoveOps(w.move, w.plan, { client: clients().factory, sleep, now })
    const err = await ops.waitReplicas(w.b).catch((e) => e)
    expect(err.code).toBe('REPLICAS_BEHIND')
    expect(err.message).toMatch(/Redis/)
  })

  it('every live replica holding the list → returns', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const shared = (await Store.getShared(w.b)) as NonNullable<
      Awaited<ReturnType<typeof Store.getShared>>
    >
    const { etag } = await tenantsBody(shared)
    await Sightings.recordSighting(w.b, {
      instance: 'i1',
      version: '0.3.210',
      etag,
      at: new Date(t).toISOString()
    })
    const ops = defaultMoveOps(w.move, w.plan, { client: clients().factory, sleep, now })
    await ops.waitReplicas(w.b)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('pullFiles', () => {
  it('mints the ticket on the source, starts + polls the pull on the target, revokes the ticket', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const c = clients()
    const lines: string[] = []
    const ops = defaultMoveOps(w.move, w.plan, {
      client: c.factory,
      sleep,
      now,
      log: (l) => lines.push(l)
    })
    const s = await ops.pullFiles('full')
    expect(s.state).toBe('done')
    expect(c.calls).toEqual([
      [w.a, 'fileTicket'],
      [
        w.b,
        'pullFiles',
        {
          source: 'https://src.internal.example.com/api/hub-transfer/files',
          mode: 'full',
          ticket: true
        }
      ],
      [w.b, 'pullStatus', 'running'],
      [w.b, 'pullStatus', 'done'],
      [w.a, 'revokeTicket', true]
    ])
    expect(lines.join('\n')).not.toContain(TICKET)
    // Nothing left to revoke at the move end.
    await ops.revokeTickets()
    expect(c.calls.filter((x) => x[1] === 'revokeTicket')).toHaveLength(1)
  })

  // P6-31: to a shared deployment the key prefix changes: saved-settings objects are copied too.
  it('a dedicated source to a shared target asks the pull for the saved-settings objects too', async () => {
    const w = await setup(false)
    TENANT = w.tenant
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({
        hub_token: (await import('../../../services/hub/secrets.js')).sealSecret('t'.repeat(40))
      })
    const c = clients()
    const ops = defaultMoveOps(w.move, w.plan, {
      client: c.factory,
      link: () =>
        ({
          fileTicket: async () => ({ ticket: TICKET, expires_at: '2026-11-23T00:00:00Z' }),
          revokeTicket: async () => ({ revoked: true })
        }) as never,
      sleep,
      now
    })
    await ops.pullFiles('full')
    expect(c.calls.find((x) => x[1] === 'pullFiles')?.[2]).toMatchObject({ objects: true })
  })

  // R2-M-6: a ticket a dead run could not revoke is revoked by the next run (heal + resume or
  // roll back), not left to its 6 h expiry. It is kept with the move sealed, never in clear.
  it('R2-M-6: a dead run’s un-revoked ticket is revoked by a fresh ops instance at the move end', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const c = clients()
    const factory = (fail: boolean) => (s: { id: number }) => {
      const cl = (c.factory as (s: { id: number }) => Record<string, unknown>)(s)
      const orig = cl.revokeTicket as (...a: unknown[]) => Promise<unknown>
      cl.revokeTicket = async (...a: unknown[]) => {
        if (fail) throw new Error('unreachable')
        return orig(...a)
      }
      return cl as never
    }
    const dead = defaultMoveOps(w.move, w.plan, { client: factory(true), sleep, now })
    await dead.pullFiles('delta')
    const kept = (await db('nivaro_hub_moves').where({ id: w.move.id }).first()).steps as string
    expect(kept).not.toContain(TICKET)
    expect(JSON.parse(kept).open_tickets).toHaveLength(1)
    // The process died; a new run (a new ops instance) ends the move.
    const fresh = defaultMoveOps((await readMove(w.move.id)) as never, w.plan, {
      client: factory(false),
      sleep,
      now
    })
    await fresh.revokeTickets()
    expect(c.calls.filter((x) => x[1] === 'revokeTicket')).toEqual([[w.a, 'revokeTicket', true]])
    expect((await readMove(w.move.id))?.steps.open_tickets ?? []).toEqual([])
  })

  it('a ticket that could not be revoked is revoked at the move end', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const c = clients()
    let fail = true
    const factory = (s: { id: number }) => {
      const cl = (c.factory as (s: { id: number }) => Record<string, unknown>)(s)
      const orig = cl.revokeTicket as (...a: unknown[]) => Promise<unknown>
      cl.revokeTicket = async (...a: unknown[]) => {
        if (fail) {
          fail = false
          throw new Error('unreachable')
        }
        return orig(...a)
      }
      return cl as never
    }
    const ops = defaultMoveOps(w.move, w.plan, { client: factory, sleep, now })
    await ops.pullFiles('delta')
    await ops.revokeTickets()
    expect(c.calls.filter((x) => x[1] === 'revokeTicket')).toEqual([[w.a, 'revokeTicket', true]])
  })
})

describe('maintenance and retire', () => {
  it('a dedicated source: strict maintenance with the move id, then waits 16 s (R14); off sends the move id too', async () => {
    const w = await setup(false)
    TENANT = w.tenant
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({
        hub_token: (await import('../../../services/hub/secrets.js')).sealSecret('t'.repeat(40))
      })
    const link = { maintenance: vi.fn(async () => undefined) }
    const ops = defaultMoveOps(w.move, w.plan, {
      client: clients().factory,
      link: () => link as never,
      sleep,
      now
    })
    await ops.sourceMaintenance(true)
    expect(link.maintenance).toHaveBeenCalledWith(true, w.move.id)
    expect(sleep).toHaveBeenCalledWith(16_000)
    await ops.sourceMaintenance(false)
    expect(link.maintenance).toHaveBeenLastCalledWith(false, w.move.id)
  })

  it('C-2: a dedicated source is reached on its own address after the name points at the target (maintenance on, then rollback off)', async () => {
    const w = await setup(false)
    TENANT = w.tenant
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({
        hub_token: (await import('../../../services/hub/secrets.js')).sealSecret('t'.repeat(40))
      })
    // The manual route already moved the name: the public name answers from the target now.
    const steps = { ...w.move.steps, routed: [0], route_confirmed_at: new Date(t).toISOString() }
    await db('nivaro_hub_moves')
      .where({ id: w.move.id })
      .update({ steps: JSON.stringify(steps) })
    const bases: string[] = []
    const link = { maintenance: vi.fn(async () => undefined) }
    const ops = defaultMoveOps(w.move, w.plan, {
      client: clients().factory,
      link: (base) => {
        bases.push(base)
        return link as never
      },
      sleep,
      now
    })
    await ops.sourceMaintenance(true)
    await ops.sourceMaintenance(false)
    expect(link.maintenance).toHaveBeenCalledTimes(2)
    expect(bases).toEqual(['https://src-direct.example.com', 'https://src-direct.example.com'])
    expect(bases.join()).not.toContain(
      new URL(String((await db('nivaro_hub_environments').where({ id: w.envId }).first()).base_url))
        .host
    )
  })

  it('a public-name source base is refused while a route intent stands (never sent to the target)', async () => {
    const w = await setup(false)
    TENANT = w.tenant
    const steps = {
      ...w.move.steps,
      routed: [0],
      addresses: { ...w.move.steps.addresses, source_link_public: true }
    }
    await db('nivaro_hub_moves')
      .where({ id: w.move.id })
      .update({ steps: JSON.stringify(steps) })
    const linkFn = vi.fn()
    const ops = defaultMoveOps(w.move, w.plan, {
      client: clients().factory,
      link: linkFn,
      sleep,
      now
    })
    expect((await ops.sourceMaintenance(false).catch((e) => e)).code).toBe('SOURCE_UNREACHABLE')
    expect(linkFn).not.toHaveBeenCalled()
  })

  it('a shared source is retired by the list: every replica takes it', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const c = clients()
    const ops = defaultMoveOps(w.move, w.plan, { client: c.factory, sleep, now })
    const err = await ops.retireSource().catch((e) => e)
    // No replica of the source is seen in this test: the wait fails rather than claim it.
    expect(err.code).toBe('REPLICAS_BEHIND')
    expect(c.calls[0]).toEqual([w.a, 'refresh'])
  })
})

describe('targetReady (shared target)', () => {
  it('schema failed → SCHEMA_FAILED at once', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const c = clients()
    c.conf.schema = 'failed'
    const ops = defaultMoveOps(w.move, w.plan, { client: c.factory, sleep, now })
    const err = await ops.targetReady().catch((e) => e)
    expect(err.code).toBe('SCHEMA_FAILED')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('another key fingerprint → APP_KEY_MISMATCH; the right one → ready', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const c = clients()
    c.conf.keyFp = '0'.repeat(32)
    const ops = defaultMoveOps(w.move, w.plan, { client: c.factory, sleep, now })
    expect((await ops.targetReady().catch((e) => e)).code).toBe('APP_KEY_MISMATCH')
    const { keyFingerprint } = await import('../../../services/app-key-fingerprint.js')
    c.conf.keyFp = keyFingerprint('ab'.repeat(32))
    await ops.targetReady()
  })
})

describe('databaseIdentity and verifyName', () => {
  it('a shared side checks the app’s own database record through its link; the password never leaves the call', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const c = clients()
    const lines: string[] = []
    const ops = defaultMoveOps(w.move, w.plan, {
      client: c.factory,
      sleep,
      now,
      log: (l) => lines.push(l)
    })
    expect(await ops.databaseIdentity('target')).toBe('pg|pg1|5432|acme')
    expect(c.calls).toContainEqual([w.b, 'dbCheck', true])
    c.conf.dbIdentity = null
    expect(await ops.databaseIdentity('source')).toBeNull()
    expect(lines.join('\n')).not.toContain(PASSWORD)
  })

  it('verifyName: a shared target must name its key and the tenant; a dedicated one neither', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    let body: Record<string, unknown> = {}
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    const ops = defaultMoveOps(w.move, w.plan, {
      client: clients().factory,
      fetch: fetch as never,
      sleep,
      now
    })
    body = { version: '0.3.210', shared_deployment: 'dst', tenant: w.tenant }
    expect(await ops.verifyName({ version: '0.3.210', shared: 'dst' })).toBe(true)
    body = { version: '0.3.210', shared_deployment: 'dst', tenant: 'other-e1' }
    expect(await ops.verifyName({ version: '0.3.210', shared: 'dst' })).toBe(false)
    body = { version: '0.3.209', shared_deployment: 'dst', tenant: w.tenant }
    expect(await ops.verifyName({ version: '0.3.210', shared: 'dst' })).toBe(false)
    body = { version: '0.3.210' }
    expect(await ops.verifyName({ version: '0.3.210', shared: null })).toBe(true)
    body = { version: '0.3.210', shared_deployment: 'dst' }
    expect(await ops.verifyName({ version: '0.3.210', shared: null })).toBe(false)
  })

  it('placeOnTarget sets placed_at and unplace clears it', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    await db('nivaro_hub_moves').where({ id: w.move.id }).update({ placed_at: null })
    const ops = defaultMoveOps(w.move, w.plan, { client: clients().factory, sleep, now })
    await ops.placeOnTarget()
    expect((await readMove(w.move.id))?.placed_at).not.toBeNull()
    await ops.unplace()
    expect((await readMove(w.move.id))?.placed_at).toBeNull()
  })
})

describe('deployTarget on Docker (R9: the target gets the app key, never a fresh one)', () => {
  async function dockerTarget(stackKey?: string, fetchImpl?: typeof fetch) {
    const w = await setup(true)
    TENANT = w.tenant
    const driver = await insertId('nivaro_hub_drivers', {
      kind: 'docker',
      name: `agent${w.envId}`,
      config: JSON.stringify({ agent_url: 'https://agent.example.com', dns_mode: 'manual' })
    })
    const pd = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: driver,
      target: JSON.stringify({ stack: `acme-t${w.envId}` })
    })
    const steps = {
      list: [],
      phase: 'forward',
      addresses: {
        source_link_base: null,
        source_link_public: false,
        pull_source: 'https://src.internal.example.com',
        target_link_base: `https://hub-move-e${w.envId}-x.example.com`,
        target_publish_host: null,
        target_temp_host: `hub-move-e${w.envId}-x.example.com`
      }
    }
    await db('nivaro_hub_moves')
      .where({ id: w.move.id })
      .update({ to_placement_id: pd, steps: JSON.stringify(steps), kind: 'to_dedicated' })
    if (stackKey) {
      const { saveStackSettings } = await import('../../../services/hub/docker/stack-settings.js')
      const { sealSecret } = await import('../../../services/hub/secrets.js')
      await saveStackSettings(w.envId, {
        size: 'small',
        redis: 'bundled',
        publish_port: null,
        settings: {},
        secrets: sealSecret(JSON.stringify({ ENCRYPTION_KEY: sealSecret(stackKey) }))
      })
    }
    const move = (await readMove(w.move.id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const applied: Array<{ name: string; spec: Record<string, unknown> }> = []
    const agent = {
      agentHealth: vi.fn(async () => ({
        edge: 'traefik',
        host_suffixes: ['example.com'],
        images: ['nodeworks/nivaro', 'registry.example.com/ext-x'],
        publish_ports: null
      })),
      agentApply: vi.fn(async (_d: unknown, name: string, spec: Record<string, unknown>) => {
        applied.push({ name, spec })
        return { spec_hash: 'a'.repeat(64), changed: ['web'], unchanged: [] }
      }),
      agentStack: vi.fn(async () => ({
        state: converging ? 'updating' : 'converged',
        image: `nodeworks/nivaro@sha256:${'b'.repeat(64)}`
      }))
    }
    const ops = defaultMoveOps(
      move,
      { ...w.plan, kind: 'to_dedicated' },
      {
        client: clients().factory,
        sleep,
        now,
        agent: agent as never,
        docker: { agent: agent as never, hubPublicUrl: () => 'https://hub.example.com' },
        imageDigest: async () => `sha256:${'b'.repeat(64)}`,
        fetch: fetchImpl
      }
    )
    return { w, ops, applied }
  }

  it('the stack settings and the applied spec carry the app key; boots in maintenance on the per-move name', async () => {
    const { w, ops, applied } = await dockerTarget()
    await ops.deployTarget()
    const { readStackSettings, openStackSecrets } = await import(
      '../../../services/hub/docker/stack-settings.js'
    )
    expect(openStackSecrets(await readStackSettings(w.envId)).ENCRYPTION_KEY).toBe('ab'.repeat(32))
    expect(applied).toHaveLength(1)
    const spec = applied[0].spec as {
      secrets: Record<string, string>
      env: Record<string, string>
      hostnames: string[]
    }
    expect(spec.secrets.ENCRYPTION_KEY).toBe('ab'.repeat(32))
    expect(spec.env.HUB_BOOT_MAINTENANCE).toBe(String(w.move.id))
    expect(spec.hostnames).toEqual([`hub-move-e${w.envId}-x.example.com`])
  })

  it('a shared source: the target installs the source deployment’s extension pins, never the environment’s own', async () => {
    const SRC_PIN = `registry.example.com/ext-x@sha256:${'1'.repeat(64)}`
    const ENV_PIN = `registry.example.com/ext-x@sha256:${'2'.repeat(64)}`
    const { w, ops, applied } = await dockerTarget()
    await db('nivaro_hub_apps')
      .where({ id: w.move.app_id })
      .update({ extensions: JSON.stringify(['x']) })
    await db('nivaro_hub_shared_deployments')
      .where({ id: w.a })
      .update({ extensions: JSON.stringify(['x']), extension_pins: JSON.stringify({ x: SRC_PIN }) })
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({ extension_pins: JSON.stringify({ x: ENV_PIN }) })
    await ops.deployTarget()
    expect((applied[0].spec as { extensions: Record<string, string> }).extensions).toEqual({
      x: SRC_PIN
    })
    const env = await db('nivaro_hub_environments').where({ id: w.envId }).first('extension_pins')
    expect(JSON.parse(env.extension_pins)).toEqual({ x: SRC_PIN })
    // R2-M-2: the pins it replaced are kept with the move for a rollback.
    expect((await readMove(w.move.id))?.steps.prev_extension_pins).toBe(
      JSON.stringify({ x: ENV_PIN })
    )
  })

  it('P6-26: the target route keeps the per-move name (the freeze address) and boot maintenance; targetMaintenance(true) sends nothing', async () => {
    const { w, ops, applied } = await dockerTarget()
    // The move's mirror deploy row: deployTarget records what the stack runs on it.
    await db('nivaro_hub_deploys').insert({
      app_id: w.move.app_id,
      environment_id: w.envId,
      kind: 'move',
      move_id: w.move.id,
      version: '0.3.210',
      from_version: '0.3.210',
      status: 'running',
      step: 'deploy_target',
      plan: JSON.stringify({ move_id: w.move.id, steps: [] }),
      started_at: new Date(),
      heartbeat_at: new Date()
    })
    await ops.deployTarget()
    await ops.targetMaintenance(true)
    await ops.route({ side: 'target', op: 'apply_stack' } as never)
    expect(applied).toHaveLength(2)
    const spec = applied[1].spec as { env: Record<string, string>; hostnames: string[] }
    expect(spec.hostnames).toContain(`hub-move-e${w.envId}-x.example.com`)
    expect(spec.env.HUB_BOOT_MAINTENANCE).toBe(String(w.move.id))
  })

  async function mirrorRow(w: Awaited<ReturnType<typeof dockerTarget>>['w']) {
    await db('nivaro_hub_deploys').insert({
      app_id: w.move.app_id,
      environment_id: w.envId,
      kind: 'move',
      move_id: w.move.id,
      version: '0.3.210',
      from_version: '0.3.210',
      status: 'running',
      step: 'deploy_target',
      plan: JSON.stringify({ move_id: w.move.id, steps: [] }),
      started_at: new Date(),
      heartbeat_at: new Date()
    })
  }

  it('P6-27: dropTempHost re-applies with only the environment’s names, no boot maintenance, and waits until the name stops serving', async () => {
    let answers = 2
    const probe = vi.fn(
      async (_url: string) => new Response('{}', { status: answers-- > 0 ? 200 : 404 })
    )
    const { w, ops, applied } = await dockerTarget(undefined, probe as never)
    await mirrorRow(w)
    await ops.deployTarget()
    const temp = `hub-move-e${w.envId}-x.example.com`
    expect(await ops.dropTempHost()).toBe(temp)
    const spec = applied.at(-1)?.spec as { env: Record<string, string>; hostnames: string[] }
    expect(spec.hostnames).not.toContain(temp)
    expect(spec.hostnames.length).toBeGreaterThan(0)
    expect(spec.env.HUB_BOOT_MAINTENANCE).toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(3)
    expect(String(probe.mock.calls[0][0])).toBe(`https://${temp}/api/version`)
  })

  it('P6-27: a name that keeps serving after two minutes → TEMP_HOST_STILL_SERVED', async () => {
    const probe = vi.fn(async () => new Response('{}', { status: 200 }))
    const { w, ops } = await dockerTarget(undefined, probe as never)
    await mirrorRow(w)
    await ops.deployTarget()
    expect((await ops.dropTempHost().catch((e) => e))?.code).toBe('TEMP_HOST_STILL_SERVED')
  })

  // R2-M-8: a route apply waits for the route step's own 10-minute budget, not 30 minutes.
  it('R2-M-8: a route apply that never converges stops at the route deadline, not after 30 minutes', async () => {
    const { w, ops } = await dockerTarget()
    await mirrorRow(w)
    await ops.deployTarget()
    // From here the stack never converges.
    converging = true
    const start = t
    const err = await ops
      .route({ side: 'target', op: 'apply_stack' } as never, { deadline: start + 10 * 60_000 })
      .catch((e) => e)
    converging = false
    expect(err?.code).toBe('ROUTE_TIMEOUT')
    expect(t - start).toBeLessThan(11 * 60_000)
  })

  it('stack settings holding another key → APP_KEY_MISMATCH, nothing applied', async () => {
    const { ops, applied } = await dockerTarget('cd'.repeat(32))
    const err = await ops.deployTarget().catch((e) => e)
    expect(err.code).toBe('APP_KEY_MISMATCH')
    expect(applied).toEqual([])
  })
})

describe('deployTarget on GitLab (P6-20: boot maintenance rides the deploy job)', () => {
  it('sends HUB_BOOT_MAINTENANCE=<move id> as a pipeline variable on the deploy trigger', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const driver = await insertId('nivaro_hub_drivers', {
      kind: 'gitlab',
      name: `gl-t${w.envId}`,
      config: JSON.stringify({
        api: 'https://gitlab.example.com',
        project: 'acme/acme-deploy',
        branch: 'prod',
        deploy_job: 'deploy',
        pin_file: '.hub/nivaro-version'
      })
    })
    const pd = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: driver,
      target: '{}'
    })
    await insertId('nivaro_hub_components', {
      placement_id: pd,
      position: 0,
      name: 'api',
      kind: 'api',
      driver_id: driver,
      source_branch: 'main',
      verify_url: 'https://acme-direct.example.com/api/version'
    })
    await db('nivaro_hub_moves').where({ id: w.move.id }).update({ to_placement_id: pd })
    const move = (await readMove(w.move.id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const sent: Array<{ via: string; variables: Record<string, string> | undefined }> = []
    const ops = defaultMoveOps(
      move,
      { ...w.plan, kind: 'to_dedicated' },
      {
        client: clients().factory,
        sleep,
        now,
        imageDigest: async () => `sha256:${'b'.repeat(64)}`,
        gitlabWrite: {
          runDeployJob: (async (
            _c: unknown,
            _r: string,
            _s: string,
            o: { variables?: Record<string, string> }
          ) => {
            sent.push({ via: 'runDeployJob', variables: o.variables })
            return { status: 'success', job: {} }
          }) as never,
          playJob: (async (_c: unknown, _id: number, v?: Record<string, string>) => {
            sent.push({ via: 'playJob', variables: v })
            return {}
          }) as never
        },
        // The promotion's own runner, reduced to the two calls it makes on the GitLab side.
        deployComponent: (async (
          _step: unknown,
          _v: string,
          _ctx: unknown,
          _log: unknown,
          opts?: { deps?: { gitlab?: Record<string, (...a: unknown[]) => Promise<unknown>> } }
        ) => {
          const g = opts?.deps?.gitlab ?? {}
          await g.runDeployJob?.({}, 'prod', 'f'.repeat(40), { deploy: 'deploy', minutes: 60 })
          await g.playJob?.({}, 5)
          return { status: 'success', step: 'deploy api', error: null }
        }) as never
      }
    )
    await ops.deployTarget()
    expect(sent).toEqual([
      { via: 'runDeployJob', variables: { HUB_BOOT_MAINTENANCE: String(w.move.id) } },
      { via: 'playJob', variables: { HUB_BOOT_MAINTENANCE: String(w.move.id) } }
    ])
  })
})

describe('removeTarget on GitLab (R3-I-1)', () => {
  it('a retire that fails is reported (TARGET_NOT_STOPPED), never taken as stopped', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({
        hub_token: (await import('../../../services/hub/secrets.js')).sealSecret('t'.repeat(40))
      })
    const steps = {
      ...w.move.steps,
      addresses: { ...w.move.steps.addresses, target_link_base: 'https://acme-direct.example.com' }
    }
    // The move's target is the GitLab placement of this world (setup(false) placement pd).
    const driver = await insertId('nivaro_hub_drivers', {
      kind: 'gitlab',
      name: `glr${w.envId}`,
      config: JSON.stringify({ api: 'https://gitlab.example.com', project: 'a/b' })
    })
    const pd = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: driver,
      target: '{}'
    })
    await db('nivaro_hub_moves')
      .where({ id: w.move.id })
      .update({ to_placement_id: pd, steps: JSON.stringify(steps) })
    const move = (await readMove(w.move.id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const retire = vi.fn(async () => {
      throw new Error('unreachable')
    })
    const ops = defaultMoveOps(move, w.plan, {
      client: clients().factory,
      link: () => ({ retire }) as never,
      sleep,
      now
    })
    const err = await ops.removeTarget().catch((e) => e)
    expect(retire).toHaveBeenCalledWith(w.move.id)
    expect(err?.code).toBe('TARGET_NOT_STOPPED')
  })
})

// P6-26 Rule 1: a dedicated target is frozen on its own address and the freeze is read back.
describe('freezeTarget on GitLab (P6-26 Rule 1)', () => {
  async function gitlabTarget(link: Record<string, unknown>) {
    const w = await setup(true)
    TENANT = w.tenant
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({
        hub_token: (await import('../../../services/hub/secrets.js')).sealSecret('t'.repeat(40))
      })
    const steps = {
      ...w.move.steps,
      addresses: { ...w.move.steps.addresses, target_link_base: 'https://acme-direct.example.com' }
    }
    const driver = await insertId('nivaro_hub_drivers', {
      kind: 'gitlab',
      name: `glf${w.envId}`,
      config: JSON.stringify({ api: 'https://gitlab.example.com', project: 'a/b' })
    })
    const pd = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: driver,
      target: '{}'
    })
    await db('nivaro_hub_moves')
      .where({ id: w.move.id })
      .update({ to_placement_id: pd, steps: JSON.stringify(steps) })
    const move = (await readMove(w.move.id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const bases: string[] = []
    const ops = defaultMoveOps(move, w.plan, {
      client: clients().factory,
      link: (base: string) => {
        bases.push(base)
        return link as never
      },
      sleep,
      now
    })
    return { w, ops, bases }
  }
  const status = (s: { maintenance: boolean | null; retired: boolean }) =>
    vi.fn(async () => ({ version: '0.3.210', preflight: { status: 'ok', failing: [] }, ...s }))

  it('maintenance on with the move id, read back, on the target’s own address (never the public name)', async () => {
    const maintenance = vi.fn(async () => undefined)
    const retire = vi.fn(async () => undefined)
    const { w, ops, bases } = await gitlabTarget({
      maintenance,
      retire,
      status: status({ maintenance: true, retired: false })
    })
    await ops.freezeTarget()
    expect(maintenance).toHaveBeenCalledWith(true, w.move.id)
    expect(retire).not.toHaveBeenCalled()
    expect(bases).toEqual(['https://acme-direct.example.com'])
  })

  it('maintenance not read back → retire, read back retired → frozen', async () => {
    const retire = vi.fn(async () => undefined)
    const st = vi
      .fn()
      .mockResolvedValueOnce({ maintenance: false, retired: false })
      .mockResolvedValueOnce({ maintenance: false, retired: true })
    const { w, ops } = await gitlabTarget({
      maintenance: vi.fn(async () => undefined),
      retire,
      status: st
    })
    await ops.freezeTarget()
    expect(retire).toHaveBeenCalledWith(w.move.id)
  })

  it('neither proven → TARGET_NOT_FROZEN (an accepted call alone is never a freeze)', async () => {
    const { ops } = await gitlabTarget({
      maintenance: vi.fn(async () => undefined),
      retire: vi.fn(async () => undefined),
      status: status({ maintenance: false, retired: false })
    })
    expect((await ops.freezeTarget().catch((e) => e))?.code).toBe('TARGET_NOT_FROZEN')
  })

  it('removeTarget: a retire answered but not read back retired → TARGET_NOT_STOPPED', async () => {
    const { ops } = await gitlabTarget({
      retire: vi.fn(async () => undefined),
      status: status({ maintenance: null, retired: false })
    })
    expect((await ops.removeTarget().catch((e) => e))?.code).toBe('TARGET_NOT_STOPPED')
  })
})

// R2-M-7: a cancel reaches the GitLab target's deploy (the promotion runner polls stopRequested
// at every wait and before playing a manual job), instead of waiting for the whole deploy job.
describe('deployTarget on GitLab is cancellable (R2-M-7)', () => {
  it('passes the run’s cancel check to the deploy as stopRequested; a stopped deploy is ABORTED', async () => {
    const w = await setup(true)
    TENANT = w.tenant
    const driver = await insertId('nivaro_hub_drivers', {
      kind: 'gitlab',
      name: `gl-c${w.envId}`,
      config: JSON.stringify({
        api: 'https://gitlab.example.com',
        project: 'acme/acme-deploy',
        branch: 'prod',
        deploy_job: 'deploy',
        pin_file: '.hub/nivaro-version'
      })
    })
    const pd = await insertId('nivaro_hub_placements', {
      kind: 'dedicated',
      driver_id: driver,
      target: '{}'
    })
    await insertId('nivaro_hub_components', {
      placement_id: pd,
      position: 0,
      name: 'api',
      kind: 'api',
      driver_id: driver,
      source_branch: 'main',
      verify_url: 'https://acme-direct.example.com/api/version'
    })
    await db('nivaro_hub_moves').where({ id: w.move.id }).update({ to_placement_id: pd })
    const move = (await readMove(w.move.id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    let asked = 0
    const ops = defaultMoveOps(
      move,
      { ...w.plan, kind: 'to_dedicated' },
      {
        client: clients().factory,
        sleep,
        now,
        imageDigest: async () => `sha256:${'b'.repeat(64)}`,
        deployComponent: (async (
          _step: unknown,
          _v: string,
          _ctx: unknown,
          _log: unknown,
          opts?: { deps?: { stopRequested?: () => Promise<boolean> } }
        ) => {
          if (await opts?.deps?.stopRequested?.())
            return { status: 'cancelled', step: 'deploy api', error: 'Stopped', code: 'ABORTED' }
          return { status: 'success', step: 'deploy api', error: null }
        }) as never
      }
    )
    const err = await ops
      .deployTarget({
        stopRequested: async () => {
          asked++
          return true
        }
      })
      .catch((e) => e)
    expect(asked).toBeGreaterThan(0)
    expect(err?.code).toBe('ABORTED')
  })
})
