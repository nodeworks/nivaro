import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { clearAutoFailures } from './auto-transition-memory.js'
import { findRecordInstance } from './branch-instances.js'
import { withChainStep } from './chain.js'
import { assertInstanceAccess, InstanceAccessError } from './instance-guard.js'
import {
  type GateInstance,
  type GateTransition,
  manualTransitionRefusal
} from './manual-transition-gate.js'
import { claimTransition, TransitionDuplicateError } from './transition-guard.js'
import {
  runsInBackground,
  type TransitionRunHandle,
  TransitionRunningError,
  takeTransitionRun
} from './transition-runs.js'
import { TransitionBlockedError } from './workflow-actions.js'
import {
  applyTransition,
  type DeferredTransitionEvent,
  flushChainEvents,
  resolveFriendlyId,
  runAutoTransitions
} from './workflow-transitions.js'

interface WorkflowInstance {
  id: string
  template: string
  collection: string
  item: string
  current_state: string | null
  started_at: Date
  completed_at: Date | null
}

interface WorkflowState {
  id: string
  template: string
  key: string
  label: string
  color: string | null
  is_initial: boolean
  is_terminal: boolean
  lock_record: boolean
  sort: number
  skip_criteria: string | null
  skip_if_no_owners: boolean
  stage_visibility: string
  owners_not_required?: boolean | number
  description: string | null
  external_label?: string | null
}

interface WorkflowTransition {
  id: string
  template: string
  label: string
  actions?: string | null
}

function parseJson(val: string | null | undefined): unknown {
  if (!val) return null
  try {
    return JSON.parse(val)
  } catch {
    return null
  }
}

function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (val === 1 || val === '1' || val === 'true') return true
  return false
}

/** The state as the pipeline routes answer it — the one shape both the route
 *  and the Teams card action return. */
export function formatWorkflowState(s: WorkflowState) {
  return {
    ...s,
    is_initial: coerceBool(s.is_initial),
    is_terminal: coerceBool(s.is_terminal),
    lock_record: coerceBool(s.lock_record),
    skip_if_no_owners: coerceBool(s.skip_if_no_owners),
    skip_criteria: parseJson(s.skip_criteria),
    stage_visibility: s.stage_visibility ?? 'always',
    owners_not_required: s.owners_not_required === true || s.owners_not_required === 1
  }
}

export interface RecordTransitionOptions {
  user: User
  isAdmin: boolean
  collection: string
  item: string
  transitionId: string
  comment?: string | null
  reviewed?: boolean
  log: FastifyBaseLogger
  /** The HTTP request when there is one — the activity row's caller columns
   *  (ip, user agent, auth method) and the person-held edit lock read it. */
  req?: FastifyRequest
  /** The caller saw "<name> is editing this record" and moves it anyway. */
  lockAck?: boolean
  /** No HTTP request, but a person pressed it (a Teams card): the edit lock
   *  binds them like a session. */
  lockAsPerson?: boolean
  /** The caller can take "it is running" for an answer. Only then, and only
   *  for a transition marked to run in the background, the move is answered
   *  202 once every check has passed and finishes on the background pool.
   *  Every other caller waits for it as before. */
  acceptPending?: boolean
}

/** Who the edit lock judges for this move: the request, or — for a person
 *  acting without one (Teams) — the user as a signed-in person. Null = not judged. */
export function lockActorFor(opts: {
  user: User
  req?: Pick<FastifyRequest, 'user' | 'authMethod'>
  lockAsPerson?: boolean
}): Pick<FastifyRequest, 'user' | 'authMethod'> | null {
  if (opts.req) return opts.req
  if (opts.lockAsPerson && opts.user?.id)
    return { user: opts.user, authMethod: 'session' } as Pick<FastifyRequest, 'user' | 'authMethod'>
  return null
}

