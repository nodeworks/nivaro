// A date column filter that can say more than "which day": before, after,
// on or before, on or after, between. One encoding, shared by the collection
// browser, the queue worklist and the server's queue filtering, so a saved
// view written on one surface reads the same on the others.
//
//   on:2026-09-19            the whole of that day
//   before:2026-09-19        strictly earlier
//   after:2026-09-19         strictly later
//   onbefore:2026-09-19      that day or earlier
//   onafter:2026-09-19       that day or later
//   between:2026-09-01..2026-09-30   inclusive on both ends
//
// The legacy collection-browser encodings (`r:from..to` and the preset names)
// still parse, so views saved before this keep working.

export type DateFilterOp = 'on' | 'before' | 'after' | 'onbefore' | 'onafter' | 'between'

export interface DateFilterValue {
  op: DateFilterOp
  from: string
  to?: string
}

export const DATE_FILTER_OPS: Array<{ op: DateFilterOp; label: string }> = [
  { op: 'on', label: 'On' },
  { op: 'before', label: 'Before' },
  { op: 'after', label: 'After' },
  { op: 'onbefore', label: 'On or before' },
  { op: 'onafter', label: 'On or after' },
  { op: 'between', label: 'Between' }
]

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isOp = (v: string): v is DateFilterOp => DATE_FILTER_OPS.some((o) => o.op === v)

export function parseDateFilter(raw: string | null | undefined): DateFilterValue | null {
  if (!raw) return null
  const i = raw.indexOf(':')
  if (i < 0) return null
  const op = raw.slice(0, i)
  const rest = raw.slice(i + 1)
  if (op === 'between' || op === 'r') {
    const [a, b] = rest.split('..')
    if (!DAY.test(a ?? '')) return null
    return { op: 'between', from: a, to: DAY.test(b ?? '') ? b : a }
  }
  if (!isOp(op) || !DAY.test(rest)) return null
  return { op, from: rest }
}

export function formatDateFilter(v: DateFilterValue): string {
  return v.op === 'between' ? `between:${v.from}..${v.to || v.from}` : `${v.op}:${v.from}`
}

const short = (d: string) => {
  const [y, m, dd] = d.split('-')
  return y && m && dd ? `${m}/${dd}/${y.slice(2)}` : d
}

export function describeDateFilter(v: DateFilterValue): string {
  if (v.op === 'between') return `${short(v.from)}–${short(v.to || v.from)}`
  const label = DATE_FILTER_OPS.find((o) => o.op === v.op)?.label ?? v.op
  return v.op === 'on' ? short(v.from) : `${label} ${short(v.from)}`
}

/** The inclusive day window a filter covers, as `yyyy-mm-dd` bounds.
 *  A null bound is open-ended. */
export function dateFilterBounds(v: DateFilterValue): { from: string | null; to: string | null } {
  const prevDay = (d: string) => shiftDay(d, -1)
  const nextDay = (d: string) => shiftDay(d, 1)
  switch (v.op) {
    case 'on':
      return { from: v.from, to: v.from }
    case 'before':
      return { from: null, to: prevDay(v.from) }
    case 'after':
      return { from: nextDay(v.from), to: null }
    case 'onbefore':
      return { from: null, to: v.from }
    case 'onafter':
      return { from: v.from, to: null }
    case 'between':
      return { from: v.from, to: v.to || v.from }
  }
}

function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + by))
  return dt.toISOString().slice(0, 10)
}

/** The day a stored value falls on, as `yyyy-mm-dd`, or null when it is not a
 *  date at all. Queue `extra` values arrive as whatever the source column
 *  stringified to — ISO, `MM/DD/YYYY`, or a JS `Date.toString()` — so the
 *  parse is deliberately forgiving and always reads the LOCAL calendar day
 *  (a plain `yyyy-mm-dd` is taken as that day, never shifted by a timezone). */
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

/** Does a stored value satisfy the filter? A value that is not a date never
 *  matches — a text filter is the tool for those. */
export function matchesDateFilter(value: unknown, v: DateFilterValue): boolean {
  const day = dayOfValue(value)
  if (!day) return false
  const { from, to } = dateFilterBounds(v)
  if (from && day < from) return false
  if (to && day > to) return false
  return true
}
