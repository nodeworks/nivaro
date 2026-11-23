import { createHash } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { getApp } from '../../io-holder.js'
import { type JobRunHandle, startJobRun } from '../../job-runs.js'
import { readApp } from '../apps.js'
import { createPlacement, getDriver, getPlacement } from '../drivers.js'
import {
  defaultPromoteLock,
  defaultSharedLock,
  LOCK_RENEW_MS,
  lockHolderRefusal,
  type PromoteLock,
  type SharedLock,
  sharedLockRefusal
} from '../promote-lock.js'
import type { PullStatus } from '../shared/deployment-client.js'
import { getShared } from '../shared/store.js'
import {
  AddressError,
  type AddressOptions,
  type MoveAddresses,
  resolveMoveAddresses
} from './addresses.js'
import { isMoveLiveHere, markMoveLive, unmarkMoveLive } from './heal.js'
import { asStepError, defaultMoveOps, type MoveOps, MoveStepError } from './ops.js'
import {
  checkTarget,
  type MovePlan,
  type MovePlanner,
  MovePlannerError,
  type MoveStepKey,
  type MoveTarget,
  planMove
} from './plan-port.js'
import { undoMove } from './rollback.js'
import {
  freshSteps,
  type HubMoveRow,
  MOVES,
  type MoveChecklistState,
  type MoveFiles,
  type MoveFilesSummary,
  type MoveStatus,
  type MoveSteps,
  mergeSteps,
  OPEN_MOVE_STATUSES,
  openMoveOf,
  patchMove,
  patchMoveIfHolder,
  readMove,
  setEnvStatus,
  stepDone
} from './rows.js'

/**
 * Nivaro Hub phase 6, Task 16: the move run — a recorded, locked, resumable run of the plan's
 * steps (Task 15 decides which steps and in which order, preflight B8's manual order included;
 * this runner executes `plan.steps` as listed).
 *
 * Start (startMove): the typed confirm is `<app key>/<env key>` (400 CONFIRM_MISMATCH); the plan is
 * made again and its hash must be the one the person saw (409 PLAN_CHANGED with the fresh plan;
 * blockers → 409 PLAN_BLOCKED); every required checklist item must be ticked (409 CHECKLIST_INCOMPLETE naming them; the plan
 * has no `startable` flag, the run decides).
 * Locks: the environment's lock as `move` (another holder → 409 BUSY naming it; an open move of
 * the environment → 409 BUSY) and the shared lock of every shared deployment the move touches as
 * `move` (409 SHARED_BUSY, e.g. during an upgrade). Both are held for the whole run, a manual
 * route wait included, renewed with the heartbeat every 60 s. Records: the move row; one
 * nivaro_hub_deploys row (kind `move`, move_id, version = plan.version, closed here, R8); a job
 * run; activity hub-move-start | done | rolled-back | cancel. A move to a shared deployment makes
 * its target placement at start (kind shared, pool_max) and removes it again on rollback.
 *
 * The environment's status (B1, no `moving`): untouched until `maintenance_on`, then
 * `maintenance` (the status before is the move's prior_status); `release` sets `active`; a
 * rollback puts the prior one back.
 *
 * Steps (budgets): wait_idle 10 min until the source is idle; target_ready 10 min (the ops);
 * route + verify 10 min when automatic; a manual route waits (status `waiting`, heartbeat on) up to
 * 24 h for confirmRoute or the name to serve the target, then fails; file steps follow the pull's
 * own stall rule (Task 10). Files: the first warm copy is `full` (T10 carry), later ones `delta`;
 * inside maintenance a pull with failed rows stops the move (it rolls back, nothing is lost); a
 * source 404 is `missing` (logged, never blocking: the object was gone before the move); a row
 * whose stored size was stale is copied and counted (size_mismatch).
 *
 * Before `release` any failure or a cancel rolls back (rollback.ts) → `rolled_back` / `cancelled`
 * (`failed` when an undo itself failed). `release` is the point of no return: the environment's
 * placement_id, version_pin and (Docker target) hub_managed move to the target. After it, a
 * failing `retire_source` ends `success` with a warning and the checklist item `retire_source`
 * open; it is never rolled back. Tickets are revoked after each copy and at the end.
 *
 * Stored error, job-run and activity text: codes and plain sentences only (MoveStepError and the
 * clients' own safe messages); any other error becomes a generic sentence and only its name is
 * logged — never a token, ticket, key or connection.
 */

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'
const PLACEMENTS = 'nivaro_hub_placements'

export const WAIT_IDLE_MS = 10 * 60_000
export const ROUTE_VERIFY_MS = 10 * 60_000
export const MANUAL_ROUTE_MS = 24 * 60 * 60_000
const POLL_MS = 5_000
const VERIFY_POLL_MS = 15_000
const MANUAL_POLL_MS = 15_000
/** A waiting run looks at the name itself this often (besides confirmRoute). */
const MANUAL_SELF_CHECK_MS = 5 * 60_000

/** A refusal of start / cancel / resume / confirm: status, code, plain sentence. */
export class MoveError extends Error {
  code: string
  statusCode: number
  plan?: MovePlan
  blockers?: MovePlan['blockers']
  open?: string[]
  constructor(
    code: string,
    message: string,
    statusCode = 409,
    extra: { plan?: MovePlan; blockers?: MovePlan['blockers']; open?: string[] } = {}
  ) {
    super(message)
    this.name = 'MoveError'
    this.code = code
    this.statusCode = statusCode
    Object.assign(this, extra)
  }
}

export interface MoveRunDeps {
  ops?: (move: HubMoveRow, plan: MovePlan, log: RunLog) => MoveOps
  planner?: MovePlanner
  lock?: PromoteLock
  sharedLock?: SharedLock
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  startJobRun?: (label: string, moveId: number, by: string | null) => Promise<JobRunHandle>
  /** Heartbeat + lock renewal interval (default 60 s). */
  renewMs?: number
  /** Resolves and probes each dedicated side's address at start (addresses.ts). */
  addresses?: (
    envId: number,
    to: MoveTarget,
    plan: MovePlan,
    opts?: AddressOptions
  ) => Promise<MoveAddresses>
  /** Poll intervals (tests shorten or lengthen them against a fake clock). */
  pollMs?: number
  manualPollMs?: number
}

type RunLog = (line: string, level?: 'info' | 'warn' | 'error') => void

