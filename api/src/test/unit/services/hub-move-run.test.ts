import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 16: the move run (services/hub/move/run.ts), its rollback and heal.
// Real SQLite with the hub tables (542–553); every side effect is a fake MoveOps that records its
// calls; the clock is fake (sleep moves it); the planner is a fixture built from Task 15's own
// step lists; locks are in memory.

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
  logActivity: vi.fn(async (row: Record<string, unknown>) => {
    activity.rows.push(row)
    return null
  })
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
const Run = await import('../../../services/hub/move/run.js')
const { healMoves } = await import('../../../services/hub/move/heal.js')
const { readMove } = await import('../../../services/hub/move/rows.js')
const { MoveStepError } = await import('../../../services/hub/move/ops.js')
const { MOVE_STEPS, MANUAL_MOVE_STEPS } = await import('../../../services/hub/move/plan.js')
const { memoryPromoteLock, sharedLock } = await import('../../../services/hub/promote-lock.js')
type MovePlan = import('../../../services/hub/move/types.js').MovePlan
type MoveKind = import('../../../services/hub/move/types.js').MoveKind
type RouteAction = import('../../../services/hub/move/types.js').RouteAction
type MoveOps = import('../../../services/hub/move/ops.js').MoveOps

const HUB_KEY = 'e'.repeat(64)
const SECRET_TOKEN = 'hub-link-Token-SECRET-0123456789-abcdefghij'
const SECRET_TICKET = `nvt_${'T'.repeat(43)}`
const SECRET_CONN = 'postgres://app:Pa55-SECRET@db.internal:5432/acme'
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

interface World {
  envId: number
  appKey: string
  envKey: string
  sharedA: number
  sharedB: number
  dockerPlacement: number
  sharedPlacementA: number
}

async function world(fromKind: 'docker' | 'shared'): Promise<World> {
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
  const envKey = 'prod'
  const envId = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: envKey,
    status: 'active',
    base_url: `https://acme${n}.apps.example.com`,
    hostnames: '[]',
    placement_id: fromKind === 'docker' ? dockerPlacement : sharedPlacementA,
    version_pin: '0.3.210'
  })
  return { envId, appKey, envKey, sharedA, sharedB, dockerPlacement, sharedPlacementA }
}

function planOf(kind: MoveKind, routing: 'automatic' | 'manual' = 'automatic'): MovePlan {
  const route: RouteAction[] =
    kind === 'to_dedicated'
      ? [{ side: 'target', op: 'apply_stack' }]
      : [
          { side: 'source', op: 'drop_host', host: 'acme.example.com' },
          { side: 'target', op: 'add_host', host: 'acme.example.com' }
        ]
  return {
    kind,
    routing,
    steps: [...(routing === 'manual' ? MANUAL_MOVE_STEPS : MOVE_STEPS)[kind]],
    route,
    manual_request: routing === 'manual' ? 'Point acme.example.com at the target.' : null,
    version: '0.3.210',
    hostnames: ['acme.example.com'],
    files: { count: 3, bytes: 30, first_pull: 'full' },
    blockers: [],
    warnings: [],
    checklist: [
      { id: 'callbacks_registered', text: 'Register the callbacks', required: true },
      ...(routing === 'manual'
        ? [{ id: 'route_ticket', text: 'Raise the route ticket', required: true }]
        : [])
    ],
    plan_hash: 'a'.repeat(64)
  }
}

type Call = [string, unknown?]

