import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { clearAutoFailures } from './auto-transition-memory.js'
import { findRecordInstance } from './branch-instances.js'
import { withChainStep } from './chain.js'
import { chainFields } from './chain-columns.js'
import { assertInstanceAccess, InstanceAccessError } from './instance-guard.js'
import { writeStartHistory } from './instance-start.js'
import { originFields } from './note-authorship.js'
import { parseJson } from './pipeline-engine.js'
import { checkTransitionOwner, TRANSITION_OWNER_REQUIRED } from './record-access.js'
import { claimTransition, TransitionDuplicateError } from './transition-guard.js'
import { evaluateTransitionRequirements } from './transition-requirements.js'
import { TransitionBlockedError } from './workflow-actions.js'
import { evaluateConditionRules, fetchRecordForConditions } from './workflow-conditions.js'
import {
  applyTransition,
  coerceBool,
  resolveTransitionTarget,
  runAutoTransitions,
  type WorkflowInstance,
  type WorkflowState,
  type WorkflowTransition
} from './workflow-transitions.js'

// ─── Shared workflow start/transition mutations (#601) ───────────────────────
// The exact precondition chain the REST endpoints in routes/pipelines.ts apply
// (POST /pipelines/instance/:collection/:item/start and .../transition),
// exposed as service functions so the GraphQL mutations `workflow_start` /
// `workflow_transition` run the SAME gates — from-state validation, auto
// transitions never manually executable, role check, transition requirements,
// condition-rule revalidation — with typed errors carrying HTTP-ish status
// codes for the caller to map. routes/pipelines.ts can delegate to these to
// retire its inline copies.

export class WorkflowMutationError extends Error {
  statusCode: number
  extras?: Record<string, unknown>
  constructor(statusCode: number, message: string, extras?: Record<string, unknown>) {
    super(message)
    this.name = 'WorkflowMutationError'
    this.statusCode = statusCode
    this.extras = extras
  }
}

interface WorkflowBindingRow {
  id: number
  template: string
  collection: string
  state_field: string | null
  state_field_map: string | null
}

export interface WorkflowActor {
  id?: string | null
  role?: string | null
  isAdmin?: boolean
  /** The caller's user row: the start/advance gate reads the record AS them,
   *  and owner-only transitions (#794) judge it (without it a non-admin is
   *  refused an owner-only transition). */
  user?: User | null
}

/** The shared start/advance gate (instance-guard), as a WorkflowMutationError. */
async function guardRecord(actor: WorkflowActor | undefined, collection: string, item: string) {
  try {
    await assertInstanceAccess(actor?.user ?? null, actor?.isAdmin ?? false, collection, item)
  } catch (err) {
    if (err instanceof InstanceAccessError)
      throw new WorkflowMutationError(err.statusCode, err.message)
    throw err
  }
}

/**
 * Start the bound pipeline instance for a record — mirror of the REST start
 * handler: binding lookup, duplicate guard, initial state, skip-criteria
 * advance, state_field mirror, activity log. Returns the created instance.
 */
export async function startWorkflowInstance(opts: {
  collection: string
  item: string
  actor?: WorkflowActor
}): Promise<WorkflowInstance | undefined> {
  const { collection, item } = opts
  await guardRecord(opts.actor, collection, item)

  const binding = (await db('nivaro_workflow_bindings').where({ collection }).first()) as
    | WorkflowBindingRow
    | undefined
  if (!binding) throw new WorkflowMutationError(400, 'No pipeline bound to this collection')

  const existing = (await db<WorkflowInstance>('nivaro_workflow_instances')
    .where({ collection, item })
    .first()) as WorkflowInstance | undefined
  if (existing) throw new WorkflowMutationError(409, 'Pipeline already started for this item')

  const initialState = (await db<WorkflowState>('nivaro_workflow_states')
    .where({ template: binding.template, is_initial: true })
    .first()) as WorkflowState | undefined

  const instanceId = randomUUID()
  const startedAt = new Date()
  await db('nivaro_workflow_instances').insert({
    id: instanceId,
    template: binding.template,
    collection,
    item,
    current_state: initialState?.id ?? null,
    started_at: startedAt,
    completed_at: null
  })
  // #1219: the start is the instance's first history row.
  if (initialState)
    await writeStartHistory({
      instanceId,
      stateId: String(initialState.id),
      userId: opts.actor?.id ?? null,
      timestamp: startedAt
    })

  // Resolve skip criteria — may advance past the initial state
  let finalState: WorkflowState | undefined = initialState
  if (initialState) {
    const resolvedState = await resolveTransitionTarget(
      initialState.id,
      binding.template,
      collection,
      item,
      instanceId,
      db
    )
    const finalStateId = resolvedState?.id ?? initialState.id
    if (finalStateId !== initialState.id) {
      finalState = (resolvedState as unknown as WorkflowState | null) ?? initialState
      await db('nivaro_workflow_instances')
        .where({ id: instanceId })
        .update({
          current_state: finalStateId,
          completed_at: resolvedState && coerceBool(resolvedState.is_terminal) ? new Date() : null
        })
      await db('nivaro_workflow_history').insert({
        ...(await chainFields('nivaro_workflow_history')),
        instance: instanceId,
        transition: null,
        from_state: initialState.id,
        to_state: finalStateId,
        user: opts.actor?.id ?? null,
        comment: 'Auto-advanced via skip criteria',
        timestamp: new Date(),
        ...(await originFields('nivaro_workflow_history', 'machine'))
      })
    }
  }

  // Write the resolved state into the bound state_field when configured
  if (finalState && binding.state_field) {
    try {
      await db(collection)
        .where({ id: item })
        .update({ [binding.state_field]: finalState.key })
    } catch {
      // Collection may not have the field — non-fatal
    }
  }

  const instance = (await db<WorkflowInstance>('nivaro_workflow_instances')
    .where({ id: instanceId })
    .first()) as WorkflowInstance | undefined
  await logActivity({
    action: 'pipeline-start',
    collection,
    item,
    user: opts.actor?.id ?? undefined,
    comment: `Started pipeline${finalState ? ` — initial state: ${finalState.label}` : ''}`
  })
  return instance
}

