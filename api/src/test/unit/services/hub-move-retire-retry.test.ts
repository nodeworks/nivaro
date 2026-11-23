import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, untested path 2: `retire_source` checks the new home's app key fingerprint
// before it retires the old home (E2E B4, F4-1). When that check fails (APP_KEY_MISMATCH /
// APP_KEY_UNKNOWN) through its whole retry window, and then the key is fixed and the move is
// retried. Real SQLite with the hub tables (542–553), the real run, rollback, heal, tenants list
// and MOVE_OPEN; only the move's side effects are a fake MoveOps (its key check reads a flag the
// test flips when "the key is fixed").
//
// Expected: the move stays open (interrupted) with a clear reason; the old home is never retired
// on a failed check — a shared source keeps listing the app; MOVE_OPEN keeps refusing
// person-started actions meanwhile; Cancel / Roll back answer TOO_LATE (the app already serves
// from its new home); Resume after the key is fixed checks it again and retires the old home.

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
const { readMove } = await import('../../../services/hub/move/rows.js')
const { MoveStepError } = await import('../../../services/hub/move/ops.js')
const { MOVE_STEPS } = await import('../../../services/hub/move/plan.js')
const { memoryPromoteLock, sharedLock } = await import('../../../services/hub/promote-lock.js')
const { moveOpenRefusal } = await import('../../../services/hub/move-open.js')
const { startPromotion } = await import('../../../services/hub/promote-run.js')
const { tenantsOf } = await import('../../../services/hub/shared/tenants.js')
const Store = await import('../../../services/hub/shared/store.js')
type MovePlan = import('../../../services/hub/move/types.js').MovePlan
type MoveKind = import('../../../services/hub/move/types.js').MoveKind
type MoveOps = import('../../../services/hub/move/ops.js').MoveOps

const HUB_KEY = 'e'.repeat(64)
const SECRET_KEY = 'ab'.repeat(32)
const START = Date.parse('2026-11-22T10:00:00Z')
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
  const sharedA = await insertId('nivaro_hub_shared_deployments', {
    key: `shared-a${n}`,
    name: 'A',
    mode: 'docker',
    link_url: 'https://a.internal.example.com',
    status: 'active',
    version_pin: '0.3.210'
  })
  const sharedB = await insertId('nivaro_hub_shared_deployments', {
    key: `shared-b${n}`,
    name: 'B',
    mode: 'docker',
    link_url: 'https://b.internal.example.com',
    status: 'active',
    version_pin: '0.3.210'
  })
  const driver = await insertId('nivaro_hub_drivers', {
    kind: 'docker',
    name: `agent${n}`,
    config: JSON.stringify({ agent_url: 'https://agent.example.com' })
  })
  const dockerPlacement = await insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: driver,
    target: JSON.stringify({ stack: `acme-prod${n}` })
  })
  const sharedPlacementA = await insertId('nivaro_hub_placements', {
    kind: 'shared',
    driver_id: null,
    shared_deployment_id: sharedA,
    target: JSON.stringify({ pool_max: 5 })
  })
  const appKey = `acme${n}`
  const appId = await insertId('nivaro_hub_apps', { key: appKey, name: 'Acme' })
  const envId = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'prod',
    status: 'active',
    base_url: `https://acme${n}.apps.example.com`,
    hostnames: '[]',
    placement_id: from === 'docker' ? dockerPlacement : sharedPlacementA,
    version_pin: '0.3.210'
  })
  await Store.setAppKey(envId, SECRET_KEY)
  return { envId, appKey, sharedA, sharedB, dockerPlacement, sharedPlacementA }
}
type World = Awaited<ReturnType<typeof world>>

function planOf(kind: MoveKind): MovePlan {
  return {
    kind,
    routing: 'automatic',
    steps: [...MOVE_STEPS[kind]],
    route:
      kind === 'to_dedicated'
        ? [{ side: 'target', op: 'apply_stack' }]
        : [
            { side: 'source', op: 'drop_host', host: 'acme.example.com' },
            { side: 'target', op: 'add_host', host: 'acme.example.com' }
          ],
    manual_request: null,
    version: '0.3.210',
    hostnames: ['acme.example.com'],
    files: { count: 3, bytes: 30, first_pull: 'full' },
    blockers: [],
    warnings: [],
    checklist: [],
    plan_hash: 'a'.repeat(64)
  }
}

/** The new home's key as the check sees it: wrong until the test fixes it. */
const key = { state: 'mismatch' as 'mismatch' | 'unknown' | 'ok' }

