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
  /**
   * R3-I-3: does the caller still hold the environment's and the shared locks (a strict
   * renewal)? Asked before every undo action; false = stop at once (the run is interrupted, never
   * undoing beside another runner).
   */
  stillHeld: () => Promise<boolean>
  /** R3-I-2: the operator ticked `target_stopped` (the target is stopped by hand). */
  targetStoppedByHand: () => Promise<boolean>
}

export interface UndoResult {
  failed: MoveStepKey[]
  /** Stopped before the end: `halted` (target live, source kept frozen) or `lost` (locks). */
  stopped: 'halted' | 'lost' | null
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
    // R3-I-2: a halted release undo is retried on the next Roll back, never skipped.
    else if (s.key === 'release' && s.state === 'undo_failed') out.push(s.key)
  }
  return out
}

/** Undoes the move's completed steps in reverse. Answers the steps whose undo failed. */
export async function undoMove(ctx: UndoContext): Promise<UndoResult> {
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
    if (!(await ctx.stillHeld())) return { failed, stopped: 'lost' }
    try {
      if (key === 'release') {
        // R2-I-2 / R3-I-1 / R3-I-2: the target may already be lifted. It must be proven frozen
        // again, or stopped (removed / retired), or the operator must say it is stopped
        // (target_stopped) — only then does the environment row go back to the source and the
        // rollback go on. Otherwise it halts with the source frozen: never two writers.
        let stopped = false
        try {
          await ctx.ops.targetMaintenance(true)
          if (ctx.shared.to !== null) await ctx.ops.waitReplicas(ctx.shared.to)
          stopped = true
        } catch (err) {
          ctx.log(
            `undo: the target did not take its maintenance back (${codeOf(err)}); stopping it instead`,
            'warn'
          )
        }
        if (!stopped && ctx.shared.to === null) {
          try {
            await ctx.ops.removeTarget()
            stopped = true
          } catch (err) {
            ctx.log(`undo: the target could not be stopped (${codeOf(err)})`, 'warn')
          }
        }
        if (!stopped && (await ctx.targetStoppedByHand())) {
          ctx.log('undo: the operator confirmed the target is stopped (target_stopped)')
          stopped = true
        }
        if (!stopped) {
          failed.push(key)
          ctx.log('undo: the target could not be stopped; the source stays in maintenance', 'error')
          await mark(key, 'undo_failed', 'the target could not be stopped (HALTED_TARGET_LIVE)')
          return { failed, stopped: 'halted' }
        }
        const prev = ctx.move.steps.release_prev
        if (prev) await restoreEnvRow(ctx.move.environment_id, prev)
      } else if (key === 'route') {
        const route = ctx.move.plan?.route ?? []
        const applied = [...(steps.routed ?? [])].reverse() // newest intent first (record order)
        for (const i of applied) {
          const a = route[i]
          if (!(await ctx.stillHeld())) return { failed, stopped: 'lost' }
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
        try {
          await ctx.ops.removeTarget()
        } catch (err) {
          // The operator already stopped it by hand (target_stopped, R3-I-2): nothing is left.
          if (!(await ctx.targetStoppedByHand())) throw err
          ctx.log('undo: the target was stopped by hand (target_stopped)')
        } finally {
          // R2-M-2 / R3-M-2: the environment's own extension pins, as they were before the target
          // deploy — put back even when the removal failed.
          if (ctx.move.steps.prev_extension_pins !== undefined)
            await restoreExtensionPins(ctx.move.environment_id, ctx.move.steps.prev_extension_pins)
        }
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
      if (key === 'release') return { failed, stopped: 'halted' }
    }
  }
  return { failed, stopped: null }
}
