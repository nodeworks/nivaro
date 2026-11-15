/**
 * Change proposals — the pure part (no db): which fields a person may propose
 * a value for, how a typed value is read, and when two values are the same.
 * The service (change-proposals.ts) feeds it the field metadata, the person's
 * field lists and the record's relations.
 */

export type ProposalKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'choice'
  | 'relation'

export interface ProposalFieldMeta {
  field: string
  type: string | null
  interface: string | null
  hidden?: boolean | null
  readonly?: boolean | null
  special?: string[] | null
  options?: Record<string, unknown> | null
  computed_type?: string | null
  computed_formula?: string | null
}

export interface ProposalFieldContext {
  /** the target collection when the field is a plain many-to-one link */
  m2oTarget: string | null
  /** the field is the alias side of a one-to-many / many-to-many link */
  alias: boolean
  /** update field list (null = every field) */
  writable: Set<string> | null
  /** read field list (null = every field) */
  readable: Set<string> | null
  /** fields the lock leaves open — the person changes those directly */
  openFields: Set<string>
  isAdmin: boolean
}

const AUDIT_SPECIALS = ['user-created', 'date-created', 'user-updated', 'date-updated']
const ALIAS_SPECIALS = ['alias', 'o2m', 'm2m', 'm2a', 'files', 'translations', 'group', 'no-data']
const SYSTEM_TABLE = /^(nivaro_|directus_)/i
const FILE_INTERFACES = /^(file|files|file-image|image|upload)/i
const RICH_INTERFACES = /wysiwyg|rich|markdown|html|code/i
const TEXT_TYPES = new Set(['string', 'text', 'char', 'varchar', 'nvarchar'])
const NUMBER_TYPES = new Set(['integer', 'biginteger', 'bigint', 'decimal', 'float', 'double'])
const DATE_TYPES = new Set(['date'])
const DATETIME_TYPES = new Set(['datetime', 'timestamp', 'datetime2'])

export function choicesOf(meta: ProposalFieldMeta): Array<{ value: unknown; text: string }> | null {
  const raw = (meta.options as { choices?: unknown } | null)?.choices
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: Array<{ value: unknown; text: string }> = []
  for (const c of raw) {
    if (c && typeof c === 'object' && 'value' in (c as Record<string, unknown>)) {
      const o = c as { value: unknown; text?: unknown }
      out.push({ value: o.value, text: o.text != null ? String(o.text) : String(o.value) })
    } else if (typeof c === 'string' || typeof c === 'number') {
      out.push({ value: c, text: String(c) })
    }
  }
  return out.length > 0 ? out : null
}

/**
 * The input a field takes in a proposal, or null when it cannot be proposed:
 * a field the person could not write if the record were open (outside their
 * update or read list, read-only, admin-only for a non-admin, an audit stamp,
 * computed), a link list, a file, a link to a system table, a field the lock
 * leaves open (they change it directly) or a type the form below cannot take.
 */
export function proposalKindOf(
  meta: ProposalFieldMeta,
  ctx: ProposalFieldContext
): ProposalKind | null {
  const name = meta.field
  if (!name || name === 'id' || name.startsWith('_')) return null
  if (ctx.openFields.has(name)) return null
  if (ctx.writable && !ctx.writable.has(name)) return null
  if (ctx.readable && !ctx.readable.has(name)) return null
  if (meta.hidden === true || meta.readonly === true) return null
  if (!ctx.isAdmin && (meta.options as { admin_only_edit?: unknown } | null)?.admin_only_edit)
    return null
  const special = (meta.special ?? []).map((s) => String(s).toLowerCase())
  if (special.some((s) => AUDIT_SPECIALS.includes(s) || ALIAS_SPECIALS.includes(s))) return null
  if (meta.computed_type || meta.computed_formula) return null
  if (ctx.alias) return null
  const iface = String(meta.interface ?? '')
  if (FILE_INTERFACES.test(iface) || iface.startsWith('list') || iface === 'inline-grid')
    return null
  // Formatted text would lose its formatting in a plain box: asked for with Request help.
  if (RICH_INTERFACES.test(iface)) return null
  const type = String(meta.type ?? '').toLowerCase()
  if (type === 'alias' || type === 'json' || type === 'csv' || type === 'hash') return null
  if (ctx.m2oTarget) return SYSTEM_TABLE.test(ctx.m2oTarget) ? null : 'relation'
  if (choicesOf(meta)) return 'choice'
  if (type === 'boolean') return 'boolean'
  if (NUMBER_TYPES.has(type)) return 'number'
  if (DATE_TYPES.has(type)) return 'date'
  if (DATETIME_TYPES.has(type)) return 'datetime'
  if (TEXT_TYPES.has(type)) return /textarea|multiline/i.test(iface) ? 'textarea' : 'text'
  return null
}

