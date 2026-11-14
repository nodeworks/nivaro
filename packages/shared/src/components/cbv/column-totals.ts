/**
 * List totals row (2026-11-13): per number column, a footer figure over the
 * WHOLE filtered result — Sum (default), Average, Min, Max or Count — computed
 * by the server as the viewer (`GET /items/:c/aggregate`, the same gated query
 * a list read builds: search, column conditions, row filters, User Scopes,
 * the field list). One request per column with totals on, so turning a second
 * column on never re-asks the first. Pure helpers; the hook lives in the view.
 */
import { type ColumnFormatConfig, formatValue } from '../../lib/format-value'

export type TotalFn = 'sum' | 'avg' | 'min' | 'max' | 'count'

export const TOTAL_FNS: Array<{ fn: TotalFn; label: string; short: string }> = [
  { fn: 'sum', label: 'Sum', short: 'Sum' },
  { fn: 'avg', label: 'Average', short: 'Avg' },
  { fn: 'min', label: 'Minimum', short: 'Min' },
  { fn: 'max', label: 'Maximum', short: 'Max' },
  { fn: 'count', label: 'Count (filled in)', short: 'Count' }
]

export function isTotalFn(v: unknown): v is TotalFn {
  return typeof v === 'string' && TOTAL_FNS.some((t) => t.fn === v)
}

/** A column the server can total: a plain column of this collection, not a path or a synthetic one. */
export function totalsEligibleKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
}

/** Query params for one column's total, with the list's own search + conditions. */
export function totalsParams(
  key: string,
  fn: TotalFn,
  list: { search?: string; conditions?: string }
): Record<string, string> {
  return {
    [fn]: key,
    ...(list.search ? { search: list.search } : {}),
    ...(list.conditions ? { conditions: list.conditions } : {})
  }
}

type AggregateAnswer = {
  data?: Array<Partial<Record<TotalFn, Record<string, unknown> | undefined>>>
}

/** The figure out of an aggregate answer; null = no rows / nothing to total. */
export function readTotal(res: AggregateAnswer | null | undefined, key: string, fn: TotalFn) {
  const v = res?.data?.[0]?.[fn]?.[key]
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** How a total reads: counts as whole numbers, the rest in the column's own format. */
export function formatTotal(v: number, fn: TotalFn, format?: ColumnFormatConfig | null): string {
  if (fn === 'count') return Math.round(v).toLocaleString('en-US')
  if (format?.type === 'number') return formatValue(String(v), format)
  const rounded = Math.round(v * 100) / 100
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const storeKey = (collection: string) => `nvr_cbv_totals_${collection}`

/** The person's last totals choice for this list (this browser); {} when none or unreadable. */
export function loadRememberedTotals(collection: string): Record<string, TotalFn> {
  try {
    const raw = localStorage.getItem(storeKey(collection))
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, TotalFn> = {}
    for (const [k, v] of Object.entries(parsed))
      if (totalsEligibleKey(k) && isTotalFn(v)) out[k] = v
    return out
  } catch {
    return {}
  }
}

export function rememberTotals(collection: string, totals: Record<string, TotalFn>): void {
  try {
    if (Object.keys(totals).length === 0) localStorage.removeItem(storeKey(collection))
    else localStorage.setItem(storeKey(collection), JSON.stringify(totals))
  } catch {
    /* private window / blocked storage: the choice lasts this visit only */
  }
}

/** The tooltip on a footer figure. */
export function totalTip(fn: TotalFn, label: string, rows: number | null): string {
  const what = TOTAL_FNS.find((t) => t.fn === fn)?.label.toLowerCase() ?? fn
  const over =
    rows == null ? 'all matching records' : `all ${rows.toLocaleString('en-US')} matching records`
  return fn === 'count'
    ? `Records with ${label} filled in, across ${over}`
    : `${what.charAt(0).toUpperCase()}${what.slice(1)} of ${label} across ${over}`
}
