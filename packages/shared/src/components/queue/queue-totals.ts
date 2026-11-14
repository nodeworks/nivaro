/**
 * Queue worklist totals row (2026-11-14) — the collection list's totals row (cbv/column-totals.ts:
 * the same functions, menu, remembered choices and "no total" rules) on a queue table.
 *
 * The figures come from the server over the WHOLE result the viewer sees with the current
 * scope tab and column filters (`GET /queues/:id/items?totals=<paths>`, the same gated read as
 * the rows): every function's figure for every asked column, combined across the queue's
 * sources, plus the same per source collection. So switching Sum → Average reads nothing.
 * Pure helpers; the hook-up lives in QueueWorklist.
 */
import {
  combineTerms,
  linearSumTerms,
  TOTAL_FNS,
  type TotalFn,
  type TotalTerm,
  totalTip
} from '../cbv/column-totals'

/** One column's figures over some rows (min / max null when nothing was filled in). */
export interface QueueTotalPart {
  sum: number
  count: number
  min: number | null
  max: number | null
}

export interface QueueColumnTotal extends QueueTotalPart {
  avg: number | null
  by_collection?: Record<string, QueueTotalPart>
}

/** `totals` on the items answer: extra-column path → its figures. */
export type QueueTotalsAnswer = Record<string, QueueColumnTotal>

/** Where a queue keeps one person's own totals choices (this browser). */
export const queueTotalsStoreKey = (queueId: string) => `nvr_queue_totals_${queueId}`

/** A queue column key that may carry a total: an extra column or a formula column. */
export function queueTotalsEligibleKey(key: string): boolean {
  return /^(extra|formula)\.[A-Za-z_][\w.]*$/.test(key)
}

export type QueueTotalsSupport =
  /** The server totals this extra-column path. */
  | { kind: 'server'; path: string }
  /** A formula column that only adds and subtracts number columns: summed from their sums. */
  | { kind: 'derived'; terms: TotalTerm[] }
  | { kind: 'none'; why: string }

export interface QueueTotalsContext {
  /** extra_field_meta from GET /queues/:id. */
  meta?: Array<{
    path: string
    number?: boolean
    no_total?: string
    multi_value?: boolean
    aggregate?: string | null
  }> | null
  /** Paths any source formats as a number (column_formats type 'number'). */
  numberFormatPaths?: Set<string>
  /** display_config.formula_columns. */
  formulas?: Array<{ key: string; formula: string }> | null
}

export const FORMULA_NO_TOTAL =
  'Worked out in the list from a formula that does more than add and subtract number columns, so it has no total.'

function extraSupport(path: string, ctx: QueueTotalsContext): QueueTotalsSupport | null {
  const m = ctx.meta?.find((x) => x.path === path)
  // Several values per row ("2026, 2027") are never one number, whatever the format says.
  if (m?.multi_value && !m.aggregate) return null
  if (m?.no_total) return { kind: 'none', why: m.no_total }
  if (m?.number || ctx.numberFormatPaths?.has(path)) return { kind: 'server', path }
  return null
}

/**
 * Whether a queue column has a totals row figure, and how. Null = not a number column (no
 * totals entry in its menu). A formula column always says which: Sum from its inputs' sums,
 * or why it has none — the choice is never offered and then dropped.
 */
export function queueTotalsSupport(
  key: string,
  ctx: QueueTotalsContext
): QueueTotalsSupport | null {
  if (key.startsWith('extra.')) return extraSupport(key.slice('extra.'.length), ctx)
  if (key.startsWith('formula.')) {
    const fc = ctx.formulas?.find((f) => `formula.${f.key}` === key)
    if (!fc) return null
    const terms = linearSumTerms(fc.formula)
    const paths = terms?.map((t) =>
      t.field.startsWith('extra.') ? t.field.slice('extra.'.length) : null
    )
    if (terms && paths?.every((p) => p != null && extraSupport(p, ctx)?.kind === 'server'))
      return {
        kind: 'derived',
        terms: terms.map((t, i) => ({ field: paths[i] as string, sign: t.sign }))
      }
    return { kind: 'none', why: FORMULA_NO_TOTAL }
  }
  return null
}

