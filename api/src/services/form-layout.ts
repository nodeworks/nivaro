import { db } from '../db/index.js'

/**
 * Layout-backed public forms — resolve a submission form's layout into a
 * renderable structure: ordered sections (or wizard steps when the layout's
 * tab_mode is 'steps') of public-safe fields with labels, widget hints,
 * select choices and visibility rules.
 *
 * Public-safe means: physical columns only (no alias/relation-path/sentinel
 * assignments), not hidden, not readonly, never `id` or user_* audit fields.
 */

export interface FormLayoutField {
  path: string
  label: string
  db_type: string
  required: boolean
  placeholder: string | null
  choices: Array<{ value: string; text: string }> | null
  visibility: Array<{ when: string; op: string; value?: unknown; action: 'show' | 'hide' }> | null
}

export interface FormLayoutSection {
  label: string | null
  fields: FormLayoutField[]
}

export interface FormLayoutStructure {
  tab_mode: 'tabs' | 'steps'
  sections: FormLayoutSection[]
  field_paths: string[]
}

const EXCLUDED = new Set(['id', 'user_created', 'user_updated', 'date_created', 'date_updated'])

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

export async function loadFormLayout(
  layoutId: number,
  collection: string,
  opts: { includeReadonly?: boolean } = {}
): Promise<FormLayoutStructure | null> {
  const layout = await db('nivaro_collection_layouts')
    .where({ id: layoutId, collection })
    .first()
    .catch(() => null)
  if (!layout || (layout.layout_type ?? 'grouped') !== 'grouped') return null

  const [groups, assignments, fieldRows, physicalRows] = await Promise.all([
    db('nivaro_field_groups')
      .where({ layout_id: layoutId })
      .select('id', 'key', 'label', 'sort')
      .orderBy('sort'),
    db('nivaro_layout_field_assignments')
      .where({ layout_id: layoutId })
      .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'overrides')
      .orderBy('sort'),
    db('nivaro_fields')
      .where({ collection })
      .select('field', 'label', 'type', 'required', 'placeholder', 'options', 'visibility_rules', 'hidden', 'readonly'),
    db.raw(`SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_NAME = ?`, [
      collection
    ]) as Promise<Array<{ name: string }>>
  ])

  const physical = new Set(physicalRows.map((r) => r.name))
  const metaByField = new Map(
    (fieldRows as Array<Record<string, unknown>>).map((f) => [String(f.field), f])
  )

  const toField = (a: Record<string, unknown>): FormLayoutField | null => {
    const path = String(a.field)
    if (path.startsWith('__') || path.includes('.') || EXCLUDED.has(path)) return null
    if (!physical.has(path)) return null // alias fields have no column
    if (a.is_visible === 0 || a.is_visible === false) return null
    const meta = metaByField.get(path)
    if (!meta || meta.hidden === true || meta.hidden === 1) return null
    const overrides = parseJson<Record<string, unknown>>(a.overrides) ?? {}
    if (!opts.includeReadonly) {
      if (meta.readonly === true || meta.readonly === 1) return null
      if (overrides.readonly === true) return null
    }
    const fieldOpts = parseJson<Record<string, unknown>>(meta.options)
    const rawChoices = fieldOpts?.choices ?? fieldOpts?.options
    const choices = Array.isArray(rawChoices)
      ? rawChoices
          .map((c: unknown) =>
            c && typeof c === 'object'
              ? {
                  value: String((c as { value?: unknown }).value ?? ''),
                  text: String((c as { text?: unknown; label?: unknown }).text ?? (c as { label?: unknown }).label ?? (c as { value?: unknown }).value ?? '')
                }
              : { value: String(c), text: String(c) }
          )
          .filter((c) => c.value !== '')
      : null
    return {
      path,
      label: String(a.label_override ?? meta.label ?? path.replace(/_/g, ' ')),
      db_type: String(meta.type ?? ''),
      required: meta.required === true || meta.required === 1,
      placeholder: meta.placeholder != null ? String(meta.placeholder) : null,
      choices: choices?.length ? choices : null,
      visibility: parseJson<FormLayoutField['visibility']>(meta.visibility_rules) ?? null
    }
  }

  const asgs = assignments as Array<Record<string, unknown>>
  const ungrouped = asgs
    .filter((a) => a.group_key == null || a.group_key === '')
    .map(toField)
    .filter((f): f is FormLayoutField => f !== null)

  const sections: FormLayoutSection[] = []
  if (ungrouped.length > 0) sections.push({ label: null, fields: ungrouped })
  for (const g of groups as Array<{ id: number; key: string; label: string }>) {
    const fields = asgs
      .filter((a) => a.group_key === g.key || a.group_key === String(g.id))
      .map(toField)
      .filter((f): f is FormLayoutField => f !== null)
    if (fields.length > 0) sections.push({ label: g.label, fields })
  }

  if (sections.length === 0) return null

  return {
    tab_mode: layout.tab_mode === 'steps' ? 'steps' : 'tabs',
    sections,
    field_paths: sections.flatMap((s) => s.fields.map((f) => f.path))
  }
}
