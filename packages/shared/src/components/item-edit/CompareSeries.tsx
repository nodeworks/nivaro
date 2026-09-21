import { useQuery } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { NivaroClient } from '@nivaro/sdk'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * Comparison series for an inline grid (`options.compare_series`).
 *
 * A second, read-only line of figures under the grid's own cells — "what
 * actually happened" beside "what was planned" — fetched from an endpoint the
 * layout names. The grid stays domain-blind: the endpoint says which row key
 * and columns it speaks about, which columns are closed (final), the verdict
 * it wants shown, and what each figure is made of. Any month × key planning
 * grid whose "what really happened" lives elsewhere fits the contract — the
 * nouns (what a detail row IS, what the grid's own figures are called) come
 * from the endpoint too, so this file never names a domain.
 *
 * Contract (endpoint response, under `data`):
 *   label            'Actual' — the series name
 *   plan_label       'Plan' — what the grid's own figures are called (default 'Plan')
 *   unit             { one, many } — the noun for a detail row (default entry/entries)
 *   key_field        the grid column that identifies a row (e.g. 'year')
 *   columns          the grid columns the series speaks about
 *   rows[]           { key, values: {column: number}, details?: {column: DetailRow[]} }
 *   closed_through   'YYYY-MM' | null — month columns at or before it are final
 *   closed_rule      one sentence explaining how a month closes
 *   status           { key, label, tone, reason } | null — the verdict + why
 *   figures[]        { label, value, format } — strip chips beside the grid's own
 */

export interface CompareSeriesConfig {
  /** `/my-extension/actuals/{{$parent.id}}` — `{{$parent.<field>}}` tokens read the parent draft. */
  endpoint: string
  label?: string
}

export interface CompareDetailRow {
  id: number | string
  label: string
  sub?: string | null
  amount: number
  date?: string | null
  tone?: 'ok' | 'warn' | 'danger' | 'neutral'
  note?: string | null
  meta?: Array<{ label: string; value: string }>
}

export interface CompareSeriesRow {
  key: string | number
  values: Record<string, number>
  details?: Record<string, CompareDetailRow[]>
  /** The same figures broken down by the grid's category column (row_split
   *  grids). Keys are category ids; whatever the endpoint could not place
   *  sits under 'unclassified'. `values` stays the sum of every entry. */
  by_category?: Record<
    string,
    { values: Record<string, number>; details?: Record<string, CompareDetailRow[]> }
  >
}

/** An extra read-only line under the actual ('Committed' beside 'Actual'). */
export interface CompareExtraSeries {
  key: string
  label: string
  /** One sentence on how the figures were placed — shown on hover. */
  hint?: string
  rows: Array<{ key: string | number; values: Record<string, number> }>
  /** What the whole line adds up to. A period's figure is a SHARE of it, so
   *  the sources below describe the line, not one period. */
  total?: number
  /** Heading over `details` — "Open on linked purchase orders". */
  details_label?: string
  /** The records the line is made of. With these the figure is clickable. */
  details?: CompareDetailRow[]
}

/** Values the endpoint suggests for empty cells; the grid stages them only on
 *  Apply, never over a filled cell or a closed column. */
export interface CompareProposal {
  id: string
  label: string
  reason: string
  /** Stored as the change reason on every row the apply touches. */
  change_reason?: string
  /** `category` places a row on that split line of the key; absent = the key's single line. */
  rows: Array<{ key: string | number; category?: string | number; values: Record<string, number> }>
  /**
   * `fill` (default): figures land on EMPTY open periods only. `add`: figures are
   * added to what the open periods already hold (a negative figure takes away,
   * never below zero) — for a total that moved, not a plan that is missing.
   */
  mode?: 'fill' | 'add'
}

export interface CompareSeriesData {
  label: string
  plan_label?: string
  unit?: { one: string; many: string }
  key_field: string
  columns: string[]
  rows: CompareSeriesRow[]
  closed_through: string | null
  closed_rule?: string
  /** Closed columns are refused by the writer unless set to the actual;
   *  the grid shows them read-only (admins may still edit, with a reason). */
  closed_locked?: boolean
  closed_locked_message?: string
  status?: { key: string; label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral'; reason?: string } | null
  figures?: Array<{ label: string; value: number; format?: 'currency' | 'number' }>
  series?: CompareExtraSeries[]
  proposals?: CompareProposal[]
}

/** The extra series' value for a (row, column), null when it has none. */
/** A figure of an extra series, clickable when the endpoint says what the line
 *  is made of: the period's share, the whole line, how it was placed, and the
 *  records behind it. Without `details` it is plain text, as before. */
export function SeriesFigurePopover(props: {
  series: CompareExtraSeries
  value: number
  /** "October 2026" */
  periodLabel: string
  /** Total-column figure: the popover describes the whole row, not a period. */
  whole?: boolean
  children: React.ReactNode
}) {
  const { series: s, value, periodLabel, whole, children } = props
  const [open, setOpen] = useState(false)
  const details = s.details ?? []
  if (details.length === 0 && s.total == null) return <>{children}</>
  const total = s.total ?? null
  const pct = total && total > 0.005 ? Math.round((value / total) * 1000) / 10 : null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-compare-series-details={s.key}
          data-tip=''
          className='rounded px-0.5 underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:decoration-solid'
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' sideOffset={6} className='w-[360px] p-0 text-[12px]'>
        <div className='border-b border-slate-200 px-3 py-2 dark:border-border'>
          <p className='text-[12.5px] font-semibold text-slate-900 dark:text-slate-100'>
            {`${s.label} · ${periodLabel}`}
          </p>
          <dl className='mt-1 grid grid-cols-3 gap-2 tabular-nums'>
            <div>
              <dt className='text-[10.5px] text-slate-500 dark:text-slate-400'>
                {whole ? 'This row' : 'This period'}
              </dt>
              <dd className='font-medium text-slate-800 dark:text-slate-100'>{fmtMoney(value)}</dd>
            </div>
            {total != null && (
              <div>
                <dt className='text-[10.5px] text-slate-500 dark:text-slate-400'>Whole line</dt>
                <dd className='font-medium text-slate-800 dark:text-slate-100'>{fmtMoney(total)}</dd>
              </div>
            )}
            {pct != null && (
              <div>
                <dt className='text-[10.5px] text-slate-500 dark:text-slate-400'>Share</dt>
                <dd className='font-medium text-slate-800 dark:text-slate-100'>{`${pct}%`}</dd>
              </div>
            )}
          </dl>
          {s.hint ? (
            <p className='mt-1.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400'>{s.hint}</p>
          ) : null}
        </div>
        {details.length > 0 ? (
          <>
            {s.details_label ? (
              <p className='px-3 pt-1.5 text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>
                {s.details_label}
              </p>
            ) : null}
            <ul className='max-h-[200px] overflow-y-auto overscroll-contain px-3 py-1' data-compare-series-list=''>
              {details.map((d) => (
                <li key={String(d.id)} className='py-1' data-compare-series-row={String(d.id)}>
                  <div className='flex items-baseline gap-2'>
                    <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200'>
                      {d.label}
                      {d.sub ? (
                        <span className='text-slate-500 dark:text-slate-400'>{` · ${d.sub}`}</span>
                      ) : null}
                    </span>
                    <span className='tabular-nums text-slate-800 dark:text-slate-100'>
                      {fmtMoney(d.amount)}
                    </span>
                  </div>
                  {(d.date || (d.meta?.length ?? 0) > 0 || d.note) && (
                    <p className='truncate text-[10.5px] text-slate-500 dark:text-slate-400'>
                      {[d.date, ...(d.meta ?? []).map((x) => `${x.label} ${x.value}`), d.note]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className='border-t border-slate-100 px-3 py-1 text-[10.5px] tabular-nums text-slate-500 dark:border-border dark:text-slate-400'>
              {`${details.length} ${details.length === 1 ? 'record' : 'records'}`}
            </p>
          </>
        ) : (
          <p className='px-3 py-2 text-slate-500 dark:text-slate-400'>Nothing listed behind this line.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function extraSeriesValue(
  s: CompareExtraSeries,
  rowKey: unknown,
  column: string
): number | null {
  const r = s.rows.find((x) => String(x.key) === String(rowKey))
  const v = r?.values[column]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Sum of a closed month's plan − actual over every closed month of a row. */
export function closedVariance(
  data: CompareSeriesData,
  cmpRow: CompareSeriesRow | null,
  plannedRow: Record<string, unknown>
): { diff: number; months: number } | null {
  const rowKey = plannedRow[data.key_field]
  let diff = 0
  let months = 0
  for (const c of data.columns) {
    if (!isMonth(c) || !compareColumnClosed(data, rowKey, c)) continue
    const planned = Number(plannedRow[c]) || 0
    const actual = cmpRow?.values[c] ?? 0
    if (planned === 0 && actual === 0) continue
    months++
    diff += actual - planned
  }
  return months ? { diff, months } : null
}

/** Open month columns of a row that come AFTER `column` — where a closed
 *  month's unspent remainder can go. */
export function openColumnsAfter(data: CompareSeriesData, rowKey: unknown, column: string): string[] {
  const from = MONTHS.indexOf(column)
  return data.columns.filter(
    (c) => isMonth(c) && MONTHS.indexOf(c) > from && !compareColumnClosed(data, rowKey, c)
  )
}

export function monthLabel(column: string): string {
  const i = MONTHS.indexOf(column)
  return i < 0 ? column : MONTH_SHORT[i]
}

export function monthLabelLong(column: string): string {
  const i = MONTHS.indexOf(column)
  return i < 0 ? column : column.charAt(0).toUpperCase() + column.slice(1)
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `{{$parent.<field>}}` tokens → values; null while any token is unresolved. */
export function resolveCompareEndpoint(
  endpoint: string,
  parentDraft: Record<string, unknown> | null | undefined
): string | null {
  let unresolved = false
  const out = endpoint.replace(/\{\{\s*\$parent\.(\w+)\s*\}\}/g, (_, f: string) => {
    const v = parentDraft?.[f]
    if (v == null || v === '' || v === 'new') {
      unresolved = true
      return ''
    }
    return encodeURIComponent(String(v))
  })
  return unresolved ? null : out
}

export function useCompareSeries(opts: {
  client: NivaroClient | null | undefined
  endpoint: string | null
  enabled: boolean
}) {
  return useQuery<CompareSeriesData | null>({
    queryKey: ['o2m-compare', opts.endpoint ?? ''],
    queryFn: async () => {
      if (!opts.client || !opts.endpoint) return null
      const r = await opts.client.request<{ data: CompareSeriesData }>(get(opts.endpoint))
      return r?.data ?? null
    },
    enabled: opts.enabled && !!opts.endpoint && !!opts.client,
    staleTime: 60_000,
    retry: 1
  })
}

/** The series row for a grid row, matched on the endpoint's key field. */
export function compareRowFor(
  data: CompareSeriesData | null | undefined,
  row: Record<string, unknown> | null | undefined
): CompareSeriesRow | null {
  if (!data || !row) return null
  const key = row[data.key_field]
  if (key == null || key === '') return null
  return data.rows.find((r) => String(r.key) === String(key)) ?? null
}

/** Month columns at or before `closed_through` are final; other columns never are. */
export function compareColumnClosed(
  data: CompareSeriesData | null | undefined,
  rowKey: unknown,
  column: string
): boolean {
  if (!data?.closed_through) return false
  const m = MONTHS.indexOf(column)
  if (m < 0) return false
  const year = Number(rowKey)
  if (!Number.isFinite(year)) return false
  const [cy, cm] = data.closed_through.split('-').map(Number)
  return year * 12 + m <= cy * 12 + (cm - 1)
}

export function closedThroughLabel(closedThrough: string | null | undefined): string | null {
  if (!closedThrough) return null
  const [y, m] = closedThrough.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null
  return `${MONTH_SHORT[m - 1] ?? ''} ${y}`.trim()
}

const isMonth = (column: string) => MONTHS.includes(column)

export function fmtMoney(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 100_000)
    return n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1
    })
  // Always cents: the figure sits directly under a grid value rendered with
  // two decimals, and "$18,091" beside "$18,091.00" reads as two numbers.
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}

const TONE_TEXT: Record<string, string> = {
  ok: 'text-[color:var(--nvr-role-positive,#15803d)] dark:text-[color:var(--nvr-role-positive-dark,#9fbf8a)]',
  warn: 'text-[color:var(--nvr-role-warning,#b45309)] dark:text-[color:var(--nvr-role-warning-dark,#d4936a)]',
  danger:
    'text-[color:var(--nvr-role-negative,#dc2626)] dark:text-[color:var(--nvr-role-negative-dark,#e08383)]',
  neutral: 'text-slate-500 dark:text-slate-400'
}
const TONE_DOT: Record<string, string> = {
  ok: 'bg-[color:var(--nvr-role-positive,#15803d)] dark:bg-[color:var(--nvr-role-positive-dark,#9fbf8a)]',
  warn: 'bg-[color:var(--nvr-role-warning,#b45309)] dark:bg-[color:var(--nvr-role-warning-dark,#d4936a)]',
  danger: 'bg-[color:var(--nvr-role-negative,#dc2626)] dark:bg-[color:var(--nvr-role-negative-dark,#e08383)]',
  neutral: 'bg-slate-400'
}

/**
 * How a planned/actual pair reads. A closed month whose figures disagree is
 * the reviewable case (warn); an OPEN month already spent past its plan
 * is the alarming one (danger); everything else is quiet.
 */
export function compareTone(
  planned: number,
  actual: number,
  closed: boolean
): 'warn' | 'danger' | 'neutral' | 'ok' {
  const diff = actual - planned
  if (Math.abs(diff) < 0.005) return planned === 0 ? 'neutral' : 'ok'
  if (closed) return 'warn'
  if (diff > 0) return 'danger'
  return 'neutral'
}

/** What a reconcile does to a row: the closed column takes the actual and the
 *  difference moves to (or comes out of) one open column. Pure. */
export function reconcilePlan(args: {
  data: CompareSeriesData
  rowKey: unknown
  column: string
  plannedRow: Record<string, unknown>
  actual: number
  target: string | null
}): { patch: Record<string, number>; moved: number; targetShort: number } {
  const { column, plannedRow, actual, target } = args
  const planned = Number(plannedRow[column]) || 0
  const remainder = Math.round((planned - actual) * 100) / 100
  const patch: Record<string, number> = { [column]: actual }
  let moved = 0
  let targetShort = 0
  if (target && Math.abs(remainder) >= 0.005) {
    const cur = Number(plannedRow[target]) || 0
    // Unspent (planned > actual) moves forward; overspend comes out of the
    // target, never below zero — what the target cannot cover is reported.
    const next = Math.max(0, Math.round((cur + remainder) * 100) / 100)
    moved = Math.round((next - cur) * 100) / 100
    targetShort = Math.round((cur + remainder - next) * 100) / 100
    patch[target] = next
  }
  return { patch, moved, targetShort }
}

/**
 * "Set <month> to actual, move the remainder to <month>" — the one-click
 * reconcile (display popover) and the carry-forward (row editor) share it.
 * Stages nothing itself: `onApply` receives the patch and a prefilled reason.
 */
export function ReconcileAction(props: {
  data: CompareSeriesData
  rowKey: unknown
  column: string
  columnLabel: string
  plannedRow: Record<string, unknown>
  actual: number
  onApply: (patch: Record<string, number>, reason: string) => void
  /** 'link' inside the popover, 'button' in the row editor. */
  variant?: 'link' | 'button'
}) {
  const { data, rowKey, column, columnLabel, plannedRow, actual, onApply, variant = 'link' } = props
  const [open, setOpen] = useState(false)
  const planned = Number(plannedRow[column]) || 0
  const remainder = Math.round((planned - actual) * 100) / 100
  const targets = useMemo(() => openColumnsAfter(data, rowKey, column), [data, rowKey, column])
  const [target, setTarget] = useState<string | null>(null)
  useEffect(() => {
    if (open) setTarget(targets[0] ?? null)
  }, [open, targets])
  const plan = reconcilePlan({ data, rowKey, column, plannedRow, actual, target })
  const defaultReason = () => {
    const base = `Reconciled ${columnLabel} ${String(rowKey)} to invoiced (${fmtMoney(actual)})`
    if (!target || Math.abs(plan.moved) < 0.005) return base
    return remainder > 0
      ? `${base} — moved ${fmtMoney(plan.moved)} to ${monthLabelLong(target)}`
      : `${base} — took ${fmtMoney(-plan.moved)} from ${monthLabelLong(target)}`
  }
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason(defaultReason())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target])
  if (Math.abs(remainder) < 0.005) return null
  const plan_ = planLabel(data).toLowerCase()
  const apply = () => {
    onApply(plan.patch, reason.trim() || defaultReason())
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-compare-reconcile={column}
          data-tip=''
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            variant === 'button'
              ? 'inline-flex h-6 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-background dark:text-slate-200 dark:hover:bg-white/5'
              : // Wraps at word boundaries inside a narrow month cell ("Carry" /
                // "forward" / "$1.00") instead of painting over the neighbour.
                'group/reconcile inline-flex max-w-full flex-wrap items-baseline gap-x-1 text-left text-[11px] font-medium leading-4 text-nvr-cyan'
          )}
        >
          {/* The underline lives on the label alone — a decoration on the
              button propagates onto the amount too. */}
          <span
            className={
              variant === 'link'
                ? 'underline decoration-dotted underline-offset-2 group-hover/reconcile:decoration-solid'
                : undefined
            }
          >
            {remainder > 0 ? 'Carry forward' : 'Reconcile'}
          </span>
          <span className='tabular-nums text-slate-500 dark:text-slate-400'>
            {fmtMoney(Math.abs(remainder))}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        sideOffset={6}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className='w-[360px] max-w-[calc(100vw-32px)] p-3 text-[12px]'
        data-compare-reconcile-popover
      >
        <div className='font-semibold text-slate-800 dark:text-foreground'>
          {remainder > 0 ? 'Carry the unspent remainder forward' : 'Reconcile to what was invoiced'}
        </div>
        <ol className='mt-2 space-y-1.5 text-slate-600 dark:text-slate-300'>
          <li>
            1. Set <b>{columnLabel}</b> {plan_} to the actual{' '}
            <b className='tabular-nums'>{fmtMoney(actual)}</b>{' '}
            <span className='text-slate-400'>(was {fmtMoney(planned)})</span>
          </li>
          <li>
            2.{' '}
            {targets.length === 0 ? (
              <span>
                No open month follows it on this row — the {fmtMoney(Math.abs(remainder))}{' '}
                {remainder > 0 ? 'is dropped from the plan' : 'is left unplanned'}.
              </span>
            ) : (
              <span className='inline-flex flex-wrap items-center gap-1'>
                {remainder > 0 ? 'Move' : 'Take'} <b className='tabular-nums'>{fmtMoney(Math.abs(remainder))}</b>{' '}
                {remainder > 0 ? 'to' : 'from'}
                {targets.map((t) => (
                  <button
                    key={t}
                    type='button'
                    data-compare-reconcile-target={t}
                    aria-pressed={target === t}
                    onClick={() => setTarget(t)}
                    className={cn(
                      'rounded-full border px-2 py-px text-[11px]',
                      target === t
                        ? 'border-nvr-cyan bg-nvr-cyan/10 font-semibold text-slate-800 dark:text-slate-100'
                        : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
                    )}
                  >
                    {monthLabel(t)}
                  </button>
                ))}
                <button
                  type='button'
                  data-compare-reconcile-target='__none__'
                  aria-pressed={target === null}
                  onClick={() => setTarget(null)}
                  className={cn(
                    'rounded-full border px-2 py-px text-[11px]',
                    target === null
                      ? 'border-nvr-cyan bg-nvr-cyan/10 font-semibold text-slate-800 dark:text-slate-100'
                      : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
                  )}
                >
                  nowhere
                </button>
              </span>
            )}
            {plan.targetShort > 0.005 && (
              <span className={cn('block text-[11px]', TONE_TEXT.warn)}>
                {monthLabelLong(target ?? '')} only holds {fmtMoney((Number(plannedRow[target ?? '']) || 0))} —{' '}
                {fmtMoney(plan.targetShort)} stays unplanned.
              </span>
            )}
          </li>
        </ol>
        <label className='mt-2.5 block text-[10.5px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-compare-reconcile-reason
            className='mt-1 h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] font-normal normal-case tracking-normal text-slate-800 dark:border-border dark:bg-background dark:text-slate-100'
          />
        </label>
        <div className='mt-2.5 flex justify-end gap-1.5'>
          <button
            type='button'
            onClick={() => setOpen(false)}
            className='h-7 rounded-md px-2.5 text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'
          >
            Cancel
          </button>
          <button
            type='button'
            data-compare-reconcile-apply
            onClick={apply}
            className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:opacity-90'
          >
            Stage this change
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The second line under a cell: the actual, its delta, and the invoices behind it. */
export function CompareCell(props: {
  data: CompareSeriesData
  row: CompareSeriesRow | null
  rowKey: unknown
  column: string
  planned: unknown
  /** Column label for the popover title ('September'). */
  columnLabel: string
  compact?: boolean
  /** The whole planned row — needed for the closed-variance summary and the
   *  reconcile action (both read sibling columns). */
  plannedRow?: Record<string, unknown>
  /** When the host can stage a change to this row, the popover offers the
   *  one-click reconcile on a closed month that disagrees with its actual. */
  onAdjust?: (patch: Record<string, number>, reason: string) => void
}) {
  const { data, row, rowKey, column, planned, columnLabel, compact, plannedRow, onAdjust } = props
  if (!data.columns.includes(column)) return null
  const actual = row?.values[column]
  const closed = compareColumnClosed(data, rowKey, column)
  const plannedN = Number(planned) || 0
  const extra = (data.series ?? [])
    .map((s) => ({ s, v: extraSeriesValue(s, rowKey, column) }))
    .filter((x) => x.v != null && Math.abs(x.v as number) >= 0.005)
  const extraLines = extra.length > 0 && (
    <div className='flex flex-wrap items-baseline gap-x-1' data-compare-extra=''>
      {extra.map(({ s, v }) => (
        <span
          key={s.key}
          data-compare-series={s.key}
          data-tip={s.details?.length ? '' : s.hint}
          className='flex items-baseline gap-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400'
        >
          <span className='font-mono text-[9px] uppercase tracking-wide'>{s.label}</span>
          <SeriesFigurePopover
            series={s}
            value={v as number}
            periodLabel={`${columnLabel ?? column} ${String(rowKey)}`}
          >
            <span className='tabular-nums'>{fmtMoney(v as number, compact)}</span>
          </SeriesFigurePopover>
        </span>
      ))}
    </div>
  )
  const isLast = data.columns[data.columns.length - 1] === column && !isMonth(column)
  const variance = isLast && plannedRow ? closedVariance(data, row, plannedRow) : null
  const varianceLine = variance && (
    <div
      data-compare-variance={variance.diff > 0 ? 'over' : 'under'}
      data-tip={`Closed months: ${planLabel(data).toLowerCase()} vs ${data.label.toLowerCase()} over ${variance.months} closed ${variance.months === 1 ? 'month' : 'months'}`}
      className={cn(
        'flex items-baseline gap-1 text-[11px] leading-4',
        TONE_TEXT[Math.abs(variance.diff) < 0.005 ? 'ok' : 'warn']
      )}
    >
      <span className='font-mono text-[9px] uppercase tracking-wide'>Closed Δ</span>
      <span className='tabular-nums font-medium'>
        {Math.abs(variance.diff) < 0.005 ? 'even' : `${variance.diff > 0 ? '+' : '−'}${fmtMoney(Math.abs(variance.diff), true)}`}
      </span>
      <span className='text-slate-400 dark:text-slate-500'>· {variance.months} mo</span>
    </div>
  )
  // No series row at all for this key: this row's key has nothing recorded
  // anywhere, say so once per cell quietly rather than pretending zero.
  if (!row || actual == null) {
    // A closed month with a plan but NO actual still needs reconciling —
    // the endpoint recorded nothing for it, so the actual is zero.
    const reconcileEmpty =
      closed && onAdjust && plannedRow && plannedN !== 0 ? (
        <ReconcileAction
          data={data}
          rowKey={rowKey}
          column={column}
          columnLabel={columnLabel}
          plannedRow={plannedRow}
          actual={0}
          onApply={onAdjust}
        />
      ) : null
    return (
      <div
        data-compare-cell={column}
        data-compare-empty=''
        className='mt-0.5 flex flex-wrap items-baseline gap-x-1 text-[11px] leading-4 text-slate-400 dark:text-slate-500'
      >
        <span className='font-mono text-[9px] uppercase tracking-wide'>{data.label}</span>
        <span>—</span>
        {/* The action sits on its own line under the figure: inline after the
            dash it wrapped mid-label in a month-wide cell ("Carry" / "forward"). */}
        {reconcileEmpty && <span className='basis-full pt-0.5'>{reconcileEmpty}</span>}
        {extraLines}
        {varianceLine}
      </div>
    )
  }
  const details = row.details?.[column] ?? []
  const tone = compareTone(plannedN, actual, closed)
  const diff = actual - plannedN
  const showDelta = Math.abs(diff) >= 0.005 && plannedN !== 0
  const canReconcile = closed && !!onAdjust && !!plannedRow && Math.abs(diff) >= 0.005
  const opensPopover = details.length > 0 || canReconcile
  const figure = (
    <span
      className={cn(
        'tabular-nums font-medium',
        opensPopover &&
          'cursor-pointer underline decoration-dotted decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:decoration-slate-600',
        'text-slate-700 dark:text-slate-200'
      )}
    >
      {fmtMoney(actual, compact)}
    </span>
  )
  return (
    <div
      data-compare-cell={column}
      data-compare-tone={tone}
      className='mt-0.5 flex flex-wrap items-baseline gap-x-1 text-[11px] leading-4'
    >
      <span className='font-mono text-[9px] uppercase tracking-wide text-slate-500 dark:text-slate-400'>
        {data.label}
      </span>
      {opensPopover ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type='button'
              data-compare-details
              // An empty data-tip SUPPRESSES the host cell's own instant tip
              // (cell history) while the pointer is on the figure — otherwise
              // that tip paints over the popover's title the moment it opens.
              data-tip=''
              aria-label={`${data.label} for ${columnLabel} ${String(rowKey)} — ${details.length} ${unitWord(data, details.length)}`}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className='rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
            >
              {figure}
            </button>
          </PopoverTrigger>
          <CompareDetailsPopover
            title={`${columnLabel} ${String(rowKey)}`}
            label={data.label}
            planLabel={planLabel(data)}
            unit={unitWord(data, details.length)}
            actual={actual}
            planned={plannedN}
            closed={closed}
            rows={details}
            reconcile={
              canReconcile && plannedRow ? (
                <ReconcileAction
                  data={data}
                  rowKey={rowKey}
                  column={column}
                  columnLabel={columnLabel}
                  plannedRow={plannedRow}
                  actual={actual}
                  onApply={onAdjust!}
                />
              ) : null
            }
          />
        </Popover>
      ) : (
        figure
      )}
      {showDelta && (
        <span
          data-compare-delta
          className={cn('tabular-nums text-[10.5px]', TONE_TEXT[tone])}
          data-tip={
            closed
              ? `Closed month — ${fmtMoney(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the ${planLabel(data).toLowerCase()}`
              : diff > 0
                ? `Already ${fmtMoney(diff)} over the ${planLabel(data).toLowerCase()} with the month still open`
                : `${fmtMoney(-diff)} of the ${planLabel(data).toLowerCase()} still to come`
          }
        >
          {diff > 0 ? '+' : '−'}
          {fmtMoney(Math.abs(diff), true)}
        </span>
      )}
      {extraLines}
      {varianceLine}
    </div>
  )
}

/** Endpoint-suggested values for empty cells — Apply stages them, Dismiss
 *  hides the suggestion in this browser. */
export function CompareProposalBanner(props: {
  proposals: CompareProposal[]
  onApply: (p: CompareProposal) => void
  onDismiss: (p: CompareProposal) => void
}) {
  if (props.proposals.length === 0) return null
  return (
    <div className='mb-2 space-y-1.5'>
      {props.proposals.map((p) => (
        <div
          key={p.id}
          data-compare-proposal={p.id}
          className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] dark:border-sky-900/50 dark:bg-sky-950/30'
        >
          <div className='min-w-0 flex-1'>
            <span className='font-semibold text-slate-800 dark:text-slate-100'>{p.label}</span>
            <span className='ml-2 text-slate-600 dark:text-slate-300'>{p.reason}</span>
          </div>
          <div className='flex shrink-0 gap-1.5'>
            <button
              type='button'
              data-compare-proposal-apply
              onClick={() => props.onApply(p)}
              className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white hover:opacity-90'
            >
              Apply
            </button>
            <button
              type='button'
              data-compare-proposal-dismiss
              onClick={() => props.onDismiss(p)}
              className='h-7 rounded-md px-2.5 text-[12px] text-slate-600 hover:bg-white/60 dark:text-slate-300 dark:hover:bg-white/5'
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The endpoint names the grid's own figures; 'Plan' when it doesn't. */
export function planLabel(data: Pick<CompareSeriesData, 'plan_label'> | null | undefined): string {
  return data?.plan_label?.trim() || 'Plan'
}

/** The endpoint names a detail row; 'entry'/'entries' when it doesn't. */
export function unitWord(data: Pick<CompareSeriesData, 'unit'> | null | undefined, n: number): string {
  const u = data?.unit
  if (u?.one && u?.many) return n === 1 ? u.one : u.many
  return n === 1 ? 'entry' : 'entries'
}

function CompareDetailsPopover(props: {
  title: string
  label: string
  planLabel: string
  unit: string
  actual: number
  planned: number
  closed: boolean
  rows: CompareDetailRow[]
  reconcile?: React.ReactNode
}) {
  const { title, label, planLabel: plan, unit, actual, planned, closed, rows, reconcile } = props
  const diff = actual - planned
  return (
    <PopoverContent
      align='start'
      sideOffset={6}
      onOpenAutoFocus={(e) => e.preventDefault()}
      className='w-[400px] max-w-[calc(100vw-32px)] p-0 text-[12px]'
      data-compare-popover
    >
      <div className='flex items-start justify-between gap-3 border-b border-slate-200 px-3.5 py-2.5 dark:border-border'>
        <div className='min-w-0'>
          <div className='flex items-center gap-1.5 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            {title}
            {closed && (
              <span
                className='inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-white/[0.06] dark:text-slate-400'
                data-tip='This month is closed — its actuals are final'
              >
                <Lock className='h-2.5 w-2.5' aria-hidden='true' /> Closed
              </span>
            )}
          </div>
          <div className='mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-500 dark:text-muted-foreground'>
            <span>
              {label} <b className='font-semibold text-slate-700 dark:text-slate-200'>{fmtMoney(actual)}</b>
            </span>
            <span>
              {plan} <b className='font-semibold text-slate-700 dark:text-slate-200'>{fmtMoney(planned)}</b>
            </span>
            {Math.abs(diff) >= 0.005 && (
              <span className={TONE_TEXT[compareTone(planned, actual, closed)]}>
                {diff > 0 ? '+' : '−'}
                {fmtMoney(Math.abs(diff))}
              </span>
            )}
          </div>
        </div>
        <span className='shrink-0 text-[11px] text-slate-400 dark:text-slate-500'>
          {rows.length} {unit}
        </span>
      </div>
      {reconcile && (
        <div className='flex items-center gap-2 border-b border-slate-200 px-3.5 py-2 text-[11px] text-slate-600 dark:border-border dark:text-slate-300'>
          <span>This closed month disagrees with its {label.toLowerCase()}.</span>
          {reconcile}
        </div>
      )}
      <ul className='max-h-72 overflow-y-auto py-1' data-compare-details-list>
        {rows.map((r) => (
          <li
            key={String(r.id)}
            className='flex items-start justify-between gap-3 px-3.5 py-1.5 hover:bg-muted'
            data-compare-detail-row
          >
            <div className='min-w-0'>
              <div className='truncate font-medium text-slate-800 dark:text-foreground'>
                {r.label}
                {r.sub && <span className='ml-1.5 font-normal text-slate-500 dark:text-muted-foreground'>{r.sub}</span>}
              </div>
              <div className='mt-px flex flex-wrap gap-x-2 text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                {r.date && <span>{r.date}</span>}
                {(r.meta ?? []).map((m) => (
                  <span key={m.label}>
                    <span className='text-slate-400 dark:text-slate-500'>{m.label}</span> {m.value}
                  </span>
                ))}
              </div>
              {r.note && (
                <div className={cn('mt-px text-[10.5px] font-medium', TONE_TEXT[r.tone ?? 'neutral'])}>
                  {r.note}
                </div>
              )}
            </div>
            <span className='shrink-0 tabular-nums font-medium text-slate-800 dark:text-foreground'>
              {fmtMoney(r.amount)}
            </span>
          </li>
        ))}
      </ul>
    </PopoverContent>
  )
}

/** One strip chip — the same body the grid's own figure strip uses. */
export function GridStatChip(props: {
  label: string
  value: number | null | undefined
  format?: 'currency' | 'number'
  negative?: boolean
  dataKey?: string
}) {
  const n = props.value
  const text =
    n == null
      ? '—'
      : props.format === 'currency'
        ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
        : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return (
    <div
      data-o2m-stat={props.dataKey ?? props.label}
      data-stat-negative={props.negative ? 'true' : undefined}
      className={cn(
        'flex items-baseline gap-2 rounded-md border px-2.5 py-1',
        props.negative
          ? 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30'
          : 'border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40'
      )}
    >
      <span className='text-[10.5px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
        {props.label}
      </span>
      <span
        className={cn(
          'text-[12.5px] font-semibold tabular-nums',
          props.negative ? 'text-red-700 dark:text-red-300' : 'text-slate-800 dark:text-slate-100'
        )}
      >
        {text}
      </span>
    </div>
  )
}

/** The verdict chip + closed-through legend that lead the figure strip. */
export function CompareStripChips(props: { data: CompareSeriesData | null | undefined; loading: boolean; error: boolean }) {
  const { data, loading, error } = props
  if (loading)
    return (
      <div
        data-compare-loading
        className='flex items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 dark:border-border dark:bg-muted/40'
      >
        <span className='h-3 w-28 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
      </div>
    )
  if (error)
    return (
      <div
        data-compare-error
        className='flex items-center gap-1.5 rounded-md border border-dashed border-slate-200 px-2.5 py-1 text-[11px] text-slate-400 dark:border-border'
      >
        Actuals unavailable right now
      </div>
    )
  if (!data) return null
  const closed = closedThroughLabel(data.closed_through)
  return (
    <>
      {data.status && (
        <div
          data-compare-status={data.status.key}
          data-tip={data.status.reason || undefined}
          className='flex max-w-[420px] items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1 dark:border-border dark:bg-card'
        >
          <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[data.status.tone])} aria-hidden='true' />
          <span className='shrink-0 whitespace-nowrap text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
            {data.status.label}
          </span>
          {data.status.reason && (
            <span className='min-w-0 truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
              {data.status.reason}
            </span>
          )}
        </div>
      )}
      {closed && (
        <div
          data-compare-closed={data.closed_through ?? ''}
          data-tip={data.closed_rule}
          className='flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 dark:border-border dark:bg-muted/40 dark:text-slate-300'
        >
          <Lock className='h-3 w-3 text-slate-400' aria-hidden='true' />
          Closed through <b className='font-semibold'>{closed}</b>
        </div>
      )}
      {(data.figures ?? []).map((f) => (
        <GridStatChip key={f.label} label={f.label} value={f.value} format={f.format} dataKey={`compare:${f.label}`} />
      ))}
    </>
  )
}

/** Column header decoration: a lock on closed months. */
export function compareHeaderProps(data: CompareSeriesData | null | undefined, column: string, sampleRowKey: unknown) {
  if (!data || !isMonth(column)) return { closed: false }
  return { closed: compareColumnClosed(data, sampleRowKey, column) }
}

export function isMonthColumn(column: string): boolean {
  return isMonth(column)
}

/** Sum of the series over a column, for the footer. */
export function compareColumnSum(data: CompareSeriesData | null | undefined, column: string): number | null {
  if (!data || !data.columns.includes(column)) return null
  let any = false
  let sum = 0
  for (const r of data.rows) {
    const v = r.values[column]
    if (v == null) continue
    any = true
    sum += v
  }
  return any ? sum : null
}