/**
 * The columns a list shows totals for: the person's / view's choice, on a column that can
 * have one (a formula column only ever Sum).
 */
export function queueTotalColumns(
  aggs: Record<string, TotalFn>,
  support: (key: string) => QueueTotalsSupport | null
): string[] {
  return Object.keys(aggs).filter((k) => {
    const s = support(k)
    return s?.kind === 'server' || (s?.kind === 'derived' && aggs[k] === 'sum')
  })
}

/** The extra-column paths the server is asked to total for those columns (≤12, stable order). */
export function queueTotalPaths(
  columns: string[],
  support: (key: string) => QueueTotalsSupport | null
): string[] {
  const out: string[] = []
  for (const k of columns) {
    const s = support(k)
    const paths =
      s?.kind === 'server' ? [s.path] : s?.kind === 'derived' ? s.terms.map((t) => t.field) : []
    for (const p of paths) if (!out.includes(p)) out.push(p)
  }
  return out.sort().slice(0, 12)
}

/** One function's figure out of a column's figures; null = nothing to show. */
export function pickTotal(t: QueueTotalPart & { avg?: number | null }, fn: TotalFn): number | null {
  if (fn === 'count') return t.count
  if (t.count <= 0) return null
  if (fn === 'sum') return t.sum
  if (fn === 'min') return t.min
  if (fn === 'max') return t.max
  return t.avg ?? (t.count > 0 ? t.sum / t.count : null)
}

/** A column's footer figure from the answer (undefined = not in the answer yet). */
export function queueTotalValue(
  answer: QueueTotalsAnswer | null | undefined,
  support: QueueTotalsSupport,
  fn: TotalFn
): number | null | undefined {
  if (!answer) return undefined
  if (support.kind === 'server') {
    const t = answer[support.path]
    return t ? pickTotal(t, fn) : undefined
  }
  if (support.kind === 'derived') {
    if (support.terms.some((t) => !answer[t.field])) return undefined
    // An input with nothing filled in sums to 0 (the formula reads an empty value as 0);
    // only when every input is empty is there no figure.
    if (support.terms.every((t) => (answer[t.field]?.count ?? 0) === 0)) return null
    return combineTerms(support.terms, (f) => answer[f]?.sum ?? 0)
  }
  return null
}

/**
 * The footer figure's tooltip: what it is over, and — when the column's rows come from more
 * than one source — the same figure per source.
 */
export function queueTotalTip(opts: {
  fn: TotalFn
  label: string
  rows: number | null
  /** Per source collection (server columns only). */
  byCollection?: Record<string, QueueTotalPart>
  collectionLabel?: (c: string) => string
  format: (v: number) => string
  partial?: boolean
  derivedText?: string
}): string {
  let tip = totalTip(opts.fn, opts.label, opts.rows)
  if (opts.derivedText) tip += `, worked out as ${opts.derivedText}`
  const parts = Object.entries(opts.byCollection ?? {})
  if (parts.length > 1) {
    const short = TOTAL_FNS.find((t) => t.fn === opts.fn)?.short ?? opts.fn
    const each = parts
      .map(([c, p]) => {
        const v = pickTotal(p, opts.fn)
        return `${opts.collectionLabel?.(c) ?? c} ${v == null ? '—' : opts.format(v)}`
      })
      .join(' · ')
    tip += `. ${short} by source: ${each}`
  }
  if (opts.partial)
    tip +=
      '. This worklist is past its read limit, so the figure covers the rows it read, not every record.'
  return tip
}

/** A formula column's format as a number format the totals can read. */
export function formulaTotalFormat(format?: 'currency' | 'number' | null) {
  return format === 'currency'
    ? ({ type: 'number', decimals: 2, thousands: true, prefix: '$' } as const)
    : null
}
