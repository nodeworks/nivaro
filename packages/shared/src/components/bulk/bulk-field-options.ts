import {
  type FormSection,
  formSections,
  HEADER_SECTION_KEY,
  mergeFormSections
} from '../../lib/form-sections'
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
  fields: Record<
    string,
    {
      records: number
      locked: number
      reason: string | null
      required?: boolean
      /** A to-many field: the bar adds, replaces or removes links (2026-11-13). */
      m2m?: { related: string; junction: string }
    }
  >
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
  /** The form requires it: an empty value is never applied (army 11 N3). */
  required: boolean
  /** A to-many field: the related collection its links point at. */
  m2m?: { related: string; junction: string }
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
          reason: r.reason,
          required: r.required === true,
          ...(r.m2m ? { m2m: r.m2m } : {})
        }
      ]
    })
    if (options.length) out.push({ key: s.key, label: s.label, options })
  }
  return withStepLabels(out)
}

/**
 * Section headings as the form's steps read them (army 11 N4: "Container ›
 * Basic Info" named the layout's tab container): the section's own name, the
 * full path only where two sections share a name, and the header band as
 * "Record header".
 */
function withStepLabels(sections: BulkFieldSection[]): BulkFieldSection[] {
  const leaf = (s: BulkFieldSection) =>
    s.key === HEADER_SECTION_KEY ? 'Record header' : (s.label.split(' › ').pop() ?? s.label)
  const counts = new Map<string, number>()
  for (const s of sections) counts.set(leaf(s), (counts.get(leaf(s)) ?? 0) + 1)
  return sections.map((s) => ({ ...s, label: (counts.get(leaf(s)) ?? 0) > 1 ? s.label : leaf(s) }))
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
