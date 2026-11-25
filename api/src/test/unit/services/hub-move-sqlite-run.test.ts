import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub gap sqlite (0.3.215): a SQLite app's move — the db_copy step between wait_idle and the file
// copy, the copy proof at target_ready, the source checksum before release, rollback before
// release (the target copy discarded, the source lifted), crash/resume at db_copy, and the
// SQLite record a dedicated source gets. Real SQLite hub tables; fake MoveOps; fake clock.

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
const Run = await import('../../../services/hub/move/run.js')
const { healMoves } = await import('../../../services/hub/move/heal.js')
const { readMove, mergeSteps } = await import('../../../services/hub/move/rows.js')
const { MoveStepError } = await import('../../../services/hub/move/ops.js')
const { SQLITE_MOVE_STEPS } = await import('../../../services/hub/move/plan.js')
const { memoryPromoteLock, sharedLock } = await import('../../../services/hub/promote-lock.js')
const { createSqliteDatabase } = await import('../../../services/hub/db/databases.js')
type MovePlan = import('../../../services/hub/move/types.js').MovePlan
type MoveKind = import('../../../services/hub/move/types.js').MoveKind
type MoveOps = import('../../../services/hub/move/ops.js').MoveOps

const SHA = 'c'.repeat(64)
const START = Date.parse('2026-11-24T10:00:00Z')
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }
let t = START
const now = () => t
const sleep = vi.fn(async (ms: number) => {
  t += ms
  await new Promise((r) => setImmediate(r))
})
let seq = 0

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

async function world(from: 'docker' | 'shared') {
  const n = ++seq
  const shared = await insertId('nivaro_hub_shared_deployments', {
    key: `lite-${n}`,
    name: 'Lite',
    mode: 'docker',
    link_url: 'https://lite.internal.example.com',
    status: 'active',
    version_pin: '0.3.215'
  })
  const driver = await insertId('nivaro_hub_drivers', {
    kind: 'docker',
    name: `agent${n}`,
    config: JSON.stringify({ agent_url: 'https://agent.example.com' })
  })
  const dockerPlacement = await insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: driver,
    target: JSON.stringify({ stack: `lite-prod${n}` })
  })
  const sharedPlacement = await insertId('nivaro_hub_placements', {
    kind: 'shared',
    shared_deployment_id: shared,
    target: JSON.stringify({ pool_max: 2 })
  })
  const appKey = `lite${n}`
  const appId = await insertId('nivaro_hub_apps', { key: appKey, name: 'Lite' })
  const record = from === 'shared' ? (await createSqliteDatabase(null)).id : null
  const envId = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'prod',
    status: 'active',
    base_url: `https://lite${n}.apps.example.com`,
    hostnames: '[]',
    placement_id: from === 'docker' ? dockerPlacement : sharedPlacement,
    version_pin: '0.3.215',
    db_ref: record ? `hub-db:${record}` : null
  })
  const { setAppKey } = await import('../../../services/hub/shared/store.js')
  await setAppKey(envId, 'ab'.repeat(32))
  return { envId, appKey, shared, dockerPlacement, record }
}

function planOf(kind: MoveKind): MovePlan {
  return {
    kind,
    sqlite: true,
    routing: 'automatic',
    steps: [...SQLITE_MOVE_STEPS[kind]],
    route:
      kind === 'to_dedicated'
        ? [{ side: 'target', op: 'apply_stack' }]
        : [
            { side: 'source', op: 'drop_host', host: 'lite.example.com' },
            { side: 'target', op: 'add_host', host: 'lite.example.com' }
          ],
    manual_request: null,
    version: '0.3.215',
    hostnames: ['lite.example.com'],
    files: { count: 1, bytes: 10, first_pull: 'full' },
    blockers: [],
    warnings: [],
    checklist: [],
    plan_hash: 'b'.repeat(64)
  }
}