/** A fake MoveOps: records every call; `fail(name, arg?)` makes that call throw once matched. */
function fakeOps() {
  const calls: Call[] = []
  const state = {
    failOn: null as null | ((name: string, arg: unknown) => boolean),
    busy: { imports: 0, exports: 0, renders: 0 },
    serving: true,
    pull: (mode: 'full' | 'delta') => ({
      state: 'done' as const,
      total: 3,
      copied: mode === 'full' ? 3 : 0,
      skipped: mode === 'full' ? 0 : 3,
      failed: 0,
      missing: [] as string[],
      bytes: 30,
      error: null,
      size_mismatch: 0,
      failed_ids: [] as string[]
    }),
    during: null as null | ((name: string, arg: unknown) => Promise<void> | void),
    identity: { source: 'pg|db.internal|5432|acme', target: 'pg|db.internal|5432|acme' }
  }
  const rec =
    <A extends unknown[], R>(name: string, out: (...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      calls.push(a.length ? [name, a[0]] : [name])
      if (state.during) await state.during(name, a[0])
      if (state.failOn?.(name, a[0])) {
        state.failOn = null
        // A secret-bearing message: never stored or shown (only a known error's text is).
        throw new Error(`boom ${SECRET_TOKEN} ${SECRET_TICKET} ${SECRET_CONN} ${SECRET_KEY}`)
      }
      return (await out(...a)) as Awaited<R>
    }
  const ops: MoveOps = {
    sourceMaintenance: rec('sourceMaintenance', (_on: boolean) => undefined),
    targetMaintenance: rec('targetMaintenance', (_on: boolean) => undefined),
    sourceBusy: rec('sourceBusy', () => state.busy),
    pullFiles: rec('pullFiles', (mode: 'full' | 'delta') => state.pull(mode)),
    placeOnTarget: rec('placeOnTarget', () => undefined),
    unplace: rec('unplace', () => undefined),
    waitReplicas: rec('waitReplicas', (_id: number) => undefined),
    targetUnretire: rec('targetUnretire', () => undefined),
    targetReady: rec('targetReady', () => undefined),
    deployTarget: rec('deployTarget', () => undefined),
    removeTarget: rec('removeTarget', () => undefined),
    route: rec('route', (_a: RouteAction) => undefined),
    unroute: rec('unroute', (_a: RouteAction) => undefined),
    verifyName: rec('verifyName', (_e: unknown) => state.serving),
    retireSource: rec('retireSource', () => undefined),
    revokeTickets: rec('revokeTickets', () => undefined),
    databaseIdentity: rec('databaseIdentity', (side: 'source' | 'target') => state.identity[side])
  }
  return { ops, calls, state, names: () => calls.map((c) => c[0]) }
}

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
      complete: async (o?: string) => {
        out.completed = o ?? 'done'
      },
      fail: async (err: unknown) => {
        out.failed = (err as Error).message
      }
    }))
  }
}

let fake = fakeOps()
let run = fakeRun()
let plan: MovePlan = planOf('to_shared')
let lock = memoryPromoteLock
let shLock = sharedLock(null)

function useDeps(o: Partial<Parameters<typeof Run.setMoveRunDeps>[0] & object> = {}) {
  Run.setMoveRunDeps({
    ops: () => fake.ops,
    planner: async () => plan,
    lock,
    sharedLock: shLock,
    now,
    sleep,
    startJobRun: run.start,
    renewMs: 3_600_000,
    pollMs: 5_000,
    manualPollMs: 60 * 60_000,
    ...o
  })
}

async function start(w: World, to: unknown, over: Record<string, unknown> = {}) {
  return Run.startMove(
    w.envId,
    {
      to,
      plan_hash: plan.plan_hash,
      confirm: `${w.appKey}/${w.envKey}`,
      checklist: { callbacks_registered: true, route_ticket: true },
      ...over
    } as never,
    'AAAAAAAA-0000-4000-8000-000000000001'
  )
}

const toFor = (kind: MoveKind, w: World) =>
  kind === 'to_dedicated'
    ? { kind: 'dedicated', placement_id: w.dockerPlacement }
    : { kind: 'shared', shared_id: kind === 'to_shared' ? w.sharedA : w.sharedB }

const fromFor = (kind: MoveKind): 'docker' | 'shared' =>
  kind === 'to_shared' ? 'docker' : 'shared'

async function refusal(p: Promise<unknown>): Promise<{ code: string; statusCode: number }> {
  try {
    await p
  } catch (err) {
    return err as { code: string; statusCode: number }
  }
  throw new Error('expected a refusal')
}

