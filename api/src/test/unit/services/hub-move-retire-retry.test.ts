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
//
// Round 1 (rulings P6-43, I-2, M-1, M-2): the key check is the REAL one (ops.ts verifyTargetKey /
// targetKeyFp over fake deployment and hub-link clients that report what the new home runs), the
// fix goes through the REAL App key PUT route (taken only when it matches the new home's report),
// and "Finish and keep the old home" (POST /moves/:id/finish-keep-source, typed confirm) ends a
// move whose key never checks without retiring the old home.

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
vi.mock('../../../middleware/authenticate.js', () => {
  const admin = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'AAAAAAAA-0000-4000-8000-000000000001', status: 'active' }
    req.isAdmin = true
  }
  return { requireAuth: vi.fn(admin), requireAdmin: vi.fn(admin), authenticate: vi.fn(admin) }
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
const { defaultMoveOps } = await import('../../../services/hub/move/ops.js')
const { keyFingerprint } = await import('../../../services/app-key-fingerprint.js')
const { hubSharedRoutes } = await import('../../../routes/hub-shared.js')
const { hubMoveRoutes } = await import('../../../routes/hub-move.js')
const Fastify = (await import('fastify')).default
const StackSettings = await import('../../../services/hub/docker/stack-settings.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')

/** The environment's Docker stack settings, its secrets sealed as a Stack panel save stores them. */
async function stackWithKey(envId: number, encryptionKey: string, session = 'f0'.repeat(32)) {
  await StackSettings.saveStackSettings(envId, {
    size: 'small',
    redis: 'bundled',
    publish_port: null,
    settings: { NIVARO_EXAMPLE: 'kept' },
    secrets: sealSecret(
      JSON.stringify({
        ENCRYPTION_KEY: sealSecret(encryptionKey),
        SESSION_SECRET: sealSecret(session)
      })
    )
  })
}
const stackSecrets = async (envId: number) =>
  StackSettings.openStackSecrets(await StackSettings.readStackSettings(envId))
type MovePlan = import('../../../services/hub/move/types.js').MovePlan
type MoveKind = import('../../../services/hub/move/types.js').MoveKind
type MoveOps = import('../../../services/hub/move/ops.js').MoveOps

const HUB_KEY = 'e'.repeat(64)
const SECRET_KEY = 'ab'.repeat(32)
/** The key the new home really runs in the "new home runs another key" cases. */
const NEW_KEY = 'c3'.repeat(32)
const OTHER_KEY = 'd4'.repeat(32)
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

/**
 * What the NEW home reports (the fingerprint of the key it runs; null = it reports none), and
 * whether it can be reached at all. The real key check reads it through fake link clients.
 */
const home = {
  fp: null as string | null,
  unreachable: false,
  /** Runs before each real key check (a test looks at the stored move then). */
  onCheck: null as null | (() => Promise<void>)
}

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
    // Replaced by the real ones in useDeps (realKeyOps).
    verifyTargetKey: rec('verifyTargetKey', () => undefined),
    targetKeyFp: rec('targetKeyFp', () => home.fp),
    dropTempHost: rec('dropTempHost', () => null as string | null),
    revokeTickets: rec('revokeTickets', () => undefined),
    databaseIdentity: rec('databaseIdentity', () => 'pg|db.internal|5432|acme')
  }
  return { ops, calls }
}

let fake = fakeOps()
let plan = planOf('to_shared')
const runOut = { failed: [] as string[], completed: [] as string[] }

/** The new home as the real ops reach it: its deployment link or its hub link. */
function reportOf() {
  if (home.unreachable)
    throw Object.assign(new Error('The new home did not answer.'), {
      name: 'HubLinkError',
      code: 'LINK_UNREACHABLE'
    })
  return { key_fp: home.fp }
}
const fakeClient = (() => ({ appStatus: async () => reportOf() })) as never
const fakeLink = (() => ({ sharedReadiness: async () => reportOf() })) as never

/** The fake ops, with the REAL key check (ops.ts) over the fake clients. */
function realKeyOps(move: Parameters<typeof defaultMoveOps>[0], p: MovePlan): MoveOps {
  const real = defaultMoveOps(move, p, { client: fakeClient, link: fakeLink, sleep })
  return {
    ...fake.ops,
    targetKeyFp: async () => {
      fake.calls.push('targetKeyFp')
      return real.targetKeyFp()
    },
    verifyTargetKey: async () => {
      fake.calls.push('verifyTargetKey')
      await home.onCheck?.()
      try {
        return await real.verifyTargetKey()
      } catch (err) {
        // The link clients' own errors arrive as MoveStepErrors with their code.
        const code = (err as { code?: unknown }).code
        if (code === 'LINK_UNREACHABLE')
          throw new MoveStepError('LINK_UNREACHABLE', 'The new home did not answer.')
        throw err
      }
    }
  }
}

