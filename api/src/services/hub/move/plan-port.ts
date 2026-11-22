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
    return buildMovePlan(await gatherMovePlanInput(envId, to, { ownLocks: opts.ownLocks === true }))
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