let base: MoveRunDeps = {}
/** Tests: the deps every start / cancel / resume / confirm uses (routes pass none). */
export function setMoveRunDeps(d: MoveRunDeps | null): void {
  base = d ?? {}
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

interface Env {
  now: () => number
  sleep: (ms: number) => Promise<void>
  lock: PromoteLock
  sharedLock: SharedLock
  planner: MovePlanner
  opsFor: (move: HubMoveRow, plan: MovePlan, log: RunLog) => MoveOps
  startRun: (label: string, moveId: number, by: string | null) => Promise<JobRunHandle>
  renewMs: number
  addresses: (
    envId: number,
    to: MoveTarget,
    plan: MovePlan,
    opts?: AddressOptions
  ) => Promise<MoveAddresses>
  pollMs: number
  manualPollMs: number
}

function envOf(over: MoveRunDeps = {}): Env {
  const d = { ...base, ...over }
  return {
    now: d.now ?? Date.now,
    sleep: d.sleep ?? realSleep,
    lock: d.lock ?? defaultPromoteLock(),
    sharedLock: d.sharedLock ?? defaultSharedLock(),
    planner: d.planner ?? planMove,
    opsFor: d.ops ?? ((m, p, log) => defaultMoveOps(m, p, { log })),
    startRun:
      d.startJobRun ??
      ((label, id, by) =>
        startJobRun('deploy', `hub-move-${id}`, { label, triggeredBy: by ?? null })),
    renewMs: d.renewMs ?? LOCK_RENEW_MS,
    addresses:
      d.addresses ?? ((envId, to, plan, o) => resolveMoveAddresses(envId, to, plan, {}, o)),
    pollMs: d.pollMs ?? POLL_MS,
    manualPollMs: d.manualPollMs ?? MANUAL_POLL_MS
  }
}

// ── locks ────────────────────────────────────────────────────────────────────────────────

interface Held {
  envId: number
  envToken: string
  shared: Array<{ id: number; token: string }>
}

async function takeLocks(envId: number, sharedIds: number[], e: Env): Promise<Held> {
  const envToken = await e.lock.take(envId, 'move')
  if (!envToken) {
    const holder = (await e.lock.holder?.(envId)) ?? null
    const r = lockHolderRefusal(holder, {
      code: 'BUSY',
      message: 'Another action holds this environment — try again shortly.'
    })
    throw new MoveError('BUSY', r.message)
  }
  const shared: Held['shared'] = []
  try {
    for (const id of [...new Set(sharedIds)].sort((a, b) => a - b)) {
      const token = await e.sharedLock.take(id, 'move')
      if (!token) {
        const r = sharedLockRefusal(await e.sharedLock.holder(id))
        throw new MoveError('SHARED_BUSY', r.message)
      }
      shared.push({ id, token })
    }
  } catch (err) {
    for (const s of shared) await e.sharedLock.release(s.id, s.token)
    await e.lock.release(envId, envToken)
    throw err
  }
  return { envId, envToken, shared }
}

async function releaseLocks(held: Held, e: Env): Promise<void> {
  for (const s of held.shared) await e.sharedLock.release(s.id, s.token).catch(() => undefined)
  await e.lock.release(held.envId, held.envToken).catch(() => undefined)
}

function lockTokens(held: Held): NonNullable<MoveSteps['locks']> {
  return { env: held.envToken, shared: held.shared.map((x) => ({ id: x.id, token: x.token })) }
}

/** The shared deployment ids of a move's two sides. */
async function sharedIdsOf(fromPlacementId: number, toPlacementId: number) {
  const [from, to] = await Promise.all([getPlacement(fromPlacementId), getPlacement(toPlacementId)])
  return {
    from: from?.kind === 'shared' ? from.shared_deployment_id : null,
    to: to?.kind === 'shared' ? to.shared_deployment_id : null,
    toDocker: to?.kind === 'dedicated' ? (await getDriver(to.driver_id))?.kind === 'docker' : false
  }
}

// ── live runs in this process ────────────────────────────────────────────────────────────

const running = new Map<number, Promise<void>>()

/** Resolves when the run this process started for the move has ended (tests, shutdown). */
export async function awaitMove(id: number): Promise<void> {
  await running.get(id)
}

function spawn(moveId: number, work: () => Promise<void>): void {
  markMoveLive(moveId)
  const p = runInBackgroundPool(work)
    .catch((err) =>
      getApp()?.log?.error?.(
        { move_id: moveId, err: (err as Error | null)?.name ?? 'Error' },
        'hub move: the run stopped unexpectedly'
      )
    )
    .finally(() => {
      unmarkMoveLive(moveId)
      if (running.get(moveId) === p) running.delete(moveId)
    })
  running.set(moveId, p)
}

// ── start ────────────────────────────────────────────────────────────────────────────────

export interface StartBody {
  to: MoveTarget
  plan_hash: string
  confirm: string
  checklist: Record<string, boolean>
  /** Ruling P6-20 #2: refusals the operator overrides for this move (LINK_URL_NOT_PULLABLE). */
  overrides: string[]
}

/** Refusals a move start may override (operator checkbox, recorded with the move). */
export const MOVE_OVERRIDES = ['LINK_URL_NOT_PULLABLE'] as const

function checkBody(raw: unknown): StartBody {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  // Review minor 8: Task 15's own refusal (BAD_TARGET, BAD_POOL …) with its sentence.
  let to: MoveTarget
  try {
    to = checkTarget(b.to)
  } catch (err) {
    if (err instanceof MovePlannerError) throw new MoveError(err.code, err.message, 400)
    throw err
  }
  if (typeof b.plan_hash !== 'string' || !/^[0-9a-f]{16,128}$/i.test(b.plan_hash))
    throw new MoveError('BAD_PLAN_HASH', 'plan_hash must be the hash of the plan you checked.', 400)
  const checklist: Record<string, boolean> = {}
  if (b.checklist && typeof b.checklist === 'object' && !Array.isArray(b.checklist))
    for (const [k, v] of Object.entries(b.checklist as Record<string, unknown>))
      if (/^[a-z][a-z0-9_]{0,63}$/.test(k) && typeof v === 'boolean') checklist[k] = v
  const overrides: string[] = []
  if (b.overrides !== undefined && b.overrides !== null) {
    if (!Array.isArray(b.overrides))
      throw new MoveError('BAD_OVERRIDE', 'overrides is a list of refusal codes.', 400)
    for (const o of b.overrides) {
      if (typeof o !== 'string' || !(MOVE_OVERRIDES as readonly string[]).includes(o))
        throw new MoveError(
          'BAD_OVERRIDE',
          `A move may override only ${MOVE_OVERRIDES.join(', ')}.`,
          400
        )
      if (!overrides.includes(o)) overrides.push(o)
    }
  }
  return {
    overrides,
    to,
    plan_hash: b.plan_hash,
    confirm: typeof b.confirm === 'string' ? b.confirm.trim() : '',
    checklist
  }
}

export async function startMove(
  envId: number,
  rawBody: StartBody,
  by: string,
  over: MoveRunDeps = {}
): Promise<{ move_id: number }> {
  const e = envOf(over)
  const body = checkBody(rawBody)
  const env = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown> | undefined
  if (!env) throw new MoveError('NOT_FOUND', 'No such environment.', 404)
  const app = await readApp(Number(env.app_id))
  if (!app) throw new MoveError('NOT_FOUND', 'No such app.', 404)
  const confirmText = `${app.key}/${String(env.key)}`
  if (body.confirm !== confirmText)
    throw new MoveError('CONFIRM_MISMATCH', `Type ${confirmText} to start the move.`, 400)
  if (env.placement_id == null)
    throw new MoveError('NO_PLACEMENT', 'The environment has no placement to move from.')
  const fromPlacementId = Number(env.placement_id)

  const open = await openMoveOf(envId)
  if (open)
    throw new MoveError(
      'BUSY',
      open.status === 'interrupted'
        ? `Move ${open.id} of this environment stopped half way — resume it or roll it back first.`
        : `Move ${open.id} of this environment is under way — wait for it or cancel it.`
    )

  const fromPlacement = await getPlacement(fromPlacementId)
  const fromShared = fromPlacement?.kind === 'shared' ? fromPlacement.shared_deployment_id : null
  const toShared = body.to.kind === 'shared' ? body.to.shared_id : null
  const held = await takeLocks(
    envId,
    [fromShared, toShared].filter((x): x is number => x !== null),
    e
  )
  let handedOff = false
  try {
    let plan: MovePlan
    try {
      // Re-planned while this start holds its own `move` locks (P6-14): they never read as BUSY.
      plan = await e.planner(envId, body.to, { ownLocks: true })
    } catch (err) {
      if (err instanceof MovePlannerError)
        throw new MoveError(err.code, err.message, err.statusCode)
      throw err
    }
    if (plan.plan_hash !== body.plan_hash)
      throw new MoveError(
        'PLAN_CHANGED',
        'The plan changed since you checked it. Check the new plan and start again.',
        409,
        { plan }
      )
    if (plan.blockers.length)
      throw new MoveError(
        'PLAN_BLOCKED',
        `The move cannot start: ${plan.blockers.map((b) => b.code).join(', ')}.`,
        409,
        { plan, blockers: plan.blockers }
      )
    const open2 = plan.checklist.filter((c) => c.required && body.checklist[c.id] !== true)
    if (open2.length)
      throw new MoveError(
        'CHECKLIST_INCOMPLETE',
        `The move cannot start until every required item is ticked: ${open2
          .map((c) => `${c.id} (${c.text.slice(0, 120)})`)
          .join('; ')}.`,
        409,
        { open: open2.map((c) => c.id) }
      )

    // C-2 / P6-18 #1 #2: every dedicated side has an address of its own, probed now, and the
    // target can pull the files from the source — before anything is written.
    let addresses: MoveAddresses
    try {
      addresses = await e.addresses(envId, body.to, plan, {
        allowUnpullable: body.overrides.includes('LINK_URL_NOT_PULLABLE')
      })
    } catch (err) {
      if (err instanceof AddressError) throw new MoveError(err.code, err.message, err.statusCode)
      throw err
    }

    // The target placement (the dedicated one named, or a new shared placement), the move row
    // and its mirror deploy row are written in ONE transaction: a failure leaves none of them
    // behind (review minor 6).
    let toPlacementId = 0
    let shared: Awaited<ReturnType<typeof getShared>> = null
    if (body.to.kind === 'dedicated') {
      const p = await getPlacement(body.to.placement_id)
      if (!p || p.kind === 'shared')
        throw new MoveError('NOT_FOUND', 'No such dedicated placement.', 404)
      toPlacementId = p.id
    } else {
      shared = await getShared(body.to.shared_id)
      if (!shared) throw new MoveError('NOT_FOUND', 'No such shared deployment.', 404)
    }
    const created = body.to.kind === 'shared'
    const checklist: MoveChecklistState[] = plan.checklist.map((c) => ({
      ...c,
      done: body.checklist[c.id] === true
    }))
    const steps: MoveSteps = {
      ...freshSteps(plan.steps),
      created_placement: created,
      addresses,
      ...(body.overrides.length ? { overrides: body.overrides } : {}),
      // I-3: heal frees exactly these locks (compare-and-delete) once the heartbeat is stale.
      locks: lockTokens(held)
    }
    const startedAt = new Date(e.now())
    const moveId = await db.transaction(async (trx) => {
      if (body.to.kind === 'shared' && shared) {
        const placement = await createPlacement(
          {
            kind: 'shared',
            shared_deployment_id: shared.id,
            driver_id: null,
            target: body.to.pool_max ? { pool_max: body.to.pool_max } : {}
          },
          trx
        )
        toPlacementId = placement.id
      }
      const id = Number(
        await insertReturningId(trx, MOVES, {
          app_id: app.id,
          environment_id: envId,
          from_placement_id: fromPlacementId,
          to_placement_id: toPlacementId,
          kind: plan.kind,
          routing: plan.routing,
          status: 'running',
          step: plan.steps[0] ?? 'check',
          steps: JSON.stringify(steps),
          plan: JSON.stringify(plan),
          plan_hash: plan.plan_hash,
          files: JSON.stringify({}),
          checklist: JSON.stringify(checklist),
          prior_status: String(env.status ?? 'active'),
          started_by: by,
          started_at: startedAt,
          heartbeat_at: startedAt
        })
      )
      await insertReturningId(trx, DEPLOYS, {
        app_id: app.id,
        environment_id: envId,
        kind: 'move',
        move_id: id,
        version: plan.version,
        from_version: plan.version,
        status: 'running',
        step: plan.steps[0] ?? 'check',
        plan: JSON.stringify({ move_id: id, kind: plan.kind, steps: [] }),
        started_by: by,
        started_at: startedAt,
        heartbeat_at: startedAt
      })
      return id
    })
    const target =
      body.to.kind === 'shared'
        ? `shared deployment ${shared?.key ?? body.to.shared_id}`
        : `placement ${toPlacementId}`
    const run = await e.startRun(`Move ${confirmText} to ${target}`, moveId, by)
    if (run.id) await patchMove(moveId, { job_run_id: Number(run.id) })
    run.log(`move ${moveId}: ${plan.kind}, ${plan.routing} routing, ${plan.steps.length} steps`)
    await logActivity({
      action: 'hub-move-start',
      user: by,
      collection: ENVS,
      item: String(envId),
      comment: JSON.stringify({
        move_id: moveId,
        kind: plan.kind,
        routing: plan.routing,
        ...(body.overrides.includes('LINK_URL_NOT_PULLABLE')
          ? {
              override: 'LINK_URL_NOT_PULLABLE',
              note: "target allows this host (the operator says the target's SSRF_ALLOW_HOSTS lists the source link)"
            }
          : {})
      })
    }).catch(() => null)
    spawn(moveId, () => drive(moveId, held, run, by, e))
    handedOff = true
    return { move_id: moveId }
  } finally {
    if (!handedOff) await releaseLocks(held, e)
  }
}

// ── the run ──────────────────────────────────────────────────────────────────────────────

/** A stop inside a step: a cancel, or this run no longer holds its locks. */
class Halt extends Error {
  constructor(readonly why: 'cancel' | 'lost') {
    super(why)
    this.name = 'Halt'
  }
}

interface Ctx {
  moveId: number
  envId: number
  held: Held
  run: JobRunHandle
  by: string | null
  e: Env
  deployId: number
  lockLost: boolean
  ops: MoveOps
  plan: MovePlan
  shared: { from: number | null; to: number | null; toDocker: boolean }
  sharedKeyTo: string | null
}

const safeLine = (s: string) => s.slice(0, 1000)

/** An identity is infrastructure detail: only its hash is stored with the move. */
const hashIdentity = (identity: string) =>
  createHash('sha256').update(identity.trim().toLowerCase()).digest('hex')

async function deployRowId(moveId: number): Promise<number> {
  const r = (await db(DEPLOYS).where({ move_id: moveId }).first('id')) as { id: number } | undefined
  return Number(r?.id ?? 0)
}

/** Runs (or continues) a move: forward from its first step not done, or its rollback. */
async function drive(
  moveId: number,
  held: Held,
  run: JobRunHandle,
  by: string | null,
  e: Env
): Promise<void> {
  const move0 = await readMove(moveId)
  if (!move0?.plan) {
    await releaseLocks(held, e)
    return
  }
  const plan = move0.plan
  const shared = await sharedIdsOf(move0.from_placement_id, move0.to_placement_id)
  const log: RunLog = (line, level = 'info') => {
    try {
      run.log(safeLine(line), level)
    } catch {
      // bookkeeping never breaks the run
    }
  }
  const ctx: Ctx = {
    moveId,
    envId: move0.environment_id,
    held,
    run,
    by,
    e,
    deployId: await deployRowId(moveId),
    lockLost: false,
    ops: e.opsFor(move0, plan, log),
    plan,
    shared,
    sharedKeyTo: shared.to !== null ? ((await getShared(shared.to))?.key ?? null) : null
  }

  // Heartbeat: locks renewed, heartbeat_at written (move + mirror row) every renewMs.
  const beat = async () => {
    // R2-M-5: a Redis error while renewing counts as a lost lock (strict renewal), never "held":
    // the run stops at its next boundary (interrupted; heal frees the rest, a person rolls back).
    const strictEnv = (envId: number, token: string) =>
      e.lock.renewStrict ? e.lock.renewStrict(envId, token) : e.lock.renew(envId, token)
    const strictShared = (id: number, token: string) =>
      e.sharedLock.renewStrict ? e.sharedLock.renewStrict(id, token) : e.sharedLock.renew(id, token)
    const ok = await strictEnv(held.envId, held.envToken).catch(() => false)
    let sharedOk = true
    for (const s of held.shared)
      if (!(await strictShared(s.id, s.token).catch(() => false))) sharedOk = false
    if (!ok || !sharedOk) ctx.lockLost = true
    const at = new Date(e.now())
    // Review minor 2: a run another replica healed (its heartbeat looked stale) stops at its next
    // boundary instead of writing over `interrupted`; heal also freed its locks.
    const beatRows = await patchMove(
      moveId,
      { heartbeat_at: at },
      { status: ['running', 'waiting'] }
    ).catch(() => 1)
    if (beatRows === 0 && (await readMove(moveId))?.status === 'interrupted') ctx.lockLost = true
    await db(DEPLOYS)
      .where({ id: ctx.deployId, status: 'running' })
      .update({ heartbeat_at: at })
      .catch(() => null)
  }
  const timer = setInterval(() => void beat(), e.renewMs)
  timer.unref?.()
  try {
    await beat()
    const m = await readMove(moveId)
    if (m?.steps.phase === 'rollback') await rollBack(ctx, m.steps.undo_reason ?? 'failed', null)
    else await forward(ctx)
  } finally {
    clearInterval(timer)
    await releaseLocks(held, e)
  }
}

async function cancelAsked(ctx: Ctx): Promise<boolean> {
  return ctx.deployId ? ctx.e.lock.cancelRequested(ctx.deployId).catch(() => false) : false
}

/** Asked at every step boundary and inside every wait. */
async function boundary(ctx: Ctx, allowCancel = true): Promise<void> {
  if (ctx.lockLost) throw new Halt('lost')
  if (allowCancel && (await cancelAsked(ctx))) throw new Halt('cancel')
}

/**
 * Writes the run's step list. Bookkeeping another writer added to the stored list meanwhile (the
 * ops record prev_extension_pins, confirmRoute its time) is kept: a key the run's copy lacks is
 * taken from the stored one.
 */
async function saveSteps(ctx: Ctx, steps: MoveSteps, extra: Partial<{ step: MoveStepKey }> = {}) {
  // R3-M-1: one atomic merge — the run's list wins, a key it lacks is kept from the stored one.
  // R4-M-1: never over a move another runner holds now (its tokens in `locks`), and the lock
  // tokens are always the stored ones (a run's copy may be older).
  let theirs = false
  await mergeSteps(ctx.moveId, (stored) => {
    if (stored.locks?.env && stored.locks.env !== ctx.held.envToken) {
      theirs = true
      return null
    }
    for (const [k, v] of Object.entries(stored))
      if (k !== 'list' && !(k in steps)) (steps as unknown as Record<string, unknown>)[k] = v
    if (stored.locks) steps.locks = stored.locks
    return steps
  })
  if (theirs) {
    ctx.lockLost = true
    return
  }
  if (extra.step !== undefined) await patchMove(ctx.moveId, { step: extra.step })
}

async function forward(ctx: Ctx): Promise<void> {
  const move = await readMove(ctx.moveId)
  if (!move) return
  const steps = structuredClone(move.steps)
  for (const entry of steps.list) {
    if (entry.state === 'done') continue
    const released = stepDone(steps, 'release')
    try {
      // After release a cancel is no longer taken: the target already serves.
      await boundary(ctx, !released)
    } catch (err) {
      if (err instanceof Halt && err.why === 'lost') return interrupt(ctx)
      return rollBack(ctx, 'cancelled', null)
    }
    entry.state = 'running'
    entry.started_at = new Date(ctx.e.now()).toISOString()
    entry.note = null
    await saveSteps(ctx, steps, { step: entry.key })
    await db(DEPLOYS)
      .where({ id: ctx.deployId })
      .update({ step: entry.key })
      .catch(() => null)
    ctx.run.log(`${entry.key}: started`)
    try {
      await doStep(ctx, entry.key, steps)
      entry.state = 'done'
      entry.finished_at = new Date(ctx.e.now()).toISOString()
      await saveSteps(ctx, steps)
      ctx.run.log(`${entry.key}: done`)
    } catch (err) {
      if (err instanceof Halt) {
        // C-3: a step stopped inside (a cancel or lost lock in route, the manual wait …) may have
        // half happened: it stays `running`, which the rollback undoes and a resume re-runs.
        entry.state = 'running'
        await saveSteps(ctx, steps)
        if (err.why === 'lost') return interrupt(ctx)
        return rollBack(ctx, 'cancelled', null)
      }
      const se = asStepError(err, `The step ${entry.key} stopped unexpectedly.`)
      if (!(err instanceof MoveStepError) && se.code === 'STEP_FAILED')
        getApp()?.log?.warn?.(
          { move_id: ctx.moveId, step: entry.key, err: (err as Error | null)?.name ?? 'Error' },
          'hub move: a step failed unexpectedly'
        )
      entry.state = 'failed'
      entry.finished_at = new Date(ctx.e.now()).toISOString()
      entry.note = safeLine(`${se.code}: ${se.message}`).slice(0, 300)
      await saveSteps(ctx, steps)
      ctx.run.log(`${entry.key}: ${se.code}: ${se.message}`, 'error')
      if (entry.key === 'retire_source' || released) return finishRetireFailed(ctx, steps, se)
      // R3-I-3: a run that lost its locks never undoes (the failure may be the same outage).
      if (!(await locksHeld(ctx))) return interrupt(ctx)
      return rollBack(ctx, 'failed', se)
    }
  }
  return finishSuccess(ctx, null)
}

// ── one step ─────────────────────────────────────────────────────────────────────────────

function summary(mode: 'full' | 'delta', s: PullStatus, at: number): MoveFilesSummary {
  return {
    mode,
    state: s.state,
    total: s.total,
    copied: s.copied,
    skipped: s.skipped,
    failed: s.failed,
    missing: s.missing.length,
    size_mismatch: Number(s.size_mismatch) || 0,
    bytes: s.bytes,
    at: new Date(at).toISOString()
  }
}

async function copyFiles(ctx: Ctx, slot: keyof MoveFiles, blocking: boolean): Promise<void> {
  const move = await readMove(ctx.moveId)
  // T10 carry: the first warm copy is full; a re-run of the warm step (resume) and the delta
  // inside maintenance take only what changed.
  const mode: 'full' | 'delta' =
    slot === 'full' ? 'full' : slot === 'warm' && !move?.files.warm ? 'full' : 'delta'
  const s = await ctx.ops.pullFiles(mode)
  const files: MoveFiles = { ...(move?.files ?? {}), [slot]: summary(mode, s, ctx.e.now()) }
  await patchMove(ctx.moveId, { files })
  ctx.run.log(
    `files (${mode}): ${s.copied} copied, ${s.skipped} already there, ${s.failed} failed, ${s.missing.length} missing at the source`
  )
  if (s.missing.length)
    ctx.run.log(
      `${s.missing.length} stored file(s) were already missing at the source (404) and stay missing`,
      'warn'
    )
  if (s.size_mismatch)
    ctx.run.log(`${s.size_mismatch} file(s) had a stale stored size; copied as the source has them`)
  if (s.state === 'failed')
    throw new MoveStepError(
      'FILES_FAILED',
      `The file copy failed${s.error ? `: ${s.error.slice(0, 200)}` : ''}.`
    )
  if (blocking && s.failed > 0) {
    const ids = (s.failed_ids ?? []).slice(0, 5)
    throw new MoveStepError(
      'FILES_NOT_COPIED',
      `${s.failed} file(s) could not be copied${ids.length ? ` (${ids.join(', ')}${s.failed > ids.length ? ', …' : ''})` : ''}; the move rolls back so none is lost.`
    )
  }
  if (!blocking && s.failed > 0)
    ctx.run.log(
      `${s.failed} file(s) failed in the warm copy; copied again inside maintenance`,
      'warn'
    )
}

/** Puts the source in maintenance and waits until every replica holds it (maintenance_on). */
async function freezeSource(ctx: Ctx): Promise<void> {
  // B1 names shared sides; a dedicated source's env status says it too (Hub-only meaning,
  // nothing reads it from the app; the rollback puts the prior status back).
  await setEnvStatus(ctx.envId, 'maintenance')
  await ctx.ops.sourceMaintenance(true)
  // Review Focus #2: no step after this until every live replica holds the new list.
  if (ctx.shared.from !== null) await ctx.ops.waitReplicas(ctx.shared.from)
}

/** Lifts the source's maintenance again (the R5-I-1 deploy window): its prior status first. */
async function liftSource(ctx: Ctx): Promise<void> {
  const move = await readMove(ctx.moveId)
  if (move?.prior_status) await setEnvStatus(ctx.envId, move.prior_status)
  await ctx.ops.sourceMaintenance(false)
  if (ctx.shared.from !== null)
    await ctx.ops
      .waitReplicas(ctx.shared.from)
      .catch((err) =>
        ctx.run.log(
          `not every replica of the source has the lifted maintenance yet (${asStepError(err, '').code})`,
          'warn'
        )
      )
}

/** R5-I-1: the post-deploy maintenance call, retried with backoff (about 2 minutes in all). */
async function targetMaintenanceWithRetry(ctx: Ctx): Promise<void> {
  const waits = [5_000, 15_000, 30_000, 60_000]
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.ops.targetMaintenance(true)
      return
    } catch (err) {
      const se = asStepError(err, 'The target did not take maintenance.')
      if (attempt >= waits.length) throw se
      ctx.run.log(
        `deploy_target: the target did not take maintenance yet (${se.code}); trying again`,
        'warn'
      )
      await ctx.e.sleep(waits[attempt])
    }
  }
}

