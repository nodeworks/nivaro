import { createHash, randomBytes } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { pullFailReasonsFrom, pullFailSentence } from '../../hub-transfer/fail-reasons.js'
import { getApp } from '../../io-holder.js'
import { type JobRunHandle, startJobRun } from '../../job-runs.js'
import { readApp } from '../apps.js'
import { createPlacement, getDriver, getPlacement } from '../drivers.js'
import { hubTokenColumns } from '../link-token.js'
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
import { getShared, openAppKey, setAppKey } from '../shared/store.js'
import {
  AddressError,
  type AddressOptions,
  type MoveAddresses,
  resolveMoveAddresses
} from './addresses.js'
import { isMoveLiveHere, markMoveLive, unmarkMoveLive } from './heal.js'
import { asStepError, defaultMoveOps, type MoveOps, MoveStepError, TARGET_READY_MS } from './ops.js'
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
  mergeChecklist,
  mergeSteps,
  OPEN_MOVE_STATUSES,
  openMoveOf,
  patchMove,
  patchMoveIfHolder,
  readMove,
  readStepsText,
  setEnvStatus,
  stepDone
} from './rows.js'
import { withMoveRun } from './run-context.js'

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
 * open; it is never rolled back. One exception: when the new home's key does not check
 * (or the new home cannot be asked), the old home is not retired and the move stays open —
 * `interrupted`, MOVE_OPEN refusing — until a Resume finds the key right, or a person chooses
 * Finish and stop the old home (stopRetireKey, finishStopSource; rulings P6-42 / P6-43 / P6-45). Tickets
 * are revoked after each copy and at the end.
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
  // FW-4: everything this run does is marked as the move's own (the MOVE_OPEN guards let it pass).
  const p = runInBackgroundPool(() => withMoveRun(moveId, work))
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
  /** Ruling P6-20 #2: refusals the operator overrides for this move (LINK_URL_NOT_PULLABLE for a
   *  shared source, SOURCE_NOT_PULLABLE for a dedicated one: the target lists the host in its
   *  SSRF_ALLOW_HOSTS). */
  overrides: string[]
}

