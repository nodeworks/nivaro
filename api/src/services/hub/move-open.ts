import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { currentMoveRun } from './move/run-context.js'

/**
 * Nivaro Hub phase 6 (final review, moves I-2 / ruling P6-37): the open move that touches an
 * environment or a shared deployment.
 *
 * An `interrupted` move holds no lock on purpose (its heal frees the dead run's locks so Resume
 * and Roll back can take them), so the lock checks of other actions never see it. The person-
 * facing actions that would change what the move relies on ask here first and refuse 409
 * MOVE_OPEN: a shared upgrade or re-apply, a promotion (plan and start, owners too), Docker Apply
 * now and Restart, an environment PATCH of its placement, stack or names, and place-on-shared.
 *
 * The move's own runner is let through: it runs every step, undo and op inside
 * move/run-context.ts `withMoveRun(moveId)` (FW-4), and a move is never "open" against its own
 * run (`currentMoveRun()` is left out here). Today the runner deploys with lower-level steps
 * (promote-run deployComponentAt, docker/run-step prepareStackSpec, the agent client, its own
 * shared render), not through these entry points; the context keeps it working if it ever does.
 * Another open move still refuses inside a run.
 *
 * Open = running, waiting or interrupted (the same list as move/rows.ts OPEN_MOVE_STATUSES; a
 * test pins that they agree). Touches = the move's environment is one of `envIds`, or its from or
 * to placement is a placement of shared deployment `sharedId`.
 */

const MOVES = 'nivaro_hub_moves'
const PLACEMENTS = 'nivaro_hub_placements'
const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'

export const MOVE_OPEN_STATUSES: readonly string[] = ['running', 'waiting', 'interrupted']

export interface OpenMove {
  id: number
  environment_id: number
  kind: string
  status: string
  from_placement_id: number
  to_placement_id: number
  /** `<app>/<env>` when the rows are there, else `environment <id>`. */
  label: string
}

export interface MoveOpenRefusal {
  code: 'MOVE_OPEN'
  status: 409
  message: string
  move_id: number
}

/**
 * The oldest open move that touches the environment(s) or the shared deployment; null when none.
 * A database without the moves table (an older ledger) has none.
 */
export async function openMoveFor(
  target: { envIds?: number[]; sharedId?: number | null },
  k: Knex = db
): Promise<OpenMove | null> {
  // The move whose own run this is never refuses itself (FW-4 run context).
  const own = currentMoveRun()
  const envIds = (target.envIds ?? []).filter((n) => Number.isInteger(n) && n > 0)
  const sharedId = target.sharedId ?? null
  if (!envIds.length && sharedId == null) return null
  if (!(await k.schema.hasTable(MOVES))) return null
  const placementIds =
    sharedId == null
      ? []
      : (
          (await k(PLACEMENTS).where({ shared_deployment_id: sharedId }).pluck('id')) as Array<
            number | string
          >
        ).map(Number)
  if (!envIds.length && !placementIds.length) return null
  const q0 = k(MOVES).whereIn('status', MOVE_OPEN_STATUSES as string[])
  if (own != null) q0.whereNot({ id: own })
  const row = (await q0
    .where((q) => {
      if (envIds.length) q.orWhereIn('environment_id', envIds)
      if (placementIds.length)
        q.orWhereIn('from_placement_id', placementIds).orWhereIn('to_placement_id', placementIds)
    })
    .orderBy('id', 'asc')
    .first('id', 'environment_id', 'kind', 'status', 'from_placement_id', 'to_placement_id')) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const envId = Number(row.environment_id)
  const env = (await k(ENVS).where({ id: envId }).first('key', 'app_id')) as
    | { key: string; app_id: number }
    | undefined
  const app = env
    ? ((await k(APPS).where({ id: env.app_id }).first('key')) as { key: string } | undefined)
    : undefined
  return {
    id: Number(row.id),
    environment_id: envId,
    kind: String(row.kind),
    status: String(row.status),
    from_placement_id: Number(row.from_placement_id),
    to_placement_id: Number(row.to_placement_id),
    label: env && app ? `${app.key}/${env.key}` : `environment ${envId}`
  }
}

/** The plain sentence a MOVE_OPEN refusal carries (names the move, never a value). */
export function moveOpenMessage(m: OpenMove): string {
  const state = m.status === 'interrupted' ? 'interrupted' : 'under way'
  return `The move of ${m.label} (move ${m.id}) is ${state}: resume it or roll it back first.`
}

/** The refusal for an open move that touches the target, or null when none. */
export async function moveOpenRefusal(
  target: { envIds?: number[]; sharedId?: number | null },
  k: Knex = db
): Promise<MoveOpenRefusal | null> {
  const m = await openMoveFor(target, k)
  return m ? { code: 'MOVE_OPEN', status: 409, message: moveOpenMessage(m), move_id: m.id } : null
}
