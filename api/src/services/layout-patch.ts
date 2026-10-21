import type { Knex } from 'knex'
import { changeNoteColumnReady, normalizeChangeNote } from './layout-change-note.js'
import { entryConfigColumnReady, normalizeEntryConfig, parseEntryConfig } from './layout-entry.js'

/**
 * Layout settings — the parsers, validators and the PATCH body → column
 * patch conversion shared by PATCH /collection-layouts/:id and the layout
 * editor's `layout_update` op (POST /collection-layouts/:id/ops).
 */

export type LayoutConditions = { role_ids?: string[] } | null

export type RecordConditionRule = { field: string; op: 'eq' | 'neq' | 'nnull'; value?: unknown }

// Safely parse the conditions JSON text column into an object (or null).
export function parseConditions(raw: unknown): LayoutConditions {
  if (raw == null) return null
  if (typeof raw === 'object') return raw as LayoutConditions
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as LayoutConditions) : null
  } catch {
    return null
  }
}

/**
 * Role allow-list. `conditions.role_ids` on a layout is a RESTRICTION, not a
 * preference: a non-admin whose role is not listed can never resolve, pin
 * (?layout=<slug>), list, or drill into that layout — record-condition
 * matches included (a CAR still resolves the admin-only PUB layout for an
 * admin, and the next allowed layout for everyone else). Empty/absent list =
 * open to all. Admins always pass.
 */
export function roleAllows(
  row: Record<string, unknown>,
  userRoleId: string | null | undefined,
  isAdmin: boolean
): boolean {
  if (isAdmin) return true
  const roleIds = parseConditions(row.conditions)?.role_ids
  if (!Array.isArray(roleIds) || roleIds.length === 0) return true
  if (!userRoleId) return false
  const want = String(userRoleId).toUpperCase()
  return roleIds.some((r) => String(r).toUpperCase() === want)
}

// Safely parse the record_conditions JSON text column into a rule array (or null).
export function parseRecordConditions(raw: unknown): RecordConditionRule[] | null {
  if (raw == null) return null
  if (Array.isArray(raw)) return raw as RecordConditionRule[]
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as RecordConditionRule[]) : null
  } catch {
    return null
  }
}

// Safely parse the default_values JSON text column into a plain object (or null).
/** JSON string[] of relation fields the quick picker walks; anything else = none. */
export function parseQuickPicker(raw: unknown): string[] | null {
  if (raw == null) return null
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!Array.isArray(v)) return null
  const steps = v.filter(
    (s): s is string => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
  )
  return steps.length ? [...new Set(steps)] : null
}

export function parseDefaultValues(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export const FIELD_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Every layout_type the form knows how to render. 'summary' (2026-09-14) =
 *  the read-only presentation Summary mode shows instead of the grouped
 *  layout; activation is type-scoped like the rest. */
export const LAYOUT_TYPES = ['grouped', 'table', 'file', 'addendum', 'detail', 'summary'] as const

export const isLayoutType = (t: unknown): t is (typeof LAYOUT_TYPES)[number] =>
  LAYOUT_TYPES.includes(t as (typeof LAYOUT_TYPES)[number])

/** A layout's machine name: lowercase letters, digits, `_` and `-` (the dash
 *  form is what migration 092 backfilled; new slugs use `_`). '' when nothing
 *  usable is left. */
export function slugify(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 200)
}

export const PDF_THEMES = ['classic', 'minimal', 'executive', 'custom'] as const
export const PDF_PAGE_SIZES = ['A4', 'Letter'] as const
export const PDF_ORIENTATIONS = ['portrait', 'landscape'] as const