function fakeOps() {
  const calls: string[] = []
  const rec =
    <A extends unknown[], R>(name: string, out: (...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      calls.push(name)
      return (await out(...a)) as Awaited<R>
    }
  const ops: MoveOps = {
    sourceMaintenance: rec('sourceMaintenance', () => undefined),
    targetMaintenance: rec('targetMaintenance', () => undefined),
    sourceBusy: rec('sourceBusy', () => ({ imports: 0, exports: 0, renders: 0 })),
    pullFiles: rec('pullFiles', (mode: 'full' | 'delta') => ({
      state: 'done' as const,
      total: 3,
      copied: mode === 'full' ? 3 : 0,
      skipped: mode === 'full' ? 0 : 3,
      failed: 0,
      missing: [],
      bytes: 30,
      error: null,
      size_mismatch: 0,
      failed_ids: []
    })),
    placeOnTarget: rec('placeOnTarget', () => undefined),
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
    verifyTargetKey: rec('verifyTargetKey', () => {
      if (key.state === 'mismatch')
        throw new MoveStepError(
          'APP_KEY_MISMATCH',
          "The new home seals this app's values with another key than the app's own."
        )
      if (key.state === 'unknown')
        throw new MoveStepError(
          'APP_KEY_UNKNOWN',
          'The new home holds no encryption key for this app.'
        )
    }),
    dropTempHost: rec('dropTempHost', () => null as string | null),
    revokeTickets: rec('revokeTickets', () => undefined),
    databaseIdentity: rec('databaseIdentity', () => 'pg|db.internal|5432|acme')
  }
  return { ops, calls }
}

let fake = fakeOps()
let plan = planOf('to_shared')
const runOut = { failed: [] as string[], completed: [] as string[] }

function useDeps() {
  Run.setMoveRunDeps({
    ops: () => fake.ops,
    planner: async () => plan,
    lock: memoryPromoteLock,
    sharedLock: sharedLock(null),
    now,
    sleep,
    startJobRun: async () => ({
      id: 77,
      progress: () => undefined,
      log: () => undefined,
      complete: async (o?: string) => void runOut.completed.push(o ?? 'done'),
      fail: async (err: unknown) => void runOut.failed.push((err as Error).message)
    }),
    addresses: async () => ({
      source_link_base: 'https://src.direct.example.com',
      source_link_public: false,
      pull_source: 'https://src.direct.example.com',
      target_link_base: null,
      target_publish_host: null,
      target_temp_host: null
    }),
    renewMs: 3_600_000,
    pollMs: 5_000,
    manualPollMs: 60 * 60_000
  } as never)
}

const toFor = (kind: MoveKind, w: World) =>
  kind === 'to_dedicated'
    ? { kind: 'dedicated', placement_id: w.dockerPlacement }
    : { kind: 'shared', shared_id: kind === 'to_shared' ? w.sharedA : w.sharedB }

async function startMove(w: World, kind: MoveKind): Promise<number> {
  plan = planOf(kind)
  const { move_id } = await Run.startMove(
    w.envId,
    {
      to: toFor(kind, w),
      plan_hash: plan.plan_hash,
      confirm: `${w.appKey}/prod`,
      checklist: {}
    } as never,
    'AAAAAAAA-0000-4000-8000-000000000001'
  )
  await Run.awaitMove(move_id)
  return move_id
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; statusCode?: number }> {
  try {
    await p
  } catch (err) {
    return err as { code: string; statusCode?: number }
  }
  throw new Error('expected a refusal')
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
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
  key.state = 'mismatch'
  fake = fakeOps()
  runOut.failed = []
  runOut.completed = []
  useDeps()
})

