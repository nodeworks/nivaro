import { type FormSection, formSections, mergeFormSections } from '../../lib/form-sections'
import { titleCase } from '../../lib/utils'

/**
 * #2722 — what bulk "Update field" offers: the selected records' forms as one
 * list of sections (the form most of them open with first), each field the
 * person may change with how many records take the write. Pure: the bar
 * passes `/items/:c/bulk-fields` and the collection's field labels.
 */

export interface BulkFieldsForm {
  layout_id: number
  name: string
  records: number
  groups: Array<{
    id: number | null
    key: string
    label: string | null
    type: string | null
    sort: number
    container_id: number | null
  }>
  placements: Array<{
    field: string
    group_key: string | null
    sort: number
    label_override: string | null
    is_visible: boolean
  }>
  ungrouped_sort: number | null
}

export interface BulkFieldsReport {
  readable: number
  no_form: number
  capped?: boolean
  forms: BulkFieldsForm[]
  fields: Record<string, { records: number; locked: number; reason: string | null }>
}

export interface BulkFieldOption {
  field: string
  label: string
  /** Records the write lands on (on their form, not locked). */
  writable: number
  /** Records whose form does not show the field. */
  offForm: number
  locked: number
  reason: string | null
}

export interface BulkFieldSection {
  key: string
  label: string
  options: BulkFieldOption[]
}

export function bulkFieldSections(
  report: BulkFieldsReport,
  labels: Record<string, string | null | undefined> = {}
): BulkFieldSection[] {
  const lists: FormSection[][] = report.forms.map((f) =>
    formSections(f.groups, f.placements, { ungroupedSort: f.ungrouped_sort })
  )
  if (report.no_form > 0) {
    // Records without a form: every field the person may change, in one list.
    const placed = new Set(lists.flat().flatMap((s) => s.fields.map((x) => x.field)))
    const rest = Object.keys(report.fields)
      .filter((f) => !placed.has(f))
      .sort((a, b) => (labels[a] || a).localeCompare(labels[b] || b))
    if (rest.length)
      lists.push([
        {
          key: '__no_form__',
          label: report.forms.length ? 'Other fields' : 'Fields',
          fields: rest.map((field) => ({ field, label: null }))
        }
      ])
  }
  const out: BulkFieldSection[] = []
  for (const s of mergeFormSections(lists)) {
    const options = s.fields.flatMap((f): BulkFieldOption[] => {
      const r = report.fields[f.field]
      if (!r) return []
      return [
        {
          field: f.field,
          label: f.label || labels[f.field] || titleCase(f.field),
          writable: Math.max(0, r.records - r.locked),
          offForm: Math.max(0, report.readable - r.records),
          locked: r.locked,
          reason: r.reason
        }
      ]
    })
    if (options.length) out.push({ key: s.key, label: s.label, options })
  }
  return out
}

/** One line under a field: who the write skips, in plain words; null = every record. */
export function bulkFieldNote(o: BulkFieldOption, total: number): string | null {
  const parts: string[] = []
  if (o.locked > 0)
    parts.push(
      o.writable === 0 && o.offForm === 0 ? (o.reason ?? 'Locked') : `locked on ${o.locked}`
    )
  if (o.offForm > 0) parts.push(`not on the form of ${o.offForm}`)
  if (parts.length === 0) return null
  if (o.writable === 0 && o.offForm === 0) return parts[0]
  return `${o.writable} of ${total} — ${parts.join(', ')}`
}
