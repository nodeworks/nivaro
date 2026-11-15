/**
 * Copy a figure as a picture: the words that go on the image.
 *
 * Pure text builders (no DOM) so they can be tested: the "As of" stamp in the
 * viewer's own clock, 12-hour, and the filters in effect — dashboard filters,
 * the report date range and entity filters, the widget's own filter — each as
 * one plain sentence. The render side lives in widget-image-render.ts.
 */
import {
  describeCondition,
  describeFilterObject,
  orList,
  type SentenceLabels
} from './config-sentences'
import { titleCase } from './utils'

/** "As of Nov 14, 2026, 9:45 PM" — the viewer's local time, 12-hour. */
export function formatAsOf(when: Date | number | string = new Date()): string {
  const d = when instanceof Date ? when : new Date(when)
  if (Number.isNaN(d.getTime())) return ''
  const text = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(d)
  return `As of ${text}`
}

const DATE_PRESETS: Record<string, string> = {
  this_month: 'this month',
  last_30_days: 'last 30 days',
  last_3_months: 'last 3 months',
  last_6_months: 'last 6 months',
  last_12_months: 'last 12 months',
  ytd: 'year to date'
}

/** A report date range as words; null when there is none. */
export function describeDateRangeFilter(
  range: { preset?: string; start?: string; end?: string } | null | undefined
): string | null {
  if (!range?.preset) return null
  if (range.preset === 'custom') {
    if (range.start && range.end) return `Dates: ${range.start} to ${range.end}`
    if (range.start) return `Dates: from ${range.start}`
    if (range.end) return `Dates: up to ${range.end}`
    return null
  }
  const label = DATE_PRESETS[range.preset]
  return label ? `Dates: ${label}` : null
}

/** Report entity filters (`{field, values, labels?}`) — "Zone is East or West". */
export function describeEntityFilters(
  filters:
    | Array<{ field: string; values: Array<string | number>; labels?: string[] }>
    | null
    | undefined,
  L: SentenceLabels = {}
): string[] {
  const out: string[] = []
  for (const f of filters ?? []) {
    if (!f?.field || !Array.isArray(f.values) || f.values.length === 0) continue
    // The labels already are what a person reads, so no choice lookup.
    const shown = f.values.map((v, i) => String(f.labels?.[i] ?? v))
    const clause = describeCondition(f.field, 'in', shown, {
      ...L,
      choices: undefined,
      records: undefined
    })
    out.push(clause ?? `${titleCase(f.field)} is ${orList(shown)}`)
  }
  return out
}

/** A dashboard's global filters (`{field, op: 'eq' | 'contains', value}`). */
export function describeGlobalFilters(
  filters: Array<{ field: string; op?: string; value: unknown }> | null | undefined,
  L: SentenceLabels = {}
): string[] {
  const out: string[] = []
  for (const f of filters ?? []) {
    if (!f?.field || f.value === '' || f.value == null) continue
    const clause = describeCondition(f.field, f.op === 'contains' ? 'contains' : 'eq', f.value, L)
    if (clause) out.push(clause)
  }
  return out
}

/**
 * The widget's own filter (an items-style filter object, JSON text allowed).
 * Something we cannot say in words becomes "A custom filter", never raw JSON.
 */
export function describeWidgetOwnFilter(raw: unknown, L: SentenceLabels = {}): string[] {
  let filter = raw
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return []
    try {
      filter = JSON.parse(t)
    } catch {
      return []
    }
  }
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return []
  if (Object.keys(filter as Record<string, unknown>).length === 0) return []
  const text = describeFilterObject(filter, L)
  if (!text) return ['A custom filter on this widget']
  return [text.charAt(0).toUpperCase() + text.slice(1)]
}

/** A widget's own `{field, op, value}` condition list, one sentence per rule. */
export function describeWidgetRules(
  rules: Array<{ field?: string; op?: string; value?: unknown }> | null | undefined,
  L: SentenceLabels = {}
): string[] {
  const out: string[] = []
  let unsaid = false
  for (const r of rules ?? []) {
    if (!r?.field) continue
    const c = describeCondition(r.field, r.op, r.value, L)
    if (c) out.push(c.charAt(0).toUpperCase() + c.slice(1))
    else unsaid = true
  }
  if (unsaid) out.push('A custom filter on this widget')
  return out
}

export interface WidgetImageInput {
  title: string
  /** When the figures were read; defaults to now. */
  asOf?: Date | number | string
  /** Dashboard-level filters (field/op/value). */
  dashboardFilters?: Array<{ field: string; op?: string; value: unknown }> | null
  /** Report date range. */
  dateRange?: { preset?: string; start?: string; end?: string } | null
  /** Report entity filters. */
  entityFilters?: Array<{
    field: string
    values: Array<string | number>
    labels?: string[]
  }> | null
  /** The widget's own filter (object or JSON text). */
  widgetFilter?: unknown
  /** The widget's own `{field, op, value}` rules (report widgets). */
  widgetRules?: Array<{ field?: string; op?: string; value?: unknown }> | null
  /** Extra plain-word lines a host wants on the picture. */
  extra?: string[]
  labels?: SentenceLabels
}

export interface WidgetImageLabel {
  title: string
  asOf: string
  /** Every filter in effect, one plain sentence each; empty = none. */
  filters: string[]
}

/** Everything that is printed on the picture, in order. */
export function buildWidgetImageLabel(input: WidgetImageInput): WidgetImageLabel {
  const L = input.labels ?? {}
  const seen = new Set<string>()
  const filters: string[] = []
  const add = (list: Array<string | null | undefined>) => {
    for (const s of list) {
      const t = s?.trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        filters.push(t)
      }
    }
  }
  add([describeDateRangeFilter(input.dateRange)])
  add(describeGlobalFilters(input.dashboardFilters, L))
  add(describeEntityFilters(input.entityFilters, L))
  add(describeWidgetOwnFilter(input.widgetFilter, L))
  add(describeWidgetRules(input.widgetRules, L))
  add(input.extra ?? [])
  return {
    title: input.title?.trim() || 'Figure',
    asOf: formatAsOf(input.asOf ?? new Date()),
    filters
  }
}

/** The lines under the title: "As of …", then the filters or "No filters". */
export function widgetImageSubtitleLines(label: WidgetImageLabel): string[] {
  return [label.asOf, label.filters.length ? `Filters: ${label.filters.join(' · ')}` : 'No filters']
}

/** "Open-orders-2026-11-14-2145.png" — safe on every file system. */
export function widgetImageFileName(
  title: string,
  when: Date | number | string = new Date()
): string {
  const d = when instanceof Date ? when : new Date(when)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = Number.isNaN(d.getTime())
    ? ''
    : `-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const base =
    (title || 'figure')
      .normalize('NFKD')
      .replace(/[^\w\s-]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'figure'
  return `${base}${stamp}.png`
}
