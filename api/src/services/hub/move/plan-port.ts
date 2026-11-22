/**
 * Nivaro Hub phase 6, Task 16: the move runner's port onto Task 15's planner.
 *
 * Task 15 (built in parallel, ruling P6-12) owns `services/hub/move/types.ts`, `plan.ts`,
 * `gather.ts` and `route-actions.ts`. Until it merges, the run builds against the plan's stated
 * interfaces through this file:
 *  - the types below are the plan's (Task 15 "Produces") word for word, plus the `manual` step
 *    variant of preflight B8 (the runner never assumes an order: it runs `plan.steps` as listed);
 *  - `planMove(envId, to)` = `buildMovePlan(await gatherMovePlanInput(envId, to))`, loaded at call
 *    time from `./gather.js` and `./plan.js` (named by a variable so this file typechecks while
 *    those do not exist yet). Without them a plan answers 503 MOVE_PLANNER_MISSING.
 *
 * MERGE (with Task 15): replace the types with `export type { … } from './types.js'` and the
 * loader with static imports of `gatherMovePlanInput` / `buildMovePlan`; nothing else changes.
 */

import type { SharedDeployment } from '../shared/store.js'

export type MoveKind = 'to_shared' | 'to_dedicated' | 'between_shared'

export type MoveStepKey =
  | 'check'
  | 'files_warm'
  | 'maintenance_on'
  | 'wait_idle'
  | 'files_delta'
  | 'deploy_target'
  | 'place_on_target'
  | 'target_ready'
  | 'files_full'
  | 'route'
  | 'verify'
  | 'release'
  | 'retire_source'
  | 'done'

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

export type RouteAction = {
  side: 'source' | 'target'
  op: 'drop_host' | 'add_host' | 'remove_stack' | 'apply_stack'
  host?: string
}

export type MoveTarget =
  | { kind: 'shared'; shared_id: number; pool_max?: number }
  | { kind: 'dedicated'; placement_id: number }

export interface MovePlanItem<C extends string = string> {
  code: C
  text: string
}

export interface MoveChecklistItem {
  id: string
  text: string
  required: boolean
}

export interface MovePlan {
  kind: MoveKind
  routing: 'automatic' | 'manual'
  steps: MoveStepKey[]
  route: RouteAction[]
  manual_request: string | null
  version: string
  hostnames: string[]
  files: { count: number; bytes: number }
  blockers: MovePlanItem[]
  warnings: MovePlanItem[]
  checklist: MoveChecklistItem[]
  plan_hash: string
}

/** What a side of a move is (Task 15 PlacementSide), as far as the runner needs it. */
export type SideKind = 'shared' | 'docker' | 'gitlab'
export type SharedSide = { kind: 'shared'; shared: SharedDeployment }

export type MovePlanner = (envId: number, to: MoveTarget) => Promise<MovePlan>

/** A planner that could not be reached (Task 15 not merged) or failed. */
export class MovePlannerError extends Error {
  code: string
  statusCode: number
  constructor(code: string, message: string, statusCode = 503) {
    super(message)
    this.name = 'MovePlannerError'
    this.code = code
    this.statusCode = statusCode
  }
}

let override: MovePlanner | null = null

/** Tests (and the merge, if it prefers) put a planner in place. null = Task 15's own. */
export function setMovePlanner(fn: MovePlanner | null): void {
  override = fn
}

// Named by variables so this file compiles before Task 15's modules exist.
const GATHER_MODULE = './gather.js'
const PLAN_MODULE = './plan.js'

/** The plan for moving `envId` to `to`, made by Task 15's gather + pure planner. */
export async function planMove(envId: number, to: MoveTarget): Promise<MovePlan> {
  if (override) return override(envId, to)
  let gather: { gatherMovePlanInput?: (e: number, t: MoveTarget) => Promise<unknown> }
  let plan: { buildMovePlan?: (input: unknown) => MovePlan }
  try {
    gather = await import(GATHER_MODULE)
    plan = await import(PLAN_MODULE)
  } catch {
    throw new MovePlannerError(
      'MOVE_PLANNER_MISSING',
      'This Hub cannot plan moves yet (the move planner is not installed).'
    )
  }
  if (typeof gather.gatherMovePlanInput !== 'function' || typeof plan.buildMovePlan !== 'function')
    throw new MovePlannerError(
      'MOVE_PLANNER_MISSING',
      'This Hub cannot plan moves yet (the move planner is not installed).'
    )
  return plan.buildMovePlan(await gather.gatherMovePlanInput(envId, to))
}

/** A move target as sent, checked; null when it names nothing usable. */
export function parseMoveTarget(raw: unknown): MoveTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const b = raw as Record<string, unknown>
  const pos = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : null
  if (b.kind === 'shared') {
    const id = pos(b.shared_id)
    if (id === null) return null
    if (b.pool_max !== undefined && b.pool_max !== null) {
      const p = pos(b.pool_max)
      if (p === null || p > 20) return null
      return { kind: 'shared', shared_id: id, pool_max: p }
    }
    return { kind: 'shared', shared_id: id }
  }
  if (b.kind === 'dedicated') {
    const id = pos(b.placement_id)
    return id === null ? null : { kind: 'dedicated', placement_id: id }
  }
  return null
}

/** The steps a step list may hold, in the runner's terms (unknown keys are refused). */
export function isMoveStepKey(v: unknown): v is MoveStepKey {
  return typeof v === 'string' && (MOVE_STEP_KEYS as readonly string[]).includes(v)
}
