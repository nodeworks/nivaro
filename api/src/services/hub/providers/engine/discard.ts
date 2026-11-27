import { logActivity } from '../../../activity.js'
import {
  type HubResourceChangeRow,
  type HubResourceRow,
  RESOURCES,
  readChange,
  readResource,
  updateChange,
  updateResource
} from '../store.js'
import { auditChange } from './audit.js'
import { type ChangeStatus, type HubActor, ResourceChangeError } from './contract.js'
import { engineDeps } from './deps.js'
import { assertMayWrite } from './gates.js'
import { holdResourceLocks, hubResourceChangeLockKey, hubResourceLockKey } from './locks.js'
import { changeResumable } from './resume-rule.js'

/**
 * A create that never reached the provider (Task 3b item D). A create inserts its resource row
 * BEFORE the provider call (run.ts), tagged with the change that made it; when the call fails the
 * row stays with no provider id. Such a row is not a real resource: the UI shows it as "Create
 * failed" (or "Creating…" while its change still runs) with Resume — the change's own resume —
 * and Discard, which drops the row here: no provider call, one audit row, and the failed change
 * is closed as cancelled so a later resume cannot write into a row that is gone.
 */

/** The row tag naming the change whose create inserted the row (engine-only; never sent out). */
export const CREATE_CHANGE_TAG = 'nivaro-hub:create-change'

export interface PendingCreate {
  /** The change that inserted the row; null for a row made before the tag existed. */
  change_id: number | null
  /** That change's status now; null when the change is gone (or unknown). */
  status: ChangeStatus | null
  /** Resume would run it again (interrupted, or failed on something a retry may fix). */
  resumable: boolean
}

/** The change id a row's create tag names, or null. */
export function createChangeIdOf(row: Pick<HubResourceRow, 'tags'>): number | null {
  const raw = row.tags?.[CREATE_CHANGE_TAG]
  return raw && /^\d+$/.test(raw) ? Number(raw) : null
}

/**
 * What the UI shows for a row with no provider id: its create's change and whether resume can
 * run it. null for a row that exists at the provider (or is deleted).
 */
export function pendingCreateOf(
  row: Pick<HubResourceRow, 'external_id' | 'deleted_at' | 'tags'>,
  change: HubResourceChangeRow | null,
  /** The change connection's secret fingerprint now (Task 11c: AUTH_FAILED resumes once it moved). */
  connectionFingerprint?: string | null
): PendingCreate | null {
  if (row.external_id || row.deleted_at) return null
  const status = change?.status ?? null
  const resumable = change != null && changeResumable(change, connectionFingerprint)
  return { change_id: createChangeIdOf(row), status, resumable }
}

const refuse = (code: ConstructorParameters<typeof ResourceChangeError>[0], message: string) =>
  new ResourceChangeError(code, message)

/**
 * Drops a never-created resource row. Refused while its change is running (RESOURCE_BUSY), for a
 * row the provider has (BAD_STATUS — delete it instead), and for anyone but a Hub administrator
 * or the person who started the change (ADMIN_ONLY; a shared row is administrators only).
 */
export async function discardFailedCreate(
  resourceId: number,
  actor: HubActor
): Promise<{ resourceId: number; changeId: number | null }> {
  assertMayWrite(actor)
  const row = await readResource(resourceId)
  if (!row || row.deleted_at) throw refuse('NOT_FOUND', 'No such resource.')
  if (row.external_id)
    throw refuse(
      'BAD_STATUS',
      'This resource exists at the provider. Plan a delete instead of discarding it.'
    )
  const changeId = createChangeIdOf(row)
  if (changeId != null) {
    const { healResourceChanges } = await import('./run.js')
    await healResourceChanges(changeId)
  }
  const change = changeId != null ? await readChange(changeId) : null
  const mayAct =
    actor.isAdmin || (row.scope === 'app' && change != null && change.requested_by === actor.id)
  if (!mayAct)
    throw refuse(
      'ADMIN_ONLY',
      'Only the person who started this change or a Hub administrator can discard it.'
    )
  if (change?.status === 'applying')
    throw refuse('RESOURCE_BUSY', 'Its change is still running. Wait for it to end.')

  const deps = engineDeps()
  const keys = [hubResourceLockKey(row.id)]
  if (changeId != null) keys.push(hubResourceChangeLockKey(changeId))
  const hold = await holdResourceLocks(deps.lock(), keys)
  try {
    // The change: closed so a resume never replays the create into a row that is gone.
    if (change && (change.status === 'failed' || change.status === 'interrupted')) {
      const closed = await updateChange(
        change.id,
        {
          status: 'cancelled',
          error_code: 'DISCARDED',
          error: 'The failed create was discarded; nothing was made at the provider.',
          finished_at: new Date(deps.now())
        },
        { expectStatus: change.status }
      )
      if (!closed)
        throw refuse('BAD_STATUS', 'Its change moved a moment ago. Reload and look again.')
    }
    const again = await readResource(row.id)
    if (!again || again.deleted_at || again.external_id)
      throw refuse('BAD_STATUS', 'The resource changed a moment ago. Reload and look again.')
    await updateResource(row.id, { deleted_at: new Date(deps.now()), observed: null, drift: false })
  } finally {
    await hold.release()
  }
  const detail = { resource_id: row.id, type: row.type, name: row.name }
  if (change)
    await auditChange('hub-resource-discard', actor.id, change, { ...detail, from: change.status })
  else
    await logActivity({
      action: 'hub-resource-discard',
      user: actor.id,
      collection: RESOURCES,
      item: String(row.id),
      origin: 'person',
      comment: JSON.stringify({ ...detail, connection_id: row.connection_id, scope: row.scope })
    }).catch(() => null)
  return { resourceId: row.id, changeId }
}
