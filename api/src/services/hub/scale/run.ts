import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { hubPublicOrigin } from '../../deployment-mode.js'
import {
  AgentError,
  agentHealth,
  agentScale,
  agentStack,
  describeAgentError
} from '../docker/agent-client.js'
import type { StackScaleChange, StackSpec, StackStatus } from '../docker/agent-types.js'
import { environmentNames } from '../docker/render-spec.js'
import { prepareStackSpec } from '../docker/run-step.js'
import { deployedStack } from '../docker/stack-guards.js'
import { type DockerDriverRow, getDriver } from '../drivers.js'
import { recordedImage } from '../move/shared-route.js'
import { deliverHubNotice, hubEventRecipients, type NotifyDeps } from '../notify-events.js'
import {
  defaultPromoteLock,
  defaultSharedLock,
  LOCK_RENEW_MS,
  lockHolderRefusal,
  type PromoteLock,
  PromotionError,
  type SharedLock,
  sharedLockRefusal
} from '../promote-lock.js'
import { renderSharedSpec, SharedRenderError } from '../shared/stack-render.js'
import { getShared, openSharedToken } from '../shared/store.js'
import { tenantsOf } from '../shared/tenants.js'
import { deployedSharedRoles } from '../shared/upgrade-plan.js'
import { ensureSharedSecrets } from '../shared/upgrade-run.js'
import {
  changesBetween,
  type PlanDeps,
  planScale,
  type RoleChangeInput,
  ScaleError,
  type ScalePlan
} from './plan.js'
import { type RoleFigures, type ScaleShape, shapeText } from './shape.js'
import {
  insertRun,
  noteChange,
  type RunSource,
  readRun,
  type ScaleRun,
  type ScaleStep,
  shapeFromFigures,
  staleRuns,
  type TargetKind,
  updateRunning,
  writeShape
} from './store.js'
import { readTarget, type ScaleTarget } from './target.js'

/**
 * Nivaro Hub scaling: one change run (manual, automatic or by schedule) of a stack's replicas and
 * limits, through the Hub agent's scale endpoint (agent 0.2.4). Every change is a run row
 * (nivaro_hub_scale_runs) with its reason, the figures that caused it, the shape before and after
 * and its steps; the run holds the stack's lock (the environment lock, or the shared deployment's
 * lock, holder `scale`) for its whole life, renewed with a heartbeat.
 *
 * A step: render the spec the stack runs now (exactly as a restart does — the recorded image and
 * pins, the saved settings, the shape BEFORE the step), ask the agent to change only the numbers
 * of this step, wait for swarm to settle on the new spec hash, then keep the new numbers
 * (nivaro_hub_scale_roles), so every later render — promotion, Apply now, upgrade, move — renders
 * the scaled stack. A realtime scale-in is one replica a step, with a pause between steps so the
 * stopped process's sockets reconnect to the others before the next one stops.
 *
 * Resume: a run whose process stopped keeps `running` with an old heartbeat; the scale tick takes
 * the lock again and sends the same step again. The agent answers `already` when the stack runs
 * that step's spec, so nothing is applied twice.
 */

export const SETTLE_MS = 15 * 60_000
export const POLL_MS = 5_000
/** Between realtime scale-in steps: the closed sockets reconnect to the other processes. */
export const DRAIN_MS = 60_000
/** A run whose heartbeat is older than this is resumed by the tick. */
export const STALE_MS = 3 * 60_000
const POLL_MISSES = 3

export interface CurrentSpec {
  driver: DockerDriverRow
  spec: StackSpec
}