function useDeps() {
  Run.setMoveRunDeps({
    ops: (move: Parameters<typeof defaultMoveOps>[0], p: MovePlan) => realKeyOps(move, p),
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
      target_link_base: 'https://tgt.direct.example.com',
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

let http: Awaited<ReturnType<typeof buildHttp>>
async function buildHttp() {
  const a = Fastify()
  await a.register(
    async (f) => {
      hubSharedRoutes(f)
      hubMoveRoutes(f)
    },
    { prefix: '/api/hub' }
  )
  await a.ready()
  return a
}
const putKey = (envId: number, key: string) =>
  http.inject({ method: 'PUT', url: `/api/hub/environments/${envId}/app-key`, payload: { key } })
const finishKeep = (id: number, confirm: string) =>
  http.inject({
    method: 'POST',
    url: `/api/hub/moves/${id}/finish-keep-source`,
    payload: { confirm }
  })

const fp = (k: string) => keyFingerprint(k)

beforeAll(async () => {
  http = await buildHttp()
})

afterAll(async () => {
  await http.close()
})

beforeEach(() => {
  t = START
  // The new home runs another key than the one the Hub holds (SECRET_KEY): the check fails.
  home.fp = fp(NEW_KEY)
  home.unreachable = false
  home.onCheck = null
  fake = fakeOps()
  runOut.failed = []
  runOut.completed = []
  useDeps()
})

async function listedOnSource(w: World): Promise<string | null> {
  const listed = await tenantsOf((await Store.getShared(w.sharedA)) as never)
  return listed.find((r) => r.env.id === w.envId)?.wireStatus ?? null
}

async function stoppedAtRetire(w: World, kind: MoveKind, id: number) {
  const m = await readMove(id)
  // Open, with a clear reason: the code, what it means, both ways out (P6-43 (c)).
  expect(m?.status).toBe('interrupted')
  expect(m?.error).toMatch(/^APP_KEY_MISMATCH: /)
  expect(m?.error).toContain('the old home was not retired')
  expect(m?.error).toContain('then Resume')
  expect(m?.error).toContain('Finish and keep the old home')
  expect(m?.finished_at).toBeNull()
  // The real check was retried (about a minute) before the run stopped.
  expect(fake.calls.filter((c) => c === 'verifyTargetKey').length).toBeGreaterThanOrEqual(3)
  // Never retired; the step column never says retire_source (a shared source keeps the app).
  expect(fake.calls).not.toContain('retireSource')
  expect(m?.steps.list.find((x) => x.key === 'retire_source')?.state).toBe('failed')
  expect(m?.steps.list.find((x) => x.key === 'release')?.state).toBe('done')
  expect(m?.step).toBe('release')
  const item = m?.checklist.find((c) => c.id === 'retire_source')
  expect(item?.done).toBe(false)
  expect(item?.text).toMatch(/^Do not retire the old home yet: /)
  expect((await db('nivaro_hub_deploys').where({ move_id: id }).first()).status).toBe('interrupted')
  expect(runOut.completed).toEqual([])
  expect(runOut.failed.at(-1)).toMatch(/APP_KEY_MISMATCH/)
  // Never a key in the record (fingerprints are fine).
  const record = JSON.stringify(m)
  for (const k of [SECRET_KEY, NEW_KEY, OTHER_KEY]) expect(record).not.toContain(k)
  if (kind !== 'to_shared') expect(await listedOnSource(w)).toBe('maintenance')
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
  // A heal leaves it as it is; the app already serves from its new home: TOO_LATE.
  t += 60 * 60_000
  await healMoves({ now })
  expect((await readMove(id))?.status).toBe('interrupted')
  expect(await refusal(Run.cancelMove(id, 'u'))).toMatchObject({ code: 'TOO_LATE' })
}

async function resumeAndWait(id: number) {
  fake = fakeOps()
  useDeps()
  await Run.resumeMove(id, 'u')
  await Run.awaitMove(id)
  return readMove(id)
}

async function retiredOnce(w: World, kind: MoveKind, id: number) {
  const done = await readMove(id)
  expect(done?.status).toBe('success')
  expect(done?.error).toBeNull()
  expect(fake.calls.filter((c) => c === 'retireSource')).toHaveLength(1)
  expect(fake.calls).not.toContain('placeOnTarget')
  expect(fake.calls).not.toContain('route')
  expect(done?.steps.list.every((x) => x.state === 'done')).toBe(true)
  expect(done?.checklist.find((c) => c.id === 'retire_source')?.done).toBe(true)
  expect(await moveOpenRefusal({ envIds: [w.envId] })).toBeNull()
  if (kind !== 'to_shared') expect(await listedOnSource(w)).toBeNull()
}

// ── a Docker target: the App key PUT takes the key the new home really runs ──────────────────

describe('to_dedicated (Docker target): the new home runs another key', () => {
  it('stays open; the PUT takes only the key the new home reports; Resume retires once', async () => {
    const w = await world('shared')
    // The Docker target's stack settings still hold the key the Hub holds (not what it runs).
    await stackWithKey(w.envId, SECRET_KEY)
    const id = await startMove(w, 'to_dedicated')
    await stoppedAtRetire(w, 'to_dedicated', id)

    // A key that is neither: refused, saying which home reports which (fingerprints only).
    const wrong = await putKey(w.envId, OTHER_KEY)
    expect(wrong.statusCode).toBe(409)
    expect(wrong.json().code).toBe('APP_KEY_MISMATCH')
    expect(wrong.json().message).toContain(
      `The new home reports the key with fingerprint ${fp(NEW_KEY)}`
    )
    expect(wrong.json().message).toContain(`the key entered has fingerprint ${fp(OTHER_KEY)}`)
    expect(wrong.json().message).toContain(
      `The Hub holds the key with fingerprint ${fp(SECRET_KEY)}`
    )
    expect(wrong.body).not.toContain(OTHER_KEY)
    expect(await Store.openAppKey(w.envId)).toBe(SECRET_KEY)
    // A refused key never reaches the stack secret.
    expect((await stackSecrets(w.envId)).ENCRYPTION_KEY).toBe(SECRET_KEY)
    // The key the Hub already holds is not the new home's either: refused the same way.
    expect((await putKey(w.envId, SECRET_KEY)).json().code).toBe('APP_KEY_MISMATCH')

    // A Resume with nothing fixed: the real check fails again, still open, still not retired.
    const again = await resumeAndWait(id)
    expect(again?.status).toBe('interrupted')
    expect(fake.calls).not.toContain('retireSource')

    // The key the new home runs: taken (verified against the new home's own report).
    const ok = await putKey(w.envId, NEW_KEY)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data).toMatchObject({
      fp: fp(NEW_KEY),
      changed: true,
      verified: 'hub-link',
      stack_key: 'set'
    })
    expect(await Store.openAppKey(w.envId)).toBe(NEW_KEY)
    // Round 1b: the sealed stack secret now holds the key the app runs (a later Apply keeps
    // it); every other setting and secret is kept, and nothing was deployed.
    const after = await stackSecrets(w.envId)
    expect(after.ENCRYPTION_KEY).toBe(NEW_KEY)
    expect(after.SESSION_SECRET).toBe('f0'.repeat(32))
    expect((await StackSettings.readStackSettings(w.envId))?.settings).toEqual({
      NIVARO_EXAMPLE: 'kept'
    })
    expect(JSON.stringify(await StackSettings.readStackSettings(w.envId))).not.toContain(NEW_KEY)
    expect(fake.calls).not.toContain('deployTarget')
    expect(fake.calls).not.toContain('route')
    // The same key again: nothing left to change.
    const again2 = await putKey(w.envId, NEW_KEY)
    expect(again2.json().data).toMatchObject({ changed: false })
    expect(again2.json().data.stack_key).toBeUndefined()

    // Resume: the real check passes now; the old home is retired exactly once.
    await resumeAndWait(id)
    await retiredOnce(w, 'to_dedicated', id)
  })
})

// ── a shared target: APP_KEY_IMMUTABLE still refuses a different key ────────────────────────

for (const kind of ['to_shared', 'between_shared'] as MoveKind[]) {
  describe(`${kind} (shared target): the deployment reports another key`, () => {
    it('a different key is IMMUTABLE; the Hub key is taken once the deployment reports it', async () => {
      const w = await world(kind === 'to_shared' ? 'docker' : 'shared')
      // A stack settings row left from an old Docker home: a shared target never touches it.
      await stackWithKey(w.envId, OTHER_KEY)
      const id = await startMove(w, kind)
      await stoppedAtRetire(w, kind, id)

      // The key the deployment reports differs from the Hub's: a shared target keeps its key.
      const imm = await putKey(w.envId, NEW_KEY)
      expect(imm.statusCode).toBe(409)
      expect(imm.json().code).toBe('APP_KEY_IMMUTABLE')
      // The Hub's key, while the deployment still reports another: refused, both named.
      const mis = await putKey(w.envId, SECRET_KEY)
      expect(mis.json().code).toBe('APP_KEY_MISMATCH')
      expect(mis.json().message).toContain(fp(NEW_KEY))
      expect(mis.json().message).toContain(fp(SECRET_KEY))

      // Its replicas re-read the Hub's list: it reports the app's own key; the PUT agrees.
      home.fp = fp(SECRET_KEY)
      const same = await putKey(w.envId, SECRET_KEY)
      expect(same.statusCode).toBe(200)
      expect(same.json().data).toMatchObject({ changed: false })
      expect(same.json().data.stack_key).toBeUndefined()
      expect((await stackSecrets(w.envId)).ENCRYPTION_KEY).toBe(OTHER_KEY)
      await resumeAndWait(id)
      await retiredOnce(w, kind, id)
    })
  })
}

// ── no key reported, or the new home cannot be reached ───────────────────────────────────────

describe('APP_KEY_UNKNOWN: the new home reports no key', () => {
  it('no PUT can match it; Finish and keep the old home ends the move without retiring it', async () => {
    home.fp = null
    const w = await world('shared')
    const id = await startMove(w, 'to_dedicated')
    const m = await readMove(id)
    expect(m?.status).toBe('interrupted')
    expect(m?.error).toMatch(/^APP_KEY_UNKNOWN: /)
    expect(m?.error).toContain('Finish and keep the old home')
    const put = await putKey(w.envId, SECRET_KEY)
    expect(put.statusCode).toBe(409)
    expect(put.json()).toMatchObject({ code: 'APP_KEY_UNVERIFIED', reason: 'NO_KEY_FP' })
    expect(put.json().message).toContain('Finish and keep the old home')

    // A wrong typed confirm is refused; nothing changes.
    const bad = await finishKeep(id, 'nope')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('CONFIRM_MISMATCH')
    expect((await readMove(id))?.status).toBe('interrupted')

    // Finish and keep the old home.
    fake = fakeOps()
    useDeps()
    const fin = await finishKeep(id, `${w.appKey}/prod`)
    expect(fin.statusCode).toBe(202)
    await Run.awaitMove(id)
    const done = await readMove(id)
    expect(done?.status).toBe('success')
    expect(done?.error).toContain('the old home was kept and not retired')
    expect(fake.calls).not.toContain('retireSource')
    expect(fake.calls).not.toContain('verifyTargetKey')
    const item = done?.checklist.find((c) => c.id === 'retire_source')
    expect(item?.done).toBe(false)
    expect(item?.text).toMatch(/^The old home was kept on purpose/)
    // MOVE_OPEN lifts; the move cannot be finished twice or cancelled.
    expect(await moveOpenRefusal({ envIds: [w.envId] })).toBeNull()
    expect((await finishKeep(id, `${w.appKey}/prod`)).json().code).toBe('MOVE_ENDED')
    expect(await refusal(Run.cancelMove(id, 'u'))).toMatchObject({ code: 'MOVE_ENDED' })
    // The shared old home is still in place (listed, maintenance) until the item is ticked.
    expect(await listedOnSource(w)).toBe('maintenance')
    const tick = await http.inject({
      method: 'POST',
      url: `/api/hub/moves/${id}/checklist`,
      payload: { item: 'retire_source', done: true }
    })
    expect(tick.statusCode).toBe(200)
    expect(await listedOnSource(w)).toBeNull()
  })
})

describe('M-1: the new home cannot be reached to check its key', () => {
  it('says so and to Resume; never tells anyone to enter a key', async () => {
    home.unreachable = true
    const w = await world('docker')
    const id = await startMove(w, 'to_shared')
    const m = await readMove(id)
    expect(m?.status).toBe('interrupted')
    expect(m?.error).toMatch(/^LINK_UNREACHABLE: /)
    expect(m?.error).toContain('could not reach the new home to check its key')
    expect(m?.error).toContain('Resume to try again')
    const item = m?.checklist.find((c) => c.id === 'retire_source')?.text ?? ''
    for (const text of [m?.error ?? '', item]) {
      expect(text).not.toMatch(/enter (the|its|this) (app's )?key/i)
      expect(text).not.toContain('App key')
    }
    expect(fake.calls).not.toContain('retireSource')
    // It answers again, with the right key: Resume retires.
    home.unreachable = false
    home.fp = fp(SECRET_KEY)
    await resumeAndWait(id)
    await retiredOnce(w, 'to_shared', id)
  })
})

// ── I-2: Resume clears the previous stop ─────────────────────────────────────────────────────

describe('I-2: a resumed stop no longer carries its old error', () => {
  it('the error is cleared while the resumed run works, and only a new stop writes one', async () => {
    const w = await world('docker')
    const id = await startMove(w, 'to_shared')
    expect((await readMove(id))?.error).toMatch(/^APP_KEY_MISMATCH/)
    const seen: Array<string | null> = []
    home.onCheck = async () => {
      seen.push((await readMove(id))?.error ?? null)
    }
    try {
      await resumeAndWait(id)
    } finally {
      home.onCheck = null
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((e) => e === null)).toBe(true)
    expect((await readMove(id))?.error).toMatch(/^APP_KEY_MISMATCH/)
  })

  it('Finish and keep is refused before release and on a rollback that stopped', async () => {
    const w = await world('docker')
    const id = await startMove(w, 'to_shared')
    // Rewind the stored move to an interrupted ROLLBACK before release carrying an APP_KEY error
    // (target_ready refused the key, then the rollback lost its locks).
    const m0 = (await readMove(id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const steps = structuredClone(m0.steps)
    const rel = steps.list.findIndex((x) => x.key === 'release')
    steps.list.forEach((x, i) => {
      x.state = i < rel ? 'done' : 'pending'
    })
    steps.phase = 'rollback'
    await db('nivaro_hub_moves')
      .where({ id })
      .update({
        steps: JSON.stringify(steps),
        step: 'target_ready',
        error: 'APP_KEY_MISMATCH: Another key.'
      })
    expect(Run.retireStopOf(await readMove(id))).toBeNull()
    expect((await finishKeep(id, `${w.appKey}/prod`)).json().code).toBe('NOT_RELEASED')
    // And the App key PUT is judged as usual there (not against a "new home").
    expect(await Run.retireStopFor(w.envId)).toBeNull()
  })
})

// ── M-2: a stop after the step column said retire_source ─────────────────────────────────────

describe('M-2: a run that stopped after the key checked', () => {
  it('Resume finishes the retire without checking again (the proof is stored first)', async () => {
    home.fp = fp(SECRET_KEY)
    const w = await world('shared')
    const id = await startMove(w, 'between_shared')
    expect((await readMove(id))?.status).toBe('success')
    // Rewind: the key checked, the step column said retire_source, the Hub died in waitReplicas.
    const m0 = (await readMove(id)) as NonNullable<Awaited<ReturnType<typeof readMove>>>
    const steps = structuredClone(m0.steps)
    for (const x of steps.list)
      if (x.key === 'retire_source') x.state = 'running'
      else if (x.key === 'done') x.state = 'pending'
    expect(steps.retire_key_checked_at).toBeTruthy()
    await db('nivaro_hub_moves')
      .where({ id })
      .update({ status: 'interrupted', step: 'retire_source', steps: JSON.stringify(steps) })
    // Meanwhile the deployment reports another key: it is not asked again.
    home.fp = fp(NEW_KEY)
    await resumeAndWait(id)
    expect(fake.calls).not.toContain('verifyTargetKey')
    expect(fake.calls).toContain('retireSource')
    expect((await readMove(id))?.status).toBe('success')
  })

  it('a check that fails with the step column at retire_source (no proof stored) puts it back: the source lists the app again', async () => {
    const w = await world('shared')
    const id = await startMove(w, 'between_shared')
    expect((await readMove(id))?.status).toBe('interrupted')
    // An older row: the column says retire_source and no proof is stored.
    await db('nivaro_hub_moves').where({ id }).update({ step: 'retire_source' })
    expect(await listedOnSource(w)).toBeNull()
    const again = await resumeAndWait(id)
    expect(again?.status).toBe('interrupted')
    expect(again?.step).toBe('release')
    expect(await listedOnSource(w)).toBe('maintenance')
    expect(fake.calls).not.toContain('retireSource')
  })
})

describe('other retire outcomes', () => {
  it('a key check that passes inside its retry window retires at once (no interruption)', async () => {
    const w = await world('docker')
    let n = 0
    home.fp = fp(NEW_KEY)
    sleep.mockImplementation(async (ms: number) => {
      t += ms
      if (++n === 2) home.fp = fp(SECRET_KEY)
      await new Promise((r) => setImmediate(r))
    })
    try {
      const id = await startMove(w, 'to_shared')
      expect((await readMove(id))?.status).toBe('success')
      expect(fake.calls).toContain('retireSource')
    } finally {
      sleep.mockImplementation(async (ms: number) => {
        t += ms
        await new Promise((r) => setImmediate(r))
      })
    }
  })

  it('a retire that fails for another reason still ends success with the item open', async () => {
    home.fp = fp(SECRET_KEY)
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