async function waitFor(cond: () => Promise<boolean>, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition never held')
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
  sleep.mockClear()
  fake = fakeOps()
  run = fakeRun()
  activity.rows = []
  // Fresh locks per test (memoryPromoteLock is process-wide: release whatever a test left).
  lock = memoryPromoteLock
  shLock = sharedLock(null)
  useDeps()
})

// ── happy paths ──────────────────────────────────────────────────────────────────────────────

const ORDER: Record<MoveKind, string[]> = {
  to_shared: [
    'databaseIdentity', // check
    'placeOnTarget',
    'waitReplicas', // target lists the app (place_on_target)
    'pullFiles', // files_warm (full)
    'sourceMaintenance', // maintenance_on (dedicated source: no replica wait)
    'sourceBusy',
    'pullFiles', // files_delta
    'targetMaintenance',
    'targetUnretire',
    'targetReady',
    'databaseIdentity',
    'route',
    'route',
    'verifyName',
    'targetMaintenance', // release: target serves for real
    'waitReplicas', // release: every target replica has it active
    'retireSource',
    'revokeTickets'
  ],
  to_dedicated: [
    'databaseIdentity',
    'sourceMaintenance',
    'waitReplicas', // shared source: every replica holds the maintenance list
    'sourceBusy',
    'deployTarget',
    'targetMaintenance',
    'targetUnretire',
    'targetReady',
    'databaseIdentity',
    'pullFiles', // files_full
    'route',
    'verifyName',
    'targetMaintenance',
    'retireSource',
    'revokeTickets'
  ],
  between_shared: [
    'databaseIdentity',
    'placeOnTarget',
    'waitReplicas',
    'pullFiles',
    'sourceMaintenance',
    'waitReplicas',
    'sourceBusy',
    'pullFiles',
    'targetMaintenance',
    'targetUnretire',
    'targetReady',
    'databaseIdentity',
    'route',
    'route',
    'verifyName',
    'targetMaintenance',
    'waitReplicas',
    'retireSource',
    'revokeTickets'
  ]
}

describe('move run — happy paths', () => {
  for (const kind of ['to_shared', 'to_dedicated', 'between_shared'] as MoveKind[]) {
    it(`${kind}: every step in order, released onto the target, success`, async () => {
      plan = planOf(kind)
      const w = await world(fromFor(kind))
      const { move_id } = await start(w, toFor(kind, w))
      await Run.awaitMove(move_id)
      expect(fake.names()).toEqual(ORDER[kind])
      const m = await readMove(move_id)
      expect(m?.status).toBe('success')
      expect(m?.steps.list.every((s) => s.state === 'done')).toBe(true)
      const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
      expect(Number(env.placement_id)).toBe(m?.to_placement_id)
      expect(env.status).toBe('active')
      expect(env.version_pin).toBe('0.3.210')
      if (kind === 'to_dedicated') expect([1, true, '1']).toContain(env.hub_managed)
      // The first copy is full, the one inside maintenance a delta (T10 carry).
      const pulls = fake.calls.filter((c) => c[0] === 'pullFiles').map((c) => c[1])
      expect(pulls).toEqual(kind === 'to_dedicated' ? ['full'] : ['full', 'delta'])
      // One mirror deploy row, kind move, closed success.
      const dep = await db('nivaro_hub_deploys').where({ move_id }).first()
      expect(dep).toMatchObject({ kind: 'move', status: 'success', version: '0.3.210' })
      expect(run.out.completed).toMatch(/done/)
      expect(activity.rows.map((r) => r.action)).toEqual(['hub-move-start', 'hub-move-done'])
      // Locks are free again: a second start is not BUSY on the lock.
      expect(await lock.held(w.envId)).toBe(false)
    })
  }

  it('maintenance waits for every replica: waitReplicas right after sourceMaintenance(true) on a shared source', async () => {
    plan = planOf('between_shared')
    const w = await world('shared')
    const { move_id } = await start(w, toFor('between_shared', w))
    await Run.awaitMove(move_id)
    const i = fake.calls.findIndex((c) => c[0] === 'sourceMaintenance' && c[1] === true)
    expect(fake.calls[i + 1]).toEqual(['waitReplicas', w.sharedA])
    // No step after it ran before the wait: sourceBusy follows.
    expect(fake.calls[i + 2][0]).toBe('sourceBusy')
    // The env is in maintenance on the Hub while the source holds it (B1).
    const m = await readMove(move_id)
    expect(m?.prior_status).toBe('active')
  })
})