for (const kind of ['to_shared', 'to_dedicated', 'between_shared'] as MoveKind[]) {
  describe(`${kind}: the key check at retire_source fails, then the key is fixed`, () => {
    it('stays open with a clear reason, never retires, MOVE_OPEN refuses; Resume retires', async () => {
      const w = await world(kind === 'to_shared' ? 'docker' : 'shared')
      const id = await startMove(w, kind)
      const m = await readMove(id)

      // Open, with a clear reason: the code, what it means, what to do.
      expect(m?.status).toBe('interrupted')
      expect(m?.error).toMatch(/^APP_KEY_MISMATCH: /)
      expect(m?.error).toContain('the old home was not retired')
      expect(m?.error).toContain('then Resume the move')
      expect(m?.finished_at).toBeNull()
      // The check was retried (about a minute) before the run stopped.
      expect(fake.calls.filter((c) => c === 'verifyTargetKey').length).toBeGreaterThanOrEqual(3)
      // The old home is never retired on a failed check.
      expect(fake.calls).not.toContain('retireSource')
      const step = m?.steps.list.find((s) => s.key === 'retire_source')
      expect(step?.state).not.toBe('done')
      expect(m?.steps.list.find((s) => s.key === 'release')?.state).toBe('done')
      expect(m?.step).not.toBe('retire_source')
      // The checklist says the same, not "retire by hand".
      const item = m?.checklist.find((c) => c.id === 'retire_source')
      expect(item?.done).toBe(false)
      expect(item?.text).toMatch(/^Do not retire the old home yet\./)
      // The deploy row and the job run say interrupted, never success.
      expect((await db('nivaro_hub_deploys').where({ move_id: id }).first()).status).toBe(
        'interrupted'
      )
      expect(runOut.completed).toEqual([])
      expect(runOut.failed.at(-1)).toMatch(/APP_KEY_MISMATCH/)
      // Never a key in the record.
      expect(JSON.stringify(m)).not.toContain(SECRET_KEY)

      // A shared source keeps listing the app (in maintenance) until it is really retired.
      if (kind !== 'to_shared') {
        const listed = await tenantsOf((await Store.getShared(w.sharedA)) as never)
        const row = listed.find((r) => r.env.id === w.envId)
        expect(row?.wireStatus).toBe('maintenance')
      }

      // MOVE_OPEN keeps refusing person-started actions meanwhile.
      expect(await moveOpenRefusal({ envIds: [w.envId] })).toMatchObject({
        code: 'MOVE_OPEN',
        status: 409,
        move_id: id
      })
      expect(
        await refusal(
          startPromotion(w.envId, {
            kind: 'promote',
            version: '0.3.210',
            confirm: 'prod',
            planHash: 'x',
            user: { id: 'u' }
          })
        )
      ).toMatchObject({ code: 'MOVE_OPEN' })
      // A heal leaves it as it is (it holds no lock and no heartbeat on purpose).
      t += 60 * 60_000
      await healMoves({ now })
      expect((await readMove(id))?.status).toBe('interrupted')
      // The app already serves from its new home: nothing can roll it back.
      expect(await refusal(Run.cancelMove(id, 'u'))).toMatchObject({ code: 'TOO_LATE' })

      // Resume while the key is still wrong: checked again, still not retired, still open.
      fake = fakeOps()
      useDeps()
      await Run.resumeMove(id, 'u')
      await Run.awaitMove(id)
      expect((await readMove(id))?.status).toBe('interrupted')
      expect(fake.calls).not.toContain('retireSource')

      // The key is fixed; Resume checks it and retires the old home.
      key.state = 'ok'
      fake = fakeOps()
      useDeps()
      await Run.resumeMove(id, 'u')
      await Run.awaitMove(id)
      const done = await readMove(id)
      expect(done?.status).toBe('success')
      expect(done?.error).toBeNull()
      expect(fake.calls.slice(0, 2)).toEqual(['verifyTargetKey', 'retireSource'])
      expect(fake.calls).not.toContain('placeOnTarget')
      expect(fake.calls).not.toContain('route')
      expect(done?.steps.list.every((s) => s.state === 'done')).toBe(true)
      expect(done?.checklist.find((c) => c.id === 'retire_source')?.done).toBe(true)
      expect(await moveOpenRefusal({ envIds: [w.envId] })).toBeNull()
      // A shared source no longer lists the app.
      if (kind !== 'to_shared') {
        const listed = await tenantsOf((await Store.getShared(w.sharedA)) as never)
        expect(listed.find((r) => r.env.id === w.envId)).toBeUndefined()
      }
    })
  })
}

describe('APP_KEY_UNKNOWN (the new home holds no key yet)', () => {
  it('the same: open, named, never retired; Resume after the key is entered succeeds', async () => {
    key.state = 'unknown'
    const w = await world('docker')
    const id = await startMove(w, 'to_shared')
    const m = await readMove(id)
    expect(m?.status).toBe('interrupted')
    expect(m?.error).toMatch(/^APP_KEY_UNKNOWN: /)
    expect(fake.calls).not.toContain('retireSource')
    key.state = 'ok'
    fake = fakeOps()
    useDeps()
    await Run.resumeMove(id, 'u')
    await Run.awaitMove(id)
    expect((await readMove(id))?.status).toBe('success')
    expect(fake.calls).toContain('retireSource')
  })

  it('a key check that passes inside its retry window retires at once (no interruption)', async () => {
    const w = await world('docker')
    let n = 0
    fake.ops.verifyTargetKey = async () => {
      fake.calls.push('verifyTargetKey')
      if (n++ < 2) throw new MoveStepError('APP_KEY_UNKNOWN', 'Not yet.')
    }
    const id = await startMove(w, 'to_shared')
    expect((await readMove(id))?.status).toBe('success')
    expect(fake.calls).toContain('retireSource')
  })

  it('a retire that fails for another reason still ends success with the item open', async () => {
    key.state = 'ok'
    const w = await world('docker')
    fake.ops.retireSource = async () => {
      throw new MoveStepError('SOURCE_NOT_RETIRED', 'The old Docker stack could not be removed.')
    }
    const id = await startMove(w, 'to_shared')
    const m = await readMove(id)
    expect(m?.status).toBe('success')
    expect(m?.error).toMatch(/not retired \(SOURCE_NOT_RETIRED\)/)
    expect(m?.checklist.find((c) => c.id === 'retire_source')?.done).toBe(false)
  })
})
