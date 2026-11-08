/**
 * Army 11 N12 (2026-11-08): who may delete a record that runs a pipeline.
 *
 * A person who is not an administrator deletes a pipeline record only while
 * it has never left its first step: its run sits at the template's initial
 * state, is not finished, and no move out of a step was ever recorded (a
 * record sent back to its first step has been in approval — its history and
 * approvals must stay on record). Anything else is cancelled through its
 * pipeline, never deleted. Administrators are not bound (the record page's
 * Delete is theirs). A record with no run is judged by the role policies
 * alone, as before.
 *
 * Judged on REQUEST deletes only (the items service is handed the request):
 * the engine's own deletes (merges, imports, cascades) carry no request.
 *
 * Twin of the list row menu's offer (packages/shared lib/delete-offer.ts):
 * change both.
 */
import { db } from '../db/index.js'

export const DELETE_IN_FLIGHT = 'DELETE_IN_FLIGHT'

export class DeleteInFlightError extends Error {
  statusCode = 403
  code = DELETE_IN_FLIGHT
}

export interface DeleteRunState {
  /** The record's run sits at its template's initial state. */
  atFirstStep: boolean
  /** The run is finished (Completed, Canceled). */
  finished: boolean
  /** A move out of a step was ever recorded for the record. */
  moved: boolean
  /** The step the record sits at, for the sentence. */
  stepLabel: string | null
}

/** The sentence a non-admin gets, or null when the delete may go ahead. Pure. */
export function inFlightDeleteMessage(run: DeleteRunState | null): string | null {
  if (!run) return null
  const step = run.stepLabel?.trim() || null
  if (run.finished)
    return `This record is finished${step ? ` (${step})` : ''} and can’t be deleted. Ask an administrator if it must be removed.`
  if (!run.atFirstStep)
    return `This record has been submitted${step ? ` and is at ${step}` : ''}, so it can’t be deleted. Cancel it instead — its history and approvals stay on record.`
  if (run.moved)
    return 'This record has been through approval before, so it can’t be deleted. Cancel it instead — its history and approvals stay on record.'
  return null
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** The record's run as the delete rule reads it; null = no run. */
export async function deleteRunState(
  collection: string,
  id: string | number
): Promise<DeleteRunState | null> {
  const runs = (await db('nivaro_workflow_instances as i')
    .leftJoin('nivaro_workflow_states as s', 's.id', 'i.current_state')
    .where({ 'i.collection': collection, 'i.item': String(id) })
    .orderBy([
      { column: 'i.started_at', order: 'desc' },
      { column: 'i.id', order: 'desc' }
    ])
    .select('i.id', 'i.completed_at', 's.is_initial', 's.label', 's.key')) as Array<{
    id: string
    completed_at: unknown
    is_initial: unknown
    label: string | null
    key: string | null
  }>
  if (runs.length === 0) return null
  // The open run when there is one (a record has one run at a time), else the newest.
  const run = runs.find((r) => r.completed_at == null) ?? runs[0]
  const moved = !!(await db('nivaro_workflow_history')
    .whereIn(
      'instance',
      runs.map((r) => r.id)
    )
    .whereNotNull('from_state')
    .first('id'))
  return {
    atFirstStep: truthy(run.is_initial),
    finished: run.completed_at != null,
    moved,
    stepLabel: run.label ?? run.key ?? null
  }
}

/** Throws DeleteInFlightError when a non-admin may not delete this record. */
export async function assertDeletableByPerson(
  collection: string,
  id: string | number,
  isAdmin: boolean
): Promise<void> {
  if (isAdmin) return
  let message: string | null
  try {
    message = inFlightDeleteMessage(await deleteRunState(collection, id))
  } catch {
    // A question that cannot be answered refuses, like the edit lock.
    message = 'Could not confirm this record may be deleted. Try again, or ask an administrator.'
  }
  if (message) throw new DeleteInFlightError(message)
}
