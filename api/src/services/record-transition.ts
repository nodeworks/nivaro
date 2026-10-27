import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
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
import { TransitionBlockedError } from './workflow-actions.js'
import { applyTransition, runAutoTransitions } from './workflow-transitions.js'

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
  /** The HTTP request when there is one — only the activity row's caller
   *  columns (ip, user agent, auth method) read it. */
  req?: FastifyRequest
}

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
    if (err instanceof TransitionDuplicateError) {
      return { status: 409, body: { error: err.message, code: err.code, first: err.first } }
    }
    throw err
  }

  // #1217: a person acting on the record is the retry the engine was
  // waiting for — held auto transitions on it may fire again.
  await clearAutoFailures({ instanceId: String(instance.id) })

  let applied: Awaited<ReturnType<typeof applyTransition>>
  try {
    applied = await applyTransition({
      instance,
      transition: transition as unknown as Parameters<typeof applyTransition>[0]['transition'],
      userId: user?.id ?? null,
      comment: body.comment ?? null,
      source: 'manual'
    })
  } catch (err) {
    // The move did not happen — an immediate retry must be allowed.
    await claim.release()
    if (err instanceof TransitionBlockedError) {
      return { status: 422, body: { error: err.message } }
    }
    throw err
  }
  const { updatedInstance, newStateObj, previousState } = applied

  // Chained automation: fire any auto transitions now valid from the new state.
  // They hang under this transition's history row in the event chain.
  await withChainStep(applied.history_id ? `history:${applied.history_id}` : 'auto', () =>
    runAutoTransitions(collection, item)
  )

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