// ── rollback ─────────────────────────────────────────────────────────────────────────────────

/** What the step at `key` calls first (the call the test makes fail). */
function failFor(key: string): (name: string, arg: unknown) => boolean {
  const first: Record<string, (n: string, a: unknown) => boolean> = {
    check: (n) => n === 'databaseIdentity',
    place_on_target: (n) => n === 'placeOnTarget',
    files_warm: (n, a) => n === 'pullFiles' && a === 'full',
    maintenance_on: (n, a) => n === 'sourceMaintenance' && a === true,
    wait_idle: (n) => n === 'sourceBusy',
    files_delta: (n, a) => n === 'pullFiles' && a === 'delta',
    files_full: (n, a) => n === 'pullFiles' && a === 'full',
    deploy_target: (n) => n === 'deployTarget',
    target_ready: (n) => n === 'targetReady',
    route: (n) => n === 'route',
    verify: (n) => n === 'verifyName'
  }
  return first[key]
}

const UNDO = new Set(['unroute', 'unplace', 'removeTarget'])
const undoCalls = (calls: Call[]) =>
  calls.filter((c) => UNDO.has(c[0]) || (c[0] === 'sourceMaintenance' && c[1] === false))

describe('rolls back from every step before release', () => {
  for (const kind of ['to_shared', 'to_dedicated', 'between_shared'] as MoveKind[]) {
    const steps = MOVE_STEPS[kind]
    const before = steps.slice(0, steps.indexOf('release'))
    for (const key of before) {
      it(`${kind}: a failure at ${key} undoes the completed steps in reverse → rolled_back`, async () => {
        plan = planOf(kind)
        const w = await world(fromFor(kind))
        fake.state.failOn = failFor(key)
        const { move_id } = await start(w, toFor(kind, w))
        await Run.awaitMove(move_id)
        const m = await readMove(move_id)
        expect(m?.status).toBe('rolled_back')

        // Expected undo, latest first: each undoable step that ran (done, or the failed one).
        const ran = steps.slice(0, steps.indexOf(key) + 1)
        const expected: Call[] = []
        for (const s of [...ran].reverse()) {
          if (s === 'route') {
            // C-3: an action is recorded as an intent before it is applied, so the one whose
            // apply (or converge) failed is undone too.
            const intents = key === 'route' ? plan.route.slice(0, 1) : plan.route
            for (const a of [...intents].reverse()) expected.push(['unroute', a])
          }
          if (s === 'place_on_target') expected.push(['unplace'])
          if (s === 'deploy_target') expected.push(['removeTarget'])
          if (s === 'maintenance_on') expected.push(['sourceMaintenance', false])
        }
        expect(undoCalls(fake.calls)).toEqual(expected)
        // Never undone twice, never a release, never retired.
        expect(fake.names()).not.toContain('retireSource')
        // The environment is back where it was, with its status before the move.
        const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
        expect(Number(env.placement_id)).toBe(m?.from_placement_id)
        expect(env.status).toBe('active')
        expect(m?.placed_at).toBeNull()
        // Tickets revoked; the mirror row closed failed; activity says rolled back.
        expect(fake.names()).toContain('revokeTickets')
        expect((await db('nivaro_hub_deploys').where({ move_id }).first()).status).toBe('failed')
        expect(activity.rows.map((r) => r.action)).toContain('hub-move-rolled-back')
        // A shared target placement this move made is gone again.
        if (kind !== 'to_dedicated')
          expect(
            await db('nivaro_hub_placements').where({ id: m?.to_placement_id }).first()
          ).toBeUndefined()
      })
    }
  }

  // Review C-3: this test used to expect only the first action undone. That was wrong: the
  // second action's apply may have been accepted (a converge timeout) or half done, so every
  // recorded intent is undone, idempotently.
  it('a route whose second action fails undoes both recorded intents, newest first', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    let n = 0
    fake.state.failOn = (name) => name === 'route' && ++n === 2
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    expect(undoCalls(fake.calls)).toEqual([
      ['unroute', plan.route[1]],
      ['unroute', plan.route[0]],
      ['sourceMaintenance', false],
      ['unplace']
    ])
  })

  it('a cancel inside route (between two actions) rolls back the recorded intent', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    let id = 0
    fake.state.during = async (name) => {
      if (name === 'route') await Run.cancelMove(id, 'u')
    }
    const out = await start(w, toFor('to_shared', w))
    id = out.move_id
    await Run.awaitMove(id)
    expect((await readMove(id))?.status).toBe('cancelled')
    expect(fake.calls.filter((c) => c[0] === 'route')).toHaveLength(1)
    expect(undoCalls(fake.calls)).toEqual([
      ['unroute', plan.route[0]],
      ['sourceMaintenance', false],
      ['unplace']
    ])
  })

  it('a delta copy with failed rows rolls back (nothing is lost); missing ones do not', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.pull = (mode) => ({
      state: 'done',
      total: 3,
      copied: 1,
      skipped: 0,
      failed: mode === 'delta' ? 1 : 0,
      missing: ['f9'],
      bytes: 3,
      error: null,
      size_mismatch: 0,
      failed_ids: mode === 'delta' ? ['f2'] : []
    })
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('rolled_back')
    expect(m?.error).toMatch(/FILES_NOT_COPIED/)
    expect(m?.error).toContain('f2')
    expect(m?.files.warm?.missing).toBe(1)
  })

  it('a target on another database fails target_ready (DATABASE_DIFFERS) and rolls back', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.identity.target = 'pg|other.internal|5432|acme'
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('rolled_back')
    expect(m?.error).toMatch(/^DATABASE_DIFFERS/)
    expect(JSON.stringify(m)).not.toContain('other.internal')
  })

  it('an undo that fails ends the move failed, naming it', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.during = (name) => {
      if (name === 'targetReady' || name === 'unplace')
        throw new MoveStepError('X_FAILED', 'This failed.')
    }
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('failed')
    expect(m?.error).toMatch(/could not undo: place_on_target/)
    // The other undo still ran.
    expect(undoCalls(fake.calls)).toContainEqual(['sourceMaintenance', false])
  })
})

