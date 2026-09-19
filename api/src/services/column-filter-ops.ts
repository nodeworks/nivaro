/**
 * Queue column filters that mean more than "contains this text".
 *
 * A column's configured display format already says what it holds — a date, a
 * number, a boolean — so the filter control follows it, and its value arrives
 * encoded with the operator the person picked:
 *
 *   on:2026-09-19 · before:… · after:… · onbefore:… · onafter:… · between:a..b
 *   num:gt:1000 · num:lte:50 · num:eq:3 · num:between:10..20
 *   bool:true · bool:false
 *
 * Anything without a recognised prefix stays the historic contains-match, so
 * saved views written before this keep working. Matching happens in JS on the
 * resolved rows: `extra` values are whatever the source column stringified to
 * (ISO, MM/DD/YYYY, a JS Date.toString()), which no SQL comparison can be
 * trusted to read the same way twice.
 */

export type ColumnFilterOp =
  | { kind: 'date'; from: string | null; to: string | null }
  | { kind: 'num'; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'; a: number; b?: number }
  | { kind: 'bool'; value: boolean }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const shiftDay = (day: string, by: number): string => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10)
}

export function parseColumnFilterOp(raw: string): ColumnFilterOp | null {
  const i = raw.indexOf(':')
  if (i < 0) return null
  const head = raw.slice(0, i)
  const rest = raw.slice(i + 1)

  if (head === 'bool') {
    if (rest !== 'true' && rest !== 'false') return null
    return { kind: 'bool', value: rest === 'true' }
  }

  if (head === 'num') {
    const j = rest.indexOf(':')
    if (j < 0) return null
    const op = rest.slice(0, j)
    const val = rest.slice(j + 1)
    if (op === 'between') {
      const [a, b] = val.split('..').map(Number)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null
      return { kind: 'num', op: 'between', a: Math.min(a, b), b: Math.max(a, b) }
    }
    if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(op)) return null
    const a = Number(val)
    if (!Number.isFinite(a)) return null
    return { kind: 'num', op: op as 'eq', a }
  }

  // Dates. `r:` is the collection browser's older range encoding.
  if (head === 'between' || head === 'r') {
    const [a, b] = rest.split('..')
    if (!DAY.test(a ?? '')) return null
    return { kind: 'date', from: a, to: DAY.test(b ?? '') ? b : a }
  }
  if (!DAY.test(rest)) return null
  switch (head) {
    case 'on':
      return { kind: 'date', from: rest, to: rest }
    case 'before':
      return { kind: 'date', from: null, to: shiftDay(rest, -1) }
    case 'after':
      return { kind: 'date', from: shiftDay(rest, 1), to: null }
    case 'onbefore':
      return { kind: 'date', from: null, to: rest }
    case 'onafter':
      return { kind: 'date', from: rest, to: null }
    default:
      return null
  }
}

/** The calendar day a stored value falls on, or null when it is not a date. */
export function dayOfValue(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return localDay(value)
  const s = String(value).trim()
  if (!s) return null
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/)
  if (iso) return iso[1]
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  const parsed = new Date(s)
  return Number.isNaN(parsed.getTime()) ? null : localDay(parsed)
}

function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Currency and thousands separators are display, not data. */
export function numberOfValue(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const n = Number(String(value).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

function boolOfValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(s)) return true
  if (['false', '0', 'no', 'n'].includes(s)) return false
  return null
}

/** A value that cannot be read as the filter's type never matches — a text
 *  filter is the tool for those rows. */
export function matchesColumnFilterOp(value: unknown, op: ColumnFilterOp): boolean {
  if (op.kind === 'date') {
    const day = dayOfValue(value)
    if (!day) return false
    if (op.from && day < op.from) return false
    if (op.to && day > op.to) return false
    return true
  }
  if (op.kind === 'num') {
    const n = numberOfValue(value)
    if (n == null) return false
    switch (op.op) {
      case 'eq':
        return n === op.a
      case 'neq':
        return n !== op.a
      case 'gt':
        return n > op.a
      case 'gte':
        return n >= op.a
      case 'lt':
        return n < op.a
      case 'lte':
        return n <= op.a
      case 'between':
        return n >= op.a && n <= (op.b as number)
    }
  }
  const b = boolOfValue(value)
  return b === null ? false : b === op.value
}

/** Option-list order. Values people recognise come first — a site’s DNS name
 *  (`michiganave.dc`) ahead of the import debris some legacy rows carry
 *  (`#N/A`, `'000261-CAS-6505 TAM O''SHANTER DR-T44'`). Nothing is hidden: a
 *  row holding one of those still has to be findable. */
export function optionRank(value: string): number {
  const v = value.trim()
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(v)) return 0 // dns-shaped
  if (/^[#'"]|^\d/.test(v)) return 2 // codes and CSV debris
  return 1
}

export function sortOptionValues(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => {
    const r = optionRank(a) - optionRank(b)
    return r !== 0 ? r : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  })
}
