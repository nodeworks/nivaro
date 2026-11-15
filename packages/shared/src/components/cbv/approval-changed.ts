/**
 * "Changed after approval" list filter (round 7, item 21): keeps the records that sit in an
 * approved step and were changed in the app since (api services/approval-changes.ts, virtual
 * condition `$approval_changed`). Stored in the list's filters like any chip, so saved views and
 * links carry it; NOT keeps the rest. It reads like a presence filter: the value's truthiness.
 */

export const APPROVAL_CHANGED_PATH = '$approval_changed'
export const APPROVAL_CHANGED_LABEL = 'Changed after approval'

export function isApprovalChangedFilter(f: { path: string[] }): boolean {
  return f.path[0] === APPROVAL_CHANGED_PATH && f.path.length === 1
}

export function approvalChangedEntry(id?: string) {
  return {
    id: id ?? `${APPROVAL_CHANGED_PATH}-${Date.now()}`,
    path: [APPROVAL_CHANGED_PATH],
    pathLabels: [APPROVAL_CHANGED_LABEL],
    fieldType: 'boolean',
    op: '_eq',
    value: 'true'
  }
}