function fakeOps(moveRecord: { id: number | null } = { id: null }) {
  const calls: string[] = []
  const state = {
    copy: async (): Promise<{ sha256: string; bytes: number; migrations: number }> => ({
      sha256: SHA,
      bytes: 4096,
      migrations: 560
    }),
    sum: async () => SHA
  }
  const rec =
    <R>(name: string, out: (...a: any[]) => R) =>
    async (...a: any[]) => {
      calls.push(name)
      return out(...a)
    }
  const ops: MoveOps = {
    sourceMaintenance: rec('sourceMaintenance', (on: boolean) => {
      calls[calls.length - 1] = `sourceMaintenance:${on}`
    }),
    targetMaintenance: rec('targetMaintenance', () => undefined),
    sourceBusy: rec('sourceBusy', () => ({ imports: 0, exports: 0, renders: 0 })),
    pullFiles: rec('pullFiles', (mode: 'full' | 'delta') => ({
      state: 'done' as const,
      total: 1,
      copied: 1,
      skipped: 0,
      failed: 0,
      missing: [],
      bytes: 10,
      error: null,
      size_mismatch: 0,
      failed_ids: [],
      mode
    })),
    placeOnTarget: async () => {
      calls.push('placeOnTarget')
      // The real op makes the record a dedicated SQLite source needs (ops.ts placeOnTarget).
      if (moveRecord.id !== null) {
        const id = moveRecord.id
        const m = await db('nivaro_hub_moves').orderBy('id', 'desc').first('id')
        await mergeSteps(Number(m.id), (st) => ({ ...st, sqlite_record: id }))
      }
    },
    unplace: rec('unplace', () => undefined),
    waitReplicas: rec('waitReplicas', () => undefined),
    targetUnretire: rec('targetUnretire', () => undefined),
    targetReady: rec('targetReady', () => undefined),
    freezeTarget: rec('freezeTarget', () => undefined),
    deployTarget: rec('deployTarget', () => undefined),
    removeTarget: rec('removeTarget', () => undefined),
    route: rec('route', () => undefined),
    unroute: rec('unroute', () => undefined),
    verifyName: rec('verifyName', () => true),
    retireSource: rec('retireSource', () => undefined),
    verifyTargetKey: rec('verifyTargetKey', () => undefined),
    stopSource: rec('stopSource', () => undefined),
    targetKeyFp: rec('targetKeyFp', () => null),
    dropTempHost: rec('dropTempHost', () => null),
    revokeTickets: rec('revokeTickets', () => undefined),
    databaseIdentity: rec('databaseIdentity', () => 'never-asked'),
    copyDatabase: async () => {
      calls.push('copyDatabase')
      return state.copy()
    },
    sourceDatabaseSum: async () => {
      calls.push('sourceDatabaseSum')
      return state.sum()
    }
  }
  return { ops, calls, state }
}

function fakeRun() {
  return vi.fn(async () => ({
    id: 77,
    progress: () => undefined,
    log: () => undefined,
    complete: async () => undefined,
    fail: async () => undefined
  }))
}

let fake = fakeOps()
let plan = planOf('to_shared')

function useDeps() {
  Run.setMoveRunDeps({
    ops: () => fake.ops,
    planner: async () => plan,
    lock: memoryPromoteLock,
    sharedLock: sharedLock(null),
    now,
    sleep,
    startJobRun: fakeRun(),
    addresses: async () => ({
      source_link_base: 'https://src.direct.example.com',
      source_link_public: false,
      pull_source: 'https://src.direct.example.com',
      target_link_base: 'https://tgt.direct.example.com',
      target_publish_host: null,
      target_temp_host: null
    }),
    renewMs: 3_600_000,
    pollMs: 5_000,
    manualPollMs: 60 * 60_000
  })
}

async function start(w: Awaited<ReturnType<typeof world>>, kind: MoveKind) {
  return Run.startMove(
    w.envId,
    {
      to:
        kind === 'to_dedicated'
          ? { kind: 'dedicated', placement_id: w.dockerPlacement }
          : { kind: 'shared', shared_id: w.shared },
      plan_hash: plan.plan_hash,
      confirm: `${w.appKey}/prod`,
      checklist: {}
    } as never,
    'AAAAAAAA-0000-4000-8000-000000000001'
  )
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  for (const m of migrations) await m.up(db)
})

