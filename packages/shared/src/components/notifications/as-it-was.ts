/**
 * "As it was" (#1385) — the pure half of the snapshot sheet: the server's
 * payload shape and how one value renders for a field.
 */

export interface AsItWasField {
  field: string
  label: string | null
  type: string | null
  interface: string | null
  format: string | null
  /** The M2O target collection when the field is a link. */
  m2o: string | null
}

export interface AsItWasPayload {
  collection: string
  item: string
  revision_id: number | null
  /** When the snapshot was written (null = no snapshot from that time). */
  at: string | null
  notified_at: string | null
  snapshot: Record<string, unknown> | null
  current: Record<string, unknown>
  changed_fields: string[]
  fields: AsItWasField[]
  /** M2O labels per field for both sides. */
  labels: Record<string, { snapshot: string | null; current: string | null }>
}

const fmtDate = (v: unknown, withTime: boolean) => {
  const s = String(v)
  // A bare calendar day never shifts with the viewer's zone.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (day) return `${day[2]}/${day[3]}/${day[1]}`
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
  if (!withTime) return date
  return `${date} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** The words a value shows as in the sheet; '' for an empty value. */
export function formatSnapshotValue(
  value: unknown,
  field: AsItWasField,
  label?: string | null
): string {
  if (value == null || value === '') return ''
  if (field.m2o) return label ?? `#${String(value)}`
  if (typeof value === 'object' && !(value instanceof Date)) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  const t = field.type ?? ''
  if (t === 'boolean') return value === true || value === 1 || value === '1' ? 'Yes' : 'No'
  if (field.format === 'currency') {
    const n = Number(value)
    return Number.isNaN(n)
      ? String(value)
      : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (t === 'decimal' || t === 'float' || t === 'integer' || t === 'bigInteger') {
    const n = Number(value)
    return Number.isNaN(n) ? String(value) : n.toLocaleString('en-US')
  }
  if (t === 'date') return fmtDate(value, false)
  if (t === 'datetime' || t === 'timestamp' || value instanceof Date) return fmtDate(value, true)
  const s = String(value)
  if (/rich|wysiwyg|editor/i.test(field.interface ?? '') || /^\s*</.test(s)) return stripHtml(s)
  return s
}

/** Field label: the configured one, else the key title-cased. */
export function snapshotFieldLabel(field: AsItWasField): string {
  if (field.label) return field.label
  return field.field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Rows of the sheet: changed fields first (they are the point), then the
 *  rest in field order; the empty-both-sides rows drop out. */
export function orderSnapshotFields(payload: AsItWasPayload): AsItWasField[] {
  const changed = new Set(payload.changed_fields)
  const hasValue = (f: AsItWasField) => {
    const a = payload.snapshot?.[f.field]
    const b = payload.current[f.field]
    return (a != null && a !== '') || (b != null && b !== '')
  }
  const kept = payload.fields.filter(hasValue)
  return [...kept.filter((f) => changed.has(f.field)), ...kept.filter((f) => !changed.has(f.field))]
}