/** Whether a body flag says yes (JSON true, "1", "true"). */
export function lockAckFrom(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

/**
 * The refusal a move gets while ANOTHER person holds a live edit lock on the
 * record (army 11 f4 M4: Submit ran while Bernard was typing, and his unsaved
 * change could no longer be saved, with no word to either of them). The
 * mover is told who is editing and may move it anyway (`lock_ack`); the
 * editor is then told (lockMovedNotice). Integrations and connected apps hold
 * no locks and are never refused (item-lock-guard.ts LOCK_BOUND_AUTH).
 */
export function lockedMoveRefusal(
  holder: { locked_by: string; locked_by_name: string | null },
  transitionLabel: string
): { status: 409; body: Record<string, unknown> } {
  const who = holder.locked_by_name ?? 'Someone else'
  return {
    status: 409,
    body: {
      error: `${who} is editing this record right now. If you ${transitionLabel} now, what they have not saved yet can no longer be saved. Ask them to finish first, or ${transitionLabel} anyway.`,
      code: 'RECORD_LOCKED',
      locked_by: holder.locked_by,
      locked_by_name: holder.locked_by_name,
      move_anyway: true
    }
  }
}

/**
 * Background moves this process is finishing right now. They borrow from the
 * background pool, which scheduled jobs and imports share: past the cap, a
 * caller waits for its move as it always did instead of adding to it.
 */
let backgroundMoves = 0
export const BACKGROUND_MOVES_MAX = 8

/** Run one manual transition on a record as `user`. The body of
 *  POST /pipelines/instance/:collection/:item/transition, moved here so the
 *  Teams card actions run the very same gate chain. */
export async function runRecordTransition(
  opts: RecordTransitionOptions
): Promise<{ status: number; body: unknown }> {
  const { user, isAdmin, collection, item, log, req } = opts
  const body = { transition_id: opts.transitionId, comment: opts.comment, reviewed: opts.reviewed }

  // Moving a pipeline changes the record: update permission + visibility.
  try {
    await assertInstanceAccess(user, isAdmin, collection, item)
  } catch (err) {
    if (err instanceof InstanceAccessError)
      return { status: err.statusCode, body: { error: err.message } }
    throw err
  }

  const instance = await findRecordInstance<WorkflowInstance>(collection, item)
  if (!instance) return { status: 404, body: { error: 'No pipeline instance for this item' } }

  const transition = await db<WorkflowTransition>('nivaro_workflow_transitions')
    .where({ id: body.transition_id, template: instance.template })
    .first()
  if (!transition) return { status: 404, body: { error: 'Transition not found' } }

  // The shared manual-transition gate chain: completed/escape, from-state,
  // auto refusal, roles, owner-only, required note, requirements and
  // condition rules — the same chain branch and bulk transitions run.
  const refusal = await manualTransitionRefusal({
    user,
    isAdmin,
    collection,
    item,
    instance: instance as unknown as GateInstance,
    transition: transition as unknown as GateTransition,
    comment: body.comment ?? null,
    reviewed: body.reviewed === true,
    log
  })
  if (refusal) return { status: refusal.status, body: refusal.body }

  // Someone else is editing it right now: ask before moving it out from under them.
  let displaced: { locked_by: string; locked_by_name: string | null } | null = null
  const lockActor = lockActorFor({ user, req, lockAsPerson: opts.lockAsPerson })
  if (lockActor) {
    const { editLockRefusal } = await import('./item-lock-guard.js')
    const held = await editLockRefusal(lockActor, collection, item).catch(() => null)
    if (held) {
      if (!opts.lockAck) return lockedMoveRefusal(held.body, transition.label)
      displaced = { locked_by: held.body.locked_by, locked_by_name: held.body.locked_by_name }
    }
  }

  // A transition marked "runs in the background" (transition-runs.ts): this
  // record's run is held from here until the move has ended, so everyone who
  // has the record open sees it running and a second run by anyone is refused.
  // Every check above has already answered as it always does. A transition
  // without the mark takes no run and goes on exactly as before.
  let run: TransitionRunHandle | null = null
  const pending = opts.acceptPending === true && backgroundMoves < BACKGROUND_MOVES_MAX
  if (runsInBackground(transition.actions)) {
    try {
      run = await takeTransitionRun({
        instance,
        transition,
        userId: user?.id ?? null,
        mode: pending ? 'background' : 'inline',
        recordLabel: pending ? await resolveFriendlyId(collection, item).catch(() => null) : null
      })
    } catch (err) {
      if (err instanceof TransitionRunningError) {
        return { status: 409, body: { error: err.message, code: err.code, run: err.run } }
      }
      throw err
    }
  }

  // Shared mutation chain (instance update, history, materialized queue
  // sync, state_field mirror incl. state_field_map, transition actions).
  // A blocking action failure (e.g. an ERP submission) aborts BEFORE any
  // mutation — the record stays in its current state and the client gets
  // the error to display.
  // Double-fire guard: the twin of a request already running (or just
  // finished) is refused here, after every gate and before any mutation.
  let claim: Awaited<ReturnType<typeof claimTransition>>
  try {
    claim = await claimTransition({
      instanceId: String(instance.id),
      transitionId: String(transition.id),
      label: transition.label
    })
  } catch (err) {
    await run?.cancel()
    if (err instanceof TransitionDuplicateError) {
      return { status: 409, body: { error: err.message, code: err.code, first: err.first } }
    }
    throw err
  }

  // #1217: a person acting on the record is the retry the engine was
  // waiting for — held auto transitions on it may fire again.
  await clearAutoFailures({ instanceId: String(instance.id) })

  // The move itself. One body for both ways of running it, so a background
  // run is attributed (history user, origin, activity with the caller's
  // request) and chained exactly as the run a person waits for.
  const finish = () => finishRecordTransition({ opts, instance, transition, claim, run, displaced })
  if (run && pending) {
    // Answer now. The actions (the partner call) and the state change run on
    // the background pool; the record moves only if they succeed, and a
    // refusal is stored and told to this person by the run (its `refused`).
    const held = run
    backgroundMoves++
    void runInBackgroundPool(() =>
      finish()
        .catch((err) => {
          // A refusal thrown rather than answered (a move with nowhere to go)
          // is on the run already; anything else is ours to look at.
          log.error({ err, collection, item, run: held.id }, 'background transition failed')
        })
        .finally(() => {
          backgroundMoves--
        })
    )
    return { status: 202, body: { data: { background: true, run: held.view } } }
  }
  return finish()
}

/**
 * Apply a transition whose every check has passed: the mutation chain, the
 * automatic moves it sets off, the activity row and the notice to an editor
 * the move displaced. Answers what the route answers.
 */
async function finishRecordTransition(a: {
  opts: RecordTransitionOptions
  instance: WorkflowInstance
  transition: WorkflowTransition
  claim: Awaited<ReturnType<typeof claimTransition>>
  run: TransitionRunHandle | null
  displaced: { locked_by: string; locked_by_name: string | null } | null
}): Promise<{ status: number; body: unknown }> {
  const { opts, instance, transition, claim, displaced } = a
  const { user, collection, item, req } = opts
  const body = { comment: opts.comment }

  // This move and any automatic moves it sets off are ONE chain: their
  // events fire together once the chain settles, so people are told only
  // where the record came to rest (army 11 o3 manual Fusion double mail).
  const chainEvents: DeferredTransitionEvent[] = []
  let applied: Awaited<ReturnType<typeof applyTransition>>
  try {
    applied = await applyTransition({
      instance,
      transition: transition as unknown as Parameters<typeof applyTransition>[0]['transition'],
      userId: user?.id ?? null,
      comment: body.comment ?? null,
      source: 'manual',
      deferEvents: chainEvents,
      ...(a.run ? { run: a.run } : {})
    })
  } catch (err) {
    // The move did not happen — an immediate retry must be allowed.
    await claim.release()
    flushChainEvents(chainEvents)
    if (err instanceof TransitionBlockedError) {
      return { status: 422, body: { error: err.message } }
    }
    throw err
  }
  const { updatedInstance, newStateObj, previousState } = applied

  // Chained automation: fire any auto transitions now valid from the new state.
  // They hang under this transition's history row in the event chain.
  try {
    await withChainStep(applied.history_id ? `history:${applied.history_id}` : 'auto', () =>
      runAutoTransitions(collection, item, { deferred: chainEvents })
    )
  } finally {
    flushChainEvents(chainEvents)
  }

  const prevStateObj = previousState
    ? await db<WorkflowState>('nivaro_workflow_states').where({ id: previousState }).first()
    : null
  const fromLabel = prevStateObj?.label ?? previousState ?? 'Start'
  const toLabel = newStateObj?.label ?? 'Unknown'
  const transitionLabel = transition.label
  const userComment = body.comment ? ` — "${body.comment}"` : ''

  await logActivity({
    action: 'pipeline-transition',
    collection,
    item,
    user: user?.id,
    req,
    comment: `${fromLabel} → ${toLabel} via ${transitionLabel}${userComment}`
  })
  if (displaced) await lockMovedNotice({ user, collection, item, toLabel, holder: displaced })
  return {
    status: 200,
    body: {
      data: {
        instance: updatedInstance,
        new_state: newStateObj ? formatWorkflowState(newStateObj as unknown as WorkflowState) : null
      }
    }
  }
}

/**
 * Tell the person whose edit a move overrode (they were editing; the mover
 * chose to go ahead): who moved it, where to, and whether they may still save
 * there. Their own sockets only (`user:<id>`); best effort.
 */
async function lockMovedNotice(a: {
  user: User
  collection: string
  item: string
  toLabel: string
  holder: { locked_by: string }
}): Promise<void> {
  try {
    const { lockHolderVerdict } = await import('./edit-lock.js')
    const verdict = await lockHolderVerdict(a.holder.locked_by, a.collection, a.item).catch(
      () => null
    )
    const byName =
      [a.user.first_name, a.user.last_name].filter(Boolean).join(' ') || a.user.email || 'Someone'
    const { emitToUserRoom } = await import('./user-sync.js')
    emitToUserRoom(a.holder.locked_by, 'lock:moved', {
      collection: a.collection,
      item: String(a.item),
      by_name: byName,
      state_label: a.toLabel,
      still_editable: verdict ? verdict.allowed !== false : true
    })
  } catch {
    /* the move stands; the editor's form still turns read-only from its own re-read */
  }
}