export interface RunDeps extends PlanDeps {
  envLock?: PromoteLock
  sharedLock?: SharedLock
  agentScale?: typeof agentScale
  agentStack?: (d: DockerDriverRow, name: string, expect?: string) => Promise<StackStatus | null>
  /** The spec the stack runs with `shape`; default renderCurrentSpec. */
  renderCurrent?: (t: ScaleTarget, shape: ScaleShape) => Promise<CurrentSpec>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollMs?: number
  settleMs?: number
  drainMs?: number
  renewMs?: number
  notify?: NotifyDeps
  /** Tests: wait for the background run instead of firing it off. */
  inline?: boolean
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class Stop extends Error {
  status: 'failed' | 'cancelled' | 'interrupted'
  code: string
  constructor(status: Stop['status'], code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/

/** The spec the stack runs now, with `shape` laid over the template (never an inspect). */
export async function renderCurrentSpec(t: ScaleTarget, shape: ScaleShape): Promise<CurrentSpec> {
  if (!t.stack || !t.driver)
    throw new Stop('failed', 'NO_STACK_NAME', 'The stack has no swarm stack name or driver.')
  if (t.kind === 'environment') {
    const deployed = await deployedStack(t.id, t.stack)
    if (deployed.state !== 'ok' || !t.version || deployed.version !== t.version)
      throw new Stop(
        'failed',
        'STACK_STATE_UNKNOWN',
        `The Hub cannot tell which spec ${t.stack} runs — deploy it (Apply now) before scaling it.`
      )
    try {
      const prepared = await prepareStackSpec(
        t.id,
        {
          name: t.stack,
          driverId: t.driver.id,
          version: t.version,
          image: deployed.image,
          extensions: deployed.extensions
        },
        { scale: shape }
      )
      return { driver: prepared.driver, spec: prepared.spec }
    } catch (err) {
      if (err instanceof PromotionError) throw new Stop('failed', err.code, err.message)
      throw err
    }
  }
  // A shared deployment: what its newest successful run deployed, the names its apps claim now
  // (a move changes them), the roles it runs — exactly as a move's route step renders it.
  const shared = await getShared(t.id)
  if (!shared?.stack || shared.driver_id == null || !shared.version_pin)
    throw new Stop('failed', 'NOT_DEPLOYED', 'The shared deployment has no recorded run.')
  const driver = await getDriver(shared.driver_id)
  if (driver?.kind !== 'docker')
    throw new Stop('failed', 'NO_DRIVER', 'The shared deployment names no Docker driver.')
  const recorded = await recordedImage(shared.id, shared.version_pin)
  if (!recorded || !PIN_RE.test(recorded.image))
    throw new Stop(
      'failed',
      'STACK_STATE_UNKNOWN',
      `The Hub has no record of what ${shared.stack} runs; deploy it once before scaling it.`
    )
  const token = await openSharedToken(shared.id)
  if (!token) throw new Stop('failed', 'TOKEN_MISSING', 'The deployment token cannot be opened.')
  const secrets = await ensureSharedSecrets(shared.id)
  let edge: 'traefik' | 'publish' = 'traefik'
  try {
    edge = (await agentHealth(driver)).edge === 'publish' ? 'publish' : 'traefik'
  } catch (err) {
    throw new Stop(
      'failed',
      'AGENT_UNREACHABLE',
      err instanceof AgentError
        ? describeAgentError(err, { stack: shared.stack })
        : 'The Hub agent does not answer.'
    )
  }
  const names = new Set<string>()
  for (const r of await tenantsOf(shared)) for (const n of environmentNames(r.env)) names.add(n)
  try {
    const spec = renderSharedSpec({
      shared,
      driver: driver.config,
      edge,
      secrets,
      token,
      version: shared.version_pin,
      image: recorded.image,
      extensions: { ...shared.extension_pins, ...recorded.extensions },
      hubPublicUrl: hubPublicOrigin() ?? '',
      explicitHosts: [...names],
      roles: (await deployedSharedRoles(shared)).roles,
      scale: shape
    })
    return { driver, spec }
  } catch (err) {
    if (err instanceof SharedRenderError) throw new Stop('failed', err.code, err.message)
    throw err
  }
}

type Held =
  | { kind: 'environment'; envId: number; token: string }
  | { kind: 'shared'; sharedId: number; token: string }

async function takeLock(t: ScaleTarget, deps: RunDeps): Promise<Held> {
  if (t.kind === 'shared') {
    const lock = deps.sharedLock ?? defaultSharedLock()
    const token = await lock.take(t.id, 'scale')
    if (!token) {
      const r = sharedLockRefusal(await lock.holder(t.id).catch(() => null))
      throw new ScaleError(r.code, r.message)
    }
    return { kind: 'shared', sharedId: t.id, token }
  }
  const lock = deps.envLock ?? defaultPromoteLock()
  const token = await lock.take(t.id, 'scale')
  if (!token) {
    const r = lockHolderRefusal((await lock.holder?.(t.id).catch(() => null)) ?? null, {
      code: 'ENVIRONMENT_BUSY',
      message: 'Another action holds this environment — wait for it to end.'
    })
    throw new ScaleError(r.code, r.message)
  }
  return { kind: 'environment', envId: t.id, token }
}

async function renewLock(h: Held, deps: RunDeps): Promise<boolean> {
  try {
    if (h.kind === 'shared') {
      const l = deps.sharedLock ?? defaultSharedLock()
      return l.renewStrict
        ? await l.renewStrict(h.sharedId, h.token)
        : await l.renew(h.sharedId, h.token)
    }
    const l = deps.envLock ?? defaultPromoteLock()
    return l.renewStrict ? await l.renewStrict(h.envId, h.token) : await l.renew(h.envId, h.token)
  } catch {
    return false
  }
}

async function releaseLock(h: Held, deps: RunDeps): Promise<void> {
  try {
    if (h.kind === 'shared')
      await (deps.sharedLock ?? defaultSharedLock()).release(h.sharedId, h.token)
    else await (deps.envLock ?? defaultPromoteLock()).release(h.envId, h.token)
  } catch {
    // the lock expires on its own
  }
}

export interface StartInput {
  roles: RoleChangeInput[]
  /** Manual: the plan the person read (409 PLAN_CHANGED otherwise). */
  plan_hash?: string
  /** Manual: the typed key, where the plan asks for it. */
  confirm?: string
}

export interface StartActor {
  by: string | null
  source: RunSource
  /** Automatic: why (the rule's sentence with its figure). */
  reason?: string
  figures?: Record<string, unknown> | null
}

export interface Started {
  run_id: number
  plan: ScalePlan
  /** For tests and the tick: settles when the run ends. */
  done: Promise<void>
}

/**
 * Plans and starts one change. Manual: bound to `plan_hash`, refused on any blocker, typed
 * confirm on production and shared deployments. Automatic: refused on any blocker (the tick logs
 * a skipped row instead). Answers once the run row exists; the run goes on in the background.
 */
export async function startScale(
  kind: TargetKind,
  id: number,
  input: StartInput,
  actor: StartActor,
  deps: RunDeps = {}
): Promise<Started> {
  const t = await readTarget(kind, id, deps.health)
  if (!t) throw new ScaleError('NOT_FOUND', 'No such stack.', 404)
  const plan = await planScale(t, input.roles, actor.source === 'manual' ? 'manual' : 'auto', deps)
  if (actor.source === 'manual' && input.plan_hash !== plan.plan_hash)
    throw Object.assign(
      new ScaleError(
        'PLAN_CHANGED',
        'The plan changed since you saw it — check the new plan and start again.'
      ),
      { plan }
    )
  if (plan.blockers.length)
    throw Object.assign(new ScaleError(plan.blockers[0].code, plan.blockers[0].text), { plan })
  if (actor.source === 'manual' && plan.confirm && input.confirm !== plan.confirm)
    throw new ScaleError('CONFIRM_REQUIRED', `Type ${plan.confirm} to change this stack.`, 400)

  const held = await takeLock(t, deps)
  let runId: number
  try {
    const steps: ScaleStep[] = plan.steps.map((to) => ({ to, status: 'pending' }))
    runId = await insertRun({
      target_kind: kind,
      target_id: id,
      stack: t.stack,
      source: actor.source,
      status: 'running',
      reason: actor.reason ?? `Changed by hand: ${shapeText(plan.from, plan.to)}.`,
      figures: actor.figures ?? null,
      from: plan.from,
      to: plan.to,
      steps,
      plan_hash: plan.plan_hash,
      started_by: actor.by
    })
  } catch (err) {
    await releaseLock(held, deps)
    throw err
  }
  const done = runInBackgroundPool(() => execute(runId, held, deps))
  if (deps.inline) await done
  return { run_id: runId, plan, done }
}

/** Waits for swarm to settle on `hash`: converged, rolled back, paused, or the time is up. */
async function settle(
  driver: DockerDriverRow,
  stack: string,
  hash: string,
  deps: RunDeps,
  alive: () => boolean
): Promise<void> {
  const read = deps.agentStack ?? agentStack
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const until = now() + (deps.settleMs ?? SETTLE_MS)
  let misses = 0
  for (;;) {
    if (!alive()) throw new Stop('interrupted', 'LOCK_LOST', 'The run lost its lock.')
    let st: StackStatus | null = null
    try {
      st = await read(driver, stack, hash)
      misses = 0
    } catch {
      misses++
      if (misses >= POLL_MISSES)
        throw new Stop(
          'failed',
          'AGENT_UNREACHABLE',
          'The Hub agent stopped answering while swarm settled.'
        )
    }
    if (st?.state === 'converged') return
    if (st?.state === 'rolled_back')
      throw new Stop(
        'failed',
        'SWARM_ROLLED_BACK',
        'Swarm rolled the change back (a new process did not start).'
      )
    if (st?.state === 'paused')
      throw new Stop(
        'failed',
        'SWARM_UPDATE_PAUSED',
        'Swarm paused the update — see the stack panel.'
      )
    if (now() > until)
      throw new Stop(
        'failed',
        'SETTLE_TIMEOUT',
        'Swarm did not settle on the change within 15 minutes.'
      )
    await sleep(deps.pollMs ?? POLL_MS)
  }
}

const changedRoles = (from: RoleFigures[], to: RoleFigures[]) =>
  to.filter((t) => {
    const f = from.find((x) => x.role === t.role)
    return !f || f.replicas !== t.replicas || f.cpus !== t.cpus || f.memory_mb !== t.memory_mb
  })

/** The run itself (fresh or resumed), holding `held` until it ends. Never throws. */
async function execute(runId: number, held: Held, deps: RunDeps): Promise<void> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  let alive = true
  const beat = async () => {
    if (!(await renewLock(held, deps))) {
      alive = false
      return
    }
    await updateRunning(runId, { heartbeat_at: new Date(now()) }).catch(() => false)
  }
  const timer = setInterval(() => void beat(), deps.renewMs ?? LOCK_RENEW_MS)
  timer.unref?.()
  let run = await readRun(runId)
  try {
    if (!run) return
    const t = await readTarget(run.target_kind, run.target_id, deps.health)
    if (!t) throw new Stop('failed', 'NOT_FOUND', 'The stack no longer exists.')
    if (!t.stack || t.stack !== run.stack)
      throw new Stop('failed', 'STACK_CHANGED', 'The stack name changed since the run started.')
    const steps = run.steps
    for (let i = run.step_index; i < steps.length; i++) {
      // A cancel lands between steps (a realtime drain): what ran keeps running.
      const fresh = await readRun(runId)
      if (fresh?.error_code === 'CANCEL_REQUESTED')
        throw new Stop(
          'cancelled',
          'CANCELLED',
          `Cancelled after ${i} of ${steps.length} steps; the stack keeps what it runs now.`
        )
      const prev = i === 0 ? run.from : steps[i - 1].to
      const changes: StackScaleChange[] = changesBetween(prev, steps[i].to)
      steps[i] = { ...steps[i], status: 'applying', at: new Date(now()).toISOString() }
      await updateRunning(runId, { steps, step_index: i })
      if (changes.length) {
        const current = await (deps.renderCurrent ?? renderCurrentSpec)(t, shapeFromFigures(prev))
        let hash: string
        try {
          hash = (
            await (deps.agentScale ?? agentScale)(current.driver, t.stack, current.spec, changes)
          ).spec_hash
        } catch (err) {
          if (err instanceof AgentError)
            throw new Stop(
              'failed',
              err.code,
              `The agent did not scale the stack: ${describeAgentError(err, { stack: t.stack })}`
            )
          throw err
        }
        steps[i] = { ...steps[i], spec_hash: hash }
        await updateRunning(runId, { steps, spec_hash: hash })
        await settle(current.driver, t.stack, hash, deps, () => alive)
      }
      // Keep the new numbers: every later render lays them over the template.
      await writeShape(
        run.target_kind,
        run.target_id,
        changedRoles(run.from, steps[i].to),
        run.started_by
      )
      steps[i] = { ...steps[i], status: 'done', at: new Date(now()).toISOString() }
      await updateRunning(runId, { steps, step_index: i + 1 })
      if (i < steps.length - 1) await sleep(deps.drainMs ?? DRAIN_MS)
    }
    await updateRunning(runId, {
      status: 'success',
      finished_at: new Date(now()),
      step_index: steps.length
    })
    await noteChange(
      run.target_kind,
      run.target_id,
      changedRoles(run.from, run.to).map((r) => r.role),
      new Date(now())
    )
    await logActivity({
      action: 'hub-scale',
      user: run.started_by,
      collection: 'nivaro_hub_scale_runs',
      item: String(runId),
      origin: run.source === 'manual' ? 'person' : 'machine',
      comment: JSON.stringify({
        target: `${run.target_kind}:${run.target_id}`,
        stack: run.stack,
        source: run.source,
        change: shapeText(run.from, run.to)
      })
    })
    if (run.source !== 'manual') await tell(t, run, 'done', null, deps)
  } catch (err) {
    const stop =
      err instanceof Stop
        ? err
        : new Stop(
            'failed',
            'INTERNAL',
            'The run stopped on an error inside the Hub — see the Hub log.'
          )
    run = run ?? (await readRun(runId))
    await updateRunning(runId, {
      status: stop.status,
      error_code: stop.code.slice(0, 64),
      error: stop.message,
      finished_at: new Date(now())
    }).catch(() => false)
    if (run && stop.status === 'failed') {
      const t = await readTarget(run.target_kind, run.target_id).catch(() => null)
      if (t) await tell(t, run, 'failed', stop.message, deps)
    }
  } finally {
    clearInterval(timer)
    await releaseLock(held, deps)
  }
}

/** Tells the app's admins and owners about an automatic change, or a failed one. */
async function tell(
  t: ScaleTarget,
  run: ScaleRun,
  what: 'done' | 'failed',
  error: string | null,
  deps: RunDeps
): Promise<void> {
  try {
    const people = new Set<string>()
    for (const appId of t.app_ids.length ? t.app_ids : [0])
      for (const p of appId ? await hubEventRecipients(appId) : []) people.add(p)
    if (!people.size) return
    const change = shapeText(run.from, run.to)
    await deliverHubNotice(
      [...people],
      {
        subject: what === 'done' ? `Scaled: ${t.label}` : `Scaling failed: ${t.label}`,
        message:
          what === 'done'
            ? `${run.source === 'schedule' ? 'The schedule' : 'Autoscaling'} changed ${change}. ${run.reason ?? ''}`.trim()
            : `${change} did not finish: ${error ?? 'unknown error'}`,
        path: `/hub/scale?target=${t.kind}:${t.id}`,
        urgent: what === 'failed' && t.production,
        source: { kind: 'hub', label: 'scale', id: run.id },
        why: 'You are a Hub administrator or an owner of this app.'
      },
      deps.notify
    )
  } catch {
    // a notice never stops a run
  }
}

/** Asks a running run to stop before its next step (a realtime drain). */
export async function cancelScale(runId: number): Promise<boolean> {
  const n = await db('nivaro_hub_scale_runs')
    .where({ id: runId, status: 'running' })
    .whereNull('error_code')
    .update({ error_code: 'CANCEL_REQUESTED' })
  return Number(n) > 0
}

/**
 * Runs whose process stopped (heartbeat older than STALE_MS) go on from their step: the lock is
 * taken again and the step sent again (the agent answers `already` for a step it applied). A lock
 * someone else holds leaves the run for the next tick; one that stays stale for an hour is marked
 * interrupted.
 */
export async function resumeStaleRuns(deps: RunDeps = {}): Promise<number> {
  const now = deps.now ?? Date.now
  let resumed = 0
  for (const run of await staleRuns(new Date(now() - STALE_MS))) {
    const t = await readTarget(run.target_kind, run.target_id, deps.health).catch(() => null)
    const age = now() - Date.parse(run.heartbeat_at ?? run.created_at ?? new Date(0).toISOString())
    if (!t) {
      await updateRunning(run.id, {
        status: 'interrupted',
        error_code: 'NOT_FOUND',
        error: 'The stack no longer exists.',
        finished_at: new Date(now())
      })
      continue
    }
    let held: Held
    try {
      held = await takeLock(t, deps)
    } catch {
      if (age > 60 * 60_000)
        await updateRunning(run.id, {
          status: 'interrupted',
          error_code: 'LOCK_HELD',
          error: 'The run stopped and another action has held the stack since.',
          finished_at: new Date(now())
        })
      continue
    }
    await updateRunning(run.id, { heartbeat_at: new Date(now()) })
    const done = runInBackgroundPool(() => execute(run.id, held, deps))
    if (deps.inline) await done
    resumed++
  }
  return resumed
}
