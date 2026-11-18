import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { chainFields } from './chain-columns.js'
import { assertInstanceAccess, InstanceAccessError } from './instance-guard.js'
import { writeStartHistory } from './instance-start.js'
import { originFields } from './note-authorship.js'
import { runRecordTransition, serverMoveLog } from './record-transition.js'
import { announceStateMoved } from './state-moved.js'
import { noteViewAsHistory } from './view-as-attribution.js'
import {
  coerceBool,
  resolveTransitionTarget,
  type WorkflowInstance,
  type WorkflowState
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
      noteViewAsHistory({
        instance: instanceId,
        from_state: initialState.id,
        to_state: finalStateId
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
  // S4 (realtime gaps 2026-11-17): the start is a move to the initial step — open records, list
  // rows and materialized queues hear it.
  void announceStateMoved(collection, item)
  return instance
}

/**
 * Execute a manual transition as `actor` — through runRecordTransition, the ONE
 * manual-move path the record panel's REST route and the Teams cards use
 * (2026-11-18): record access, the manual gate (admin-only, extension checks,
 * roles, owner / creator rule, required note, requirements, conditions), the
 * edit lock, background runs, the double-fire claim, applyTransition (instance,
 * history, actions, View-as note, live announce), the automatic moves after it
 * and the activity row. Throws WorkflowMutationError with the route's status,
 * message and extras (code, requirements, …) on any refusal.
 */
export async function executeWorkflowTransition(opts: {
  collection: string
  item: string
  transitionId: string
  comment?: string | null
  actor: WorkflowActor
  /** The HTTP request when there is one: the edit lock and the activity row's caller columns. */
  req?: FastifyRequest
}): Promise<{ instance: WorkflowInstance | undefined; newState: WorkflowState | null }> {
  const { collection, item, transitionId } = opts
  if (!transitionId) throw new WorkflowMutationError(400, 'transition_id is required')
  const user = (opts.actor.user ??
    (opts.actor.id ? { id: opts.actor.id, role: opts.actor.role ?? null } : null)) as User
  const r = await runRecordTransition({
    user,
    isAdmin: opts.actor.isAdmin ?? false,
    collection,
    item: String(item),
    transitionId: String(transitionId),
    comment: opts.comment ?? null,
    log: opts.req?.log ?? serverMoveLog,
    ...(opts.req ? { req: opts.req } : {})
  })
  if (r.status < 200 || r.status >= 300) {
    const { error, ...extras } = (r.body ?? {}) as Record<string, unknown>
    throw new WorkflowMutationError(
      r.status,
      typeof error === 'string' ? error : 'The move was refused.',
      extras
    )
  }
  const data = (r.body as { data?: { instance?: WorkflowInstance; new_state?: unknown } })?.data
  return {
    instance: data?.instance,
    newState: (data?.new_state as WorkflowState | null | undefined) ?? null
  }
}