async function doStep(ctx: Ctx, key: MoveStepKey, steps: MoveSteps): Promise<void> {
  const { ops, plan, e } = ctx
  switch (key) {
    case 'check': {
      const env = (await db(ENVS).where({ id: ctx.envId }).first('placement_id')) as
        | { placement_id: number | null }
        | undefined
      const move = await readMove(ctx.moveId)
      if (!env || Number(env.placement_id) !== move?.from_placement_id)
        throw new MoveStepError(
          'PLACEMENT_CHANGED',
          'The environment no longer sits on the placement this move started from.'
        )
      // R2: which database the source serves, kept (hashed) for the target_ready comparison.
      const identity = await ops.databaseIdentity('source')
      if (!identity)
        throw new MoveStepError(
          'DATABASE_DIFFERS',
          "The source's database could not be identified, so the Hub cannot prove the target uses the same one."
        )
      steps.source_db = hashIdentity(identity)
      await saveSteps(ctx, steps)
      return
    }
    case 'files_warm':
      return copyFiles(ctx, 'warm', false)
    case 'maintenance_on':
      return freezeSource(ctx)
    case 'wait_idle': {
      const by = e.now() + WAIT_IDLE_MS
      for (;;) {
        const b = await ops.sourceBusy()
        if (!b.imports && !b.exports && !b.renders) return
        if (e.now() >= by)
          throw new MoveStepError(
            'WAIT_IDLE_TIMEOUT',
            `The source is still busy after 10 minutes (${b.imports} imports, ${b.exports} exports, ${b.renders} renders).`
          )
        await boundary(ctx)
        await e.sleep(e.pollMs)
      }
    }
    case 'files_delta':
      return copyFiles(ctx, 'delta', true)
    case 'files_full':
      return copyFiles(ctx, 'full', true)
    case 'deploy_target': {
      // C-1 (P6-19): the target is never a second writer. It is in maintenance from its first
      // deploy until release: a Docker target boots in it (HUB_BOOT_MAINTENANCE); a GitLab one is
      // asked before the deploy (it keeps it in its own Redis across the redeploy, when it already
      // runs) and again right after it, before anything else happens.
      // R5-I-1 (P6-30): when its boot maintenance is not proven (GITLAB_BOOT_WINDOW), it may
      // start writable: the source is put in maintenance before the deploy (the automatic order
      // already did), and lifted again only once the target's maintenance is set.
      const window =
        plan.warnings.some((w) => w.code === 'GITLAB_BOOT_WINDOW') &&
        !stepDone(steps, 'maintenance_on')
      if (window && steps.boot_freeze !== 'on') {
        steps.boot_freeze = 'on'
        await saveSteps(ctx, steps)
        ctx.run.log(
          'deploy_target: the target may start without maintenance, so the source goes into maintenance for its deploy'
        )
        await freezeSource(ctx)
      }
      await ops
        .targetMaintenance(true)
        .catch((err) =>
          ctx.run.log(
            `deploy_target: the target did not take maintenance before its deploy (${asStepError(err, '').code}); set right after it`,
            'warn'
          )
        )
      await ops.deployTarget()
      await targetMaintenanceWithRetry(ctx)
      if (steps.boot_freeze === 'on') {
        await liftSource(ctx)
        steps.boot_freeze = 'lifted'
        await saveSteps(ctx, steps)
        ctx.run.log('deploy_target: the target is in maintenance; the source serves again')
      }
      return
    }
    case 'place_on_target': {
      await ops.placeOnTarget()
      if (ctx.shared.to !== null) await ops.waitReplicas(ctx.shared.to)
      return
    }
    case 'target_ready': {
      // M18: a GitLab target is set to maintenance first (a Docker one booted in it; a shared one
      // lists the app as maintenance until release) — the ops decide.
      await ops.targetMaintenance(true)
      await ops.targetUnretire()
      await ops.targetReady()
      // R2: the target opens the very database the source serves.
      const identity = await ops.databaseIdentity('target')
      if (!identity || !steps.source_db || hashIdentity(identity) !== steps.source_db)
        throw new MoveStepError(
          'DATABASE_DIFFERS',
          identity
            ? 'The target reaches another database than the source serves; nothing is routed to it.'
            : "The target's database could not be identified, so the Hub cannot prove it is the source's."
        )
      return
    }
    case 'route': {
      if (plan.routing !== 'manual') return applyRoute(ctx, steps, () => true)
      // Manual (T15 order): the Hub's own target actions first, then the wait for the name.
      await applyRoute(ctx, steps, (a) => a.side === 'target')
      return waitManualRoute(ctx, steps)
    }
    case 'verify': {
      const expect = { version: plan.version, shared: ctx.sharedKeyTo }
      const by = e.now() + ROUTE_VERIFY_MS
      for (;;) {
        if (await ops.verifyName(expect)) {
          // Manual (T15 order): the source's own drops only once the name serves the target.
          if (plan.routing === 'manual') await applyRoute(ctx, steps, (a) => a.side === 'source')
          return
        }
        if (e.now() >= by)
          throw new MoveStepError(
            'VERIFY_FAILED',
            `${plan.hostnames[0] ?? 'The public name'} did not answer from the target within 10 minutes.`
          )
        await boundary(ctx)
        await e.sleep(Math.max(e.pollMs, Math.min(VERIFY_POLL_MS, e.pollMs * 3)))
      }
    }
    case 'release':
      return release(ctx, steps)
    case 'retire_source':
      return ops.retireSource()
    case 'done':
      return
  }
}

