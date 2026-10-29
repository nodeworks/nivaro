import { formatSnapshotValue } from './as-it-was'

/**
 * "What changed, in the notification" (#3079): GET /notifications/:id/changes rows turned into
 * display lines. The server read the values as the reader; this only formats them. Pure.
 * Server shape: api services/notification-changes.ts FieldChange.
 */
export interface NotificationFieldChange {
  field: string
  label: string | null
  type: string | null
  old: unknown
  new: unknown
  old_label?: string | null
  new_label?: string | null
  diff?: { lead: string; removed: string; added: string; trail: string }
}

export interface NotificationChangesPayload {
  collection: string
  item: string
  revision_id: number | null
  at: string | null
  notified_at: string | null
  changes: NotificationFieldChange[]
  first_revision?: boolean
  note?: string
}

export interface ChangeLine {
  field: string
  label: string
  old: string
  new: string
  diff: NotificationFieldChange['diff'] | null
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export function changeLines(payload: NotificationChangesPayload | null | undefined): ChangeLine[] {
  return (payload?.changes ?? []).map((c) => {
    const isM2o = c.old_label !== undefined || c.new_label !== undefined
    const meta = {
      field: c.field,
      label: c.label,
      type: c.type,
      interface: null,
      format: null,
      m2o: isM2o ? 'related' : null
    }
    return {
      field: c.field,
      label: c.label || titleCase(c.field),
      old: c.diff ? '' : formatSnapshotValue(c.old, meta, c.old_label ?? null),
      new: c.diff ? '' : formatSnapshotValue(c.new, meta, c.new_label ?? null),
      diff: c.diff ?? null
    }
  })
}
