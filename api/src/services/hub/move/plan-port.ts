import { db } from '../../../db/index.js'
import { getPlacement } from '../drivers.js'
import { getShared } from '../shared/store.js'
import { checkMoveTarget, gatherMovePlanInput } from './gather.js'
import { buildMovePlan } from './plan.js'
import {
  type MovePlan,
  type MoveStepKey,
  type MoveTarget,
  MoveError as PlanMoveError
} from './types.js'

/**
 * Nivaro Hub phase 6, Task 16: the move runner's one door onto Task 15's planner (gather + the
 * pure plan), so the run and its tests can put another planner in place.
 *
 * The run re-plans at start while it already holds its own `move` locks (ruling P6-14), so it asks
 * gather with `ownLocks: true`: its own lock holder and its own open move never read as BUSY.
 */

export type {
  MoveKind,
  MovePlan,
  MoveStepKey,
  MoveTarget,
  RouteAction
} from './types.js'

export type MovePlanner = (
  envId: number,
  to: MoveTarget,
  opts?: { ownLocks?: boolean }
) => Promise<MovePlan>

/** A refusal before any plan could be made (gather's MoveError: 404 / 409 / 400). */
export class MovePlannerError extends Error {
  code: string
  statusCode: number
  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.name = 'MovePlannerError'
    this.code = code
    this.statusCode = statusCode
  }
}

let override: MovePlanner | null = null

/** Tests put a planner in place; null = Task 15's own. */
export function setMovePlanner(fn: MovePlanner | null): void {
  override = fn
}

/** The plan for moving `envId` to `to`. */
export async function planMove(
  envId: number,
  to: MoveTarget,
  opts: { ownLocks?: boolean } = {}
): Promise<MovePlan> {
  if (override) return override(envId, to, opts)
  try {
    const plan = buildMovePlan(
      await gatherMovePlanInput(envId, to, { ownLocks: opts.ownLocks === true })
    )
    return withReapplyWarning(plan, envId, to)
  } catch (err) {
    if (err instanceof PlanMoveError)
      throw new MovePlannerError(err.code, err.message, err.statusCode)
    throw err
  }
}

/** A move target as sent (Task 15's check); null when it names nothing usable. */
export function parseMoveTarget(raw: unknown): MoveTarget | null {
  try {
    return checkMoveTarget(raw)
  } catch {
    return null
  }
}

/** The target as sent, or Task 15's own refusal (BAD_TARGET, BAD_POOL …) with its sentence. */
export function checkTarget(raw: unknown): MoveTarget {
  try {
    return checkMoveTarget(raw)
  } catch (err) {
    if (err instanceof PlanMoveError)
      throw new MovePlannerError(err.code, err.message, err.statusCode)
    throw err
  }
}

export const MOVE_STEP_KEYS: readonly MoveStepKey[] = [
  'check',
  'files_warm',
  'maintenance_on',
  'wait_idle',
  'files_delta',
  'deploy_target',
  'place_on_target',
  'target_ready',
  'files_full',
  'route',
  'verify',
  'release',
  'retire_source',
  'done'
]

/**
 * P6-18 #3: a route action on a Hub-deployed (docker-mode) shared stack re-applies that stack:
 * swarm rolls every replica, so every app on it restarts through a rolling update. Added after
 * the plan is built (not part of plan_hash: it follows from the route actions, which are).
 */
export async function withReapplyWarning(
  plan: MovePlan,
  envId: number,
  to: MoveTarget
): Promise<MovePlan> {
  const env = (await db('nivaro_hub_environments').where({ id: envId }).first('placement_id')) as
    | { placement_id: number | null }
    | undefined
  const from = env?.placement_id ? await getPlacement(env.placement_id) : null
  const sides: Array<{ side: 'source' | 'target'; sharedId: number | null }> = [
    { side: 'source', sharedId: from?.kind === 'shared' ? from.shared_deployment_id : null },
    { side: 'target', sharedId: to.kind === 'shared' ? to.shared_id : null }
  ]
  const keys: string[] = []
  for (const x of sides) {
    if (x.sharedId === null) continue
    if (!plan.route.some((a) => a.side === x.side && (a.op === 'add_host' || a.op === 'drop_host')))
      continue
    const shared = await getShared(x.sharedId)
    if (shared?.mode === 'docker') keys.push(shared.key)
  }
  if (!keys.length) return plan
  return {
    ...plan,
    warnings: [
      ...plan.warnings,
      {
        code: 'STACK_REAPPLY_ALL' as MovePlan['warnings'][number]['code'],
        text: `Changing the names of ${keys.join(' and ')} re-applies the whole shared stack: swarm restarts its replicas one by one, and every app on it with them.`
      }
    ]
  }
}