afterAll(async () => {
  Run.setMoveRunDeps(null)
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

beforeEach(() => {
  t = START
  fake = fakeOps()
  useDeps()
})

describe('a SQLite move: every step in order', () => {
  it('to_shared (dedicated SQLite source): copied after the freeze, the record named at release', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const rec = (await createSqliteDatabase(null)).id
    fake = fakeOps({ id: rec })
    useDeps()
    const { move_id } = await start(w, 'to_shared')
    await Run.awaitMove(move_id)
    expect(fake.calls).toEqual([
      'placeOnTarget',
      'waitReplicas',
      'sourceMaintenance:true',
      'sourceBusy',
      'copyDatabase',
      'pullFiles',
      'targetMaintenance',
      'targetUnretire',
      'targetReady',
      'route',
      'route',
      'verifyName',
      'sourceDatabaseSum',
      'targetMaintenance',
      'waitReplicas',
      'verifyTargetKey',
      'retireSource',
      'dropTempHost',
      'revokeTickets'
    ])
    const m = await readMove(move_id)
    expect(m?.status).toBe('success')
    expect(m?.steps.db_copy).toMatchObject({ sha256: SHA, bytes: 4096, migrations: 560 })
    expect(m?.steps.source_db).toBe('sqlite-copy')
    const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(env.db_ref).toBe(`hub-db:${rec}`)
    expect(Number(env.placement_id)).toBe(m?.to_placement_id)
  })

  it('to_dedicated (shared SQLite source): deployed, then copied, then ready', async () => {
    plan = planOf('to_dedicated')
    const w = await world('shared')
    const { move_id } = await start(w, 'to_dedicated')
    await Run.awaitMove(move_id)
    const at = (k: string) => fake.calls.indexOf(k)
    expect(at('deployTarget')).toBeLessThan(at('copyDatabase'))
    expect(at('sourceBusy')).toBeLessThan(at('copyDatabase'))
    expect(at('copyDatabase')).toBeLessThan(at('targetReady'))
    expect(at('copyDatabase')).toBeLessThan(at('pullFiles'))
    expect(fake.calls).not.toContain('databaseIdentity')
    expect((await readMove(move_id))?.status).toBe('success')
    // The environment keeps its SQLite record (the new stack renders it as DB_DATABASE).
    const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(env.db_ref).toBe(`hub-db:${w.record}`)
  })
})

describe('a SQLite move rolls back before release', () => {
  it('a checksum mismatch at db_copy: rolled back, target unplaced (its copy discarded), source lifted', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.copy = async () => {
      throw new MoveStepError(
        'SQLITE_CHECKSUM_MISMATCH',
        "The copy's checksum is not the source's."
      )
    }
    const { move_id } = await start(w, 'to_shared')
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('rolled_back')
    expect(m?.steps.list.find((s) => s.key === 'db_copy')?.note).toMatch(/SQLITE_CHECKSUM_MISMATCH/)
    expect(fake.calls).toContain('unplace')
    expect(fake.calls).toContain('sourceMaintenance:false')
    expect(fake.calls).not.toContain('route')
    const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(Number(env.placement_id)).toBe(w.dockerPlacement)
    expect(env.db_ref).toBeNull()
  })

  it('a source that changed after the copy: release refuses (SOURCE_CHANGED) and the move rolls back', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.sum = async () => 'd'.repeat(64)
    const { move_id } = await start(w, 'to_shared')
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('rolled_back')
    expect(m?.steps.list.find((s) => s.key === 'release')?.note).toMatch(/SOURCE_CHANGED/)
    expect(fake.calls).toContain('sourceMaintenance:false')
    const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(Number(env.placement_id)).toBe(w.dockerPlacement)
  })
})

describe('crash and resume at db_copy', () => {
  it('a run that died inside db_copy is healed and resumed: the copy runs again, then on', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const { move_id } = await start(w, 'to_shared')
    await Run.awaitMove(move_id)
    const m0 = (await readMove(move_id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const steps = structuredClone(m0.steps)
    const at = steps.list.findIndex((s) => s.key === 'db_copy')
    steps.list.forEach((s, i) => {
      s.state = i < at ? 'done' : i === at ? 'running' : 'pending'
    })
    steps.phase = 'forward'
    delete steps.db_copy
    await db('nivaro_hub_moves')
      .where({ id: move_id })
      .update({
        status: 'running',
        step: 'db_copy',
        steps: JSON.stringify(steps),
        finished_at: null,
        heartbeat_at: new Date(START - 3 * 60_000)
      })
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({ placement_id: m0.from_placement_id, status: 'maintenance' })
    await db('nivaro_hub_deploys').where({ move_id }).update({ status: 'running' })
    expect(await healMoves({ now })).toBe(1)
    expect((await readMove(move_id))?.status).toBe('interrupted')

    fake = fakeOps()
    useDeps()
    await Run.resumeMove(move_id, 'u')
    await Run.awaitMove(move_id)
    expect(fake.calls[0]).toBe('copyDatabase')
    expect(fake.calls).not.toContain('placeOnTarget')
    const m = await readMove(move_id)
    expect(m?.status).toBe('success')
    expect(m?.steps.db_copy?.sha256).toBe(SHA)
  })
})