/**
 * Applies the plan's route actions that `pick` takes, in the plan's order (T15: automatic =
 * source drops, then target adds, so one edge never holds two equal Host rules), each recorded
 * in steps.routed as soon as it is applied, so a rollback undoes exactly those.
 */
async function applyRoute(
  ctx: Ctx,
  steps: MoveSteps,
  pick: (a: MovePlan['route'][number]) => boolean
): Promise<void> {
  const by = ctx.e.now() + ROUTE_VERIFY_MS
  const route = ctx.plan.route
  for (let i = 0; i < route.length; i++) {
    if ((steps.route_done ?? []).includes(i) || !pick(route[i])) continue
    await boundary(ctx)
    if (ctx.e.now() >= by)
      throw new MoveStepError(
        'ROUTE_TIMEOUT',
        'The route changes did not finish within 10 minutes.'
      )
    // C-3: the intent is recorded BEFORE the apply, so an apply the agent accepted but that never
    // converged (or a crash during it) is still undone. Every undo is idempotent.
    if (!(steps.routed ?? []).includes(i)) {
      steps.routed = [...(steps.routed ?? []), i]
      await saveSteps(ctx, steps)
    }
    await ctx.ops.route(route[i])
    steps.route_done = [...(steps.route_done ?? []), i]
    await saveSteps(ctx, steps)
    const a = route[i]
    ctx.run.log(`route: ${a.side} ${a.op}${a.host ? ` ${a.host}` : ''}`)
  }
}

