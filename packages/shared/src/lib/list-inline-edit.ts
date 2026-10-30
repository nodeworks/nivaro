/**
 * #3224 — Edit in the list. Pure decisions behind inline cell editing on the
 * collection browser and queue worklists: which columns an admin switched on,
 * which editor a field gets, how typed text becomes a stored value.
 *
 * Inline editing is OFF by default and switched on per list: the collection's
 * `browser_config.inline_edit` (every collection list) or a queue's
 * `display_config.inline_edit`. `{enabled, fields}` — `fields` lists the
 * columns that may be edited; an empty list edits nothing.
 *
 * Curation, not security: a commit is the record form's own PATCH through the
 * items service, so field-level update rights, User Scopes, row filters,
 * validation, edit locks, hooks, activity and revisions all judge it there.
 * These helpers only decide what to OFFER.
 */

export interface InlineEditConfig {
  enabled: boolean
  /** Column keys (plain field names) people may edit in the list. */
  fields: string[]
}

export const INLINE_EDIT_OFF: InlineEditConfig = { enabled: false, fields: [] }

/** Field names only — never dotted paths, synthetic `__x__` keys or formulas. */
const PLAIN_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Stored JSON → a config consumers can trust (garbage = off). */
export function normalizeInlineEdit(raw: unknown): InlineEditConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return INLINE_EDIT_OFF
  const src = raw as { enabled?: unknown; fields?: unknown }
  const fields = Array.isArray(src.fields)
    ? [
        ...new Set(
          src.fields.filter(
            (f): f is string =>
              typeof f === 'string' && PLAIN_FIELD.test(f) && f !== 'id' && !f.startsWith('__')
          )
        )
      ].slice(0, 200)
    : []
  return { enabled: src.enabled === true, fields }
}

/** What an admin stores: null when the list keeps inline editing off with no columns. */
export function inlineEditForStorage(cfg: InlineEditConfig): InlineEditConfig | null {
  const n = normalizeInlineEdit(cfg)
  return !n.enabled && n.fields.length === 0 ? null : n
}

export type InlineEditorKind =
  | 'text'
  | 'longtext'
  | 'integer'
  | 'number'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'choice'
  | 'm2o'

/** The slice of a field row (GET /collections/:c → fields[]) the decision reads. */
export interface InlineFieldMeta {
  field: string
  type: string | null
  interface?: string | null
  hidden?: boolean | null
  readonly?: boolean | null
  special?: string[] | string | null
  computed_formula?: string | null
  computed_type?: string | null
  options?: unknown
  label?: string | null
}

export interface InlineRelationMeta {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field?: string | null
  junction_field: string | null
}

/** Columns the system writes itself — never offered. */
const SYSTEM_MANAGED = new Set([
  'id',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'created_at',
  'updated_at'
])

/** `special` flags that mean "not a plain stored value". */
const NON_VALUE_SPECIALS = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'files',
  'file',
  'translations',
  'group',
  'no-data',
  'date-created',
  'date-updated',
  'user-created',
  'user-updated',
  'cast-json',
  'uuid',
  'hash',
  'conceal',
  'auto-id'
])

/** Interfaces whose value a one-line cell editor would mangle. */
const RICH_INTERFACES = new Set([
  'input-rich-text-html',
  'input-rich-text-md',
  'input-markdown',
  'rich-text',
  'wysiwyg',
  'markdown',
  'input-code',
  'code',
  'json',
  'tags',
  'list',
  'map',
  'file',
  'file-image',
  'files',
  'image',
  'checklist',
  'repeater',
  'matrix',
  'address',
  'signature',
  'duration',
  'color',
  'rating',
  'progress',
  'auto-id',
  'formula'
])

const INT_TYPES = new Set(['integer', 'bigInteger', 'int', 'bigint', 'smallint', 'tinyint'])
const NUM_TYPES = new Set([
  'float',
  'decimal',
  'numeric',
  'real',
  'money',
  'smallmoney',
  'double',
  'number'
])

