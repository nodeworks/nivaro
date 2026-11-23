import { type MoveOps, MoveStepError } from './ops.js'
import type { MoveStepKey, RouteAction } from './plan-port.js'
import {
  type HubMoveRow,
  type MoveSteps,
  restoreEnvRow,
  restoreExtensionPins,
  setEnvStatus
} from './rows.js'

/**
 * ROLLBACK INVARIANTS (ruling P6-26, binding). A move's rollback never leaves two writers on the
 * app's database, and the source leaves maintenance last.
 *
 * Rule 1 — a freeze is PROVEN, per target kind (only a target `release` may have lifted):
 *   - shared target: the env's listed status is written `maintenance`, then waitReplicas until
 *     every replica seen holds THAT list (an empty sighting set = wait, never done). A refresh of
 *     a list that still says `active` is not a freeze.
 *   - dedicated Docker target: hub-link maintenance on, on the target's own address, read back.
 *   - GitLab target: the same, or a retire read back.
 *   The env row's other fields (placement, pin, hub_managed) go back only after the proof.
 *   Before `release` ran, the target is frozen by construction (Docker boots in strict
 *   maintenance, a GitLab target is set right after its deploy or the deploy failed, a shared
 *   target lists a placed app as maintenance) and is not frozen again.
 *
 * Rule 2 — the undo order is fixed, whatever order the steps ran in:
 *   1. freeze the target, proven (Rule 1);
 *   2. undo the TARGET-side route actions without ever applying the target app's own stack again
 *      (a dedicated target's intents are dropped: its stack goes in 3; a shared target's explicit
 *      name is dropped from that live deployment's names);
 *   3. stop / remove the target (a Docker stack removed with its volumes kept; a GitLab target
 *      retired; a shared target unplaced and every replica proven to hold the list without it).
 *      A stopped, removed or operator-confirmed-stopped target is never applied again; the hub
 *      link's maintenance-on (step 1) also drops the move's boot-maintenance done marker in the
 *      target's Redis, so a stack that ever came back would boot in maintenance;
 *   4. undo the SOURCE-side route actions (the source gets its names back);
 *   5. lift the source: its prior status, sourceMaintenance(false) with the move id.
 *
 * Rule 3 — halt: when 1, 2 or 3 cannot be proven (and the operator has not ticked
 * `target_stopped`), the rollback halts and leaves the source as it is; the caller ends the move
 * `interrupted` HALTED_TARGET_LIVE with an instruction the operator can carry out for that target
 * kind, worded from the source's real state (`sourceFrozen`). A source that was never frozen
 * means the target was last proven in maintenance (Docker boot maintenance, a GitLab target set
 * after its deploy; one whose boot maintenance is not proven froze the source for its deploy,
 * R5-I-1), so the source is the one writer. Roll back again retries from the step that halted
 * (never skips it).
 *
 * Also: before every action the run re-checks it still holds its locks (R3-I-3); each finished
 * phase is written before the next, so an interrupted rollback resumes without redoing a phase.
 */

export const UNDOABLE: readonly MoveStepKey[] = [
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
  /** Writes the step list (after every phase). */
  save: (steps: MoveSteps) => Promise<void>
  /** R3-I-3: the caller still holds its locks (strict renewal); false = stop at once. */
  stillHeld: () => Promise<boolean>
  /** R3-I-2: the operator ticked `target_stopped` (no process of this app runs at the target). */
  targetStoppedByHand: () => Promise<boolean>
}

export interface UndoResult {
  failed: MoveStepKey[]
  /** Stopped before the end: `halted` (Rule 3, source left as it is) or `lost` (locks). */
  stopped: 'halted' | 'lost' | null
  /** At a halt: is the source in maintenance (maintenance_on, or the R5-I-1 deploy freeze)? */
  sourceFrozen: boolean
}

function codeOf(err: unknown): string {
  if (err instanceof MoveStepError) return err.code
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : 'ERROR'
}

/** States of a step that ran and still needs its undo (a halted undo is retried, Rule 3). */
const NEEDS_UNDO = new Set(['done', 'failed', 'running', 'undo_failed'])