/** Manual routing: `waiting` until the name serves the target (confirmRoute or a self check). */
async function waitManualRoute(ctx: Ctx, steps: MoveSteps): Promise<void> {
  const { e } = ctx
  const since = steps.waiting_since ? Date.parse(steps.waiting_since) : e.now()
  steps.waiting_since = new Date(since).toISOString()
  await saveSteps(ctx, steps)
  await patchMove(ctx.moveId, { status: 'waiting' }, { status: ['running'] })
  ctx.run.log(
    `route: waiting for the name to be pointed at the target${ctx.plan.manual_request ? ` — ${ctx.plan.manual_request.slice(0, 400)}` : ''}`
  )
  const expect = { version: ctx.plan.version, shared: ctx.sharedKeyTo }
  let lastSelf = e.now()
  try {
    for (;;) {
      await boundary(ctx)
      const m = await readMove(ctx.moveId)
      if (m?.steps.route_confirmed_at) {
        steps.route_confirmed_at = m.steps.route_confirmed_at
        ctx.run.log('route: confirmed — the name answers from the target')
        return
      }
      if (e.now() - lastSelf >= MANUAL_SELF_CHECK_MS) {
        lastSelf = e.now()
        if (await ctx.ops.verifyName(expect)) {
          // The name was pointed at the target (I-4 reads this if the move later rolls back).
          steps.route_confirmed_at = new Date(e.now()).toISOString()
          await saveSteps(ctx, steps)
          ctx.run.log('route: the name answers from the target')
          return
        }
      }
      if (e.now() - since >= MANUAL_ROUTE_MS)
        throw new MoveStepError(
          'ROUTE_TIMEOUT',
          'Nobody pointed the name at the target within 24 hours.'
        )
      await e.sleep(e.manualPollMs)
    }
  } finally {
    await patchMove(ctx.moveId, { status: 'running' }, { status: ['waiting'] })
  }
}

/**
 * The point of no return (P6-22, R2-I-2): the source is frozen (maintenance_on is done in every
 * order); the environment's switch to the target COMMITS first; only then is the target's
 * maintenance lifted. The step is marked done only after the lift, so a failure or a crash in
 * between leaves `release` running/failed — which the rollback undoes first: target frozen again
 * (or removed / retired), the environment row put back, and only after that the source.
 */
async function release(ctx: Ctx, steps: MoveSteps): Promise<void> {
  const move = await readMove(ctx.moveId)
  if (!move) throw new MoveStepError('NOT_FOUND', 'The move is gone.')
  if (!stepDone(move.steps, 'maintenance_on'))
    throw new MoveStepError(
      'SOURCE_NOT_FROZEN',
      'The source is not in maintenance; the target is never lifted while the source can write.'
    )
  const env = (await db(ENVS)
    .where({ id: ctx.envId })
    .first('placement_id', 'status', 'hub_managed', 'version_pin')) as
    | Record<string, unknown>
    | undefined
  if (!env) throw new MoveStepError('NOT_FOUND', 'The environment is gone.')
  // What the environment row held before the switch (kept from the first attempt on a resume).
  if (!steps.release_prev && Number(env.placement_id) === move.from_placement_id) {
    steps.release_prev = {
      placement_id: move.from_placement_id,
      status: String(env.status ?? 'maintenance'),
      hub_managed: env.hub_managed === true || env.hub_managed === 1 || env.hub_managed === '1',
      version_pin: env.version_pin == null ? null : String(env.version_pin)
    }
    await saveSteps(ctx, steps)
  }
  await db(ENVS)
    .where({ id: ctx.envId })
    .update({
      placement_id: move.to_placement_id,
      version_pin: ctx.plan.version,
      status: 'active',
      ...(ctx.shared.toDocker ? { hub_managed: true } : {}),
      updated_at: new Date()
    })
  ctx.run.log(`release: the environment now lives on placement ${move.to_placement_id}`)
  // Committed: the target serves for real now (a Docker target's boot maintenance is released
  // for good with the move id; a shared target's replicas re-read their list).
  await ctx.ops.targetMaintenance(false)
  // M10: the shared target serves the app `active` on every replica.
  if (ctx.shared.to !== null)
    await ctx.ops
      .waitReplicas(ctx.shared.to)
      .catch((err) =>
        ctx.run.log(
          `release: not every replica of the target has the new list yet (${asStepError(err, '').code})`,
          'warn'
        )
      )
}