function specials(f: InlineFieldMeta): string[] {
  const s = f.special
  if (Array.isArray(s)) return s.map(String)
  if (typeof s === 'string' && s.trim()) return s.split(',').map((x) => x.trim())
  return []
}

function optionsOf(f: InlineFieldMeta): Record<string, unknown> | null {
  const o = f.options
  if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>
  if (typeof o === 'string' && o.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(o) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return null
}

/** Choice labels for a dropdown / radio field (raw `$t:` labels are the caller's to render). */
export function inlineChoices(f: InlineFieldMeta): Array<{ value: string; label: string }> {
  const choices = optionsOf(f)?.choices
  if (!Array.isArray(choices)) return []
  return choices
    .filter((c): c is { value: unknown; text?: unknown } => !!c && typeof c === 'object')
    .filter((c) => c.value != null && String(c.value) !== '')
    .map((c) => ({ value: String(c.value), label: String(c.text ?? c.value) }))
}

/** The M2O relation that makes `field` a single-record picker, if any. */
export function inlineM2oTarget(
  relations: InlineRelationMeta[],
  collection: string,
  field: string
): string | null {
  const rel = relations.find(
    (r) =>
      r.many_collection === collection &&
      r.many_field === field &&
      !r.junction_field &&
      !!r.one_collection
  )
  return rel?.one_collection ?? null
}

/**
 * The editor a field gets in a list cell, or null when it can't be edited
 * there: computed, read-only, system-written, alias, relational-many, files,
 * rich/structured interfaces.
 */
export function inlineEditorKind(
  f: InlineFieldMeta | undefined | null,
  collection: string,
  relations: InlineRelationMeta[]
): InlineEditorKind | null {
  if (!f || !PLAIN_FIELD.test(f.field)) return null
  if (SYSTEM_MANAGED.has(f.field)) return null
  if (f.readonly) return null
  if (f.computed_formula || f.computed_type) return null
  const type = String(f.type ?? '')
  if (type === 'alias') return null
  const sp = specials(f)
  if (sp.some((s) => NON_VALUE_SPECIALS.has(s))) return null
  // The one-side of an O2M / M2M is an alias even when typed 'string'.
  if (relations.some((r) => r.one_collection === collection && r.one_field === f.field)) return null
  const target = inlineM2oTarget(relations, collection, f.field)
  if (target) {
    // Files open a file picker, never a record list.
    if (target === 'nivaro_files' || target === 'directus_files') return null
    return 'm2o'
  }
  const iface = String(f.interface ?? '')
  if (RICH_INTERFACES.has(iface)) return null
  if ((iface === 'select-dropdown' || iface === 'radio-buttons') && inlineChoices(f).length > 0)
    return 'choice'
  if (type === 'boolean' || iface === 'boolean' || iface === 'toggle') return 'boolean'
  if (INT_TYPES.has(type)) return 'integer'
  if (NUM_TYPES.has(type)) return 'number'
  if (type === 'date') return 'date'
  if (type === 'datetime' || type === 'dateTime' || type === 'timestamp') {
    return optionsOf(f)?.date_mode === 'date' ? 'date' : 'datetime'
  }
  if (type === 'string')
    return iface === 'input-multiline' || iface === 'textarea' ? 'longtext' : 'text'
  if (type === 'text') return 'longtext'
  return null
}

/**
 * Whether a column is open for inline editing on this list: the admin switched
 * the list on, named the column, the field has a cell editor, and the viewer's
 * role may update the collection at all (the server still judges the record).
 */
export function inlineEditFor(opts: {
  config: InlineEditConfig
  key: string
  field: InlineFieldMeta | undefined | null
  collection: string
  relations: InlineRelationMeta[]
  mayUpdate: boolean
}): InlineEditorKind | null {
  const { config, key } = opts
  if (!config.enabled || !opts.mayUpdate) return null
  if (!config.fields.includes(key)) return null
  return inlineEditorKind(opts.field, opts.collection, opts.relations)
}

/** Columns an admin may switch on for a collection (for the settings picker). */
export function inlineEditCandidates(
  fields: InlineFieldMeta[],
  collection: string,
  relations: InlineRelationMeta[]
): Array<{ field: string; kind: InlineEditorKind; label: string }> {
  const out: Array<{ field: string; kind: InlineEditorKind; label: string }> = []
  for (const f of fields) {
    if (f.hidden) continue
    const kind = inlineEditorKind(f, collection, relations)
    if (kind) out.push({ field: f.field, kind, label: f.label || f.field })
  }
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A stored value → the text an `<input>` of this kind starts with. */
export function inlineInputValue(kind: InlineEditorKind, value: unknown): string {
  if (value == null) return ''
  if (kind === 'date') return String(value).slice(0, 10)
  if (kind === 'datetime') {
    const d = new Date(String(value))
    if (Number.isNaN(d.getTime())) return ''
    // datetime-local wants the viewer's LOCAL wall clock.
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  if (kind === 'boolean') return value === true || value === 1 || value === '1' ? 'true' : 'false'
  return String(value)
}

export type InlineParse = { ok: true; value: unknown } | { ok: false; error: string }

/** Typed text → the value the PATCH carries (blank clears to null). */
export function parseInlineInput(kind: InlineEditorKind, raw: string): InlineParse {
  const text = raw ?? ''
  const trimmed = text.trim()
  switch (kind) {
    case 'text':
      return { ok: true, value: trimmed === '' ? null : text }
    case 'longtext':
      return { ok: true, value: trimmed === '' ? null : text }
    case 'integer': {
      if (trimmed === '') return { ok: true, value: null }
      const clean = trimmed.replace(/,/g, '')
      if (!/^-?\d+$/.test(clean)) return { ok: false, error: 'Enter a whole number' }
      const n = Number(clean)
      if (!Number.isSafeInteger(n)) return { ok: false, error: 'That number is too large' }
      return { ok: true, value: n }
    }
    case 'number': {
      if (trimmed === '') return { ok: true, value: null }
      const clean = trimmed.replace(/,/g, '').replace(/^\$/, '')
      const n = Number(clean)
      if (clean === '' || !Number.isFinite(n)) return { ok: false, error: 'Enter a number' }
      return { ok: true, value: n }
    }
    case 'date': {
      if (trimmed === '') return { ok: true, value: null }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { ok: false, error: 'Enter a date' }
      return { ok: true, value: trimmed }
    }
    case 'datetime': {
      if (trimmed === '') return { ok: true, value: null }
      const d = new Date(trimmed)
      if (Number.isNaN(d.getTime())) return { ok: false, error: 'Enter a date and time' }
      return { ok: true, value: d.toISOString() }
    }
    case 'boolean':
      if (trimmed === '') return { ok: true, value: null }
      return { ok: true, value: trimmed === 'true' }
    case 'choice':
    case 'm2o':
      return { ok: true, value: trimmed === '' ? null : text }
  }
}

/** Whether a commit would change nothing (skip the PATCH). */
export function inlineValueUnchanged(
  kind: InlineEditorKind,
  before: unknown,
  after: unknown
): boolean {
  if (before == null && after == null) return true
  if (before == null || after == null) return false
  if (kind === 'datetime')
    return new Date(String(before)).getTime() === new Date(String(after)).getTime()
  if (kind === 'date') return String(before).slice(0, 10) === String(after).slice(0, 10)
  if (kind === 'boolean') {
    const b = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
    return b(before) === b(after)
  }
  if (kind === 'integer' || kind === 'number') return Number(before) === Number(after)
  return String(before) === String(after)
}

/** Tab / Shift+Tab: the next editable column in the row, wrapping never. */
export function nextInlineKey(editableKeys: string[], current: string, dir: 1 | -1): string | null {
  const i = editableKeys.indexOf(current)
  if (i < 0) return null
  return editableKeys[i + dir] ?? null
}
