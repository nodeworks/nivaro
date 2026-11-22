import { type MoveOps, MoveStepError } from './ops.js'
import type { MoveStepKey } from './plan-port.js'
import {
  type HubMoveRow,
  type MoveSteps,
  restoreEnvRow,
  restoreExtensionPins,
  setEnvStatus
} from './rows.js'

/**
 * Nivaro Hub phase 6, Task 16: a move's rollback — the steps it completed, undone in reverse.
 *
 *   release          → (running/failed only: a done release is never rolled back) the target is
 *                      frozen again FIRST — maintenance on, else removed / retired; if it cannot
 *                      be stopped the rollback stops and the source stays frozen — and the
 *                      environment row goes back to the source (steps.release_prev)
 *   route            → unroute, each route action recorded as an intent, in reverse (steps.routed:
 *                      written before each apply, so an apply that never converged is undone too;
 *                      every unroute is idempotent)
 *   place_on_target  → unplace (the target's list drops the app; placed_at cleared)
 *   deploy_target    → removeTarget (a Docker stack removed with its volumes kept; a GitLab target
 *                      retired over its hub link — the Hub cannot stop its pipeline)
 *   maintenance_on   → the environment's prior status, then sourceMaintenance(false) (a dedicated
 *                      source gets {on:false, move_id}, which also releases a boot maintenance),
 *                      then, for a shared source, every replica holds the list again (best effort)
 * Every other step leaves nothing to undo: copied files stay, a check changed nothing, a ready
 * target is removed with its stack. The step that FAILED is undone too (it may have half
 * happened: maintenance set before the call errored, one of two route actions applied …); a step
 * that never started is not.
 *
 * Only a move before `release` is ever rolled back. The rollback is resumable: each undone step is
 * written (state `undone`) before the next, so an interrupted rollback continues where it stopped
 * and never undoes a step twice. An undo that fails is `undo_failed` and the rest still run; the
 * caller ends the move `failed` naming them (never `rolled_back`).
 */

export const UNDOABLE: readonly MoveStepKey[] = [
  // Only ever running / failed here (a done release is never rolled back): R2-I-2.
  'release',
  'route',
  'place_on_target',
  'deploy_target',
  'maintenance_on'
]

export interface UndoContext {
  /** The move as stored now. */
  move: HubMoveRow
  ops: MoveOps
  /** Shared deployment ids of the two sides (null for a dedicated side). */
  shared: { from: number | null; to: number | null }
  log: (line: string, level?: 'info' | 'warn' | 'error') => void
  /** Writes the step list (after every undone step). */
  save: (steps: MoveSteps) => Promise<void>
}

const LABEL: Record<string, string> = {
  release: 'release',
  route: 'route',
  place_on_target: 'placement on the target',
  deploy_target: 'target stack',
  maintenance_on: 'maintenance at the source'
}

function codeOf(err: unknown): string {
  if (err instanceof MoveStepError) return err.code
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : 'ERROR'
}

/** The steps to undo, latest first: done ones, and the one that failed or was running. */
export function stepsToUndo(steps: MoveSteps): MoveStepKey[] {
  const out: MoveStepKey[] = []
  for (const s of [...steps.list].reverse()) {
    if (!UNDOABLE.includes(s.key)) continue
    if (s.state === 'done' || s.state === 'failed' || s.state === 'running') out.push(s.key)
  }
  return out
}

/** Undoes the move's completed steps in reverse. Answers the steps whose undo failed. */
export async function undoMove(
  ctx: UndoContext
): Promise<{ failed: MoveStepKey[]; aborted: boolean }> {
  const steps: MoveSteps = structuredClone(ctx.move.steps)
  const failed: MoveStepKey[] = []
  const mark = async (key: MoveStepKey, state: 'undone' | 'undo_failed', note?: string) => {
    for (const s of steps.list)
      if (s.key === key) {
        s.state = state
        s.finished_at = new Date().toISOString()
        if (note) s.note = note
      }
    await ctx.save(steps)
  }

  for (const key of stepsToUndo(steps)) {
    try {
      if (key === 'release') {
        // R2-I-2: the target may already be lifted. It is frozen again FIRST (or removed /
        // retired when it cannot be), and the environment row goes back to the source. If the
        // target cannot be stopped, the rollback stops here: the source stays frozen, so there
        // is never a second writer (the person decides).
        const prev = ctx.move.steps.release_prev
        if (prev) await restoreEnvRow(ctx.move.environment_id, prev)
        let frozen = false
        try {
          await ctx.ops.targetMaintenance(true)
          if (ctx.shared.to !== null) await ctx.ops.waitReplicas(ctx.shared.to)
          frozen = true
        } catch (err) {
          ctx.log(
            `undo: the target did not take its maintenance back (${codeOf(err)}); removing it instead`,
            'warn'
          )
        }
        if (!frozen && ctx.shared.to === null) {
          await ctx.ops.removeTarget()
          frozen = true
        }
        if (!frozen) {
          failed.push(key)
          ctx.log('undo: the target could not be stopped; the source stays in maintenance', 'error')
          await mark(key, 'undo_failed', 'the target could not be stopped (TARGET_NOT_STOPPED)')
          return { failed, aborted: true }
        }
      } else if (key === 'route') {
        const route = ctx.move.plan?.route ?? []
        const applied = [...(steps.routed ?? [])].reverse() // newest intent first (record order)
        for (const i of applied) {
          const a = route[i]
          if (a) {
            await ctx.ops.unroute(a)
            ctx.log(`undo: ${a.side} ${a.op}${a.host ? ` ${a.host}` : ''} undone`)
          }
          steps.routed = (steps.routed ?? []).filter((x) => x !== i)
          steps.route_done = (steps.route_done ?? []).filter((x) => x !== i)
          await ctx.save(steps)
        }
      } else if (key === 'place_on_target') {
        await ctx.ops.unplace()
      } else if (key === 'deploy_target') {
        await ctx.ops.removeTarget()
        // R2-M-2: the environment's own extension pins, as they were before the target deploy.
        if (ctx.move.steps.prev_extension_pins !== undefined)
          await restoreExtensionPins(ctx.move.environment_id, ctx.move.steps.prev_extension_pins)
      } else if (key === 'maintenance_on') {
        if (ctx.move.prior_status)
          await setEnvStatus(ctx.move.environment_id, ctx.move.prior_status)
        await ctx.ops.sourceMaintenance(false)
        if (ctx.shared.from !== null) {
          try {
            await ctx.ops.waitReplicas(ctx.shared.from)
          } catch (err) {
            // The list says it; a replica that has not read it yet does within 30 s.
            ctx.log(
              `undo: not every replica of the source has the lifted maintenance yet (${codeOf(err)})`,
              'warn'
            )
          }
        }
      }
      ctx.log(`undo: ${LABEL[key] ?? key} undone`)
      await mark(key, 'undone')
    } catch (err) {
      failed.push(key)
      ctx.log(`undo: the ${LABEL[key] ?? key} could not be undone (${codeOf(err)})`, 'error')
      await mark(key, 'undo_failed', `could not be undone (${codeOf(err)})`)
      // Never bring the source back while the target could still write.
      if (key === 'release') return { failed, aborted: true }
    }
  }
  return { failed, aborted: false }
}
