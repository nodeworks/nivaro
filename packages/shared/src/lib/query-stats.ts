import { evaluateNumeric } from './expression'
import { formatDate } from './utils'

/** How a stat tile renders its value. Default is currency (the historic shape). */
export type QueryStatFormat = 'currency' | 'number' | 'percent' | 'date' | 'text'

/** The value-bearing part of a stat-tile config, shared by QueryStatStrip. */
export interface QueryStatSpec {
  /** Sum this field over the rows. */
  field?: string
  /** Delta: value = sum(field) − sum(field_subtract). */
  field_subtract?: string
  /** `{{field}}` arithmetic over the SUMMED fields (so a ratio of totals is a
   *  weighted ratio, the same math a table's totals row uses). */
  formula?: string
  format?: QueryStatFormat
  /** Rendered when the value is null — '—' by default. */
  empty_label?: string
  /** Only rows matching these field values (equality AND). */
  row_match?: Record<string, unknown>
  /** Independent query stat: numeric formats sum value_field over its rows;
   *  date/text formats take the FIRST row's value_field. */
  query?: { value_field: string; label_field?: string }
}

type Row = Record<string, unknown>

export function sumField(rows: Row[], field: string): number {
  return rows.reduce((s, r) => {
    const n = Number(r[field])
    return r[field] === null || r[field] === undefined || r[field] === '' || !Number.isFinite(n)
      ? s
      : s + n
  }, 0)
}

/** True when at least one row holds a finite number in `field`. */
function hasNumeric(rows: Row[], field: string): boolean {
  return rows.some((r) => {
    const v = r[field]
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
  })
}

export function matchRows(rows: Row[], match?: Record<string, unknown>): Row[] {
  if (!match) return rows
  const entries = Object.entries(match)
  return rows.filter((r) => entries.every(([k, v]) => String(r[k] ?? '') === String(v)))
}

export function statValue(
  stat: QueryStatSpec,
  rows: Row[],
  queryRows: Row[] | null
): number | string | null {
  if (stat.query) {
    const q = queryRows ?? []
    if (stat.format === 'date' || stat.format === 'text') {
      const v = q[0]?.[stat.query.value_field]
      return v === null || v === undefined || v === '' ? null : String(v)
    }
    return sumField(q, stat.query.value_field)
  }
  // date/text values only come from a query; summing a field as a date reads 1970
  if (stat.format === 'date' || stat.format === 'text') return null
  const matched = matchRows(rows, stat.row_match)
  if (stat.formula) {
    // an operand with no numeric rows is unknown, not zero — a ratio over it
    // must read as "no figure", never 0%
    const v = evaluateNumeric(
      stat.formula,
      (path) => (hasNumeric(matched, path) ? sumField(matched, path) : null),
      { missing: 'null' }
    )
    return v === null || !Number.isFinite(v) ? null : v
  }
  if (stat.field) {
    return (
      sumField(matched, stat.field) -
      (stat.field_subtract ? sumField(matched, stat.field_subtract) : 0)
    )
  }
  return null
}

export function fmtStat(
  v: number | string | null,
  format?: QueryStatFormat,
  emptyLabel = '—'
): string {
  if (v === null || v === undefined || v === '') return emptyLabel
  if (format === 'text') return String(v)
  if (format === 'date') {
    // an unparseable value would make formatDate throw mid-render
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return emptyLabel
    return formatDate(typeof v === 'number' ? d : v)
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return emptyLabel
  if (format === 'number') return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (format === 'percent') return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2
  })
}