// ── ends ─────────────────────────────────────────────────────────────────────────────────

/** The cancel flag of this move (keyed by its mirror deploy row) is spent once the run ends. */
async function clearCancelFlag(ctx: Ctx): Promise<void> {
  if (ctx.deployId) await ctx.e.lock.clearCancel(ctx.deployId).catch(() => undefined)
}

async function closeDeployRow(
  ctx: Ctx,
  status: 'success' | 'failed' | 'cancelled' | 'interrupted',
  error: string | null
) {
  await db(DEPLOYS)
    .where({ id: ctx.deployId })
    .update({
      status,
      error: error ? error.slice(0, 1000) : null,
      finished_at: status === 'interrupted' ? null : new Date(ctx.e.now()),
      heartbeat_at: null
    })
    .catch(() => null)
}

/**
 * P6-27: a move that ends with the target live (success, a retire that failed included) drops
 * the per-move name from the target stack. A failure never rolls back: it is an open checklist
 * item naming the name.
 */
async function dropTempName(ctx: Ctx): Promise<void> {
  try {
    await ctx.ops.dropTempHost()
  } catch (err) {
    const se = asStepError(err, 'The per-move name could not be removed.')
    const move = await readMove(ctx.moveId)
    const host = move?.steps.addresses?.target_temp_host ?? 'the per-move name'
    ctx.run.log(`the per-move name ${host} is still on the target stack (${se.code})`, 'warn')
    const checklist = (move?.checklist ?? []).filter((c) => c.id !== 'temp_host')
    checklist.push({
      id: 'temp_host',
      text: safeLine(
        `Still to do: remove the per-move name ${host} from the target stack. Apply the environment's stack again (Apply now renders only the environment's own names), then check that ${host} no longer serves the app.`
      ),
      required: false,
      done: false
    })
    await patchMove(ctx.moveId, { checklist })
  }
}

async function finishSuccess(ctx: Ctx, warning: string | null): Promise<void> {
  await dropTempName(ctx)
  await ctx.ops.revokeTickets().catch(() => undefined)
  // Review minor 6: the shared placement the environment left goes when nothing uses it.
  if (!warning) await dropUnusedSharedPlacement(ctx.moveId).catch(() => undefined)
  await patchMove(ctx.moveId, {
    status: 'success',
    step: 'done',
    error: warning,
    finished_at: new Date(ctx.e.now()),
    heartbeat_at: null
  })
  await closeDeployRow(ctx, 'success', null)
  await clearCancelFlag(ctx)
  await logActivity({
    action: 'hub-move-done',
    user: ctx.by,
    collection: ENVS,
    item: String(ctx.envId),
    comment: JSON.stringify({ move_id: ctx.moveId, warning: warning ? 'retire_source' : null })
  }).catch(() => null)
  await ctx.run.complete(
    warning ? `Move ${ctx.moveId}: done, with a warning` : `Move ${ctx.moveId}: done`
  )
}

/** After release a failing retire_source never rolls back: success with the item open. */
async function finishRetireFailed(ctx: Ctx, steps: MoveSteps, err: MoveStepError): Promise<void> {
  const move = await readMove(ctx.moveId)
  const checklist = [...(move?.checklist ?? [])]
  const item = checklist.find((c) => c.id === 'retire_source')
  if (item) item.done = false
  else
    checklist.push({
      id: 'retire_source',
      text: 'Retire the old placement by hand: the Hub could not (see the move log).',
      required: false,
      done: false
    })
  await patchMove(ctx.moveId, { checklist })
  // The steps after retire_source (done) still count as done.
  for (const s of steps.list) if (s.key === 'done') s.state = 'done'
  await saveSteps(ctx, steps)
  return finishSuccess(
    ctx,
    `The environment moved, but the old placement was not retired (${err.code}): ${err.message}`.slice(
      0,
      1000
    )
  )
}

/**
 * R3-I-3: a strict check that this run still holds the environment's and every shared lock (a
 * Redis error is "not held"). Once false, the run never acts again.
 */
async function locksHeld(ctx: Ctx): Promise<boolean> {
  if (ctx.lockLost) return false
  const { lock, sharedLock } = ctx.e
  const env = lock.renewStrict
    ? lock.renewStrict(ctx.held.envId, ctx.held.envToken)
    : lock.renew(ctx.held.envId, ctx.held.envToken)
  let ok = await env.catch(() => false)
  for (const x of ctx.held.shared) {
    const r = sharedLock.renewStrict
      ? sharedLock.renewStrict(x.id, x.token)
      : sharedLock.renew(x.id, x.token)
    if (!(await r.catch(() => false))) ok = false
  }
  if (!ok) ctx.lockLost = true
  return ok
}

/**
 * Where the target runs and how to stop it, in plain words (R3-I-2, R4-M-2): one thing the
 * operator can carry out for that target kind, and what ticking `target_stopped` states.
 */
async function targetStopText(move: HubMoveRow, sourceFrozen: boolean): Promise<string> {
  const p = await getPlacement(move.to_placement_id)
  let target = `placement ${move.to_placement_id}`
  let how = 'stop every process of this app there and keep it from starting again'
  if (p?.kind === 'shared') {
    const shared = await getShared(p.shared_deployment_id)
    const key = shared?.key ?? String(p.shared_deployment_id)
    target = `the shared deployment ${key}`
    how = `remove the app from the shared deployment ${key}: stop that deployment (scale its services to 0) until this rollback is done; the rollback then drops the app from its list and the deployment can start again`
  } else if (p) {
    const driver = await getDriver(p.driver_id)
    const stack = (p.target as { stack?: unknown }).stack
    if (driver?.kind === 'docker' && typeof stack === 'string') {
      target = `the Docker stack ${stack} (driver ${driver.name})`
      how = `remove the stack on that swarm (docker stack rm ${stack}) and do not deploy it again`
    } else {
      const at = move.steps.addresses?.target_link_base
      target = `the GitLab-deployed app${at ? ` at ${at}` : ''} (placement ${p.id})`
      how =
        'remove its stack on its swarm manager (docker stack rm) and stop its pipeline from deploying it again'
    }
  }
  return `Make sure no process of this app runs at ${target}, and none can restart: ${how}. Then tick "target stopped" (it states that no process of this app runs at ${target}, and none can restart) and Roll back again: the Hub then ${sourceFrozen ? "lifts the source's maintenance" : 'finishes the rollback'}.`
}

/**
 * R3-I-2: the rollback stopped because the target (lifted at release) could be neither frozen nor
 * stopped. The source stays in maintenance (one writer), the move is interrupted (Roll back again
 * retries the freeze, and goes on once the operator ticked target_stopped), and the error, the job
 * log, the activity and a required checklist item all say the same thing.
 */
async function halt(ctx: Ctx, move: HubMoveRow, sourceFrozen: boolean): Promise<void> {
  const say = await targetStopText(move, sourceFrozen)
  const fresh = (await readMove(ctx.moveId)) ?? move
  const checklist = fresh.checklist.filter((c) => c.id !== 'target_stopped')
  checklist.push({ id: 'target_stopped', text: say, required: true, done: false })
  // R5-I-1: worded from the source's real state, never "stays in maintenance" when it serves.
  const state = sourceFrozen
    ? 'so the source stays in maintenance (never two writers)'
    : 'and the source keeps serving: it was not put in maintenance, and the target was last set to maintenance by the Hub'
  const error = `HALTED_TARGET_LIVE: The rollback stopped: the target could not be frozen or stopped, ${state}. ${say}`
  const ours = await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, {
    status: 'interrupted',
    error: safeLine(error),
    checklist,
    heartbeat_at: null
  })
  if (!ours) {
    ctx.run.log('stopped: this run no longer holds the move', 'error')
    await ctx.run.fail(new Error('Interrupted: the run lost its locks.'))
    return
  }
  await closeDeployRow(ctx, 'interrupted', error)
  ctx.run.log(error, 'error')
  await logActivity({
    action: 'hub-move-rolled-back',
    user: ctx.by,
    collection: ENVS,
    item: String(ctx.envId),
    comment: JSON.stringify({
      move_id: ctx.moveId,
      status: 'interrupted',
      code: 'HALTED_TARGET_LIVE',
      say
    })
  }).catch(() => null)
  await ctx.run.fail(new Error(safeLine(error)))
}