const MAX_TEXT = 10_000

/**
 * A proposed value as it will be written, or `{ error }` in plain words.
 * Empty input means "clear the field" (null).
 */
export function readProposedValue(
  kind: ProposalKind,
  raw: unknown,
  meta: ProposalFieldMeta
): { value: unknown } | { error: string } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === ''))
    return { value: null }
  switch (kind) {
    case 'boolean':
      if (raw === true || raw === 'true' || raw === 1) return { value: true }
      if (raw === false || raw === 'false' || raw === 0) return { value: false }
      return { error: 'must be Yes or No' }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim())
      return Number.isFinite(n) ? { value: n } : { error: 'must be a number' }
    }
    case 'date': {
      const s = String(raw).trim().slice(0, 10)
      return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
        ? { value: s }
        : { error: 'must be a date' }
    }
    case 'datetime': {
      const t = Date.parse(String(raw))
      return Number.isNaN(t)
        ? { error: 'must be a date and time' }
        : { value: new Date(t).toISOString() }
    }
    case 'choice': {
      const choices = choicesOf(meta) ?? []
      const hit = choices.find((c) => String(c.value) === String(raw))
      return hit ? { value: hit.value } : { error: 'must be one of its choices' }
    }
    case 'relation':
      if (typeof raw === 'object') {
        const id = (raw as { id?: unknown }).id
        return id == null || id === '' ? { value: null } : { value: id }
      }
      return { value: raw }
    default: {
      const s = String(raw)
      return s.length > MAX_TEXT ? { error: `is longer than ${MAX_TEXT} characters` } : { value: s }
    }
  }
}

/** A stored or proposed value in one comparable shape. */
export function comparableValue(v: unknown, kind?: ProposalKind | null): string | null {
  if (v === undefined || v === null) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return kind === 'date' ? v.toISOString().slice(0, 10) : String(v.getTime())
  }
  if (typeof v === 'object' && v !== null && 'id' in (v as Record<string, unknown>))
    return comparableValue((v as { id: unknown }).id, kind)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  const s = String(v).trim()
  if (s === '') return null
  if (kind === 'boolean') {
    if (s === 'true' || s === '1') return '1'
    if (s === 'false' || s === '0') return '0'
  }
  if (kind === 'number') {
    const n = Number(s)
    return Number.isFinite(n) ? String(n) : s
  }
  if (kind === 'date') return s.slice(0, 10)
  if (kind === 'datetime') {
    const t = Date.parse(s)
    return Number.isNaN(t) ? s : String(t)
  }
  // Link ids: GUIDs compare without case.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
    return s.toLowerCase()
  return s
}

export function sameProposalValue(a: unknown, b: unknown, kind?: ProposalKind | null): boolean {
  return comparableValue(a, kind) === comparableValue(b, kind)
}

/** A stored value made JSON-safe for the `changes` column. */
export function storableValue(v: unknown, kind?: ProposalKind | null): unknown {
  if (v === undefined) return null
  if (v instanceof Date)
    return Number.isNaN(v.getTime())
      ? null
      : kind === 'date'
        ? v.toISOString().slice(0, 10)
        : v.toISOString()
  if (v && typeof v === 'object' && 'id' in (v as Record<string, unknown>))
    return (v as { id: unknown }).id ?? null
  if (Buffer.isBuffer(v)) return null
  return v
}

export interface ProposalChange {
  field: string
  from: unknown
  to: unknown
}

/** Lenient read of the stored `changes` column. */
export function parseProposalChanges(raw: unknown): ProposalChange[] {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(v)) return []
  const out: ProposalChange[] = []
  for (const c of v) {
    if (!c || typeof c !== 'object') continue
    const o = c as { field?: unknown; from?: unknown; to?: unknown }
    if (typeof o.field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(o.field)) continue
    out.push({ field: o.field, from: o.from ?? null, to: o.to ?? null })
  }
  return out
}