describe('after release', () => {
  it('a failure in retire_source → success with the checklist item open, never rolled back', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.failOn = (name) => name === 'retireSource'
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('success')
    expect(m?.error).toMatch(/not retired/)
    expect(m?.checklist.find((c) => c.id === 'retire_source')).toMatchObject({ done: false })
    expect(fake.names()).not.toContain('unroute')
    expect(fake.names()).not.toContain('unplace')
    expect(undoCalls(fake.calls)).toEqual([])
    const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(Number(env.placement_id)).toBe(m?.to_placement_id)
  })

  it('a cancel after release is refused (TOO_LATE)', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    let id = 0
    fake.state.during = async (name) => {
      if (name === 'retireSource') {
        const r = await refusal(Run.cancelMove(id, 'u'))
        expect(r.code).toBe('TOO_LATE')
      }
    }
    const out = await start(w, toFor('to_shared', w))
    id = out.move_id
    await Run.awaitMove(id)
    expect((await readMove(id))?.status).toBe('success')
  })
})

// ── manual routing ───────────────────────────────────────────────────────────────────────────

describe('manual routing', () => {
  it('waits (status waiting); confirmRoute while the name does not serve → {serving:false}; then serves → continues', async () => {
    plan = planOf('to_shared', 'manual')
    const w = await world('docker')
    fake.state.serving = false
    // The waiting loop polls only once an hour (fake clock) and yields to the test meanwhile.
    useDeps({
      sleep: async (ms: number) => {
        t += ms
        await new Promise((r) => setTimeout(r, 20))
      }
    })
    const { move_id } = await start(w, toFor('to_shared', w))
    await waitFor(async () => (await readMove(move_id))?.status === 'waiting')
    // Manual (T15 order): the target's own actions ran before the wait, the source's not yet.
    expect(
      fake.calls.filter((c) => c[0] === 'route').map((c) => (c[1] as RouteAction).side)
    ).toEqual(['target'])
    // No maintenance yet: the source still serves during the wait (B8).
    expect(fake.names()).not.toContain('sourceMaintenance')
    expect(await Run.confirmRoute(move_id, 'u')).toEqual({ serving: false })
    expect((await readMove(move_id))?.status).toBe('waiting')
    fake.state.serving = true
    expect(await Run.confirmRoute(move_id, 'u')).toEqual({ serving: true })
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('success')
    // The source drop ran after the name verified.
    const routeSides = fake.calls
      .filter((c) => c[0] === 'route')
      .map((c) => (c[1] as RouteAction).side)
    expect(routeSides).toEqual(['target', 'source'])
    const iVerify = fake.names().lastIndexOf('verifyName')
    const iSource = fake.calls.findIndex(
      (c) => c[0] === 'route' && (c[1] as RouteAction).side === 'source'
    )
    expect(iSource).toBeGreaterThan(iVerify)
  })

  it('a cancel during the manual wait undoes the target actions already applied → cancelled', async () => {
    plan = planOf('to_shared', 'manual')
    const w = await world('docker')
    fake.state.serving = false
    useDeps({
      sleep: async (ms: number) => {
        t += ms
        await new Promise((r) => setTimeout(r, 20))
      }
    })
    const { move_id } = await start(w, toFor('to_shared', w))
    await waitFor(async () => (await readMove(move_id))?.status === 'waiting')
    await Run.cancelMove(move_id, 'u')
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.status).toBe('cancelled')
    expect(undoCalls(fake.calls)).toEqual([['unroute', plan.route[1]], ['unplace']])
  })

  it('24 h without the route → failed and rolled back', async () => {
    plan = planOf('to_shared', 'manual')
    const w = await world('docker')
    fake.state.serving = false
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('rolled_back')
    expect(m?.error).toMatch(/^ROUTE_TIMEOUT/)
    expect(t - START).toBeGreaterThanOrEqual(24 * 60 * 60_000)
    // The target's applied action is undone; nothing at the source was ever in maintenance.
    expect(undoCalls(fake.calls)).toEqual([['unroute', plan.route[1]], ['unplace']])
  })
})

