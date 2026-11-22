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
    steps: JSON.stringify({ list: [], phase: 'forward' }),
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
      async (_tid: string, req: { source: string; ticket: string; mode: string }) => {
        calls.push([
          shared.id,
          'pullFiles',
          { source: req.source, mode: req.mode, ticket: req.ticket === TICKET }
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
