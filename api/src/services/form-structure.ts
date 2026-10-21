/**
 * Form structure settings for the PDF (#2697 #2698 #2700) — the API's copy of
 * packages/shared/src/lib/form-structure.ts (the API cannot import
 * packages/shared). Same keys, same rules: rows of fields under one label in
 * the group's swap_config `row_groups`, empty-section text in `empty_text`,
 * the fold in the placement's overrides `fold`. Keep the two in step.
 */

export interface RowGroup {
  key: string
  label: string
  fields: string[]
}

export interface GroupStructure {
  sticky: boolean
  emptyText: string | null
  rows: RowGroup[]
}

type Obj = Record<string, unknown>

function parseObj(v: unknown): Obj {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Obj
  if (typeof v !== 'string' || !v.trim()) return {}
  try {
    const p = JSON.parse(v) as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : {}
  } catch {
    return {}
  }
}

function readRows(v: unknown): RowGroup[] {
  if (!Array.isArray(v)) return []
  const out: RowGroup[] = []
  const seen = new Set<string>()
  for (const r of v) {
    if (!r || typeof r !== 'object') continue
    const { key, label, fields } = r as Obj
    if (typeof key !== 'string' || !key || seen.has(key) || !Array.isArray(fields)) continue
    const own = fields.filter(
      (f): f is string => typeof f === 'string' && !!f && !out.some((o) => o.fields.includes(f))
    )
    seen.add(key)
    out.push({ key, label: typeof label === 'string' ? label : '', fields: [...new Set(own)] })
  }
  return out
}

export function readGroupStructure(swapConfig: unknown): GroupStructure {
  const o = parseObj(swapConfig)
  const text = typeof o.empty_text === 'string' ? o.empty_text.trim() : ''
  return { sticky: o.sticky === true, emptyText: text || null, rows: readRows(o.row_groups) }
}

export function isFolded(overrides: unknown): boolean {
  return parseObj(overrides).fold === true
}

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

export interface PdfFieldIn {
  field: string
  label: string
  value: string
  colSpan?: number
  rawHtml?: boolean
  hideLabel?: boolean
  /** The record holds no value for it. */
  empty: boolean
  folded: boolean
}

export interface PdfFieldOut {
  label: string
  value: string
  colSpan?: number
  rawHtml?: boolean
  hideLabel?: boolean
}

/**
 * One PDF section's fields, shaped like the record page: an empty field
 * behind "Show more" is left out; fields side by side under one label print
 * as one value ("12 Main St · Springfield · 02134", empty members left out);
 * a section with nothing filled prints its empty-section text.
 */
export function shapePdfFields(fields: PdfFieldIn[], swapConfig: unknown): PdfFieldOut[] {
  const s = readGroupStructure(swapConfig)
  const kept = fields.filter((f) => !(f.folded && f.empty))
  if (s.emptyText && kept.length > 0 && kept.every((f) => f.empty))
    return [{ label: '', value: s.emptyText, hideLabel: true }]
  // Rich text and child tables print on their own.
  const joinable = kept.filter((f) => !f.rawHtml)
  const present = new Set(joinable.map((f) => f.field))
  const rows = s.rows.filter((r) => r.fields.filter((x) => present.has(x)).length >= 2)
  const out: PdfFieldOut[] = []
  const done = new Set<string>()
  for (const f of kept) {
    const row = f.rawHtml ? null : rows.find((r) => r.fields.includes(f.field))
    if (!row) {
      const { field: _f, empty: _e, folded: _o, ...rest } = f
      out.push(rest)
      continue
    }
    if (done.has(row.key)) continue
    done.add(row.key)
    const members = joinable.filter((x) => row.fields.includes(x.field))
    const filled = members.filter((m) => !m.empty)
    out.push({
      label: row.label.trim() || members.map((m) => m.label).join(' / '),
      value: filled.length ? filled.map((m) => m.value).join(' · ') : '—'
    })
  }
  return out
}
