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

/**
 * The person's OWN totals choices for one list (this browser), column → function or 'off'.
 * They lie over whatever the open view states (2026-11-14): a view that totals one column
 * never wipes the person's other choices, and the view's totals are never written here.
 */
export type TotalOverride = TotalFn | 'off'
export type TotalOverrides = Record<string, TotalOverride>

const isOverride = (v: unknown): v is TotalOverride => v === 'off' || isTotalFn(v)

/**
 * Reads the stored overrides. The first shape (2026-11-13) was a flat `{column: fn}` map of
 * what the list showed; each entry is read as the person's choice for that column.
 */
export function loadTotalOverrides(collection: string): TotalOverrides {
  return loadTotalOverridesAt(storeKey(collection), totalsEligibleKey)
}

export function rememberTotalOverrides(collection: string, overrides: TotalOverrides): void {
  rememberTotalOverridesAt(storeKey(collection), overrides)
}

/**
 * The same choices under any list's own storage key (a queue worklist keeps its own,
 * `nvr_queue_totals_<queue id>`, with `extra.` / `formula.` column keys).
 */
export function loadTotalOverridesAt(
  key: string,
  eligible: (column: string) => boolean
): TotalOverrides {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    if (!parsed || typeof parsed !== 'object') return {}
    const map =
      parsed.v === 2 && parsed.o && typeof parsed.o === 'object'
        ? (parsed.o as Record<string, unknown>)
        : parsed
    const out: TotalOverrides = {}
    for (const [k, v] of Object.entries(map)) if (eligible(k) && isOverride(v)) out[k] = v
    return out
  } catch {
    return {}
  }
}

export function rememberTotalOverridesAt(key: string, overrides: TotalOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify({ v: 2, o: overrides }))
  } catch {
    /* private window / blocked storage: the choice lasts this visit only */
  }
}

/** What the list shows: the view's totals with the person's own choices laid over them. */
export function shownTotals(
  viewTotals: Record<string, TotalFn>,
  overrides: TotalOverrides
): Record<string, TotalFn> {
  const out: Record<string, TotalFn> = { ...viewTotals }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === 'off') delete out[k]
    else out[k] = v
  }
  return out
}

/** The person picks a function (null = off) for one column. */
export function setOverride(
  overrides: TotalOverrides,
  key: string,
  fn: TotalFn | null
): TotalOverrides {
  return { ...overrides, [key]: fn ?? 'off' }
}

/**
 * After a view is saved with the totals on screen, a choice that now says the same as the
 * view is no longer the person's own: it follows the view from here on.
 */
export function overridesAfterSave(
  overrides: TotalOverrides,
  saved: Record<string, TotalFn>
): TotalOverrides {
  const out: TotalOverrides = {}
  for (const [k, v] of Object.entries(overrides)) {
    const same = v === 'off' ? !saved[k] : saved[k] === v
    if (!same) out[k] = v
  }
  return out
}

/** The field facts the totals choice reads. */
export interface TotalsField {
  field: string
  type?: string | null
  computed_type?: string | null
  computed_formula?: string | null
  computed_store?: boolean | null
}

/** A calculated field the list works out when it reads is not a column the server can total. */
export function isStoredField(f: TotalsField): boolean {
  return !f.computed_formula || !!f.computed_store
}

const NUMBER_TYPES = new Set(['integer', 'bigInteger', 'biginteger', 'decimal', 'float'])

export type TotalTerm = { field: string; sign: 1 | -1 }

/**
 * The fields a formula adds and takes away, when that is ALL it does: `item.a - item.b`,
 * `item.a + (item.b - item.c)`, `coalesce(item.a, 0) - item.b`, `{{a}} - {{b}}`. Then the
 * sum of the formula over the rows is the same sums added and taken away (an empty value
 * counts as 0 both ways). Anything else — a constant, ×, ÷, a function, a condition — gives
 * null: its sum cannot be built from the columns' sums.
 */
export function linearSumTerms(formula: string): TotalTerm[] | null {
  const src = String(formula ?? '').trim()
  if (!src) return null
  let i = 0
  const ws = () => {
    while (i < src.length && /\s/.test(src[i] as string)) i++
  }
  const ref = (): string | null => {
    ws()
    const rest = src.slice(i)
    const item = /^item\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
    if (item) {
      i += item[0].length
      return item[1] as string
    }
    // A dotted name (`{{extra.amount}}`, a queue formula column) is kept whole; the caller
    // decides whether it names a column it can sum.
    const mustache = /^\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/.exec(rest)
    if (mustache) {
      i += mustache[0].length
      return mustache[1] as string
    }
    const co = /^coalesce\s*\(/i.exec(rest)
    if (co) {
      i += co[0].length
      const inner = ref()
      const zero = /^\s*,\s*0(?:\.0+)?\s*\)/.exec(src.slice(i))
      if (!inner || !zero) return null
      i += zero[0].length
      return inner
    }
    return null
  }
  const counts = new Map<string, number>()
  const expr = (sign: 1 | -1): boolean => {
    let first = true
    for (;;) {
      ws()
      let s: 1 | -1 = sign
      if (src[i] === '+' || src[i] === '-') {
        if (src[i] === '-') s = s === 1 ? -1 : 1
        i++
        ws()
      } else if (!first) return false
      first = false
      if (src[i] === '(') {
        i++
        if (!expr(s)) return false
        ws()
        if (src[i] !== ')') return false
        i++
      } else {
        const f = ref()
        if (!f) return false
        counts.set(f, (counts.get(f) ?? 0) + s)
      }
      ws()
      if (i >= src.length || src[i] === ')') return true
      if (src[i] !== '+' && src[i] !== '-') return false
    }
  }
  if (!expr(1)) return null
  ws()
  if (i !== src.length) return null
  const terms: TotalTerm[] = []
  for (const [field, n] of counts) {
    if (n === 1 || n === -1) terms.push({ field, sign: n })
    else if (n !== 0) return null
  }
  return terms.length ? terms : null
}

export type TotalsSupport =
  | { kind: 'server' }
  | { kind: 'derived'; terms: TotalTerm[] }
  | { kind: 'none'; why: string }

/**
 * Whether the totals row can show a figure for this number field, and how: the server totals
 * a stored column; a calculated field that only adds and takes away stored number columns is
 * summed from their sums; anything else says why it has no total (the choice is never
 * offered and then silently dropped).
 */
export function totalsSupport(
  f: TotalsField,
  fieldOf: (name: string) => TotalsField | undefined
): TotalsSupport {
  if (isStoredField(f)) return { kind: 'server' }
  if (f.computed_type !== 'rollup') {
    const terms = linearSumTerms(f.computed_formula ?? '')
    if (
      terms?.every((t) => {
        const tf = fieldOf(t.field)
        return !!tf && isStoredField(tf) && NUMBER_TYPES.has(String(tf.type ?? ''))
      })
    )
      return { kind: 'derived', terms }
  }
  return {
    kind: 'none',
    why:
      f.computed_type === 'rollup'
        ? 'Worked out from linked records each time the list is read, so it has no total.'
        : 'Calculated each time the list is read from a formula that does more than add and subtract stored columns, so it has no total.'
  }
}

/** A derived sum from its inputs' sums; null while any input is missing. */
export function combineTerms(
  terms: TotalTerm[],
  sums: (field: string) => number | null
): number | null {
  let total = 0
  for (const t of terms) {
    const v = sums(t.field)
    if (v == null) return null
    total += t.sign * v
  }
  return Math.round(total * 1e6) / 1e6
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