// Validate a PATCH body's record_conditions array; returns an error string
// (naming the offending index) or null when valid.
export function validateRecordConditions(rules: unknown): string | null {
  if (!Array.isArray(rules)) return 'record_conditions must be an array'
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as Record<string, unknown> | null
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      return `record_conditions[${i}] must be an object`
    }
    if (typeof rule.field !== 'string' || !FIELD_IDENTIFIER_RE.test(rule.field)) {
      return `record_conditions[${i}].field must be a valid field identifier`
    }
    if (rule.op !== 'eq' && rule.op !== 'neq' && rule.op !== 'nnull') {
      return `record_conditions[${i}].op must be one of eq, neq, nnull`
    }
    if ((rule.op === 'eq' || rule.op === 'neq') && rule.value === undefined) {
      return `record_conditions[${i}].value is required for op ${rule.op}`
    }
  }
  return null
}

// Validate a PATCH body's default_values object; returns an error string
// (naming the offending key) or null when valid.
export function validateDefaultValues(values: unknown): string | null {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return 'default_values must be an object'
  }
  for (const key of Object.keys(values as Record<string, unknown>)) {
    if (!FIELD_IDENTIFIER_RE.test(key))
      return `default_values.${key} is not a valid field identifier`
  }
  return null
}

export type LayoutPatchBody = Partial<{
  name: string
  slug: string | null
  create_label: string | null
  create_hidden: boolean
  sort: number
  is_active: boolean
  disable_comments: boolean
  disable_tasks: boolean
  tab_mode: string
  validate_before_next: boolean
  summary_enabled: boolean
  summary_hide_empty: boolean
  ai_enabled: boolean
  accordion_mode: boolean
  disable_revisions: boolean
  disable_clone: boolean
  disable_delete: boolean
  row_order_field: string | null
  pdf_theme: string | null
  pdf_template_id: number | null
  pdf_cover_enabled: boolean
  pdf_cover_title_field: string | null
  pdf_cover_subtitle: string | null
  pdf_show_logo: boolean
  pdf_page_size: string
  pdf_orientation: string
  pdf_button_label: string | null
  conditions: { role_ids?: string[] } | null
  allow_schedule: boolean
  allow_disable_pickers: boolean
  layout_type: string
  addendum_layout_id: number | null
  workflow_template_id: string | null
  single_active_addendum: boolean
  addendum_default_view: boolean
  record_conditions: RecordConditionRule[] | null
  default_values: Record<string, unknown> | null
  display_mode: string | null
  parent_layout_id: number | null
  hide_integrity_banner: boolean
  hide_sla_banner: boolean
  changes_tray: boolean
  dossier_enabled: boolean
  dossier_label: string | null
  quick_picker: string[] | null
  sheet_width: number | null
  header_fields: string[] | null
  hide_empty: boolean
  change_note: string | null
  entry_config: Record<string, unknown> | null
}>

/** A layout row as the API returns it: JSON settings parsed, flags as booleans. */
export function parseLayoutRow<T extends Record<string, unknown>>(row: T): T {
  const r = row as Record<string, unknown>
  r.conditions = parseConditions(r.conditions)
  r.record_conditions = parseRecordConditions(r.record_conditions)
  r.default_values = parseDefaultValues(r.default_values)
  r.quick_picker = parseQuickPicker(r.quick_picker)
  r.header_fields = parseQuickPicker(r.header_fields)
  r.hide_empty = !!r.hide_empty
  r.changes_tray = !!r.changes_tray
  r.entry_config = parseEntryConfig(r.entry_config)
  return row
}

/** A layout id from a route param: digits only (anything else would reach SQL as NaN). */
export const isRowId = (id: unknown): boolean => typeof id === 'string' && /^\d{1,10}$/.test(id)

/** UNIQUE (collection, name) on nivaro_collection_layouts, said the same way by every writer. */
export const LAYOUT_NAME_TAKEN = 'A layout with that name already exists'

/** MSSQL 2627 / 2601 (duplicate key), also when knex wraps it in an AggregateError. */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const isCode = (n: unknown) => n === 2627 || n === 2601
  const top = err as { number?: unknown; errors?: unknown }
  if (isCode(top.number)) return true
  return (
    Array.isArray(top.errors) && top.errors.some((e) => isCode((e as { number?: unknown })?.number))
  )
}