/** Refusals a move start may override (operator checkbox, recorded with the move). */
export const MOVE_OVERRIDES = ['LINK_URL_NOT_PULLABLE', 'SOURCE_NOT_PULLABLE'] as const

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
        allowUnpullable:
          body.overrides.includes('LINK_URL_NOT_PULLABLE') ||
          body.overrides.includes('SOURCE_NOT_PULLABLE')
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
        ...(body.overrides.length
          ? {
              override: body.overrides.join(','),
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
    else if (m?.steps.finish_stop) await finishStopped(ctx)
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
    // R2-M-6: the ops alone write open_tickets; a run's older copy never puts one back.
    if (stored.open_tickets !== undefined) steps.open_tickets = stored.open_tickets
    else delete steps.open_tickets
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
    // A shared source drops the app from its list once the move's step column says
    // retire_source (tenants.ts): that is written only after the new home's key checks (doStep).
    await saveSteps(ctx, steps, entry.key === 'retire_source' ? {} : { step: entry.key })
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
      if (err instanceof RetireKeyStop) return stopRetireKey(ctx, err)
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
    ...(s.failed ? { failed_reasons: pullFailReasonsFrom(s.failed_reasons) } : {}),
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
  if (s.server_copied)
    ctx.run.log(
      `${s.server_copied} of them copied by the bucket itself (same bucket on both sides)`
    )
  if (s.state === 'failed')
    throw new MoveStepError(
      'FILES_FAILED',
      `The file copy failed${s.error ? `: ${s.error.slice(0, 200)}` : ''}.`
    )
  // Why, in plain words (hub-transfer/fail-reasons.ts): never a path, a URL or an error's text.
  const why = pullFailSentence(s.failed_reasons)
  if (blocking && s.failed > 0) {
    const ids = (s.failed_ids ?? []).slice(0, 5)
    throw new MoveStepError(
      'FILES_NOT_COPIED',
      `${s.failed} file(s) could not be copied${ids.length ? ` (${ids.join(', ')}${s.failed > ids.length ? ', …' : ''})` : ''}${why ? `: ${why}` : ''}; the move rolls back so none is lost.`
    )
  }
  if (!blocking && s.failed > 0)
    ctx.run.log(
      `${s.failed} file(s) failed in the warm copy${why ? ` (${why})` : ''}; copied again inside maintenance`,
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

/**
 * F4-1 (P6-39): the new home's key check, retried with backoff for about a minute (a shared
 * deployment's replicas re-read the list every 30 s; one link error is not an answer) before the
 * source is left unretired.
 */
async function verifyTargetKeyWithRetry(ctx: Ctx): Promise<void> {
  const waits = [5_000, 10_000, 15_000, 30_000]
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.ops.verifyTargetKey()
      return
    } catch (err) {
      const se = asStepError(err, "The new home's key could not be checked.")
      if (attempt >= waits.length) throw se
      ctx.run.log(
        `retire_source: the new home's key does not check yet (${se.code}); trying again`,
        'warn'
      )
      await ctx.e.sleep(waits[attempt])
    }
  }
}

/**
 * R5-I-1: the post-deploy maintenance call, retried with backoff (5, 15, 30, then every 60 s).
 * Final review moves Minor 3: within target_ready's own 10 minutes (TARGET_READY_MS), since an
 * app that runs its migrations at boot can take longer than 2 minutes to answer.
 */
async function targetMaintenanceWithRetry(ctx: Ctx): Promise<void> {
  const waits = [5_000, 15_000, 30_000]
  const by = ctx.e.now() + TARGET_READY_MS
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.ops.targetMaintenance(true)
      return
    } catch (err) {
      const se = asStepError(err, 'The target did not take maintenance.')
      const wait = waits[attempt] ?? 60_000
      if (ctx.e.now() + wait > by) throw se
      ctx.run.log(
        `deploy_target: the target did not take maintenance yet (${se.code}); trying again`,
        'warn'
      )
      await boundary(ctx)
      await ctx.e.sleep(wait)
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
      // R6-M-4: whenever this step runs (again, after a crash or a Resume), the source is frozen
      // again first: the freeze is idempotent, and a crash may have lifted it already.
      if (window) {
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
      try {
        // R2-M-7: a cancel reaches a GitLab deploy (it polls this at every wait).
        await ops.deployTarget({ stopRequested: () => cancelAsked(ctx) })
      } catch (err) {
        if (await cancelAsked(ctx)) throw new Halt('cancel')
        throw err
      }
      await targetMaintenanceWithRetry(ctx)
      // FW-4 I-1: a fact for the halt text (a Docker target's call sends nothing: boot maintenance).
      if (!ctx.shared.toDocker && ctx.shared.to === null) {
        steps.target_maint_set = true
        await saveSteps(ctx, steps)
      }
      if (steps.boot_freeze === 'on') {
        // R6-M-4: the intent first, so a crash inside the lift is seen (Resume freezes again,
        // a rollback lifts it).
        steps.boot_freeze = 'lifting'
        await saveSteps(ctx, steps)
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
    case 'retire_source': {
      // E2E B4 (P6-38): the new home seals with the app's own key before the old one is retired.
      // A check that never passes keeps the move open (stopRetireKey), the old home as it is.
      if (!steps.retire_key_checked_at) {
        try {
          await verifyTargetKeyWithRetry(ctx)
        } catch (err) {
          throw new RetireKeyStop(asStepError(err, "The new home's key could not be checked."))
        }
        // Review M-2: the proof is stored BEFORE the step column says retire_source, so a run
        // that stops from here on finishes the retire on Resume and never checks again.
        steps.retire_key_checked_at = new Date(e.now()).toISOString()
        await saveSteps(ctx, steps)
        if (ctx.lockLost) throw new Halt('lost')
      } else
        ctx.run.log(
          "retire_source: the new home's key checked before the run stopped; finishing the retire"
        )
      // Only now, and only while this run holds the move (M-3): a shared source's list drops
      // the app at this step (tenants.ts).
      if (!(await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, { step: 'retire_source' }))) {
        ctx.lockLost = true
        throw new Halt('lost')
      }
      return ops.retireSource()
    }
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
    // R2-M-8: one apply's converge wait ends with the route budget, not 30 minutes later.
    await ctx.ops.route(route[i], { deadline: by })
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
  // E2E B4 (P6-38): a shared-placed app's key is read from the environment's own entry only
  // (openAppKey). A Docker source keeps it in its stack settings, so it is resolved now (the R9
  // order: the entry, then the stack settings), before the switch, and written into the entry in
  // the same transaction. No key at all: the move does not release (the plan blocks it first).
  let carryKey: string | null = null
  if (ctx.shared.to !== null) {
    const entry = (await db(ENVS).where({ id: ctx.envId }).first('encryption_key')) as
      | { encryption_key: string | null }
      | undefined
    if (!entry?.encryption_key) {
      carryKey = await openAppKey(ctx.envId)
      if (!carryKey)
        throw new MoveStepError(
          'APP_KEY_UNKNOWN',
          "The Hub holds no encryption key for this app, so the shared deployment could not open its values. Enter the app's ENCRYPTION_KEY on the environment, then move again."
        )
    }
  }
  // 0.3.215 (review L2): on a shared target the app's sign-in reports and switcher use its own
  // hub token from the tenant list; an environment without one gets one here, as a placement
  // does. Sealed before the write; a Hub that cannot seal moves on without one.
  let linkToken: ReturnType<typeof hubTokenColumns> | null = null
  if (ctx.shared.to !== null)
    try {
      linkToken = hubTokenColumns(randomBytes(32).toString('hex'))
    } catch {
      linkToken = null
    }
  await db.transaction(async (trx) => {
    if (carryKey) await setAppKey(ctx.envId, carryKey, trx)
    if (linkToken)
      await trx(ENVS)
        .where({ id: ctx.envId })
        .where((q) => q.whereNull('hub_token').orWhere('hub_token', ''))
        .update(linkToken)
    await trx(ENVS)
      .where({ id: ctx.envId })
      .update({
        placement_id: move.to_placement_id,
        version_pin: ctx.plan.version,
        status: 'active',
        ...(ctx.shared.toDocker ? { hub_managed: true } : {}),
        updated_at: new Date()
      })
  })
  if (carryKey) ctx.run.log("release: the app's encryption key is kept with the environment")
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
    // E2E B3: where to check, on the public scheme and port it was served on.
    const at = move?.steps.addresses?.target_link_base ?? host
    ctx.run.log(`the per-move name ${host} is still on the target stack (${se.code})`, 'warn')
    const item = {
      id: 'temp_host',
      text: safeLine(
        `Still to do: remove the per-move name ${host} from the target stack. Apply the environment's stack again (Apply now renders only the environment's own names), then check that ${at} no longer serves the app.`
      ),
      required: false,
      done: false
    }
    await mergeChecklist(ctx.moveId, (c) => [...c.filter((x) => x.id !== 'temp_host'), item])
  }
}

async function finishSuccess(ctx: Ctx, warning: string | null): Promise<void> {
  await dropTempName(ctx)
  await ctx.ops.revokeTickets().catch(() => undefined)
  // Review minor 6: the shared placement the environment left goes when nothing uses it.
  if (!warning) await dropUnusedSharedPlacement(ctx.moveId).catch(() => undefined)
  // R5-M-2: only while this run still holds the move (never over a runner that took it).
  const ours = await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, {
    status: 'success',
    step: 'done',
    error: warning,
    finished_at: new Date(ctx.e.now()),
    heartbeat_at: null
  })
  if (!ours) return notOurs(ctx)
  // A resumed move whose key check stopped it earlier: the old home is retired now (after the
  // holder check, M-3).
  if (!warning)
    await mergeChecklist(ctx.moveId, (checklist) => {
      const found = checklist.find((c) => c.id === 'retire_source' && !c.done)
      if (!found) return null
      found.done = true
      return checklist
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

/**
 * retire_source's key check never passed. `key`: the new home answered and its key is not the
 * app's (APP_KEY_MISMATCH / APP_KEY_UNKNOWN). `unreachable`: it could not be asked at all (a link
 * error, a timeout): nothing is known about its key, so nothing tells a person to enter one (M-1).
 */
class RetireKeyStop extends MoveStepError {
  readonly kind: 'key' | 'unreachable'
  constructor(err: MoveStepError) {
    super(err.code, err.message)
    this.name = 'RetireKeyStop'
    this.kind = err.code.startsWith('APP_KEY_') ? 'key' : 'unreachable'
  }
}

/**
 * Round 1b: the stored code of a retire_source stop whose new home could not be asked (the
 * admin and the server recognise the case by this code, never by text).
 */
export const RETIRE_UNREACHABLE_CODE = 'APP_KEY_UNCHECKED_UNREACHABLE'

/** The codes a retire_source key stop stores (retireStopped reads them back). */
const RETIRE_STOP_CODES: readonly string[] = [
  'APP_KEY_MISMATCH',
  'APP_KEY_UNKNOWN',
  RETIRE_UNREACHABLE_CODE
]

/**
 * Which way out a retire_source stop has (review N-6), so each is stated once and only where it
 * can work: `key_entry` (a dedicated new home reports another key: the App key PUT can take it),
 * `no_key` (the new home reports none: no PUT can match), `shared` (a shared new home's key is
 * the one the Hub lists: wait for its replicas), `unreachable` (Resume to try again).
 */
export type RetireStopCase = 'key_entry' | 'no_key' | 'shared' | 'unreachable'

/** P6-45 / review N-7: the ONE answer server and admin use for a retire_source stop. */
export interface RetireStop {
  kind: 'key' | 'unreachable'
  case: RetireStopCase
  /** "Finish and stop the old home" is possible: the Hub can stop this old home and prove it. */
  finish: boolean
  /** "Enter the key the new home runs" can succeed. */
  key_entry: boolean
  /** The last Finish was refused (the stop was not proven): its plain reason, else null. */
  finish_refused: string | null
}

function stopCode(error: string | null): string | null {
  const m = /^([A-Z][A-Z0-9_]{1,63}): /.exec(error ?? '')
  return m ? m[1] : null
}

/**
 * The sync half of the one predicate: THIS attempt stopped at retire_source because the new
 * home's key did not check (or could not be asked). Interrupted, released, going forward, the
 * retire_source step failed with one of the stop's codes, and the key never checked in this
 * move: a run cut off mid-retire after the key passed (retire_key_checked_at) is Resume only.
 */
export function retireStopped(move: HubMoveRow | null | undefined): boolean {
  if (move?.status !== 'interrupted' || move.steps.phase === 'rollback') return false
  if (!stepDone(move.steps, 'release') || move.steps.retire_key_checked_at) return false
  if (move.steps.list.find((x) => x.key === 'retire_source')?.state !== 'failed') return false
  const code = stopCode(move.error)
  return code !== null && RETIRE_STOP_CODES.includes(code)
}

/** P6-45: how the Hub can stop an old home and prove it, or null when it cannot. */
export async function oldHomeStopKind(placementId: number): Promise<'shared' | 'docker' | null> {
  const p = await getPlacement(placementId)
  if (p?.kind === 'shared') return 'shared'
  if (p?.kind !== 'dedicated' || p.driver_id == null) return null
  return (await getDriver(p.driver_id))?.kind === 'docker' ? 'docker' : null
}

/** The one predicate (review N-7): the stop and its ways out, or null when it is not one. */
export async function retireStopOf(
  move: HubMoveRow | null | undefined
): Promise<RetireStop | null> {
  if (!move || !retireStopped(move)) return null
  const code = stopCode(move.error)
  const to = await getPlacement(move.to_placement_id)
  const kase: RetireStopCase =
    code === RETIRE_UNREACHABLE_CODE
      ? 'unreachable'
      : to?.kind === 'shared'
        ? 'shared'
        : code === 'APP_KEY_UNKNOWN'
          ? 'no_key'
          : 'key_entry'
  return {
    kind: kase === 'unreachable' ? 'unreachable' : 'key',
    case: kase,
    finish: (await oldHomeStopKind(move.from_placement_id)) !== null,
    key_entry: kase === 'key_entry',
    finish_refused: move.steps.finish_refused?.text ?? null
  }
}

/** The ways out of a stop, each once and only where it can work (the checklist item's text). */
export function retireStopWays(stop: Pick<RetireStop, 'case' | 'finish'>): string {
  const key =
    stop.case === 'key_entry'
      ? 'Enter the key the new home runs under App key on this environment (the Hub takes it only when it matches what the new home reports), then Resume.'
      : stop.case === 'no_key'
        ? "The new home reports no key: make it report the app's key, then Resume."
        : stop.case === 'shared'
          ? "The shared deployment's key is set by the Hub: wait until its replicas report it, then Resume."
          : 'Resume to try again.'
  return stop.finish
    ? `${key} Or Finish and stop the old home: the old home is stopped, not removed, and comes back only by moving the environment back to it.`
    : `${key} The Hub cannot stop this old home itself, so the move ends only once the key checks.`
}

/**
 * Untested path 2 (F4-1 / P6-39, rulings P6-42 / P6-43 / P6-45): the new home's key does not
 * check, so the old home keeps the app — it is NOT retired, and a shared source keeps listing it
 * (the step column is put back to `release`, review M-2). The move stays OPEN: `interrupted`, so
 * MOVE_OPEN keeps refusing person-started actions; Cancel / Roll back answer TOO_LATE (released).
 * Ways out (retireStopWays): Resume, the App key PUT judged against the new home, or Finish and
 * stop the old home (finishStopSource). The stored error says only what happened, with its code
 * first and no other code (N-5, N-6). Everything happens only while this run holds the move (M-3).
 */
async function stopRetireKey(ctx: Ctx, err: RetireKeyStop): Promise<void> {
  if (err.kind === 'unreachable')
    ctx.run.log(`retire_source: the new home could not be asked for its key (${err.code})`, 'warn')
  const error = safeLine(
    err.kind === 'key'
      ? `${err.code}: ${err.message} The old home was not retired.`
      : `${RETIRE_UNREACHABLE_CODE}: The Hub could not reach the new home to check its key; the old home was not retired.`
  )
  const ours = await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, {
    status: 'interrupted',
    error,
    heartbeat_at: null,
    step: 'release'
  })
  if (!ours) return notOurs(ctx)
  const stop = await retireStopOf(await readMove(ctx.moveId))
  const item = safeLine(
    `Do not remove the old home yet. ${stop ? retireStopWays(stop) : 'Resume to try again.'}`
  )
  await mergeChecklist(ctx.moveId, (checklist) => {
    const found = checklist.find((c) => c.id === 'retire_source')
    if (found) {
      found.done = false
      found.text = item
    } else checklist.push({ id: 'retire_source', text: item, required: false, done: false })
    return checklist
  })
  // No copy is left to make: the transfer tickets go now (a resume mints none).
  await ctx.ops.revokeTickets().catch(() => undefined)
  await closeDeployRow(ctx, 'interrupted', error)
  ctx.run.log(error, 'error')
  await ctx.run.fail(new Error(error))
}

/** After release a failing retire_source never rolls back: success with the item open. */
async function finishRetireFailed(ctx: Ctx, steps: MoveSteps, err: MoveStepError): Promise<void> {
  await mergeChecklist(ctx.moveId, (checklist) => {
    // Final review moves Minor 4: the source's own instruction (a Docker source never retired
    // says to remove its stack now), not only "see the log". A key that does not check never
    // gets here: it stops the move (stopRetireKey).
    const text = safeLine(
      `Retire the old placement by hand: the Hub could not (${err.code}). ${err.message}`
    )
    const item = checklist.find((c) => c.id === 'retire_source')
    if (item) {
      item.done = false
      item.text = text
    } else checklist.push({ id: 'retire_source', text, required: false, done: false })
    return checklist
  })
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
  let target = 'the new home'
  let how = 'stop every process of this app there and keep it from starting again'
  if (p?.kind === 'shared') {
    // Design R2-S1: stopping a shared deployment stops every other app on it; say so, with how many.
    const shared = await getShared(p.shared_deployment_id)
    const key = shared?.key ?? String(p.shared_deployment_id)
    const others = Number(
      (
        (await db(ENVS)
          .join('nivaro_hub_placements as p', 'p.id', `${ENVS}.placement_id`)
          .where('p.shared_deployment_id', p.shared_deployment_id)
          .whereNot(`${ENVS}.id`, move.environment_id)
          .count({ n: '*' })
          .first()) as { n?: unknown } | undefined
      )?.n ?? 0
    )
    target = key
    how = `scale its services to 0. This stops every app on ${key} (${others} other app${others === 1 ? '' : 's'}) until the rollback is done; the rollback then drops this app from its list and you can start ${key} again`
  } else if (p) {
    const driver = await getDriver(p.driver_id)
    const stack = (p.target as { stack?: unknown }).stack
    if (driver?.kind === 'docker' && typeof stack === 'string') {
      target = `the Docker stack ${stack} (driver ${driver.name})`
      how = `remove it on that swarm (docker stack rm ${stack}) and do not deploy it again`
    } else {
      const at = move.steps.addresses?.target_link_base
      target = at ? `the GitLab-deployed app at ${at}` : 'the GitLab-deployed app'
      how =
        'remove its stack on its swarm manager (docker stack rm) and stop its pipeline from deploying it again'
    }
  }
  // "Stop <target>: …" is what the admin reads the target's name from (haltedTargetName).
  return `Stop ${target}: ${how}. Then tick this box and Roll back, once no process of this app runs there and none can restart: the Hub then ${sourceFrozen ? "lifts the source's maintenance" : 'finishes the rollback'}.`
}

/**
 * R3-I-2: the rollback stopped because the target (lifted at release) could be neither frozen nor
 * stopped. The source stays in maintenance (one writer), the move is interrupted (Roll back again
 * retries the freeze, and goes on once the operator ticked target_stopped), and the error, the job
 * log, the activity and a required checklist item all say the same thing.
 */
async function halt(ctx: Ctx, move: HubMoveRow, sourceFrozen: boolean): Promise<void> {
  const say = await targetStopText(move, sourceFrozen)
  // R5-I-1: worded from the source's real state, never "stays in maintenance" when it serves.
  // FW-4 I-1: and what the Hub did to the target, never more: it set its maintenance after the
  // deploy (target_maint_set), or the target was deployed to start in it (a Docker stack's boot
  // maintenance, a template that reads the move id from the pin); the Hub never claims it set
  // a maintenance it did not.
  const fresh0 = (await readMove(ctx.moveId)) ?? move
  const state = sourceFrozen
    ? 'so the source stays in maintenance (never two writers)'
    : fresh0.steps.target_maint_set
      ? 'and the source keeps serving: it was not put in maintenance, and the target was put in maintenance after its deploy'
      : 'and the source keeps serving: it was not put in maintenance, because the target was deployed to start in maintenance'
  const error = `HALTED_TARGET_LIVE: The rollback stopped: the target could not be frozen or stopped, ${state}. ${say}`
  const ours = await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, {
    status: 'interrupted',
    error: safeLine(error),
    heartbeat_at: null
  })
  if (!ours) {
    ctx.run.log('stopped: this run no longer holds the move', 'error')
    await ctx.run.fail(new Error('Interrupted: the run lost its locks.'))
    return
  } // A tick made meanwhile is kept (compare-and-set); a tick of an earlier halt's item is reset.
  await mergeChecklist(ctx.moveId, (c) => [
    ...c.filter((x) => x.id !== 'target_stopped'),
    { id: 'target_stopped', text: say, required: true, done: false }
  ])

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

/** R5-M-2: another runner holds the move now; this one ends without writing its end. */
async function notOurs(ctx: Ctx): Promise<void> {
  ctx.lockLost = true
  ctx.run.log('stopped: another run holds this move now; it writes the end', 'error')
  await ctx.run.fail(new Error('Stopped: another run holds this move now.'))
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
  if (p?.kind === 'shared') {
    // A shared source is frozen through the Hub's list (the environment's status), never a key of
    // its own: its deployment's plain nvr:maintenance key would freeze every app on it.
    const shared = await getShared(p.shared_deployment_id)
    const key = shared?.key ?? String(p.shared_deployment_id)
    return `To recover: Apply now on the shared deployment ${key} (its stack then carries this app's names again). If the app still shows maintenance there, set the environment's status back to active on the Hub: the deployment's replicas re-read the Hub list within 30 seconds. Never clear the deployment's own maintenance key: that is the freeze of every app on ${key}.`
  }
  let names = 'Put the names back on the source by hand.'
  if (p) {
    const stack = (p.target as { stack?: unknown }).stack
    const driver = await getDriver(p.driver_id)
    if (driver?.kind === 'docker' && typeof stack === 'string')
      names = `Apply now on the source stack ${stack} (driver ${driver.name}): it renders the environment's own names again.`
  }
  // P6-32: a hub-linked app freezes on its OWN key (security.ts maintenanceOverrideKey), never
  // the plain nvr:maintenance (that one is honoured, never written, by the Hub's freeze).
  return `To recover: ${names} If the source still shows maintenance, lift it on the source app with POST /api/hub-link/maintenance {"on":false} without move_id (its hub token as the bearer). If that cannot be reached, delete the app's own key <REDIS_CHANNEL_PREFIX>nvr:maintenance:<tag> in its Redis, where <tag> is the first 16 hex characters of the sha256 of its HUB_TOKEN (redis-cli --scan --pattern '*nvr:maintenance:*' lists it); remove HUB_BOOT_MAINTENANCE from its stack first if it is set.`
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
  // R2-M-4: a person may have pointed the name at the target after the Hub's last self-check
  // (it runs every 5 minutes of the manual wait): look once more, before the target is undone.
  const r0 = move0.steps
  if (
    move0.routing === 'manual' &&
    r0.waiting_since &&
    !r0.route_confirmed_at &&
    !stepDone(r0, 'verify') &&
    (await ctx.ops
      .verifyName({ version: ctx.plan.version, shared: ctx.sharedKeyTo })
      .catch(() => false))
  ) {
    ctx.run.log('route: the name already answers from the target')
    await mergeSteps(ctx.moveId, (stored) =>
      stored.route_confirmed_at
        ? null
        : { ...stored, route_confirmed_at: new Date(ctx.e.now()).toISOString() }
    )
  }
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
  const said = await repointText(ctx, move)
  // Only a name seen answering from the target is certain (error, required item); a route
  // request that may have been carried out unseen is an item that says "if" (R2-M-4).
  const repoint = said?.sure ? said.text : null
  if (said) {
    ctx.run.log(said.text, said.sure ? 'error' : 'warn')
    await mergeChecklist(ctx.moveId, (c) => [
      ...c.filter((x) => x.id !== 'repoint_name'),
      { id: 'repoint_name', text: said.text, required: said.sure, done: false }
    ])
  }
  const recover =
    failed.includes('route') || failed.includes('maintenance_on')
      ? await sourceRecoveryText(move)
      : null
  if (recover) {
    ctx.run.log(recover, 'error')
    await mergeChecklist(ctx.moveId, (c) => [
      ...c.filter((x) => x.id !== 'restore_source'),
      { id: 'restore_source', text: safeLine(recover), required: true, done: false }
    ])
  }
  // The recovery goes first: the stored error is cut at 1000 characters.
  const base = failed.length
    ? `The rollback could not undo: ${failed.join(', ')}. ${recover ?? 'Check those by hand.'}${move.error ? ` — ${move.error}` : ''}`
    : move.error
  const error = repoint ? `${base ? `${base} — ` : ''}${repoint}` : base
  // R5-M-2: only while this run still holds the move (never over a runner that took it).
  const ours = await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, {
    status,
    error: error ?? null,
    finished_at: new Date(ctx.e.now()),
    heartbeat_at: null
  })
  if (!ours) return notOurs(ctx)
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
async function repointText(
  ctx: Ctx,
  move: HubMoveRow
): Promise<{ text: string; sure: boolean } | null> {
  if (move.routing !== 'manual') return null
  const sure = !!move.steps.route_confirmed_at || stepDone(move.steps, 'verify')
  // R2-M-4: the route request went out (the wait began) but the name was never seen moved.
  if (!sure && !move.steps.waiting_since) return null
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
  const back = `${names} back to ${source}: the move was rolled back and the target no longer serves this app.`
  return sure
    ? { text: `Point ${back}`, sure }
    : {
        text: `If someone already pointed ${names} at the target (the route request), point ${back}`,
        sure
      }
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

/** The environment's move stopped at retire_source (the one predicate, retireStopOf), or null. */
export async function retireStopFor(envId: number): Promise<HubMoveRow | null> {
  const rows = (await db('nivaro_hub_moves')
    .where({ environment_id: envId, status: 'interrupted' })
    .orderBy('id', 'desc')
    .pluck('id')) as Array<number | string>
  for (const id of rows) {
    const m = await readMove(Number(id))
    if (await retireStopOf(m)) return m
  }
  return null
}

/**
 * P6-43 (a): the key fingerprint the new home of a move reports, through the same reader as the
 * retire_source check (MoveOps.targetKeyFp); `code` when it cannot be asked.
 */
export async function newHomeKeyFp(
  move: HubMoveRow,
  over: MoveRunDeps = {}
): Promise<{ source: 'shared' | 'hub-link'; fp: string | null } | { code: string }> {
  if (!move.plan) return { code: 'NO_PLAN' }
  const e = envOf(over)
  const to = await getPlacement(move.to_placement_id)
  try {
    const fp = await e.opsFor(move, move.plan, () => undefined).targetKeyFp()
    return { source: to?.kind === 'shared' ? 'shared' : 'hub-link', fp }
  } catch (err) {
    return { code: asStepError(err, 'The new home could not be asked.').code }
  }
}

/**
 * P6-45 (replaces P6-43 (b)): "Finish and stop the old home". A retire_source key stop (the one
 * predicate, retireStopOf) whose old home the Hub can stop and prove stopped — a shared
 * deployment (the app dropped from its list, every replica holding that) or a Docker stack (its
 * services removed through the agent, volumes and the Hub's stack settings and secrets kept,
 * the agent's status showing nothing running). The run proves the stop BEFORE the move ends
 * `success` (so MOVE_OPEN lifts only then); a stop it cannot prove leaves the move at the stop
 * with a plain reason (finish_refused). Never before release (Cancel stays TOO_LATE after it); a
 * kind the Hub cannot stop (a GitLab placement) is refused CANNOT_STOP_OLD_HOME. Typed confirm
 * `<app key>/<env key>` (400 CONFIRM_MISMATCH).
 */
export async function finishStopSource(
  id: number,
  confirm: unknown,
  by: string,
  over: MoveRunDeps = {}
): Promise<void> {
  const e = envOf(over)
  const move = await readMove(id)
  if (!move) throw new MoveError('NOT_FOUND', 'No such move.', 404)
  if (!OPEN_MOVE_STATUSES.includes(move.status))
    throw new MoveError('MOVE_ENDED', `This move has ended (${move.status}).`)
  if (!stepDone(move.steps, 'release') || move.steps.phase === 'rollback')
    throw new MoveError(
      'NOT_RELEASED',
      'Before release the old home still serves the app: Resume or Roll back the move instead.'
    )
  const stop = await retireStopOf(move)
  if (!stop)
    throw new MoveError(
      'NOT_STOPPED_AT_RETIRE',
      "Only a move stopped at retiring the old home because the new home's key did not check can be finished this way. If the old home's retire had already started, Resume finishes it."
    )
  if (!stop.finish) throw cannotStop()
  const env = (await db(ENVS).where({ id: move.environment_id }).first('key', 'app_id')) as
    | { key: string; app_id: number }
    | undefined
  const app = env ? await readApp(Number(env.app_id)) : null
  const confirmText = app && env ? `${app.key}/${String(env.key)}` : null
  if (!confirmText || confirm !== confirmText)
    throw new MoveError(
      'CONFIRM_MISMATCH',
      `Type ${confirmText ?? 'the app and environment keys'} to finish the move and stop the old home.`,
      400
    )
  // Review R2-3: at a stop where the Hub could not reach the new home, the old home is the only
  // other copy: it is stopped only once the public name is seen answering from the new home
  // (the same check `verify` makes: version, shared key or none, tenant).
  if (stop.case === 'unreachable' && !(await newHomeServes(move, e)))
    throw new MoveError(
      'NEW_HOME_NOT_SERVING',
      `${move.plan?.hostnames[0] ?? 'The public name'} does not answer from the new home right now, so the old home was not stopped. Resume once the new home answers (it checks the key again), or try Finish again then.`
    )
  await restart(move, by, e, 'stop')
}

/** The public name answers from the move's new home now (the `verify` step's own check). */
async function newHomeServes(move: HubMoveRow, e: Env): Promise<boolean> {
  if (!move.plan) return false
  const ids = await sharedIdsOf(move.from_placement_id, move.to_placement_id)
  const shared = ids.to !== null ? ((await getShared(ids.to))?.key ?? null) : null
  try {
    return await e
      .opsFor(move, move.plan, () => undefined)
      .verifyName({ version: move.plan.version, shared })
  } catch {
    return false
  }
}

function cannotStop(): MoveError {
  return new MoveError(
    'CANNOT_STOP_OLD_HOME',
    'The Hub cannot stop this old home and prove it stopped (it is not a Docker stack or a shared deployment), so the move cannot end this way. Enter the key the new home runs under App key, then Resume.'
  )
}

/**
 * The run side of finishStopSource: stop the old home and prove it, then the manual "remove it"
 * item and success with a warning. A stop it cannot prove: refuseFinish (the move goes back to
 * the stop, nothing ended).
 */
async function finishStopped(ctx: Ctx): Promise<void> {
  const move = await readMove(ctx.moveId)
  if (!move) return
  const kind = await oldHomeStopKind(move.from_placement_id)
  try {
    if (!kind) throw new MoveStepError('CANNOT_STOP_OLD_HOME', cannotStop().message)
    // A shared old home stops serving the app once its list drops it: the step column says so
    // (tenants.ts), only while this run holds the move; stopSource proves every replica has it.
    if (
      kind === 'shared' &&
      !(await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, { step: 'retire_source' }))
    ) {
      ctx.lockLost = true
      return notOurs(ctx)
    }
    await ctx.ops.stopSource()
  } catch (err) {
    return refuseFinish(ctx, asStepError(err, 'The old home could not be proven stopped.'))
  }
  const steps = structuredClone((await readMove(ctx.moveId))?.steps ?? move.steps)
  for (const s of steps.list) {
    if (s.key === 'done') s.state = 'done'
    if (s.key === 'retire_source') {
      s.state = 'done'
      s.note = 'Stopped by Finish and stop the old home; not removed.'
    }
  }
  steps.finish_refused = null
  await saveSteps(ctx, steps)
  if (ctx.lockLost) return notOurs(ctx)
  const what =
    kind === 'shared'
      ? 'its shared deployment no longer lists the app'
      : 'its Docker stack has no service left (volumes kept)'
  const item = safeLine(
    `Remove the old home when you're sure: it is stopped (${what}), not removed. It comes back only by moving the environment back to it.`
  )
  await mergeChecklist(ctx.moveId, (checklist) => {
    const found = checklist.find((c) => c.id === 'retire_source')
    if (found) {
      found.done = false
      found.text = item
    } else checklist.push({ id: 'retire_source', text: item, required: false, done: false })
    return checklist
  })
  ctx.run.log(`the old home is stopped (${what}); the move ends without retiring it`)
  return finishSuccess(
    ctx,
    'The environment moved; the old home was stopped, not removed (Finish and stop the old home). Remove it when you are sure: see the checklist.'
  )
}

/**
 * P6-45: the old home's stop could not be proven. The move goes back to the stop exactly as it
 * was (interrupted, its stop error kept, the step column back at `release` so a shared old home
 * lists the app again), with the plain reason kept as finish_refused for the panel.
 */
async function refuseFinish(ctx: Ctx, err: MoveStepError): Promise<void> {
  const text = safeLine(
    `Finish and stop the old home was refused: ${err.message} The move still waits at retiring the old home; the new home serves the app.`
  ).slice(0, 500)
  const move = await readMove(ctx.moveId)
  if (move) {
    const steps = structuredClone(move.steps)
    // undefined, not delete: saveSteps keeps a key the run's copy lacks from the stored list.
    steps.finish_stop = undefined
    steps.finish_refused = { at: new Date(ctx.e.now()).toISOString(), text }
    await saveSteps(ctx, steps)
  }
  if (ctx.lockLost) return notOurs(ctx)
  const ours = await patchMoveIfHolder(ctx.moveId, ctx.held.envToken, {
    status: 'interrupted',
    heartbeat_at: null,
    step: 'release'
  })
  if (!ours) return notOurs(ctx)
  const error = (await readMove(ctx.moveId))?.error ?? null
  await closeDeployRow(ctx, 'interrupted', error)
  ctx.run.log(`${text} (${err.code})`, 'error')
  await ctx.run.fail(new Error(text))
}

async function restart(
  move: HubMoveRow,
  by: string,
  e: Env,
  way: 'forward' | 'rollback' | 'stop'
): Promise<void> {
  const ids = await sharedIdsOf(move.from_placement_id, move.to_placement_id)
  const held = await takeLocks(
    move.environment_id,
    [ids.from, ids.to].filter((x): x is number => x !== null),
    e
  )
  let handedOff = false
  try {
    // Review N-8: the step list is written with a compare-and-set on the text read here, inside
    // the lock: a write over a list that changed since (a Resume that stopped again) is refused,
    // read again and tried once more.
    let changed = 0
    for (let attempt = 0; attempt < 2 && !changed; attempt++) {
      const raw = await readStepsText(move.id)
      const fresh = await readMove(move.id)
      if (!fresh || raw === null) throw new MoveError('NOT_FOUND', 'No such move.', 404)
      if (!OPEN_MOVE_STATUSES.includes(fresh.status))
        throw new MoveError('MOVE_ENDED', `This move has ended (${fresh.status}).`)
      if (way === 'stop' && !(await retireStopOf(fresh)))
        throw new MoveError(
          'NOT_STOPPED_AT_RETIRE',
          'The move is no longer stopped at retiring the old home; reload it.'
        )
      const steps = structuredClone(fresh.steps)
      steps.locks = lockTokens(held)
      if (way === 'rollback' && steps.phase !== 'rollback') {
        steps.phase = 'rollback'
        steps.undo_reason = 'cancelled'
      }
      if (way === 'stop')
        steps.finish_stop = { by: by || null, at: new Date(e.now()).toISOString() }
      if (way !== 'rollback') steps.finish_refused = null
      changed = await patchMove(
        move.id,
        {
          status: 'running',
          steps,
          heartbeat_at: new Date(e.now()),
          // Review I-2: a resume clears the stop it resumes from (a rollback keeps its reason;
          // Finish keeps the stop's error, so a refused Finish leaves the stop as it was).
          ...(way === 'forward' ? { error: null } : {})
        },
        {
          status: way === 'stop' ? ['interrupted'] : ['interrupted', 'running', 'waiting'],
          stepsText: raw
        }
      )
    }
    if (!changed)
      throw new MoveError('MOVE_CHANGED', 'The move changed while this was being asked; reload it.')
    await db(DEPLOYS)
      .where({ move_id: move.id })
      .update({ status: 'running', heartbeat_at: new Date(e.now()), finished_at: null })
      .catch(() => null)
    const run = await e.startRun(
      `${way === 'rollback' ? 'Roll back' : way === 'stop' ? 'Finish (stop the old home)' : 'Resume'} move ${move.id}`,
      move.id,
      by
    )
    if (run.id) await patchMove(move.id, { job_run_id: Number(run.id) })
    await logActivity({
      action:
        way === 'rollback'
          ? 'hub-move-cancel'
          : way === 'stop'
            ? 'hub-move-finish-stop'
            : 'hub-move-start',
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
  let checklist: MoveChecklistState[] = []
  let known = false
  // Final review moves Minor 2: compare-and-set, so a tick never drops an item the run adds.
  await mergeChecklist(id, (stored) => {
    const found = stored.find((c) => c.id === item)
    known = !!found
    if (!found) return null
    found.done = done
    checklist = stored
    return stored
  })
  if (!known) throw new MoveError('UNKNOWN_ITEM', 'This move has no such checklist item.', 400)
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
