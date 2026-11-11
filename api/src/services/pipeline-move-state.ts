/**
 * Admin "Move to state" — put ONE record's pipeline instance in a chosen state.
 *
 * A repair tool, not a transition: no transition actions run (no ERP/MWF
 * pushes, no flows, no mail), no requirements or roles are judged. It writes
 * the move as a history row naming the admin and the reason, mirrors the
 * binding's state_field, refreshes materialized queues and tells open pages.
 * A terminal target completes the instance; any other target reopens it.
 *
 * Afterwards the automatic transitions are re-checked, so a record that
 * already meets an auto rule in its new state moves on (the answer says where
 * it ended). An addendum's decision is NOT applied or undone by a move — its
 * approval runs only through the real transition path.
 */
import { db } from '../db/index.js'
import { chainFields } from './chain-columns.js'
import { originFields } from './note-authorship.js'

export class MoveStateError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export interface MoveStateInput {
  collection: string
  item: string
  toState: string
  reason: string
  userId: string
}

export interface MoveStateResult {
  from: { id: string | null; key: string | null; label: string | null }
  to: { id: string; key: string; label: string }
  /** Where the record ended after automatic transitions re-ran (null = stayed). */
  ended: { id: string; key: string; label: string } | null
  history_id: number | null
}

export const MOVE_REASON_MIN = 5
export const MOVE_REASON_MAX = 500

interface StateRow {
  id: string
  key: string
  label: string
  is_terminal: boolean | number | null
}

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

export function validateMoveReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : ''
  if (reason.length < MOVE_REASON_MIN) {
    throw new MoveStateError(
      400,
      `Say why you are moving it (at least ${MOVE_REASON_MIN} characters)`
    )
  }
  return reason.slice(0, MOVE_REASON_MAX)
}

export async function moveRecordToState(input: MoveStateInput): Promise<MoveStateResult> {
  const reason = validateMoveReason(input.reason)
  const instance = (await db('nivaro_workflow_instances')
    .where({ collection: input.collection, item: String(input.item) })
    .first('id', 'template', 'current_state', 'completed_at')) as
    | { id: string; template: string; current_state: string | null; completed_at: Date | null }
    | undefined
  if (!instance) throw new MoveStateError(404, 'This record has no pipeline to move')

  const states = (await db('nivaro_workflow_states')
    .where({ template: instance.template })
    .select('id', 'key', 'label', 'is_terminal')) as StateRow[]
  const target = states.find((s) => same(s.id, input.toState) || s.key === input.toState)
  if (!target) throw new MoveStateError(400, 'That state is not part of this pipeline')
  if (same(target.id, instance.current_state)) {
    throw new MoveStateError(400, `It is already in ${target.label}`)
  }
  const fromStateId = instance.current_state
  const from = states.find((s) => same(s.id, fromStateId)) ?? null
  const terminal = !!Number(target.is_terminal) || target.is_terminal === true
  const now = new Date()

  let historyId: number | null = null
  await db.transaction(async (trx) => {
    await trx('nivaro_workflow_instances')
      .where({ id: instance.id })
      .update({ current_state: target.id, completed_at: terminal ? now : null })
    const res = (await trx('nivaro_workflow_history')
      .insert({
        ...(await chainFields('nivaro_workflow_history')),
        instance: instance.id,
        from_state: fromStateId,
        to_state: target.id,
        transition: null,
        user: input.userId,
        comment: `Moved by an administrator: ${reason}`,
        timestamp: now,
        ...(await originFields('nivaro_workflow_history', 'person'))
      })
      // nivaro_workflow_history carries triggers (gotchas: trigger-safe returning)
      .returning('id', { includeTriggerModifications: true })) as Array<{ id: number } | number>
    const first = res[0]
    historyId = first == null ? null : typeof first === 'object' ? Number(first.id) : Number(first)
  })

  const { syncStateField, runAutoTransitions } = await import('./workflow-transitions.js')
  await syncStateField(input.collection, String(input.item), target).catch(() => {})
  const { syncMaterializedQueueItem } = await import('./queue-materialization.js')
  await syncMaterializedQueueItem(input.collection, String(input.item)).catch(() => {})
  const { announceAddendumChange, announceRecordAspect } = await import('./record-events.js')
  announceRecordAspect(input.collection, String(input.item), '$state')
  if (input.collection === 'nivaro_addendums') void announceAddendumChange(String(input.item))

  // An auto rule the record already meets in its new state moves it on.
  let ended: MoveStateResult['ended'] = null
  if (!terminal) {
    await runAutoTransitions(input.collection, String(input.item))
    const now2 = (await db('nivaro_workflow_instances')
      .where({ id: instance.id })
      .first('current_state')) as { current_state: string | null } | undefined
    if (now2 && !same(now2.current_state, target.id)) {
      const s = states.find((x) => same(x.id, now2.current_state))
      if (s) ended = { id: s.id, key: s.key, label: s.label }
    }
  }

  return {
    from: { id: from?.id ?? null, key: from?.key ?? null, label: from?.label ?? null },
    to: { id: target.id, key: target.key, label: target.label },
    ended,
    history_id: historyId
  }
}