async function interrupt(ctx: Ctx): Promise<void> {
  // R4-M-1: only while this run is still the move's lock holder (a resumed run owns it now).
  if (
    await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, {
      status: 'interrupted',
      heartbeat_at: null
    })
  )
    await closeDeployRow(ctx, 'interrupted', null)
  ctx.run.log('stopped: this run lost its locks; resume or roll back the move', 'error')
  await ctx.run.fail(
    new Error('Interrupted: the run lost its locks. Resume or roll back the move.')
  )
}

/**
 * R5-M-1: when the rollback could not give the source its names back (or lift its maintenance),
 * the way to recover by hand: Apply now on the source's own stack (it renders the environment's
 * own names), and the Task 9 escape hatch for a maintenance the Hub can no longer lift.
 */
async function sourceRecoveryText(move: HubMoveRow): Promise<string> {
  const p = await getPlacement(move.from_placement_id)
  let names = 'Put the names back on the source by hand.'
  if (p?.kind === 'shared') {
    const shared = await getShared(p.shared_deployment_id)
    names = `Apply now on the shared deployment ${shared?.key ?? p.shared_deployment_id} (its stack then carries this app's names again).`
  } else if (p) {
    const stack = (p.target as { stack?: unknown }).stack
    const driver = await getDriver(p.driver_id)
    if (driver?.kind === 'docker' && typeof stack === 'string')
      names = `Apply now on the source stack ${stack} (driver ${driver.name}): it renders the environment's own names again.`
  }
  return `To recover: ${names} If the source still shows maintenance, lift it on the source app with POST /api/hub-link/maintenance {"on":false} without move_id, or delete the nvr:maintenance key in its Redis (remove HUB_BOOT_MAINTENANCE from its stack first if it is set).`
}

async function rollBack(
  ctx: Ctx,
  reason: 'failed' | 'cancelled',
  err: MoveStepError | null
): Promise<void> {
  const move0 = await readMove(ctx.moveId)
  if (!move0) return
  const why = move0.steps.undo_reason ?? reason
  await mergeSteps(ctx.moveId, (stored) => ({ ...stored, phase: 'rollback', undo_reason: why }))
  if (err) await patchMove(ctx.moveId, { error: safeLine(`${err.code}: ${err.message}`) })
  ctx.run.log(why === 'cancelled' ? 'cancelled: rolling back' : 'rolling back', 'warn')
  const move = (await readMove(ctx.moveId)) as HubMoveRow
  const { failed, stopped, sourceFrozen } = await undoMove({
    move,
    ops: ctx.ops,
    shared: { from: ctx.shared.from, to: ctx.shared.to },
    log: (line, level) => ctx.run.log(safeLine(line), level),
    save: (steps) => saveSteps(ctx, steps),
    stillHeld: () => locksHeld(ctx),
    targetStoppedByHand: async () =>
      !!(await readMove(ctx.moveId))?.checklist.find((c) => c.id === 'target_stopped')?.done
  })
  // R3-I-3: a run that lost its locks never goes on undoing (another runner may own the move).
  if (stopped === 'lost') return interrupt(ctx)
  // R3-I-2: the target could not be stopped: interrupted (Roll back again once it is stopped).
  if (stopped === 'halted') return halt(ctx, move, sourceFrozen)
  await ctx.ops.revokeTickets().catch(() => undefined)
  // A placement this move made for the target goes again, unless something else uses it.
  if (move.steps.created_placement) await dropCreatedPlacement(ctx.moveId, move.to_placement_id)
  else await noteUnusedTarget(ctx, move)
  await clearPlaced(ctx.moveId)

  const status: MoveStatus = failed.length
    ? 'failed'
    : why === 'cancelled'
      ? 'cancelled'
      : 'rolled_back'
  // I-4: a person pointed the name at the target (manual route); the Hub cannot undo that half.
  const repoint = await repointText(ctx, move)
  if (repoint) {
    ctx.run.log(repoint, 'error')
    const checklist = (move.checklist ?? []).filter((c) => c.id !== 'repoint_name')
    checklist.push({ id: 'repoint_name', text: repoint, required: true, done: false })
    await patchMove(ctx.moveId, { checklist })
  }
  const recover =
    failed.includes('route') || failed.includes('maintenance_on')
      ? await sourceRecoveryText(move)
      : null
  if (recover) {
    ctx.run.log(recover, 'error')
    const fresh = (await readMove(ctx.moveId)) ?? move
    const checklist = fresh.checklist.filter((c) => c.id !== 'restore_source')
    checklist.push({ id: 'restore_source', text: safeLine(recover), required: true, done: false })
    await patchMove(ctx.moveId, { checklist })
  }
  // The recovery goes first: the stored error is cut at 1000 characters.
  const base = failed.length
    ? `The rollback could not undo: ${failed.join(', ')}. ${recover ?? 'Check those by hand.'}${move.error ? ` — ${move.error}` : ''}`
    : move.error
  const error = repoint ? `${base ? `${base} — ` : ''}${repoint}` : base
  await patchMove(ctx.moveId, {
    status,
    error: error ?? null,
    finished_at: new Date(ctx.e.now()),
    heartbeat_at: null
  })
  await clearCancelFlag(ctx)
  await closeDeployRow(
    ctx,
    status === 'cancelled' ? 'cancelled' : 'failed',
    status === 'cancelled' ? null : (error ?? 'Rolled back')
  )
  await logActivity({
    action: status === 'cancelled' ? 'hub-move-cancel' : 'hub-move-rolled-back',
    user: ctx.by,
    collection: ENVS,
    item: String(ctx.envId),
    comment: JSON.stringify({
      move_id: ctx.moveId,
      status,
      code: err?.code ?? null,
      undo_failed: failed,
      ...(repoint ? { repoint } : {})
    })
  }).catch(() => null)
  if (status === 'cancelled')
    await ctx.run.complete(
      `Move ${ctx.moveId}: cancelled and undone${repoint ? ` — ${repoint}` : ''}`
    )
  else await ctx.run.fail(new Error(safeLine(error ?? 'The move failed and was rolled back.')))
}

/**
 * "Point <names> back to <source>." when the move routed by hand and the name was seen serving
 * the target (confirmRoute, the wait's own check, or verify passed); null otherwise.
 */
async function repointText(ctx: Ctx, move: HubMoveRow): Promise<string | null> {
  if (move.routing !== 'manual') return null
  if (!move.steps.route_confirmed_at && !stepDone(move.steps, 'verify')) return null
  const names = ctx.plan.hostnames.length ? ctx.plan.hostnames.join(', ') : 'the public name'
  let source = 'the source placement'
  const from = await getPlacement(move.from_placement_id)
  if (from?.kind === 'shared') {
    const shared = await getShared(from.shared_deployment_id)
    if (shared) source = `the shared deployment ${shared.key} (${shared.link_url})`
  } else if (move.steps.addresses?.source_link_base && !move.steps.addresses.source_link_public) {
    source = `the source app at ${move.steps.addresses.source_link_base}`
  } else if (from) {
    const stack = (from.target as { stack?: unknown }).stack
    source = typeof stack === 'string' ? `the Docker stack ${stack}` : `placement ${from.id}`
  }
  return `Point ${names} back to ${source}: the move was rolled back and the target no longer serves this app.`
}

async function dropUnusedSharedPlacement(moveId: number): Promise<void> {
  const move = await readMove(moveId)
  if (!move) return
  const from = await getPlacement(move.from_placement_id)
  if (from?.kind !== 'shared') return
  const used = await db(ENVS).where({ placement_id: from.id }).first('id')
  const open = await db(MOVES)
    .whereNot({ id: moveId })
    .whereIn('status', OPEN_MOVE_STATUSES as string[])
    .where((q) => q.where({ from_placement_id: from.id }).orWhere({ to_placement_id: from.id }))
    .first('id')
  if (used || open) return
  await db(PLACEMENTS).where({ id: from.id }).del()
}