export type LayoutPatchResult =
  | { patch: Record<string, unknown>; status?: undefined; error?: undefined }
  | { status: 400 | 409; error: string; patch?: undefined }

/**
 * Validate a settings body and turn it into the column patch to write.
 * is_active is not part of it: it only changes through the activate rule.
 */
export async function normalizeLayoutPatch(
  q: Knex | Knex.Transaction,
  id: number | string,
  existing: { slug?: string | null; collection: string },
  body: LayoutPatchBody
): Promise<LayoutPatchResult> {
  if (body.record_conditions !== undefined && body.record_conditions !== null) {
    const err = validateRecordConditions(body.record_conditions)
    if (err) return { status: 400, error: err }
  }
  if (body.default_values !== undefined && body.default_values !== null) {
    const err = validateDefaultValues(body.default_values)
    if (err) return { status: 400, error: err }
  }

  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) {
    // Names are unique per collection (case-insensitive, like the column's collation): say so
    // instead of letting the write fail on the constraint.
    if (typeof body.name === 'string' && body.name.trim()) {
      const wanted = body.name.trimEnd().toLowerCase()
      const others = (await q('nivaro_collection_layouts')
        .where({ collection: existing.collection })
        .whereNot({ id: Number(id) })
        .select('name')) as Array<{ name: string | null }>
      if (
        others.some(
          (o) =>
            String(o.name ?? '')
              .trimEnd()
              .toLowerCase() === wanted
        )
      )
        return { status: 409, error: LAYOUT_NAME_TAKEN }
    }
    patch.name = body.name
  }
  // A slug re-sent unchanged stays as stored: migration 092 kept characters
  // like ( & / that slugify would rewrite, and nothing cascades a rename to
  // ?layout= links, queue item_layout or grid layout_slug references.
  if (body.slug !== undefined && body.slug === existing.slug) patch.slug = existing.slug
  else if (body.slug !== undefined) {
    if (body.slug == null || body.slug === '') patch.slug = null
    else {
      const slug = slugify(String(body.slug))
      if (!slug) return { status: 400, error: 'slug must contain letters or digits' }
      const others = (await q('nivaro_collection_layouts')
        .where({ collection: existing.collection })
        .whereNot({ id: Number(id) })
        .whereNotNull('slug')
        .select('slug')) as Array<{ slug: string }>
      if (others.some((o) => String(o.slug).toLowerCase() === slug))
        return {
          status: 409,
          error: `Another layout of this collection already uses the slug "${slug}"`
        }
      patch.slug = slug
    }
  }
  if (body.create_label !== undefined) patch.create_label = body.create_label ?? null
  if (body.create_hidden !== undefined) patch.create_hidden = body.create_hidden ? 1 : 0
  if (body.sort !== undefined) patch.sort = body.sort
  if (body.disable_comments !== undefined) patch.disable_comments = body.disable_comments ? 1 : 0
  if (body.disable_tasks !== undefined) patch.disable_tasks = body.disable_tasks ? 1 : 0
  if (body.tab_mode !== undefined) patch.tab_mode = body.tab_mode
  if (body.parent_layout_id !== undefined) {
    // Layout inheritance (#424): one level only, same collection, never self.
    if (body.parent_layout_id === null) patch.parent_layout_id = null
    else {
      const parent = await q('nivaro_collection_layouts')
        .where({ id: Number(body.parent_layout_id) })
        .first('id', 'collection', 'parent_layout_id')
      const self = await q('nivaro_collection_layouts')
        .where({ id: Number(id) })
        .first('collection')
      if (
        !parent ||
        parent.collection !== self?.collection ||
        Number(parent.id) === Number(id) ||
        parent.parent_layout_id
      ) {
        return {
          status: 400,
          error: 'Parent must be a same-collection layout with no parent of its own'
        }
      }
      patch.parent_layout_id = Number(body.parent_layout_id)
    }
  }
  if (body.layout_type !== undefined) {
    if (!LAYOUT_TYPES.includes(body.layout_type as (typeof LAYOUT_TYPES)[number])) {
      return { status: 400, error: `layout_type must be one of ${LAYOUT_TYPES.join(', ')}` }
    }
    patch.layout_type = body.layout_type
  }
  if (body.validate_before_next !== undefined)
    patch.validate_before_next = body.validate_before_next ? 1 : 0
  if (body.summary_enabled !== undefined) patch.summary_enabled = body.summary_enabled ? 1 : 0
  if (body.ai_enabled !== undefined) patch.ai_enabled = body.ai_enabled ? 1 : 0
  if (body.conditions !== undefined)
    patch.conditions = body.conditions == null ? null : JSON.stringify(body.conditions)
  if (body.allow_schedule !== undefined) patch.allow_schedule = body.allow_schedule ? 1 : 0
  if (body.allow_disable_pickers !== undefined)
    patch.allow_disable_pickers = body.allow_disable_pickers ? 1 : 0
  if (body.addendum_layout_id !== undefined)
    patch.addendum_layout_id = body.addendum_layout_id ?? null
  if (body.workflow_template_id !== undefined)
    patch.workflow_template_id = body.workflow_template_id ?? null
  if (body.single_active_addendum !== undefined)
    patch.single_active_addendum = body.single_active_addendum ? 1 : 0
  if (body.addendum_default_view !== undefined)
    patch.addendum_default_view = body.addendum_default_view ? 1 : 0
  if (body.record_conditions !== undefined)
    patch.record_conditions =
      body.record_conditions == null ? null : JSON.stringify(body.record_conditions)
  if (body.default_values !== undefined)
    patch.default_values = body.default_values == null ? null : JSON.stringify(body.default_values)
  if (body.display_mode !== undefined) patch.display_mode = body.display_mode ?? null
  if (body.hide_integrity_banner !== undefined)
    patch.hide_integrity_banner = body.hide_integrity_banner === true
  if (body.dossier_enabled !== undefined) patch.dossier_enabled = body.dossier_enabled === true
  if (body.dossier_label !== undefined)
    patch.dossier_label = body.dossier_label?.trim().slice(0, 100) || null
  if (body.hide_sla_banner !== undefined) patch.hide_sla_banner = body.hide_sla_banner === true
  if (body.changes_tray !== undefined) patch.changes_tray = body.changes_tray === true
  if (body.quick_picker !== undefined) {
    if (body.quick_picker !== null && !Array.isArray(body.quick_picker))
      return { status: 400, error: 'quick_picker must be an array of field names or null' }
    const steps = parseQuickPicker(body.quick_picker)
    if (body.quick_picker !== null && body.quick_picker.length > 0 && !steps)
      return { status: 400, error: 'quick_picker entries must be field names' }
    if (steps && steps.length > 20)
      return { status: 400, error: 'quick_picker allows at most 20 steps' }
    patch.quick_picker = steps ? JSON.stringify(steps) : null
  }
  // Read-view presentation (migration 302): sheet width, header band, hide empty.
  if (body.sheet_width !== undefined) {
    if (body.sheet_width === null) patch.sheet_width = null
    else {
      const w = Number(body.sheet_width)
      if (!Number.isFinite(w) || w < 320 || w > 2000)
        return { status: 400, error: 'sheet_width must be 320–2000 px or null' }
      patch.sheet_width = Math.round(w)
    }
  }
  if (body.header_fields !== undefined) {
    if (body.header_fields !== null && !Array.isArray(body.header_fields))
      return { status: 400, error: 'header_fields must be an array of field names or null' }
    const hf = parseQuickPicker(body.header_fields)
    if (body.header_fields !== null && body.header_fields.length > 0 && !hf)
      return { status: 400, error: 'header_fields entries must be field names' }
    if (hf && hf.length > 8) return { status: 400, error: 'header_fields allows at most 8 fields' }
    patch.header_fields = hf ? JSON.stringify(hf) : null
  }
  if (body.hide_empty !== undefined) patch.hide_empty = body.hide_empty === true
  // Required change note (#2654): the column comes with migration 462.
  if (body.change_note !== undefined) {
    const res = normalizeChangeNote(body.change_note)
    if ('error' in res) return { status: 400, error: res.error }
    if (!(await changeNoteColumnReady(q)))
      return { status: 400, error: 'Change notes need migration 462 to run first' }
    patch.change_note = res.value
  }
  // Entry ergonomics (#2702 #2707 #2708 #2710 #2728): the column comes with migration 491.
  if (body.entry_config !== undefined) {
    const res = normalizeEntryConfig(body.entry_config)
    if ('error' in res) return { status: 400, error: res.error }
    if (!(await entryConfigColumnReady()))
      return { status: 400, error: 'Entry settings need migration 491 to run first' }
    patch.entry_config = res.value
  }

  // Settings the renderers read that this route used to drop.
  for (const key of [
    'summary_hide_empty',
    'accordion_mode',
    'disable_revisions',
    'disable_clone',
    'disable_delete',
    'pdf_cover_enabled',
    'pdf_show_logo'
  ] as const) {
    if (body[key] !== undefined) patch[key] = body[key] ? 1 : 0
  }
  if (body.row_order_field !== undefined) {
    const f = body.row_order_field
    if (f == null || f === '') patch.row_order_field = null
    else if (typeof f !== 'string' || !FIELD_IDENTIFIER_RE.test(f) || f.length > 255)
      return { status: 400, error: 'row_order_field must be a field name or null' }
    else patch.row_order_field = f
  }
  if (body.pdf_theme !== undefined) {
    if (body.pdf_theme === null) patch.pdf_theme = null
    else if (!PDF_THEMES.includes(body.pdf_theme as (typeof PDF_THEMES)[number]))
      return { status: 400, error: `pdf_theme must be one of ${PDF_THEMES.join(', ')}` }
    else patch.pdf_theme = body.pdf_theme
  }
  if (body.pdf_template_id !== undefined) {
    const t = body.pdf_template_id
    if (t === null) patch.pdf_template_id = null
    else if (!Number.isInteger(Number(t)) || Number(t) <= 0)
      return { status: 400, error: 'pdf_template_id must be a template id or null' }
    else patch.pdf_template_id = Number(t)
  }
  if (body.pdf_cover_title_field !== undefined) {
    const f = body.pdf_cover_title_field
    if (f == null || f === '') patch.pdf_cover_title_field = null
    else if (typeof f !== 'string' || !FIELD_IDENTIFIER_RE.test(f) || f.length > 255)
      return { status: 400, error: 'pdf_cover_title_field must be a field name or null' }
    else patch.pdf_cover_title_field = f
  }
  if (body.pdf_cover_subtitle !== undefined)
    patch.pdf_cover_subtitle = body.pdf_cover_subtitle?.trim() ? body.pdf_cover_subtitle : null
  if (body.pdf_page_size !== undefined) {
    if (!PDF_PAGE_SIZES.includes(body.pdf_page_size as (typeof PDF_PAGE_SIZES)[number]))
      return { status: 400, error: `pdf_page_size must be one of ${PDF_PAGE_SIZES.join(', ')}` }
    patch.pdf_page_size = body.pdf_page_size
  }
  if (body.pdf_orientation !== undefined) {
    if (!PDF_ORIENTATIONS.includes(body.pdf_orientation as (typeof PDF_ORIENTATIONS)[number]))
      return { status: 400, error: `pdf_orientation must be one of ${PDF_ORIENTATIONS.join(', ')}` }
    patch.pdf_orientation = body.pdf_orientation
  }
  if (body.pdf_button_label !== undefined)
    patch.pdf_button_label = body.pdf_button_label?.trim().slice(0, 100) || null
  return { patch }
}
