import { useQuery } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
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
  status?: { key: string; label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral'; reason?: string } | null
  figures?: Array<{ label: string; value: number; format?: 'currency' | 'number' }>
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
}) {
  const { data, row, rowKey, column, planned, columnLabel, compact } = props
  if (!data.columns.includes(column)) return null
  const actual = row?.values[column]
  const closed = compareColumnClosed(data, rowKey, column)
  const plannedN = Number(planned) || 0
  // No series row at all for this key: this row's key has nothing recorded
  // anywhere, say so once per cell quietly rather than pretending zero.
  if (!row || actual == null) {
    return (
      <div
        data-compare-cell={column}
        data-compare-empty=''
        className='mt-0.5 flex items-baseline gap-1 text-[11px] leading-4 text-slate-400 dark:text-slate-500'
      >
        <span className='font-mono text-[9px] uppercase tracking-wide'>{data.label}</span>
        <span>—</span>
      </div>
    )
  }
  const details = row.details?.[column] ?? []
  const tone = compareTone(plannedN, actual, closed)
  const diff = actual - plannedN
  const showDelta = Math.abs(diff) >= 0.005 && plannedN !== 0
  const figure = (
    <span
      className={cn(
        'tabular-nums font-medium',
        details.length > 0 &&
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
      {details.length > 0 ? (
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
}) {
  const { title, label, planLabel: plan, unit, actual, planned, closed, rows } = props
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
          <span className='text-[12px] font-semibold text-slate-800 dark:text-slate-100'>{data.status.label}</span>
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
