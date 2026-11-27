import { readChange, updateChange } from '../store.js'
import { auditChange, tellAboutChange } from './audit.js'
import {
  type ChangePlan,
  type HubActor,
  RESOURCE_CHANGE_CODES,
  type ResourceChangeCode,
  ResourceChangeError,
  type StoredChangePlan
} from './contract.js'
import { engineDeps } from './deps.js'
import { assertMayWrite } from './gates.js'
import { beginRun, healResourceChanges, replanFresh, viewOf } from './run.js'

/**
 * Decision 10 (Rob): an owner's change that adds a monthly cost waits as `pending_approval`; a
 * Hub administrator approves it (it starts only when a fresh plan — re-read at the provider, as
 * the requester — still has the hash the admin saw; else it turns `stale` and the owner plans
 * again) or declines it with a reason. The owner is told either way.
 */

const refuse = (code: ResourceChangeCode, message: string, details?: Record<string, unknown>) =>
  new ResourceChangeError(code, message, details)

async function pendingRow(changeId: number, actor: HubActor) {
  assertMayWrite(actor)
  if (!actor.isAdmin)
    throw refuse('ADMIN_ONLY', 'Only a Hub administrator can approve or decline a change.')
  await healResourceChanges(changeId)
  const row = await readChange(Number(changeId))
  if (!row) throw refuse('NOT_FOUND', 'No such change.')
  if (row.status !== 'pending_approval')
    throw refuse(
      'BAD_STATUS',
      `This change is ${row.status}; only a change waiting for approval can be decided.`
    )
  return row
}

export async function approveChange(
  changeId: number,
  input: { planHash: string },
  actor: HubActor
): Promise<ChangePlan> {
  const row = await pendingRow(changeId, actor)
  if (!input || input.planHash !== row.plan_hash)
    throw refuse('STALE_PLAN', 'This is not the plan you saw — check the change again.', {
      planHash: row.plan_hash
    })
  // As the requester: their access still holds, and the plan is the one they asked for.
  const requester: HubActor = { id: String(row.requested_by ?? ''), isAdmin: false, via: 'session' }
  const fresh = await replanFresh(row, requester).catch(async (e) => {
    if (e instanceof ResourceChangeError && e.code === 'STALE_PLAN')
      await tellAboutChange(
        [row.requested_by],
        row,
        'Plan your resource change again',
        'The resources changed since you planned this change, so it could not be approved as it was. Plan it again.',
        'You asked for this change.'
      )
    throw e
  })
  const b = fresh.stored.blockers[0]
  if (b)
    throw refuse(
      (b.code in RESOURCE_CHANGE_CODES ? b.code : 'BAD_STATUS') as ResourceChangeCode,
      b.message,
      { blockers: fresh.stored.blockers }
    )
  if (fresh.gateRefusal) throw fresh.gateRefusal
  const plan = row.plan as StoredChangePlan
  const out = await beginRun(row, actor, {
    expect: 'pending_approval',
    checklistRunId: plan.checklistRunId ?? null,
    claimChecklist: true,
    approvedBy: actor.id,
    audit: 'hub-resource-change-approve'
  })
  await tellAboutChange(
    [row.requested_by],
    row,
    'Your resource change was approved',
    'A Hub administrator approved your resource change; it is running now.',
    'You asked for this change.'
  )
  return out
}

export async function declineChange(
  changeId: number,
  reason: string,
  actor: HubActor
): Promise<ChangePlan> {
  const row = await pendingRow(changeId, actor)
  const why = String(reason ?? '')
    .trim()
    .slice(0, 500)
  if (!why) throw refuse('INVALID_FIELDS', 'Say why the change is declined.')
  const done = await updateChange(
    row.id,
    {
      status: 'declined',
      decline_reason: why,
      approved_by: actor.id,
      finished_at: new Date(engineDeps().now())
    },
    { expectStatus: 'pending_approval' }
  )
  if (!done) throw refuse('BAD_STATUS', 'This change was decided a moment ago.')
  await auditChange('hub-resource-change-decline', actor.id, row, {})
  await tellAboutChange(
    [row.requested_by],
    row,
    'Your resource change was declined',
    `A Hub administrator declined your resource change: ${why}`,
    'You asked for this change.'
  )
  return viewOf(done)
}