// ── cancel ───────────────────────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('cancel during files_warm → no maintenance call, then cancelled', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    let id = 0
    fake.state.during = async (name, arg) => {
      if (name === 'pullFiles' && arg === 'full') await Run.cancelMove(id, 'u')
    }
    const out = await start(w, toFor('to_shared', w))
    id = out.move_id
    await Run.awaitMove(id)
    const m = await readMove(id)
    expect(m?.status).toBe('cancelled')
    expect(fake.names()).not.toContain('sourceMaintenance')
    expect(undoCalls(fake.calls)).toEqual([['unplace']])
    expect(activity.rows.map((r) => r.action)).toContain('hub-move-cancel')
    expect((await db('nivaro_hub_deploys').where({ move_id: id }).first()).status).toBe('cancelled')
  })
})

// ── heal / resume ────────────────────────────────────────────────────────────────────────────

describe('heal and resume', () => {
  it('a running row with a 3-min-old heartbeat → interrupted; resume continues from the stored step', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    // A run stops at wait_idle (the source stays busy and the test lets the "process die").
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    // Make it look like a dead run at wait_idle: steps before done, row running, old heartbeat.
    const m0 = (await readMove(move_id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const steps = structuredClone(m0.steps)
    const at = steps.list.findIndex((s) => s.key === 'wait_idle')
    steps.list.forEach((s, i) => {
      s.state = i < at ? 'done' : i === at ? 'running' : 'pending'
    })
    steps.phase = 'forward'
    await db('nivaro_hub_moves')
      .where({ id: move_id })
      .update({
        status: 'running',
        step: 'wait_idle',
        steps: JSON.stringify(steps),
        finished_at: null,
        heartbeat_at: new Date(START - 3 * 60_000)
      })
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({ placement_id: m0.from_placement_id, status: 'maintenance' })
    await db('nivaro_hub_deploys').where({ move_id }).update({ status: 'running' })
    const failed: number[] = []
    expect(await healMoves({ now, failJobRun: async (jr) => void failed.push(jr) })).toBe(1)
    expect((await readMove(move_id))?.status).toBe('interrupted')
    expect((await db('nivaro_hub_deploys').where({ move_id }).first()).status).toBe('interrupted')
    expect(failed).toEqual([77])
    // A second heal changes nothing.
    expect(await healMoves({ now })).toBe(0)

    fake = fakeOps()
    useDeps()
    await Run.resumeMove(move_id, 'u')
    await Run.awaitMove(move_id)
    // Resumed at wait_idle: nothing before it ran again.
    expect(fake.names()[0]).toBe('sourceBusy')
    expect(fake.names()).not.toContain('placeOnTarget')
    expect((await readMove(move_id))?.status).toBe('success')
  })

  it('a fresh heartbeat is never healed', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    await db('nivaro_hub_moves')
      .where({ id: move_id })
      .update({ status: 'running', heartbeat_at: new Date(START - 60_000) })
    expect(await healMoves({ now })).toBe(0)
    await db('nivaro_hub_moves').where({ id: move_id }).update({ status: 'success' })
  })

  it('roll back an interrupted move: undone now, cancelled', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m0 = (await readMove(move_id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const steps = structuredClone(m0.steps)
    const at = steps.list.findIndex((s) => s.key === 'wait_idle')
    steps.list.forEach((s, i) => {
      s.state = i < at ? 'done' : i === at ? 'running' : 'pending'
    })
    await db('nivaro_hub_moves')
      .where({ id: move_id })
      .update({ status: 'interrupted', steps: JSON.stringify(steps), heartbeat_at: null })
    fake = fakeOps()
    useDeps()
    await Run.cancelMove(move_id, 'u')
    await Run.awaitMove(move_id)
    // place_on_target ran before maintenance_on (P6-14): undone after it.
    expect(undoCalls(fake.calls)).toEqual([['sourceMaintenance', false], ['unplace']])
    expect((await readMove(move_id))?.status).toBe('cancelled')
  })
})

// ── start refusals and locks ─────────────────────────────────────────────────────────────────

describe('start refusals and locks', () => {
  it('a second move on the same environment → 409 BUSY', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.serving = false
    plan = planOf('to_shared', 'manual')
    const first = await start(w, toFor('to_shared', w))
    const r = await refusal(start(w, toFor('to_shared', w)))
    expect(r).toMatchObject({ code: 'BUSY', statusCode: 409 })
    // The lock held by someone else (no open move row) is BUSY too, naming the holder.
    await Run.cancelMove(first.move_id, 'u')
    await Run.awaitMove(first.move_id)
    const token = await lock.take(w.envId, 'promotion')
    const r2 = await refusal(start(w, toFor('to_shared', w)))
    expect(r2.code).toBe('BUSY')
    expect((r2 as unknown as Error).message).toMatch(/promotion/)
    await lock.release(w.envId, token as string)
  })

  it('a shared upgrade running → 409 SHARED_BUSY, and nothing is written', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const token = await shLock.take(w.sharedA, 'shared')
    const r = await refusal(start(w, toFor('to_shared', w)))
    expect(r).toMatchObject({ code: 'SHARED_BUSY', statusCode: 409 })
    expect(await db('nivaro_hub_moves').where({ environment_id: w.envId }).first()).toBeUndefined()
    expect(await lock.held(w.envId)).toBe(false)
    await shLock.release(w.sharedA, token as string)
  })

  it('wrong confirm → 400 CONFIRM_MISMATCH; open required item → 409 CHECKLIST_INCOMPLETE; hash → 409 PLAN_CHANGED with the plan', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    expect(await refusal(start(w, toFor('to_shared', w), { confirm: 'acme/prod' }))).toMatchObject({
      code: 'CONFIRM_MISMATCH',
      statusCode: 400
    })
    const open = await refusal(start(w, toFor('to_shared', w), { checklist: {} }))
    expect(open).toMatchObject({ code: 'CHECKLIST_INCOMPLETE', statusCode: 409 })
    expect((open as unknown as Error).message).toContain('callbacks_registered')
    const changed = (await refusal(
      start(w, toFor('to_shared', w), { plan_hash: 'b'.repeat(64) })
    )) as unknown as { code: string; plan: MovePlan }
    expect(changed.code).toBe('PLAN_CHANGED')
    expect(changed.plan.plan_hash).toBe(plan.plan_hash)
    // A plan with a blocker never starts.
    plan = { ...planOf('to_shared'), blockers: [{ code: 'VERSION_DIFFERS', text: 'x' }] }
    expect((await refusal(start(w, toFor('to_shared', w)))).code).toBe('PLAN_BLOCKED')
    expect(await db('nivaro_hub_moves').where({ environment_id: w.envId }).first()).toBeUndefined()
    // No placement left behind by a refused start.
    expect(
      await db('nivaro_hub_placements').where({ shared_deployment_id: w.sharedA }).count({ n: '*' })
    ).toEqual([{ n: 1 }])
    expect(await lock.held(w.envId)).toBe(false)
  })

  it('re-plans with its own locks held (ownLocks) before writing anything', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const seen: Array<{ ownLocks?: boolean } | undefined> = []
    useDeps({
      planner: async (_e, _t, o) => {
        seen.push(o)
        expect(await lock.held(w.envId)).toBe(true)
        return plan
      }
    })
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    expect(seen).toEqual([{ ownLocks: true }])
  })
})

