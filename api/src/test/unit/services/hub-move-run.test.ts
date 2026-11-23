import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
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
const { healMoves, unmarkMoveLive } = await import('../../../services/hub/move/heal.js')
const { readMove } = await import('../../../services/hub/move/rows.js')
const { MoveStepError } = await import('../../../services/hub/move/ops.js')
const { MOVE_STEPS, MANUAL_MOVE_STEPS } = await import('../../../services/hub/move/plan.js')
const { memoryPromoteLock, sharedLock } = await import('../../../services/hub/promote-lock.js')
type MovePlan = import('../../../services/hub/move/types.js').MovePlan
type MoveKind = import('../../../services/hub/move/types.js').MoveKind
type RouteAction = import('../../../services/hub/move/types.js').RouteAction
type MoveOps = import('../../../services/hub/move/ops.js').MoveOps
type PullStatus = import('../../../services/hub/shared/deployment-client.js').PullStatus

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
  // The app's key, as the plan requires (APP_KEY_UNKNOWN blocks a move without one).
  const { setAppKey } = await import('../../../services/hub/shared/store.js')
  await setAppKey(envId, 'ab'.repeat(32))
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
    pull: (mode: 'full' | 'delta'): PullStatus => ({
      state: 'done',
      total: 3,
      copied: mode === 'full' ? 3 : 0,
      skipped: mode === 'full' ? 0 : 3,
      failed: 0,
      missing: [] as string[],
      bytes: 30,
      error: null,
      size_mismatch: 0,
      failed_ids: []
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
    freezeTarget: rec('freezeTarget', () => undefined),
    deployTarget: rec('deployTarget', () => undefined),
    removeTarget: rec('removeTarget', () => undefined),
    route: rec('route', (_a: RouteAction) => undefined),
    unroute: rec('unroute', (_a: RouteAction) => undefined),
    verifyName: rec('verifyName', (_e: unknown) => state.serving),
    retireSource: rec('retireSource', () => undefined),
    verifyTargetKey: rec('verifyTargetKey', () => undefined),
    dropTempHost: rec('dropTempHost', () => null as string | null),
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
    'verifyTargetKey',
    'retireSource',
    'dropTempHost',
    'revokeTickets'
  ],
  to_dedicated: [
    'databaseIdentity',
    'sourceMaintenance',
    'waitReplicas', // shared source: every replica holds the maintenance list
    'sourceBusy',
    'targetMaintenance', // C-1: asked before the deploy …
    'deployTarget',
    'targetMaintenance', // … and set right after it
    'targetMaintenance', // target_ready (M18)
    'targetUnretire',
    'targetReady',
    'databaseIdentity',
    'pullFiles', // files_full
    'route',
    'verifyName',
    'targetMaintenance',
    'verifyTargetKey',
    'retireSource',
    'dropTempHost',
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
    'verifyTargetKey',
    'retireSource',
    'dropTempHost',
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

/**
 * P6-26 Rule 2: the undo calls of a rollback, in the fixed order. `recorded` = route intents in
 * the order they were recorded; `ran` = the steps that ran (done or the failed one).
 */
function rule2Undo(kind: MoveKind, recorded: number[], ran: readonly string[]): Call[] {
  const sharedTarget = kind !== 'to_dedicated'
  const newest = [...recorded].reverse()
  const out: Call[] = []
  // 2. target-side route actions (a dedicated target's go with its stack in 3).
  if (sharedTarget)
    for (const i of newest)
      if (plan.route[i].side === 'target') out.push(['unroute', plan.route[i]])
  // 3. stop / remove the target.
  if (ran.includes('deploy_target')) out.push(['removeTarget'])
  if (ran.includes('place_on_target')) out.push(['unplace'])
  // 4. source-side route actions.
  for (const i of newest) if (plan.route[i].side === 'source') out.push(['unroute', plan.route[i]])
  // 5. lift the source.
  if (ran.includes('maintenance_on')) out.push(['sourceMaintenance', false])
  return out
}

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

        // Expected undo (P6-26 Rule 2): each undoable step that ran (done, or the failed one).
        const ran = steps.slice(0, steps.indexOf(key) + 1)
        // C-3: an action is recorded as an intent before it is applied, so the one whose apply
        // (or converge) failed is undone too.
        const all = plan.route.map((_, i) => i)
        const recorded = !ran.includes('route') ? [] : key === 'route' ? all.slice(0, 1) : all
        expect(undoCalls(fake.calls)).toEqual(rule2Undo(kind, recorded, ran))
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

  // I-5: the same table for the manual orders (B8: the route and verify come before maintenance;
  // the target's own actions run at route, the source's after verify).
  for (const kind of ['to_shared', 'to_dedicated', 'between_shared'] as MoveKind[]) {
    const steps = MANUAL_MOVE_STEPS[kind]
    const before = steps.slice(0, steps.indexOf('release'))
    for (const key of before) {
      it(`manual ${kind}: a failure at ${key} undoes the completed steps in reverse → rolled_back`, async () => {
        plan = planOf(kind, 'manual')
        const w = await world(fromFor(kind))
        fake.state.serving = true
        fake.state.failOn = failFor(key)
        const { move_id } = await start(w, toFor(kind, w))
        await Run.awaitMove(move_id)
        const m = await readMove(move_id)
        expect(m?.status).toBe('rolled_back')
        const idx = plan.route.map((_, i) => i)
        const targetIdx = idx.filter((i) => plan.route[i].side === 'target')
        const sourceIdx = idx.filter((i) => plan.route[i].side === 'source')
        const ran = steps.slice(0, steps.indexOf(key) + 1)
        const intents =
          key === 'route'
            ? targetIdx.slice(0, 1)
            : key === 'verify'
              ? targetIdx
              : ran.includes('verify')
                ? [...targetIdx, ...sourceIdx]
                : []
        expect(undoCalls(fake.calls)).toEqual(rule2Undo(kind, intents, ran))
        const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
        expect(Number(env.placement_id)).toBe(m?.from_placement_id)
        expect(env.status).toBe('active')
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
    expect(undoCalls(fake.calls)).toEqual(
      rule2Undo(
        'to_shared',
        [0, 1],
        MOVE_STEPS.to_shared.slice(0, MOVE_STEPS.to_shared.indexOf('route') + 1)
      )
    )
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
    expect(undoCalls(fake.calls)).toEqual(
      rule2Undo(
        'to_shared',
        [0],
        MOVE_STEPS.to_shared.slice(0, MOVE_STEPS.to_shared.indexOf('route') + 1)
      )
    )
  })

  it("R2-M-2: a rollback puts the environment's extension pins back", async () => {
    plan = planOf('to_dedicated')
    const w = await world('shared')
    const OLD = JSON.stringify({ x: `r/x@sha256:${'1'.repeat(64)}` })
    await db('nivaro_hub_environments').where({ id: w.envId }).update({ extension_pins: OLD })
    let id = 0
    // deployTarget installs the source's pins (as the real one does) and keeps the old ones.
    fake.state.during = async (name) => {
      if (name !== 'deployTarget') return
      const m = await readMove(id)
      const steps = { ...m?.steps, prev_extension_pins: OLD }
      await db('nivaro_hub_moves')
        .where({ id })
        .update({ steps: JSON.stringify(steps) })
      await db('nivaro_hub_environments')
        .where({ id: w.envId })
        .update({ extension_pins: JSON.stringify({ x: `r/x@sha256:${'2'.repeat(64)}` }) })
    }
    fake.state.failOn = (name) => name === 'targetReady'
    const out = await start(w, toFor('to_dedicated', w))
    id = out.move_id
    await Run.awaitMove(id)
    expect((await readMove(id))?.status).toBe('rolled_back')
    const env = await db('nivaro_hub_environments').where({ id: w.envId }).first('extension_pins')
    expect(env.extension_pins).toBe(OLD)
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

  // P6-26 Rule 3: a shared target that cannot be proven to drop the app halts the rollback; the
  // source stays in maintenance.
  it('a target undo that cannot be proven halts: interrupted HALTED_TARGET_LIVE, source kept frozen', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.during = (name) => {
      if (name === 'targetReady' || name === 'unplace')
        throw new MoveStepError('X_FAILED', 'This failed.')
    }
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('interrupted')
    expect(m?.error).toMatch(/^HALTED_TARGET_LIVE/)
    expect(undoCalls(fake.calls)).not.toContainEqual(['sourceMaintenance', false])
    // Design R2-S1: the item names the deployment, says plainly that stopping it stops every other
    // app on it, never quotes its own internal name and says each thing once.
    const item = m?.checklist.find((c) => c.id === 'target_stopped')?.text ?? ''
    expect(item).toMatch(/^Stop [^:]+: scale its services to 0\./)
    expect(item).toMatch(
      /This stops every app on \S+ \(\d+ other apps?\) until the rollback is done/
    )
    expect(item).toMatch(/Then tick this box and Roll back/)
    expect(item).not.toMatch(/"target stopped"|placement \d/)
    expect(item.split('none can restart').length).toBeLessThanOrEqual(2)
  })

  it('a source undo that fails ends the move failed, naming it (the source is still lifted)', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const src = plan.route.findIndex((a) => a.side === 'source')
    expect(src).toBeGreaterThanOrEqual(0)
    fake.state.during = (name, arg) => {
      if (name === 'verifyName') throw new MoveStepError('X_FAILED', 'This failed.')
      if (name === 'unroute' && (arg as { side?: string })?.side === 'source')
        throw new MoveStepError('X_FAILED', 'This failed.')
    }
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('failed')
    expect(m?.error).toMatch(/could not undo: route/)
    expect(undoCalls(fake.calls).at(-1)).toEqual(['sourceMaintenance', false])
    // R5-M-1: the error and a required checklist item name the recovery.
    const stack = (await db('nivaro_hub_placements').where({ id: m?.from_placement_id }).first())
      .target
    const name = JSON.parse(String(stack)).stack as string
    expect(m?.error).toContain(`Apply now on the source stack ${name}`)
    const item = m?.checklist.find((c) => c.id === 'restore_source')
    expect(item).toMatchObject({ required: true, done: false })
    expect(item?.text).toContain(`Apply now on the source stack ${name}`)
    expect(item?.text).toMatch(/\{"on":false\} without move_id/)
    // FW-4 (P6-32): a hub-linked app freezes on its OWN key, never the plain nvr:maintenance;
    // the hub-link call comes first.
    expect(item?.text).toMatch(/<REDIS_CHANNEL_PREFIX>nvr:maintenance:<tag>/)
    expect(item?.text).toMatch(/sha256 of its HUB_TOKEN/)
    expect(item?.text).not.toMatch(/delete the nvr:maintenance key/)
    expect(item?.text?.indexOf('{"on":false}')).toBeLessThan(
      item?.text?.indexOf('nvr:maintenance:') ?? -1
    )
  })

  it('FW-4: a shared source that stays frozen is lifted through the Hub list, never a Redis key', async () => {
    plan = planOf('between_shared')
    const w = await world('shared')
    fake.state.during = (name, arg) => {
      if (name === 'verifyName') throw new MoveStepError('X_FAILED', 'This failed.')
      if (name === 'sourceMaintenance' && arg === false)
        throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
    }
    const { move_id } = await start(w, toFor('between_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    const item = m?.checklist.find((c) => c.id === 'restore_source')
    expect(item?.text).toMatch(/Hub/)
    expect(item?.text).not.toMatch(/delete|redis/i)
  })
})

// Ruling P6-21: placements an open move names are kept; a never-used dedicated target goes.
describe('move placements (P6-21)', () => {
  it('deletePlacement refuses 409 PLACEMENT_IN_USE while an open move names it (source or target)', async () => {
    const { deletePlacement } = await import('../../../services/hub/drivers.js')
    plan = planOf('to_dedicated', 'manual')
    const w = await world('shared')
    fake.state.serving = false
    useDeps({
      sleep: async (ms: number) => {
        t += ms
        await new Promise((r) => setTimeout(r, 20))
      }
    })
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await waitFor(async () => (await readMove(move_id))?.status === 'waiting')
    // Nobody names the target placement yet: only the open move does.
    expect(await deletePlacement(w.dockerPlacement)).toEqual({
      ok: false,
      code: 'PLACEMENT_IN_USE'
    })
    await Run.cancelMove(move_id, 'u')
    await Run.awaitMove(move_id)
  })

  // Ruling P6-22 reverses P6-21 #2: a rollback never deletes a dedicated target placement.
  it('a rollback keeps the dedicated target placement and records that it is unused', async () => {
    plan = planOf('to_dedicated')
    const w = await world('shared')
    fake.state.failOn = (name) => name === 'targetReady'
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('rolled_back')
    expect(m?.steps.target_placement_unused).toBe(true)
    expect(await db('nivaro_hub_placements').where({ id: w.dockerPlacement }).first()).toBeDefined()
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

  // R2-M-7: a cancel reaches the target deploy (its stopRequested), and ends the move cancelled.
  it('R2-M-7: a cancel during the GitLab target deploy stops it and ends cancelled', async () => {
    plan = planOf('to_dedicated', 'manual')
    const w = await world('shared')
    let id = 0
    let saw: boolean | null = null
    fake.state.during = async (name, arg) => {
      if (name === 'deployTarget') {
        await Run.cancelMove(id, 'u')
        saw = await (arg as { stopRequested: () => Promise<boolean> }).stopRequested()
        throw new MoveStepError('ABORTED', 'api: the deploy was stopped.')
      }
    }
    const out = await start(w, toFor('to_dedicated', w))
    id = out.move_id
    await Run.awaitMove(id)
    expect(saw).toBe(true)
    expect((await readMove(id))?.status).toBe('cancelled')
    expect(undoCalls(fake.calls)).toContainEqual(['removeTarget'])
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

  // R2-M-4: the person repointed the name, then cancelled before the Hub's 5-min self-check saw
  // it: the rollback checks the name once before it undoes anything.
  it('R2-M-4: a cancel during the manual wait after the name was repointed (unseen yet) still says to point it back', async () => {
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
    fake.state.serving = true // pointed by hand, the self-check has not run yet
    await Run.cancelMove(move_id, 'u')
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('cancelled')
    expect(m?.checklist.find((c) => c.id === 'repoint_name')).toMatchObject({
      required: true,
      done: false
    })
    // Checked before the target was undone.
    const names = fake.names()
    expect(names.lastIndexOf('verifyName')).toBeLessThan(names.indexOf('unplace'))
  })

  it('R2-M-4: a cancel during the manual wait while the name does not answer from the target yet → an "if it was done" item, not required', async () => {
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
    const m = await readMove(move_id)
    const item = m?.checklist.find((c) => c.id === 'repoint_name')
    expect(item).toMatchObject({ required: false, done: false })
    expect(item?.text).toMatch(/^If /)
  })

  it('I-4: a rollback after the name was pointed at the target says to point it back, everywhere', async () => {
    plan = planOf('to_shared', 'manual')
    const w = await world('docker')
    fake.state.serving = true // the person already pointed the name at the target
    fake.state.failOn = (name, arg) => name === 'sourceMaintenance' && arg === true
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('rolled_back')
    const say = 'Point acme.example.com back to'
    expect(m?.error).toContain(say)
    expect(m?.checklist.find((c) => c.id === 'repoint_name')).toMatchObject({
      required: true,
      done: false
    })
    expect(m?.checklist.find((c) => c.id === 'repoint_name')?.text).toContain(say)
    expect(run.lines.join('\n')).toContain(say)
    expect(String(run.out.failed)).toContain(say)
    expect(JSON.stringify(activity.rows.at(-1))).toContain(say)
  })

  it('a rollback before the name moved says nothing about pointing it back', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    fake.state.failOn = (name) => name === 'targetReady'
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.error).not.toContain('Point ')
    expect(m?.checklist.find((c) => c.id === 'repoint_name')).toBeUndefined()
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

// ── C-1: the target never runs as a second writer ───────────────────────────────────────────

describe('a dedicated target stays in maintenance from its first deploy until cutover', () => {
  /**
   * Models the target: `maint` is its maintenance; a Docker target boots in it
   * (HUB_BOOT_MAINTENANCE), a GitLab one does not (its first boot may not even answer before the
   * deploy). Every op called between the deploy and the release-time lift must find it on.
   */
  function watchTarget(boot: boolean, reachableBeforeDeploy: boolean) {
    const st = { maint: false, deployed: false, lifted: false, bad: [] as string[] }
    const orig = { ...fake.ops }
    for (const [name, fn] of Object.entries(orig)) {
      ;(fake.ops as unknown as Record<string, unknown>)[name] = async (...a: unknown[]) => {
        if (name === 'targetMaintenance') {
          if (a[0] === true && !st.deployed && !reachableBeforeDeploy)
            throw new MoveStepError('LINK_UNREACHABLE', 'The target does not answer yet.')
          const out = await (fn as (...x: unknown[]) => Promise<unknown>)(...a)
          st.maint = a[0] === true
          if (a[0] === false) st.lifted = true
          return out
        }
        if (st.deployed && !st.lifted && !st.maint) st.bad.push(name)
        const out = await (fn as (...x: unknown[]) => Promise<unknown>)(...a)
        if (name === 'deployTarget') {
          st.deployed = true
          if (boot) st.maint = true
        }
        return out
      }
    }
    return st
  }

  for (const routing of ['manual', 'automatic'] as const)
    for (const [label, boot, reachable] of [
      ['Docker', true, false],
      ['GitLab, first boot', false, false],
      ['GitLab, already running', false, true]
    ] as const)
      it(`${routing} to_dedicated, ${label}: no op runs against a writable target`, async () => {
        plan = planOf('to_dedicated', routing)
        const w = await world('shared')
        fake.state.serving = true
        const st = watchTarget(boot, reachable)
        const { move_id } = await start(w, toFor('to_dedicated', w))
        await Run.awaitMove(move_id)
        expect((await readMove(move_id))?.status).toBe('success')
        expect(st.bad).toEqual([])
        // Set right after the deploy (and asked before it), lifted only at release.
        const names = fake.names()
        const iDeploy = names.indexOf('deployTarget')
        expect(fake.calls[iDeploy + 1]).toEqual(['targetMaintenance', true])
        const iLift = fake.calls.findIndex((c) => c[0] === 'targetMaintenance' && c[1] === false)
        expect(iLift).toBeGreaterThan(names.lastIndexOf('verifyName'))
      })
})

// ── R2-I-2: a half-done or crashed release never leaves two writers ─────────────────────────

describe('rollback from release: exactly one writer at every point (P6-22)', () => {
  interface Writers {
    sourceLive: boolean
    targetUp: boolean
    targetMaint: boolean
    /** A shared target: what its replicas hold for the app (only a waitReplicas proves it). */
    listed: 'none' | 'maintenance' | 'active'
    bad: string[]
  }
  /**
   * Wraps fake.ops: tracks which side can write and records any call made with two writers.
   * R4-M-3: a shared target writes only when its replicas hold the app `active`, learnt only from
   * a waitReplicas of that deployment reading the env row as the Hub lists it (a refresh of a
   * list that still says active is no freeze). A dedicated Docker target that is gone and gets
   * its stack applied again by a target-side unroute comes back writable (its done marker).
   */
  function writers(ws: Writers, boot: boolean, o: { sharedTarget?: number; envId?: number } = {}) {
    const orig = { ...fake.ops }
    const targetLive = () =>
      o.sharedTarget !== undefined ? ws.listed === 'active' : ws.targetUp && !ws.targetMaint
    const check = (name: string) => {
      if (ws.sourceLive && targetLive()) ws.bad.push(name)
    }
    const listedNow = async (): Promise<Writers['listed']> => {
      const env = await db('nivaro_hub_environments').where({ id: o.envId }).first()
      const m = await db('nivaro_hub_moves')
        .where({ environment_id: o.envId })
        .orderBy('id', 'desc')
        .first()
      if (!m) return 'none'
      if (Number(env.placement_id) === Number(m.to_placement_id))
        return env.status === 'active' ? 'active' : 'maintenance'
      return m.placed_at ? 'maintenance' : 'none'
    }
    for (const [name, fn] of Object.entries(orig)) {
      ;(fake.ops as unknown as Record<string, unknown>)[name] = async (...a: unknown[]) => {
        const out = await (fn as (...x: unknown[]) => Promise<unknown>)(...a)
        if (name === 'sourceMaintenance') ws.sourceLive = a[0] !== true
        if (name === 'deployTarget') {
          ws.targetUp = true
          if (boot) ws.targetMaint = true
        }
        if (name === 'targetMaintenance' && o.sharedTarget === undefined)
          ws.targetMaint = a[0] === true
        if (name === 'freezeTarget') ws.targetMaint = true
        if (name === 'removeTarget') ws.targetUp = false
        if (name === 'waitReplicas' && a[0] === o.sharedTarget) ws.listed = await listedNow()
        const ra = a[0] as RouteAction | undefined
        if (
          name === 'unroute' &&
          ra?.side === 'target' &&
          ra.op === 'apply_stack' &&
          !ws.targetUp
        ) {
          ws.targetUp = true
          ws.targetMaint = false
        }
        check(name)
        return out
      }
    }
  }
  const fresh = (): Writers => ({
    sourceLive: true,
    targetUp: false,
    targetMaint: false,
    listed: 'none',
    bad: []
  })

  // R3-M-3 / R4-I-1: the same for shared targets. The release committed `active` and the
  // replicas took it; the rollback must prove every replica holds `maintenance` (and then no
  // longer lists the app) before the source comes back.
  for (const kind of ['to_shared', 'between_shared'] as const)
    it(`${kind}: rollback from release proves the shared target frozen (replicas hold maintenance) before the source`, async () => {
      plan = planOf(kind)
      const w = await world(fromFor(kind))
      const ws = fresh()
      fake.state.during = (name, arg) => {
        if (name === 'targetMaintenance' && arg === false) {
          ws.listed = 'active' // the replicas re-read the list the commit made `active`
          throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
        }
      }
      writers(ws, true, {
        sharedTarget: kind === 'to_shared' ? w.sharedA : w.sharedB,
        envId: w.envId
      })
      const { move_id } = await start(w, toFor(kind, w))
      await Run.awaitMove(move_id)
      expect((await readMove(move_id))?.status).toBe('rolled_back')
      expect(ws.bad).toEqual([])
      expect(ws.listed).not.toBe('active')
      const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
      expect(Number(env.placement_id)).toBe(
        kind === 'to_shared' ? w.dockerPlacement : w.sharedPlacementA
      )
    })

  // R4-I-2: a Docker target removed by the release undo (or stopped by the operator) is never
  // applied again by a target-side unroute (it would boot writable: its done marker).
  it('manual to_dedicated Docker: re-freeze fails, removal succeeds → the target is never re-applied', async () => {
    plan = planOf('to_dedicated', 'manual')
    const w = await world('shared')
    fake.state.serving = true
    const ws = fresh()
    let lifted = false
    fake.state.during = (name, arg) => {
      if (name === 'targetMaintenance' && arg === false) {
        ws.targetMaint = false
        lifted = true
        throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
      }
      if (lifted && (name === 'freezeTarget' || (name === 'targetMaintenance' && arg === true)))
        throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
    }
    writers(ws, true)
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.status).toBe('rolled_back')
    expect(ws.bad).toEqual([])
    expect(ws.targetUp).toBe(false)
    expect(
      fake.calls.filter((c) => c[0] === 'unroute' && (c[1] as RouteAction).side === 'target')
    ).toEqual([])
  })

  it('manual to_dedicated Docker: frozen and removal both fail, the operator stops it and ticks → the target is never re-applied', async () => {
    plan = planOf('to_dedicated', 'manual')
    const w = await world('shared')
    fake.state.serving = true
    const ws = fresh()
    let lifted = false
    fake.state.during = (name, arg) => {
      if (name === 'targetMaintenance' && arg === false) {
        ws.targetMaint = false
        lifted = true
        throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
      }
      if (
        lifted &&
        (name === 'freezeTarget' ||
          name === 'removeTarget' ||
          (name === 'targetMaintenance' && arg === true))
      )
        throw new MoveStepError('AGENT_UNREACHABLE', 'No answer.')
    }
    writers(ws, true)
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.status).toBe('interrupted')
    ws.targetUp = false // the operator removed it by hand
    await Run.setMoveChecklist(move_id, 'target_stopped', true, 'u')
    await Run.cancelMove(move_id, 'u')
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.status).toBe('rolled_back')
    expect(ws.bad).toEqual([])
    expect(ws.targetUp).toBe(false)
  })

  // R3-I-1 / R3-I-2: a lifted GitLab target that can be neither frozen nor retired halts the
  // rollback with the source frozen; the operator stops it, ticks target_stopped, rolls back.
  // R5-I-1 (P6-30): a GitLab target whose boot maintenance is not proven (GITLAB_BOOT_WINDOW)
  // may start writable; the source is frozen before its deploy, in both orders.
  const bootWindow = () => {
    plan.warnings = [
      { code: 'GITLAB_BOOT_WINDOW', text: 'The Hub cannot prove it starts in maintenance.' }
    ]
  }

  it('R5-I-1: manual GitLab, unproven boot maintenance, maintenance call fails, retire unreachable → no point with two writers; the halt says the source stays frozen', async () => {
    plan = planOf('to_dedicated', 'manual')
    bootWindow()
    const w = await world('shared')
    fake.state.serving = true
    const ws = fresh()
    fake.state.during = (name, arg) => {
      if (name === 'targetMaintenance' && arg === true)
        throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
      if (name === 'removeTarget')
        throw new MoveStepError('TARGET_NOT_STOPPED', 'The GitLab target could not be retired.')
    }
    writers(ws, false)
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('interrupted')
    expect(m?.error).toMatch(/^HALTED_TARGET_LIVE/)
    expect(m?.error).toMatch(/the source stays in maintenance/)
    expect(ws.bad).toEqual([])
    expect(ws.sourceLive).toBe(false)
    // The source froze before the deploy; the maintenance call was retried with backoff.
    const names = fake.names()
    expect(names.indexOf('sourceMaintenance')).toBeLessThan(names.indexOf('deployTarget'))
    const after = fake.calls.slice(names.indexOf('deployTarget'))
    expect(
      after.filter((c) => c[0] === 'targetMaintenance' && c[1] === true).length
    ).toBeGreaterThanOrEqual(3)
  })

  for (const routing of ['manual', 'automatic'] as const)
    it(`R5-I-1: ${routing} GitLab, unproven boot maintenance, the maintenance call succeeds on a retry → one writer throughout, success`, async () => {
      plan = planOf('to_dedicated', routing)
      bootWindow()
      const w = await world('shared')
      fake.state.serving = true
      const ws = fresh()
      let n = 0
      const iDeploy = () => fake.names().indexOf('deployTarget')
      fake.state.during = (name, arg) => {
        if (name === 'targetMaintenance' && arg === true && iDeploy() >= 0 && n++ < 2)
          throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
      }
      writers(ws, false)
      const { move_id } = await start(w, toFor('to_dedicated', w))
      await Run.awaitMove(move_id)
      expect((await readMove(move_id))?.status).toBe('success')
      expect(ws.bad).toEqual([])
      const names = fake.names()
      expect(names.indexOf('sourceMaintenance')).toBeLessThan(iDeploy())
    })

  // R6-M-4: the process dies while the source's deploy-window maintenance is being lifted (the
  // lift went through, the mark did not). Resume re-runs deploy_target: it must freeze again.
  it('R6-M-4: a crash inside the lift of the deploy freeze, heal, Resume → the source is frozen again before the redeploy', async () => {
    plan = planOf('to_dedicated', 'manual')
    bootWindow()
    const w = await world('shared')
    fake.state.serving = true
    const ws = fresh()
    let crashed = false
    fake.state.during = (name, arg) => {
      if (name === 'sourceMaintenance' && arg === false && !crashed) {
        crashed = true
        ws.sourceLive = true // the lift reached the source
        return new Promise<void>(() => undefined) // … and the process died
      }
    }
    writers(ws, false)
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await waitFor(async () => crashed)
    unmarkMoveLive(move_id)
    await db('nivaro_hub_moves')
      .where({ id: move_id })
      .update({ heartbeat_at: new Date(START - 3 * 60_000) })
    expect(
      await healMoves({ now, lock, sharedLock: shLock, failJobRun: async () => undefined })
    ).toBe(1)
    const before = fake.calls.length
    await Run.resumeMove(move_id, 'u')
    await Run.awaitMove(move_id)
    const again = fake.calls.slice(before).map((c) => `${c[0]}:${String(c[1] ?? '')}`)
    const iFreeze = again.indexOf('sourceMaintenance:true')
    const iDeploy = again.findIndex((x) => x.startsWith('deployTarget'))
    expect(iDeploy).toBeGreaterThanOrEqual(0)
    expect(iFreeze).toBeGreaterThanOrEqual(0)
    expect(iFreeze).toBeLessThan(iDeploy)
    expect(ws.bad).toEqual([])
  })

  // Final review moves Minor 3 (FW-4): an app that migrates at boot may take longer than 2
  // minutes to answer; the maintenance call is retried within target_ready's 10 minutes.
  it('FW-4: a target that answers its maintenance call only after 5 minutes still moves', async () => {
    plan = planOf('to_dedicated', 'manual')
    bootWindow()
    const w = await world('shared')
    fake.state.serving = true
    let deployedAt: number | null = null
    fake.state.during = (name, arg) => {
      if (name === 'deployTarget') deployedAt = t
      if (
        name === 'targetMaintenance' &&
        arg === true &&
        deployedAt !== null &&
        t - deployedAt < 5 * 60_000
      )
        throw new MoveStepError('LINK_UNREACHABLE', 'Still migrating.')
    }
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.status).toBe('success')
  })

  it('R5-I-1: a halt with the source never frozen says the source keeps serving (never that it stays in maintenance)', async () => {
    plan = planOf('to_dedicated', 'manual')
    const w = await world('shared')
    fake.state.serving = true
    const ws = fresh()
    fake.state.failOn = (name) => name === 'pullFiles'
    fake.state.during = (name) => {
      if (name === 'removeTarget')
        throw new MoveStepError('TARGET_NOT_STOPPED', 'The GitLab target could not be retired.')
    }
    writers(ws, false)
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('interrupted')
    expect(m?.error).toMatch(/^HALTED_TARGET_LIVE/)
    expect(m?.error).not.toMatch(/stays in maintenance/)
    expect(m?.error).toMatch(/source keeps serving/)
    // FW-4 I-1: what happened, never more: this (Docker) target boots in maintenance; the Hub
    // never claims it set one itself.
    expect(m?.error).toMatch(/target was deployed to start in maintenance/)
    expect(m?.error).not.toMatch(/by the Hub/)
    expect(ws.bad).toEqual([])
    expect(ws.sourceLive).toBe(true)
  })

  // FW-4 I-1: a deploy that fails before the Hub set the target's maintenance (no deploy freeze:
  // the target starts in maintenance) halts without ever claiming the Hub set it.
  it('FW-4 I-1: a target deploy that fails before its maintenance was set → the halt says it was deployed to start in maintenance', async () => {
    plan = planOf('to_dedicated', 'manual')
    const w = await world('shared')
    fake.state.serving = true
    fake.state.during = (name) => {
      if (name === 'deployTarget')
        throw new MoveStepError('DEPLOY_FAILED', 'The deploy job failed after it started.')
      if (name === 'removeTarget')
        throw new MoveStepError('TARGET_NOT_STOPPED', 'The GitLab target could not be retired.')
    }
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('interrupted')
    expect(m?.error).toMatch(/^HALTED_TARGET_LIVE/)
    expect(m?.error).toMatch(/deployed to start in maintenance/)
    expect(m?.error).not.toMatch(/after its deploy|by the Hub/)
  })

  it('halt: a GitLab target that cannot be frozen or retired → interrupted HALTED_TARGET_LIVE; tick, Roll back → source serving, one writer throughout', async () => {
    plan = planOf('to_dedicated', 'manual')
    const w = await world('shared')
    fake.state.serving = true
    const ws = fresh()
    let lifted = false
    fake.state.during = (name, arg) => {
      if (name === 'targetMaintenance' && arg === false) {
        ws.targetMaint = false
        lifted = true
        throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
      }
      if (lifted && name === 'freezeTarget')
        throw new MoveStepError('TARGET_NOT_FROZEN', 'No answer.')
      if (lifted && name === 'removeTarget')
        throw new MoveStepError('TARGET_NOT_STOPPED', 'The GitLab target could not be retired.')
    }
    writers(ws, false)
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    let m = await readMove(move_id)
    expect(m?.status).toBe('interrupted')
    expect(m?.error).toMatch(/^HALTED_TARGET_LIVE/)
    expect(ws.sourceLive).toBe(false)
    expect(ws.bad).toEqual([])
    // The Hub still says the env lives on the target (it serves there).
    let env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(Number(env.placement_id)).toBe(w.dockerPlacement)
    const item = m?.checklist.find((c) => c.id === 'target_stopped')
    expect(item).toMatchObject({ required: true, done: false })
    expect(item?.text).toMatch(/stop/i)
    const say = item?.text ?? ''
    expect(m?.error).toContain(say)
    expect(run.lines.join('\n')).toContain(say)
    expect(JSON.parse(String(activity.rows.at(-1)?.comment)).say).toBe(say)
    // Roll back again before the tick: the freeze is retried, still fails, still halted.
    await Run.cancelMove(move_id, 'u')
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.status).toBe('interrupted')
    expect(ws.sourceLive).toBe(false)
    // The operator stops the target by hand and ticks the item; Roll back now lifts the source.
    ws.targetUp = false
    await Run.setMoveChecklist(move_id, 'target_stopped', true, 'u')
    await Run.cancelMove(move_id, 'u')
    await Run.awaitMove(move_id)
    m = await readMove(move_id)
    expect(m?.status).toBe('rolled_back')
    expect(ws.sourceLive).toBe(true)
    expect(ws.bad).toEqual([])
    env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(Number(env.placement_id)).toBe(w.sharedPlacementA)
  })

  for (const routing of ['manual', 'automatic'] as const)
    for (const [label, boot] of [
      ['Docker', true],
      ['GitLab', false]
    ] as const) {
      it(`${routing} to_dedicated, ${label}: the release's lift answers an error after lifting → target frozen first, then the source`, async () => {
        plan = planOf('to_dedicated', routing)
        const w = await world('shared')
        fake.state.serving = true
        const ws = fresh()
        // The lift goes through on the target, but its answer is lost.
        fake.state.during = (name, arg) => {
          if (name === 'targetMaintenance' && arg === false) {
            ws.targetMaint = false
            throw new MoveStepError('LINK_UNREACHABLE', 'No answer.')
          }
        }
        writers(ws, boot)
        const { move_id } = await start(w, toFor('to_dedicated', w))
        await Run.awaitMove(move_id)
        const m = await readMove(move_id)
        expect(m?.status).toBe('rolled_back')
        expect(ws.bad).toEqual([])
        const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
        expect(Number(env.placement_id)).toBe(m?.from_placement_id)
        // The first undo freezes the target, before the source comes back.
        const names = fake.calls.map((c) => `${c[0]}:${String(c[1] ?? '')}`)
        const iFreeze = names.lastIndexOf('freezeTarget:')
        const iSource = names.indexOf('sourceMaintenance:false')
        expect(iFreeze).toBeGreaterThan(names.indexOf('targetMaintenance:false'))
        expect(iSource).toBeGreaterThan(iFreeze)
      })

      it(`${routing} to_dedicated, ${label}: a crash mid-release, heal, roll back → one writer throughout`, async () => {
        plan = planOf('to_dedicated', routing)
        const w = await world('shared')
        fake.state.serving = true
        const ws = fresh()
        let id = 0
        // The process dies inside the lift: the target was lifted, the run never returns.
        fake.state.during = (name, arg) => {
          if (name === 'targetMaintenance' && arg === false) {
            ws.targetMaint = false
            return new Promise<void>(() => undefined)
          }
        }
        writers(ws, boot)
        const out = await start(w, toFor('to_dedicated', w))
        id = out.move_id
        await waitFor(async () => {
          const m = await readMove(id)
          return (
            m?.steps.list.find((x) => x.key === 'release')?.state === 'running' && !ws.targetMaint
          )
        })
        unmarkMoveLive(id) // the process is gone
        await db('nivaro_hub_moves')
          .where({ id })
          .update({ heartbeat_at: new Date(START - 3 * 60_000) })
        expect(
          await healMoves({ now, lock, sharedLock: shLock, failJobRun: async () => undefined })
        ).toBe(1)
        fake.state.during = null
        await Run.cancelMove(id, 'u')
        await Run.awaitMove(id)
        expect((await readMove(id))?.status).toBe('cancelled')
        expect(ws.bad).toEqual([])
        expect(ws.sourceLive).toBe(true)
        expect(!ws.targetUp || ws.targetMaint).toBe(true)
        const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
        expect(Number(env.placement_id)).toBe(w.sharedPlacementA)
      })
    }
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

  // I-3 / I-5: a run that died at any step, still holding its locks, is healed: interrupted, its
  // own locks freed (compare-and-delete with its tokens), and resume continues at that step.
  const FIRST_OP: Record<string, string> = {
    check: 'databaseIdentity',
    place_on_target: 'placeOnTarget',
    files_warm: 'pullFiles',
    maintenance_on: 'sourceMaintenance',
    wait_idle: 'sourceBusy',
    files_delta: 'pullFiles',
    target_ready: 'targetMaintenance',
    route: 'route',
    verify: 'verifyName',
    release: 'targetMaintenance',
    // E2E B4: the new home's key is checked before the source is retired.
    retire_source: 'verifyTargetKey'
  }
  for (const key of MOVE_STEPS.to_shared.filter((k) => k !== 'done'))
    it(`heal at ${key}: a dead run holding its locks → interrupted, locks freed, resume from ${key}`, async () => {
      plan = planOf('to_shared')
      const w = await world('docker')
      const { move_id } = await start(w, toFor('to_shared', w))
      await Run.awaitMove(move_id)
      const m0 = (await readMove(move_id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
      const steps = structuredClone(m0.steps)
      const at = steps.list.findIndex((x) => x.key === key)
      steps.list.forEach((x, i) => {
        x.state = i < at ? 'done' : i === at ? 'running' : 'pending'
      })
      steps.phase = 'forward'
      const released = at > steps.list.findIndex((x) => x.key === 'release')
      if (!released) {
        steps.routed = []
        steps.route_done = []
      }
      // The dead run's locks are still in Redis (TTL 5 min), with its tokens on the row.
      const envToken = (await lock.take(w.envId, 'move')) as string
      const shToken = (await shLock.take(w.sharedA, 'move')) as string
      steps.locks = { env: envToken, shared: [{ id: w.sharedA, token: shToken }] }
      await db('nivaro_hub_moves')
        .where({ id: move_id })
        .update({
          status: 'running',
          step: key,
          steps: JSON.stringify(steps),
          finished_at: null,
          heartbeat_at: new Date(START - 3 * 60_000)
        })
      await db('nivaro_hub_environments')
        .where({ id: w.envId })
        .update({ placement_id: released ? m0.to_placement_id : m0.from_placement_id })
      await db('nivaro_hub_deploys').where({ move_id }).update({ status: 'running' })
      expect(
        await healMoves({ now, lock, sharedLock: shLock, failJobRun: async () => undefined })
      ).toBe(1)
      expect((await readMove(move_id))?.status).toBe('interrupted')
      expect(await lock.held(w.envId)).toBe(false)
      expect(await shLock.holder(w.sharedA)).toBeNull()
      // Someone else's lock taken since is never freed by heal.
      fake = fakeOps()
      useDeps()
      await Run.resumeMove(move_id, 'u')
      await Run.awaitMove(move_id)
      expect(fake.names()[0]).toBe(FIRST_OP[key])
      expect((await readMove(move_id))?.status).toBe('success')
    })

  it('heal never frees a lock another holder took after the dead run', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m0 = (await readMove(move_id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const steps = structuredClone(m0.steps)
    steps.locks = { env: 'move:dead-token', shared: [{ id: w.sharedA, token: 'move:dead-token' }] }
    await db('nivaro_hub_moves')
      .where({ id: move_id })
      .update({
        status: 'running',
        steps: JSON.stringify(steps),
        heartbeat_at: new Date(START - 3 * 60_000)
      })
    const other = (await lock.take(w.envId, 'promotion')) as string
    expect(
      await healMoves({ now, lock, sharedLock: shLock, failJobRun: async () => undefined })
    ).toBe(1)
    expect(await lock.held(w.envId)).toBe(true)
    await lock.release(w.envId, other)
  })

  it('R2-M-3: a converge longer than the stale window keeps the heartbeat fresh; another replica never heals it', async () => {
    plan = planOf('to_dedicated')
    const w = await world('shared')
    useDeps({ renewMs: 10 })
    let id = 0
    let healedDuring = -1
    fake.state.during = async (name) => {
      if (name !== 'deployTarget') return
      // A 6-minute converge (fake clock), the heartbeat timer ticking meanwhile.
      for (let i = 0; i < 12; i++) {
        t += 30_000
        await new Promise((r) => setTimeout(r, 25))
      }
      // Seen from another replica (not this process's live set): the heartbeat is fresh.
      unmarkMoveLive(id)
      healedDuring = await healMoves({
        now,
        lock,
        sharedLock: shLock,
        failJobRun: async () => undefined
      })
      const { markMoveLive } = await import('../../../services/hub/move/heal.js')
      markMoveLive(id)
    }
    const out = await start(w, toFor('to_dedicated', w))
    id = out.move_id
    await Run.awaitMove(id)
    expect(healedDuring).toBe(0)
    expect((await readMove(id))?.status).toBe('success')
  })

  it('R2-M-5: a Redis error on lock renewal counts as lost: the run stops (interrupted), never runs on', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    let redisDown = false
    const flaky = {
      ...memoryPromoteLock,
      // The phase-2 renew treats a Redis blink as held; the move's strict renewal does not.
      renewStrict: async (envId: number, token: string) =>
        redisDown ? false : memoryPromoteLock.renew(envId, token)
    }
    useDeps({ lock: flaky as never, renewMs: 10 })
    fake.state.busy = { imports: 1, exports: 0, renders: 0 }
    fake.state.during = async (name) => {
      if (name !== 'sourceBusy' || redisDown) return
      redisDown = true
      await new Promise((r) => setTimeout(r, 40))
    }
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('interrupted')
    expect(fake.names()).not.toContain('pullFiles:delta')
    expect(fake.calls.filter((c) => c[0] === 'pullFiles')).toHaveLength(1)
    expect(fake.names()).not.toContain('retireSource')
  })

  it('R3-I-3: a lost lock then a step error → interrupted, no undo action runs', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    let lost = false
    const flaky = {
      ...memoryPromoteLock,
      renewStrict: async (envId: number, token: string) =>
        lost ? false : memoryPromoteLock.renew(envId, token)
    }
    useDeps({ lock: flaky as never })
    fake.state.during = (name) => {
      if (name === 'targetReady') {
        lost = true
        throw new MoveStepError('REPLICAS_BEHIND', 'Redis is down too.')
      }
    }
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.status).toBe('interrupted')
    expect(undoCalls(fake.calls)).toEqual([])
  })

  it("R3-I-3: an old runner that loses its lock mid-rollback stops; a person's Roll back finishes it, nothing undone twice", async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    let took = false
    fake.state.during = async (name) => {
      if (name === 'unroute' && !took) {
        took = true
        // Heal freed the lock and a person's Roll back took it meanwhile.
        const m = await readMove(move_id)
        await lock.release(w.envId, m?.steps.locks?.env as string)
        await lock.take(w.envId, 'move')
      }
    }
    fake.state.failOn = (name) => name === 'verifyName'
    let move_id = 0
    const out = await start(w, toFor('to_shared', w))
    move_id = out.move_id
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('interrupted')
    // The old runner made its one undo call, then stopped at the lock check.
    expect(undoCalls(fake.calls)).toEqual([['unroute', plan.route[1]]])
  })

  // R4-M-1: a runner that lost its locks never writes `interrupted` over a move another runner
  // took meanwhile (heal freed the locks, Resume wrote its own tokens and set it running).
  it('R4-M-1: an old runner that lost its lock does not mark a resumed move interrupted', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    let took = false
    let newToken = ''
    fake.state.during = async (name) => {
      if (name === 'unroute' && !took) {
        took = true
        const m = await readMove(move_id)
        await lock.release(w.envId, m?.steps.locks?.env as string)
        newToken = (await lock.take(w.envId, 'move')) as string
        const steps = { ...(m?.steps ?? {}), locks: { env: newToken, shared: [] } }
        await db('nivaro_hub_moves')
          .where({ id: move_id })
          .update({ status: 'running', steps: JSON.stringify(steps) })
      }
    }
    fake.state.failOn = (name) => name === 'verifyName'
    let move_id = 0
    const out = await start(w, toFor('to_shared', w))
    move_id = out.move_id
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    // The new holder's move: still running, its tokens untouched.
    expect(m?.status).toBe('running')
    expect(m?.steps.locks?.env).toBe(newToken)
    await db('nivaro_hub_moves').where({ id: move_id }).update({ status: 'cancelled' })
    await lock.release(w.envId, newToken)
  })

  // R5-M-2: the final status and mirror-row writes are holder-guarded too.
  for (const [label, failOn] of [
    ['success', null],
    ['rollback', 'verifyName']
  ] as const)
    it(`R5-M-2: a ${label} end never writes over a move another runner took just before it`, async () => {
      plan = planOf('to_shared')
      const w = await world('docker')
      let newToken = ''
      let move_id = 0
      fake.state.during = async (name) => {
        if (name === 'revokeTickets' && !newToken) {
          const m = await readMove(move_id)
          await lock.release(w.envId, m?.steps.locks?.env as string)
          newToken = (await lock.take(w.envId, 'move')) as string
          const steps = { ...(m?.steps ?? {}), locks: { env: newToken, shared: [] } }
          await db('nivaro_hub_moves')
            .where({ id: move_id })
            .update({ status: 'running', steps: JSON.stringify(steps) })
          await db('nivaro_hub_deploys').where({ move_id }).update({ status: 'running' })
        }
      }
      if (failOn) fake.state.failOn = (name) => name === failOn
      const out = await start(w, toFor('to_shared', w))
      move_id = out.move_id
      await Run.awaitMove(move_id)
      const m = await readMove(move_id)
      expect(m?.status).toBe('running')
      expect(m?.steps.locks?.env).toBe(newToken)
      expect((await db('nivaro_hub_deploys').where({ move_id }).first()).status).toBe('running')
      await db('nivaro_hub_moves').where({ id: move_id }).update({ status: 'cancelled' })
      await lock.release(w.envId, newToken)
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
    // As stored by a run that stopped inside wait_idle: no route intent, no release yet.
    steps.routed = []
    steps.route_done = []
    delete steps.release_prev
    await db('nivaro_hub_moves')
      .where({ id: move_id })
      .update({ status: 'interrupted', steps: JSON.stringify(steps), heartbeat_at: null })
    fake = fakeOps()
    useDeps()
    await Run.cancelMove(move_id, 'u')
    await Run.awaitMove(move_id)
    // P6-26 Rule 2: the target first (unplace), the source last.
    expect(undoCalls(fake.calls)).toEqual([['unplace'], ['sourceMaintenance', false]])
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

  it('no address of its own for a side → 409 (SOURCE_UNREACHABLE …) before any change', async () => {
    plan = planOf('to_shared', 'manual')
    const w = await world('docker')
    const { AddressError } = await import('../../../services/hub/move/addresses.js')
    for (const code of ['SOURCE_UNREACHABLE', 'TARGET_UNREACHABLE', 'LINK_URL_NOT_PULLABLE']) {
      useDeps({
        addresses: async () => {
          throw new AddressError(code, 'No address.')
        }
      })
      expect(await refusal(start(w, toFor('to_shared', w)))).toMatchObject({
        code,
        statusCode: 409
      })
    }
    expect(await db('nivaro_hub_moves').where({ environment_id: w.envId }).first()).toBeUndefined()
    expect(
      await db('nivaro_hub_placements').where({ shared_deployment_id: w.sharedA }).count({ n: '*' })
    ).toEqual([{ n: 1 }])
    expect(await lock.held(w.envId)).toBe(false)
    expect(fake.calls).toEqual([])
  })

  // Ruling P6-20 #2: LINK_URL_NOT_PULLABLE is overridable per move (operator checkbox, like
  // ORDER), recorded on the move and in the activity; a wrong override fails at files_warm.
  it('LINK_URL_NOT_PULLABLE: refused without the override; with it, recorded, and a wrong one rolls back at files_warm', async () => {
    plan = planOf('between_shared')
    const w = await world('shared')
    const { AddressError } = await import('../../../services/hub/move/addresses.js')
    const seen: Array<boolean | undefined> = []
    useDeps({
      addresses: async (_e, _t, _p, o) => {
        seen.push(o?.allowUnpullable)
        if (!o?.allowUnpullable)
          throw new AddressError('LINK_URL_NOT_PULLABLE', 'The target cannot pull from it.')
        return {
          source_link_base: null,
          source_link_public: false,
          pull_source: 'https://src.internal.example.com',
          target_link_base: null,
          target_publish_host: null,
          target_temp_host: null
        }
      }
    })
    expect((await refusal(start(w, toFor('between_shared', w)))).code).toBe('LINK_URL_NOT_PULLABLE')
    expect(
      (await refusal(start(w, toFor('between_shared', w), { overrides: ['ORDER'] }))).code
    ).toBe('BAD_OVERRIDE')
    // The target does not in fact allow the host: its pull fails (SSRF refusal).
    fake.state.pull = () => ({
      state: 'failed',
      total: 0,
      copied: 0,
      skipped: 0,
      failed: 0,
      missing: [],
      bytes: 0,
      error: 'The source could not be reached.',
      size_mismatch: 0,
      failed_ids: []
    })
    const { move_id } = await start(w, toFor('between_shared', w), {
      overrides: ['LINK_URL_NOT_PULLABLE']
    })
    await Run.awaitMove(move_id)
    expect(seen).toEqual([false, true])
    const m = await readMove(move_id)
    expect(m?.steps.overrides).toEqual(['LINK_URL_NOT_PULLABLE'])
    expect(m?.status).toBe('rolled_back')
    expect(m?.error).toMatch(/^FILES_FAILED/)
    expect(m?.steps.list.find((x) => x.key === 'files_warm')?.state).toBe('failed')
    expect(undoCalls(fake.calls)).toEqual([['unplace']])
    expect(fake.names()).not.toContain('sourceMaintenance')
    const startRow = activity.rows.find((r) => r.action === 'hub-move-start')
    expect(String(startRow?.comment)).toContain('target allows this host')
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

describe('step list writes are atomic (R3-M-1)', () => {
  it('two writers at once both land (compare-and-set, retried); a status guard is kept', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const { mergeSteps } = await import('../../../services/hub/move/rows.js')
    await Promise.all([
      mergeSteps(move_id, (s) => ({ ...s, route_confirmed_at: 'a' })),
      mergeSteps(move_id, (s) => ({ ...s, waiting_since: 'b' })),
      mergeSteps(move_id, (s) => ({ ...s, source_db: 'c' }))
    ])
    const m = await readMove(move_id)
    expect(m?.steps).toMatchObject({ route_confirmed_at: 'a', waiting_since: 'b', source_db: 'c' })
    // Guarded by status: a move that is not waiting is left alone.
    expect(
      await mergeSteps(move_id, (s) => ({ ...s, route_confirmed_at: 'z' }), { status: ['waiting'] })
    ).toBe(false)
    expect((await readMove(move_id))?.steps.route_confirmed_at).toBe('a')
  })
})

// Final review moves Minor 2 (FW-4): a person's tick and the run's own checklist items are
// compare-and-set writes, so neither drops the other.
describe('checklist writes are atomic (FW-4)', () => {
  it('a tick and an item the run adds at the same time both land', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const { mergeChecklist } = await import('../../../services/hub/move/rows.js')
    await Promise.all([
      Run.setMoveChecklist(move_id, 'callbacks_registered', false, 'u'),
      mergeChecklist(move_id, (c) => [
        ...c.filter((x) => x.id !== 'target_stopped'),
        { id: 'target_stopped', text: 'Stop it.', required: true, done: false }
      ]),
      mergeChecklist(move_id, (c) => [
        ...c,
        { id: 'temp_host', text: 'Still to do.', required: false, done: false }
      ])
    ])
    const m = await readMove(move_id)
    const ids = m?.checklist.map((c) => c.id) ?? []
    expect(ids).toEqual(expect.arrayContaining(['target_stopped', 'temp_host']))
    expect(m?.checklist.find((c) => c.id === 'callbacks_registered')?.done).toBe(false)
  })
})

// Ruling P6-27: the per-move name never stays on a live target after the move.
describe('per-move name removed at the end (P6-27)', () => {
  const TEMP = 'hub-move-9-e1.example.com'
  const withTemp = () =>
    useDeps({
      addresses: async () => ({
        source_link_base: 'https://src.direct.example.com',
        source_link_public: false,
        pull_source: 'https://src.direct.example.com',
        target_link_base: `https://${TEMP}`,
        target_publish_host: null,
        target_temp_host: TEMP
      })
    })

  it('done → the per-move name is removed after retire_source; no checklist item', async () => {
    plan = planOf('to_dedicated')
    withTemp()
    const w = await world('shared')
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('success')
    const names = fake.names()
    expect(names).toContain('dropTempHost')
    expect(names.indexOf('dropTempHost')).toBeGreaterThan(names.indexOf('retireSource'))
    expect(m?.checklist.find((c) => c.id === 'temp_host')).toBeUndefined()
  })

  it('the removal fails → a Still to do item naming the name; the move still ends success, nothing undone', async () => {
    plan = planOf('to_dedicated')
    withTemp()
    const w = await world('shared')
    fake.state.failOn = (name) => name === 'dropTempHost'
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('success')
    const item = m?.checklist.find((c) => c.id === 'temp_host')
    expect(item).toMatchObject({ required: false, done: false })
    expect(item?.text).toMatch(/^Still to do/)
    expect(item?.text).toContain(TEMP)
    expect(undoCalls(fake.calls)).toEqual([])
    expect(fake.names()).not.toContain('freezeTarget')
    expect(run.out.completed).toMatch(/done/)
  })

  it('a retire that fails still drops the per-move name (the target stays live)', async () => {
    plan = planOf('to_dedicated')
    withTemp()
    const w = await world('shared')
    fake.state.failOn = (name) => name === 'retireSource'
    const { move_id } = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(move_id)
    expect((await readMove(move_id))?.status).toBe('success')
    expect(fake.names()).toContain('dropTempHost')
  })
})

// FW-4 MOVE_OPEN (ruling P6-37): FW-1 refuses actions on an environment or shared deployment an
// open move touches (services/hub/move-open.ts). The move's own run must still act: every op runs
// inside currentMoveRun() = its move id, which the guard lets through; nothing else does.
describe('the move runner marks its own actions (MOVE_OPEN)', () => {
  it('every op of a run (forward, rollback, resume) sees currentMoveRun() = its move id', async () => {
    const { currentMoveRun } = await import('../../../services/hub/move/run-context.js')
    plan = planOf('to_shared')
    const w = await world('docker')
    const seen = new Set<number | null>()
    fake.state.during = () => {
      seen.add(currentMoveRun())
    }
    fake.state.failOn = (name) => name === 'verifyName'
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    expect([...seen]).toEqual([move_id])
    // Outside a run: none.
    expect(currentMoveRun()).toBeNull()
  })
})

// E2E B4 (ruling P6-38): a move onto a shared deployment carries the app's key into the
// environment's own entry (the only place a shared-placed app's key is read from), in the release
// transaction; and the key round-trips docker → shared → docker. Real store functions.
describe('the app key across moves (E2E B4, P6-38)', () => {
  const sealWith = (hex: string, plain: string) => {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), iv)
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return { iv, tag: c.getAuthTag(), ct }
  }
  const openWith = (hex: string, v: ReturnType<typeof sealWith>) => {
    const d = createDecipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), v.iv)
    d.setAuthTag(v.tag)
    return Buffer.concat([d.update(v.ct), d.final()]).toString('utf8')
  }

  it('docker → shared → docker: the app opens a value sealed before the move, on both sides', async () => {
    const Store = await import('../../../services/hub/shared/store.js')
    const { saveStackSettings } = await import('../../../services/hub/docker/stack-settings.js')
    const { sealSecret } = await import('../../../services/hub/secrets.js')
    const { keyFingerprint } = await import('../../../services/app-key-fingerprint.js')
    const K = 'c7'.repeat(32)
    const w = await world('docker')
    await db('nivaro_hub_environments')
      .where({ id: w.envId })
      .update({ encryption_key: null, encryption_key_fp: null })
    // A Docker app: its key sits in its stack settings only (no entry of its own yet).
    await saveStackSettings(w.envId, {
      size: 'small',
      redis: 'bundled',
      publish_port: null,
      settings: {},
      secrets: sealSecret(JSON.stringify({ ENCRYPTION_KEY: sealSecret(K) }))
    })
    expect(await Store.openAppKey(w.envId)).toBe(K)
    const sealed = sealWith(K, 'sealed before the move')

    plan = planOf('to_shared')
    const out = await start(w, toFor('to_shared', w))
    await Run.awaitMove(out.move_id)
    expect((await readMove(out.move_id))?.status).toBe('success')
    // On shared: the key the deployment is handed (tenantsBody reads openAppKey) opens the value.
    const onShared = await Store.openAppKey(w.envId)
    expect(onShared).toBe(K)
    expect(openWith(onShared as string, sealed)).toBe('sealed before the move')
    const env = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(env.encryption_key_fp).toBe(keyFingerprint(K))
    // The deployment's key was checked before the source was retired.
    const names = fake.names()
    expect(names.indexOf('verifyTargetKey')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('verifyTargetKey')).toBeLessThan(names.indexOf('retireSource'))

    // And back out to a Docker stack: still the same key.
    fake = fakeOps()
    useDeps()
    plan = planOf('to_dedicated')
    const back = await start(w, toFor('to_dedicated', w))
    await Run.awaitMove(back.move_id)
    expect((await readMove(back.move_id))?.status).toBe('success')
    const onDocker = await Store.openAppKey(w.envId)
    expect(onDocker).toBe(K)
    expect(openWith(onDocker as string, sealed)).toBe('sealed before the move')
  })

  it('a deployment that does not report the matching key never gets the source retired', async () => {
    plan = planOf('to_shared')
    const w = await world('docker')
    const Store = await import('../../../services/hub/shared/store.js')
    await Store.setAppKey(w.envId, 'd8'.repeat(32))
    fake.state.failOn = (name) => name === 'verifyTargetKey'
    const { move_id } = await start(w, toFor('to_shared', w))
    await Run.awaitMove(move_id)
    const m = await readMove(move_id)
    expect(m?.status).toBe('success')
    expect(m?.checklist.find((c) => c.id === 'retire_source')).toMatchObject({ done: false })
    expect(fake.names()).not.toContain('retireSource')
  })
})