/** The undoable steps that ran, in Rule 2's order (for display and tests). */
export function stepsToUndo(steps: MoveSteps): MoveStepKey[] {
  const ran = (k: MoveStepKey) => steps.list.some((s) => s.key === k && NEEDS_UNDO.has(s.state))
  return (['release', 'route', 'deploy_target', 'place_on_target', 'maintenance_on'] as const)
    .filter((k) => UNDOABLE.includes(k))
    .filter(ran)
}

/** Undoes a move in Rule 2's order. Answers the undos that failed and why it stopped early. */
export async function undoMove(ctx: UndoContext): Promise<UndoResult> {
  const steps: MoveSteps = structuredClone(ctx.move.steps)
  const failed: MoveStepKey[] = []
  const state = (k: MoveStepKey) => steps.list.find((s) => s.key === k)?.state
  const ran = (k: MoveStepKey) => NEEDS_UNDO.has(String(state(k)))
  const mark = async (key: MoveStepKey, to: 'undone' | 'undo_failed', note?: string) => {
    for (const s of steps.list)
      if (s.key === key) {
        s.state = to
        s.finished_at = new Date().toISOString()
        if (note) s.note = note
      }
    await ctx.save(steps)
  }
  const sourceFrozen = () => ran('maintenance_on') || steps.boot_freeze === 'on'
  const halt = async (key: MoveStepKey, why: string): Promise<UndoResult> => {
    failed.push(key)
    const frozen = sourceFrozen()
    ctx.log(
      `undo: ${why}; ${frozen ? 'the source stays in maintenance' : 'the source keeps serving'} (HALTED_TARGET_LIVE)`,
      'error'
    )
    await mark(key, 'undo_failed', `${why} (HALTED_TARGET_LIVE)`)
    return { failed, stopped: 'halted', sourceFrozen: frozen }
  }
  const lost = (): UndoResult => ({ failed, stopped: 'lost', sourceFrozen: sourceFrozen() })
  const sharedTarget = ctx.shared.to !== null
  const route = ctx.move.plan?.route ?? []
  /** Route intents of one side, newest first (record order). */
  const intents = (side: RouteAction['side']) =>
    [...(steps.routed ?? [])].reverse().filter((i) => route[i]?.side === side)
  const dropIntent = async (i: number) => {
    steps.routed = (steps.routed ?? []).filter((x) => x !== i)
    steps.route_done = (steps.route_done ?? []).filter((x) => x !== i)
    await ctx.save(steps)
  }

  // ── 1. freeze the target, proven (only once release may have lifted it) ────────────────────
  if (ran('release')) {
    if (!(await ctx.stillHeld())) return lost()
    let proven = false
    try {
      if (sharedTarget) {
        // The listed status first, then every replica proven to hold that list.
        await setEnvStatus(ctx.move.environment_id, 'maintenance')
        await ctx.ops.targetMaintenance(true) // a list refresh kick
        await ctx.ops.waitReplicas(ctx.shared.to as number)
      } else {
        await ctx.ops.freezeTarget()
      }
      proven = true
    } catch (err) {
      ctx.log(`undo: the target could not be proven frozen (${codeOf(err)})`, 'warn')
    }
    if (!proven && !sharedTarget) {
      // A dedicated target that cannot be frozen is stopped instead (removed / retired).
      if (!(await ctx.stillHeld())) return lost()
      try {
        await ctx.ops.removeTarget()
        proven = true
      } catch (err) {
        ctx.log(`undo: the target could not be stopped either (${codeOf(err)})`, 'warn')
      }
    }
    if (!proven && (await ctx.targetStoppedByHand())) {
      ctx.log('undo: the operator confirmed no process of this app runs at the target')
      proven = true
    }
    if (!proven) return halt('release', 'the target could not be proven frozen or stopped')
    const prev = ctx.move.steps.release_prev
    if (prev)
      await restoreEnvRow(ctx.move.environment_id, {
        ...prev,
        // A shared target was frozen through the env's status: it stays `maintenance` until the
        // source is lifted (step 5 writes the status from before the move).
        status: 'maintenance'
      })
    ctx.log('undo: the target is frozen; the environment row is back on the source')
    await mark('release', 'undone')
  }

  // ── 2. target-side route actions, never applying the target app's stack again ──────────────
  for (const i of intents('target')) {
    if (!(await ctx.stillHeld())) return lost()
    const a = route[i]
    if (a && sharedTarget) {
      try {
        await ctx.ops.unroute(a)
      } catch (err) {
        return halt(
          'route',
          `the target's route ${a.op} ${a.host ?? ''} could not be undone (${codeOf(err)})`
        )
      }
    }
    // A dedicated target's own stack is removed in step 3; its intent is only dropped here.
    if (a) ctx.log(`undo: target ${a.op}${a.host ? ` ${a.host}` : ''} undone`)
    await dropIntent(i)
  }

  // ── 3. stop / remove the target ────────────────────────────────────────────────────────────
  if (ran('deploy_target')) {
    if (!(await ctx.stillHeld())) return lost()
    let stopped = false
    try {
      await ctx.ops.removeTarget()
      stopped = true
    } catch (err) {
      if (await ctx.targetStoppedByHand()) {
        ctx.log('undo: the target was stopped by hand (target_stopped)')
        stopped = true
      } else ctx.log(`undo: the target could not be stopped (${codeOf(err)})`, 'warn')
    } finally {
      // R2-M-2 / R3-M-2: the environment's own extension pins, as before the target deploy.
      if (ctx.move.steps.prev_extension_pins !== undefined)
        await restoreExtensionPins(ctx.move.environment_id, ctx.move.steps.prev_extension_pins)
    }
    if (!stopped) return halt('deploy_target', 'the target stack could not be stopped')
    ctx.log('undo: target stack undone')
    await mark('deploy_target', 'undone')
  }
  if (ran('place_on_target')) {
    if (!(await ctx.stillHeld())) return lost()
    let gone = false
    try {
      await ctx.ops.unplace()
      if (sharedTarget) await ctx.ops.waitReplicas(ctx.shared.to as number)
      gone = true
    } catch (err) {
      if (await ctx.targetStoppedByHand()) gone = true
      else ctx.log(`undo: not every replica of the target dropped the app (${codeOf(err)})`, 'warn')
    }
    if (!gone)
      return halt('place_on_target', 'the shared target could not be proven to drop the app')
    ctx.log('undo: placement on the target undone')
    await mark('place_on_target', 'undone')
  }

  // ── 4. source-side route actions ───────────────────────────────────────────────────────────
  let sourceRouteFailed = false
  for (const i of intents('source')) {
    if (!(await ctx.stillHeld())) return lost()
    const a = route[i]
    try {
      if (a) {
        await ctx.ops.unroute(a)
        ctx.log(`undo: source ${a.op}${a.host ? ` ${a.host}` : ''} undone`)
      }
      await dropIntent(i)
    } catch (err) {
      sourceRouteFailed = true
      ctx.log(`undo: the source's route could not be put back (${codeOf(err)})`, 'error')
    }
  }
  if (ran('route')) {
    if (sourceRouteFailed) {
      failed.push('route')
      await mark('route', 'undo_failed', 'the source route could not be put back')
    } else await mark('route', 'undone')
  }

  // ── 5. lift the source ─────────────────────────────────────────────────────────────────────
  if (ran('maintenance_on') || steps.boot_freeze === 'on') {
    if (!(await ctx.stillHeld())) return lost()
    try {
      if (ctx.move.prior_status) await setEnvStatus(ctx.move.environment_id, ctx.move.prior_status)
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
      ctx.log('undo: maintenance at the source undone')
      if (steps.boot_freeze === 'on') {
        steps.boot_freeze = 'lifted'
        await ctx.save(steps)
      }
      if (ran('maintenance_on')) await mark('maintenance_on', 'undone')
    } catch (err) {
      failed.push('maintenance_on')
      ctx.log(`undo: the source's maintenance could not be lifted (${codeOf(err)})`, 'error')
      if (ran('maintenance_on'))
        await mark('maintenance_on', 'undo_failed', `could not be undone (${codeOf(err)})`)
    }
  }
  return { failed, stopped: null, sourceFrozen: false }
}