// ── secrets ──────────────────────────────────────────────────────────────────────────────────

describe('no secret in an error, job run or activity', () => {
  it('an unexpected error carrying a token, ticket, key and connection is never stored or logged', async () => {
    const logs: unknown[] = []
    const app = {
      log: { warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) }
    }
    const io = await import('../../../services/io-holder.js')
    const spy = vi.spyOn(io, 'getApp').mockReturnValue(app as never)
    for (const key of ['check', 'files_warm', 'route', 'target_ready']) {
      plan = planOf('to_shared')
      const w = await world('docker')
      fake = fakeOps()
      run = fakeRun()
      useDeps()
      fake.state.failOn = failFor(key)
      const { move_id } = await start(w, toFor('to_shared', w))
      await Run.awaitMove(move_id)
      const stored = JSON.stringify(await db('nivaro_hub_moves').where({ id: move_id }).first())
      const deploy = JSON.stringify(await db('nivaro_hub_deploys').where({ move_id }).first())
      const text = [
        stored,
        deploy,
        run.lines.join('\n'),
        String(run.out.failed),
        JSON.stringify(activity.rows),
        JSON.stringify(logs)
      ].join('\n')
      for (const s of [SECRET_TOKEN, SECRET_TICKET, SECRET_CONN, SECRET_KEY, 'Pa55-SECRET'])
        expect(text, `${key}: ${s}`).not.toContain(s)
      expect(stored).toContain('STEP_FAILED')
    }
    spy.mockRestore()
  })

  it('a known step error keeps its own plain sentence', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.ops.targetReady = async () => {
      throw new MoveStepError('SCHEMA_FAILED', 'The app could not be migrated.')
    }
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.error).toBe('SCHEMA_FAILED: The app could not be migrated.')
  })
})
