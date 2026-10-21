/**
 * A form's sections in reading order, flattened: each section (a section
 * inside a tab or step reads "Tab › Section") with its fields in order. Used
 * where a form is shown as a list rather than rendered — bulk "Update field"
 * (#2722) and record compare (#2723).
 *
 * Input is what /collection-layouts/active (or /items/:c/bulk-fields) returns
 * for the viewer: sections hidden from them are already gone, so a placement
 * whose section is missing is hidden too. Turned-off placements and slots
 * (`__owners__`, …) are never fields.
 */

export interface SectionGroupIn {
  id?: number | null
  key: string
  label?: string | null
  type?: string | null
  sort?: number | null
  container_id?: number | null
}

export interface SectionPlacementIn {
  field: string
  group_key?: string | null
  sort?: number | null
  label_override?: string | null
  is_visible?: boolean | number | null
}

export interface FormSectionField {
  field: string
  /** The form's own label for the field, when it overrides one. */
  label: string | null
}

export interface FormSection {
  key: string
  label: string
  fields: FormSectionField[]
}

export const HEADER_SECTION_KEY = '__header__'
export const GENERAL_SECTION_KEY = '__general__'
const UNGROUPED = '__ungrouped__'
const NOT_FIELDS = new Set(['content', 'metadata'])

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function formSections(
  groups: SectionGroupIn[],
  placements: SectionPlacementIn[],
  opts: { ungroupedSort?: number | null; generalLabel?: string } = {}
): FormSection[] {
  const visible = placements
    .filter((p) => p.is_visible == null || !!p.is_visible)
    .filter((p) => !p.field.startsWith('__'))
    .sort((a, b) => num(a.sort) - num(b.sort))
  const byId = new Map<number, SectionGroupIn>()
  for (const g of groups) if (g.id != null) byId.set(Number(g.id), g)
  const children = new Map<number | null, SectionGroupIn[]>()
  for (const g of groups) {
    // A section inside a container the viewer cannot see is not shown.
    const parent = g.container_id == null ? null : Number(g.container_id)
    if (parent != null && !byId.has(parent)) continue
    const list = children.get(parent) ?? []
    list.push(g)
    children.set(parent, list)
  }
  for (const list of children.values()) list.sort((a, b) => num(a.sort) - num(b.sort))

  const fieldsOf = (key: string) =>
    visible
      .filter((p) => p.group_key === key)
      .map((p) => ({ field: p.field, label: p.label_override || null }))

  const out: FormSection[] = []
  const header = fieldsOf(HEADER_SECTION_KEY)
  if (header.length) out.push({ key: HEADER_SECTION_KEY, label: 'Header', fields: header })

  const general: FormSection = {
    key: GENERAL_SECTION_KEY,
    label: opts.generalLabel ?? 'General',
    fields: visible
      .filter((p) => p.group_key == null || p.group_key === UNGROUPED)
      .map((p) => ({ field: p.field, label: p.label_override || null }))
  }
  let generalPlaced = false
  const placeGeneral = () => {
    if (generalPlaced) return
    generalPlaced = true
    if (general.fields.length) out.push(general)
  }
  if (opts.ungroupedSort == null) placeGeneral()

  const seen = new Set<string>()
  const walk = (g: SectionGroupIn, path: string[]) => {
    if (seen.has(g.key)) return
    seen.add(g.key)
    const label = g.label?.trim() || ''
    const here = label ? [...path, label] : path
    if (!NOT_FIELDS.has(String(g.type ?? ''))) {
      const fields = fieldsOf(g.key)
      if (fields.length)
        out.push({ key: g.key, label: here.join(' › ') || titleOfKey(g.key), fields })
    }
    if (g.id != null) for (const c of children.get(Number(g.id)) ?? []) walk(c, here)
  }
  for (const g of children.get(null) ?? []) {
    if (g.key === HEADER_SECTION_KEY) continue
    if (!generalPlaced && opts.ungroupedSort != null && num(g.sort) > opts.ungroupedSort)
      placeGeneral()
    walk(g, [])
  }
  placeGeneral()
  return out
}

function titleOfKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/**
 * Several forms' sections as one list: the first form's order, then each
 * field only another form shows, under that form's section (same label =
 * same section). A field appears once.
 */
export function mergeFormSections(lists: FormSection[][]): FormSection[] {
  const out: FormSection[] = []
  const byLabel = new Map<string, FormSection>()
  const seen = new Set<string>()
  for (const list of lists) {
    for (const s of list) {
      const fresh = s.fields.filter((f) => !seen.has(f.field))
      if (fresh.length === 0) continue
      for (const f of fresh) seen.add(f.field)
      const into = byLabel.get(s.label)
      if (into) into.fields.push(...fresh)
      else {
        const copy = { ...s, fields: [...fresh] }
        byLabel.set(s.label, copy)
        out.push(copy)
      }
    }
  }
  return out
}
