import { logActivity } from '../../../activity.js'
import { deliverHubNotice, hubEventRecipients } from '../../notify-events.js'
import { type HubResourceChangeRow, RESOURCE_CHANGES } from '../store.js'
import type { PlannedOp } from '../types.js'
import { engineDeps } from './deps.js'

/**
 * Hub provider changes: the audit rows (nivaro_activity, actions `hub-resource-*`, collection
 * nivaro_hub_resource_changes so the Hub audit timeline lists them) and the notices. A comment
 * names the change, the resource, its type and the FIELD NAMES an op changed — never a value
 * (secret or not). An audit or notice failure never stops a run.
 */

export type ResourceAuditAction =
  | 'hub-resource-change-start'
  | 'hub-resource-change-end'
  | 'hub-resource-change-cancel'
  | 'hub-resource-change-resume'
  | 'hub-resource-change-interrupted'
  | 'hub-resource-change-approval-request'
  | 'hub-resource-change-approve'
  | 'hub-resource-change-decline'
  | 'hub-resource-change-undo-plan'
  | 'hub-resource-create'
  | 'hub-resource-update'
  | 'hub-resource-replace'
  | 'hub-resource-delete'
  | 'hub-resource-adopt'
  | 'hub-resource-accept'
  | 'hub-resource-action'

export async function auditChange(
  action: ResourceAuditAction,
  user: string | null,
  change: Pick<
    HubResourceChangeRow,
    'id' | 'connection_id' | 'app_id' | 'environment_id' | 'scope'
  >,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await logActivity({
    action,
    user,
    collection: RESOURCE_CHANGES,
    item: String(change.id),
    origin: user ? 'person' : 'machine',
    comment: JSON.stringify({
      change_id: change.id,
      connection_id: change.connection_id,
      scope: change.scope,
      app_id: change.app_id,
      environment_id: change.environment_id,
      ...extra
    })
  }).catch(() => null)
}

/** The audit action of one applied op. */
export function opAuditAction(op: PlannedOp): ResourceAuditAction {
  if (op.action === 'adopt') return 'hub-resource-adopt'
  if (op.action === 'accept') return 'hub-resource-accept'
  if (op.action) return 'hub-resource-action'
  if (op.kind === 'create') return 'hub-resource-create'
  if (op.kind === 'delete') return 'hub-resource-delete'
  if (op.kind === 'replace') return 'hub-resource-replace'
  return 'hub-resource-update'
}

/** What one applied op's audit row says: names only. */
export function opAuditDetail(op: PlannedOp, resourceId: number | null, externalId: string | null) {
  return {
    resource_id: resourceId,
    type: op.type,
    kind: op.kind,
    ...(op.action ? { op_action: op.action } : {}),
    external_id: externalId,
    fields: [...new Set(op.changes.map((c) => c.field))]
  }
}

/** One notice about a change to people (never throws). */
export async function tellAboutChange(
  people: Array<string | null | undefined>,
  change: Pick<HubResourceChangeRow, 'id' | 'app_id'>,
  subject: string,
  message: string,
  why: string
): Promise<void> {
  try {
    await deliverHubNotice(
      people,
      {
        subject,
        message,
        path: `/hub/connections?change=${change.id}`,
        source: { kind: 'hub', label: 'resource-change', id: change.id },
        why
      },
      engineDeps().notify
    )
  } catch {
    // a notice never stops a change
  }
}

/** Admins + owners of the app (the people who may approve, and the app's owners). */
export async function approversOf(appId: number | null): Promise<string[]> {
  if (appId == null) return []
  try {
    return await hubEventRecipients(appId)
  } catch {
    return []
  }
}