/**
 * Execute a manual transition with the full REST-endpoint precondition chain,
 * then the shared mutation chain (applyTransition) and chained auto
 * transitions. Throws WorkflowMutationError on any gate failure.
 */
export async function executeWorkflowTransition(opts: {
  collection: string
  item: string
  transitionId: string
  comment?: string | null
  actor: WorkflowActor
}): Promise<{ instance: WorkflowInstance | undefined; newState: WorkflowState | null }> {
  const { collection, item, transitionId } = opts
  if (!transitionId) throw new WorkflowMutationError(400, 'transition_id is required')
  await guardRecord(opts.actor, collection, item)

  const instance = await findRecordInstance<WorkflowInstance>(collection, item)
  if (!instance) throw new WorkflowMutationError(404, 'No pipeline instance for this item')

  if (instance.completed_at) {
    throw new WorkflowMutationError(400, 'Pipeline is already completed')
  }

  const transition = (await db<WorkflowTransition>('nivaro_workflow_transitions')
    .where({ id: transitionId, template: instance.template })
    .first()) as WorkflowTransition | undefined
  if (!transition) throw new WorkflowMutationError(404, 'Transition not found')

  // Valid from the current state?
  const fromOk = transition.from_state === null || transition.from_state === instance.current_state
  if (!fromOk) {
    throw new WorkflowMutationError(400, 'Transition is not valid from the current state')
  }

  // Automatic transitions belong to the engine — never user-executable
  if (coerceBool(transition.auto_trigger)) {
    throw new WorkflowMutationError(400, 'Automatic transitions cannot be executed manually')
  }

  // Role gate
  const isAdmin = opts.actor.isAdmin ?? false
  if (!isAdmin && transition.required_roles) {
    const roles = parseJson(transition.required_roles) as string[] | null
    if (Array.isArray(roles) && roles.length > 0) {
      const userRole = opts.actor.role ?? null
      if (!userRole || !roles.includes(userRole)) {
        throw new WorkflowMutationError(403, 'You do not have permission for this transition')
      }
    }
  }

  // Owner-only (#794): same gate as the REST endpoint — the caller must own
  // the current step (delegation applied); admins exempt.
  if (coerceBool((transition as { require_owner?: unknown }).require_owner) && !isAdmin) {
    if (!opts.actor.user) {
      throw new WorkflowMutationError(
        403,
        'Only the owner of the current step can make this move.',
        {
          code: TRANSITION_OWNER_REQUIRED
        }
      )
    }
    const owner = await checkTransitionOwner({
      user: opts.actor.user,
      isAdmin,
      collection,
      item,
      instanceId: String(instance.id)
    })
    if (!owner.allowed) {
      throw new WorkflowMutationError(403, owner.message, { code: TRANSITION_OWNER_REQUIRED })
    }
  }

  // Data-entry gate: incomplete child-row / record-field requirements block
  // before condition rules — API callers cannot bypass it.
  if (transition.requirements) {
    const blocking = await evaluateTransitionRequirements(
      db,
      transition.requirements,
      item,
      undefined,
      collection
    )
    if (blocking) {
      throw new WorkflowMutationError(422, 'TRANSITION_REQUIREMENTS', { requirements: blocking })
    }
  }

  // Conditional branching guard: re-fetch and revalidate server-side — the
  // caller's view may be stale.
  if (transition.condition_rules) {
    const conditionRecord = await fetchRecordForConditions(collection, item, [
      transition.condition_rules
    ])
    if (!evaluateConditionRules(transition.condition_rules, conditionRecord)) {
      throw new WorkflowMutationError(409, 'Transition conditions not met')
    }
  }

  let claim: Awaited<ReturnType<typeof claimTransition>>
  try {
    claim = await claimTransition({
      instanceId: String(instance.id),
      transitionId: String(transition.id),
      label: transition.label
    })
  } catch (err) {
    if (err instanceof TransitionDuplicateError) {
      throw new WorkflowMutationError(409, err.message, { code: err.code, first: err.first })
    }
    throw err
  }

  // #1217: a person acting on the record is the retry the engine was waiting
  // for — held auto transitions on it may fire again.
  await clearAutoFailures({ instanceId: String(instance.id) })

  let applied: Awaited<ReturnType<typeof applyTransition>>
  try {
    applied = await applyTransition({
      instance,
      transition,
      userId: opts.actor.id ?? null,
      comment: opts.comment ?? null,
      source: 'manual'
    })
  } catch (err) {
    await claim.release()
    if (err instanceof TransitionBlockedError) {
      throw new WorkflowMutationError(422, err.message)
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
    ? ((await db<WorkflowState>('nivaro_workflow_states').where({ id: previousState }).first()) as
        | WorkflowState
        | undefined)
    : null
  const fromLabel = prevStateObj?.label ?? previousState ?? 'Start'
  const toLabel = newStateObj?.label ?? 'Unknown'
  const userComment = opts.comment ? ` — "${opts.comment}"` : ''

  await logActivity({
    action: 'pipeline-transition',
    collection,
    item,
    user: opts.actor.id ?? undefined,
    comment: `${fromLabel} → ${toLabel} via ${transition.label}${userComment}`
  })

  return { instance: updatedInstance, newState: (newStateObj as WorkflowState | null) ?? null }
}