/**
 * Ruling P6-22 (reverses P6-21 #2): a dedicated target placement is never deleted by a rollback
 * (the move did not create it). The move row only says it is unused now
 * (steps.target_placement_unused), so the admin panel can offer it again.
 */
async function noteUnusedTarget(ctx: Ctx, move: HubMoveRow): Promise<void> {
  const p = await getPlacement(move.to_placement_id)
  if (!p || p.kind === 'shared') return
  const used = await db(ENVS).where({ placement_id: p.id }).first('id')
  const now = await readMove(ctx.moveId)
  if (!now) return
  const steps = structuredClone(now.steps)
  steps.target_placement_unused = !used
  await saveSteps(ctx, steps)
}

async function clearPlaced(moveId: number) {
  await db(MOVES)
    .where({ id: moveId })
    .update({ placed_at: null })
    .catch(() => null)
}

async function dropCreatedPlacement(moveId: number, placementId: number) {
  const used = await db(ENVS).where({ placement_id: placementId }).first('id')
  const other = await db(MOVES)
    .where({ to_placement_id: placementId })
    .whereNot({ id: moveId })
    .whereIn('status', OPEN_MOVE_STATUSES as string[])
    .first('id')
  if (used || other) return
  await db(PLACEMENTS)
    .where({ id: placementId })
    .del()
    .catch(() => null)
}

// ── cancel / resume / confirm / checklist ────────────────────────────────────────────────

function fresh(m: HubMoveRow, now: number): boolean {
  const t = m.heartbeat_at ? Date.parse(m.heartbeat_at) : Number.NaN
  return Number.isFinite(t) && now - t <= 2 * 60_000
}

/** Cancel: a live run stops at its next boundary and rolls back; an interrupted one rolls back now. */
export async function cancelMove(id: number, by: string, over: MoveRunDeps = {}): Promise<void> {
  const e = envOf(over)
  const move = await readMove(id)
  if (!move) throw new MoveError('NOT_FOUND', 'No such move.', 404)
  if (!OPEN_MOVE_STATUSES.includes(move.status))
    throw new MoveError('MOVE_ENDED', `This move has ended (${move.status}).`)
  if (stepDone(move.steps, 'release'))
    throw new MoveError(
      'TOO_LATE',
      'The environment already lives on the target; this move can no longer be rolled back.'
    )
  if (move.steps.phase === 'rollback' && move.status !== 'interrupted')
    throw new MoveError('ROLLING_BACK', 'This move is already rolling back.')
  const deployId = await deployRowId(id)
  if (move.status !== 'interrupted' && (isMoveLiveHere(id) || fresh(move, e.now()))) {
    await e.lock.requestCancel(deployId)
    await logActivity({
      action: 'hub-move-cancel',
      user: by,
      collection: ENVS,
      item: String(move.environment_id),
      comment: JSON.stringify({ move_id: id, asked: true })
    }).catch(() => null)
    return
  }
  // Interrupted (or a run nobody heartbeats): roll back here.
  await restart(move, by, e, 'rollback')
}

/** Resume an interrupted move from its stored step (or its rollback, if it was rolling back). */
export async function resumeMove(id: number, by: string, over: MoveRunDeps = {}): Promise<void> {
  const e = envOf(over)
  const move = await readMove(id)
  if (!move) throw new MoveError('NOT_FOUND', 'No such move.', 404)
  if (move.status !== 'interrupted')
    throw new MoveError(
      'NOT_INTERRUPTED',
      `Only an interrupted move resumes (this one is ${move.status}).`
    )
  await restart(move, by, e, move.steps.phase === 'rollback' ? 'rollback' : 'forward')
}

async function restart(
  move: HubMoveRow,
  by: string,
  e: Env,
  way: 'forward' | 'rollback'
): Promise<void> {
  const ids = await sharedIdsOf(move.from_placement_id, move.to_placement_id)
  const held = await takeLocks(
    move.environment_id,
    [ids.from, ids.to].filter((x): x is number => x !== null),
    e
  )
  let handedOff = false
  try {
    const steps = structuredClone(move.steps)
    steps.locks = lockTokens(held)
    if (way === 'rollback' && steps.phase !== 'rollback') {
      steps.phase = 'rollback'
      steps.undo_reason = 'cancelled'
    }
    const changed = await patchMove(
      move.id,
      { status: 'running', steps, heartbeat_at: new Date(e.now()) },
      { status: ['interrupted', 'running', 'waiting'] }
    )
    if (!changed) throw new MoveError('MOVE_ENDED', 'This move has ended meanwhile.')
    await db(DEPLOYS)
      .where({ move_id: move.id })
      .update({ status: 'running', heartbeat_at: new Date(e.now()), finished_at: null })
      .catch(() => null)
    const run = await e.startRun(
      `${way === 'rollback' ? 'Roll back' : 'Resume'} move ${move.id}`,
      move.id,
      by
    )
    if (run.id) await patchMove(move.id, { job_run_id: Number(run.id) })
    await logActivity({
      action: way === 'rollback' ? 'hub-move-cancel' : 'hub-move-start',
      user: by,
      collection: ENVS,
      item: String(move.environment_id),
      comment: JSON.stringify({ move_id: move.id, resumed: true, way })
    }).catch(() => null)
    spawn(move.id, () => drive(move.id, held, run, by, e))
    handedOff = true
  } finally {
    if (!handedOff) await releaseLocks(held, e)
  }
}

/** A person says the name now points at the target: looked at once, recorded when it serves. */
export async function confirmRoute(
  id: number,
  by: string,
  over: MoveRunDeps = {}
): Promise<{ serving: boolean }> {
  const e = envOf(over)
  const move = await readMove(id)
  if (!move?.plan) throw new MoveError('NOT_FOUND', 'No such move.', 404)
  if (move.routing !== 'manual' || move.status !== 'waiting')
    throw new MoveError('NOT_WAITING', 'This move is not waiting for its route.')
  const ids = await sharedIdsOf(move.from_placement_id, move.to_placement_id)
  const sharedKey = ids.to !== null ? ((await getShared(ids.to))?.key ?? null) : null
  const ops = e.opsFor(move, move.plan, () => undefined)
  const serving = await ops.verifyName({ version: move.plan.version, shared: sharedKey })
  if (serving) {
    // R3-M-1: only this key, atomically, and only while the move still waits for its route.
    const at = new Date(e.now()).toISOString()
    await mergeSteps(id, (stored) => ({ ...stored, route_confirmed_at: at }), {
      status: ['waiting']
    })
  }
  await logActivity({
    action: 'hub-move-route-confirm',
    user: by,
    collection: ENVS,
    item: String(move.environment_id),
    comment: JSON.stringify({ move_id: id, serving })
  }).catch(() => null)
  return { serving }
}

/** Ticks (or unticks) one checklist item of a move. */
export async function setMoveChecklist(
  id: number,
  item: unknown,
  done: unknown,
  by: string
): Promise<MoveChecklistState[]> {
  const move = await readMove(id)
  if (!move) throw new MoveError('NOT_FOUND', 'No such move.', 404)
  if (typeof item !== 'string' || typeof done !== 'boolean')
    throw new MoveError('BAD_ITEM', 'Send {item, done}: an item id and true or false.', 400)
  const checklist = [...move.checklist]
  const found = checklist.find((c) => c.id === item)
  if (!found) throw new MoveError('UNKNOWN_ITEM', 'This move has no such checklist item.', 400)
  found.done = done
  await patchMove(id, { checklist })
  await logActivity({
    action: 'hub-move-checklist',
    user: by,
    collection: ENVS,
    item: String(move.environment_id),
    comment: JSON.stringify({ move_id: id, item, done })
  }).catch(() => null)
  return checklist
}

/** The plan for a move (POST /move/plan). */
export async function planFor(
  envId: number,
  rawTo: unknown,
  over: MoveRunDeps = {}
): Promise<MovePlan> {
  const e = envOf(over)
  // Review minor 8: Task 15's own refusal (BAD_TARGET, BAD_POOL …) with its sentence.
  let to: MoveTarget
  try {
    to = checkTarget(rawTo)
  } catch (err) {
    if (err instanceof MovePlannerError) throw new MoveError(err.code, err.message, 400)
    throw err
  }
  const env = await db(ENVS).where({ id: envId }).first('id')
  if (!env) throw new MoveError('NOT_FOUND', 'No such environment.', 404)
  try {
    return await e.planner(envId, to)
  } catch (err) {
    if (err instanceof MovePlannerError) throw new MoveError(err.code, err.message, err.statusCode)
    throw err
  }
}
