import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../context'
import { post } from '../lib/commands'

// Stat boxes above a query table (EFP Budget Overview strip). Each stat is
// either a client-side SUM of a field over the table's own rows (so it always
// agrees with the visible data), or an independent custom query (value = sum
// of value_field over its rows). Optional hover breakdown: `details` sums
// extra fields off the same rows; a query stat lists its rows label→value.

export interface QueryWidgetStat {
  label: string
  /** Sum this field over the main query's rows. */
  field?: string
  format?: 'currency' | 'number'
  /** Hover breakdown: each entry summed over the same rows. */
  details?: Array<{ label: string; field: string }>
  /** Independent source: own custom query. Value = sum of value_field over its
   *  rows; when label_field set, rows also list in the hover breakdown.
   *  param_from copies values from the main widget's effective params
   *  {statQueryParam: widgetParam}. */
  query?: {
    slug: string
    params?: Record<string, unknown>
    param_from?: Record<string, string>
    value_field: string
    label_field?: string
  }
  /** Card tint (any CSS color, e.g. '#f9fbd1'). */
  bg?: string
  /** Only sum rows matching these field values (equality AND) — EFP
   *  forecasting stats scope to the Workflow Forecast section. */
  row_match?: Record<string, unknown>
  /** Delta stat: value = sum(field) − sum(field_subtract); positive values
   *  render with a leading '+'. */
  field_subtract?: string
  /** EFP stat-card accent: colored top border + value (accent_dark in dark
   *  mode; accent_negative when a delta goes negative). */
  accent?: string
  accent_dark?: string
  accent_negative?: string
}

function fmtStat(v: number | null, format?: 'currency' | 'number'): string {
  if (v === null || !Number.isFinite(v)) return '—'
  if (format === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
    maximumFractionDigits: 2
  })
}

function sumField(rows: Array<Record<string, unknown>>, field: string): number {
  return rows.reduce((s, r) => {
    const n = Number(r[field])
    return Number.isFinite(n) ? s + n : s
  }, 0)
}

function StatBox({
  stat,
  rows,
  effectiveParams,
  loading
}: {
  stat: QueryWidgetStat
  rows: Array<Record<string, unknown>>
  effectiveParams: Record<string, unknown>
  loading: boolean
}) {
  const client = useNivaroClient()
  const [hover, setHover] = useState(false)
  const q = stat.query
  const queryParams = q
    ? {
        ...(q.params ?? {}),
        ...Object.fromEntries(
          Object.entries(q.param_from ?? {}).map(([sp, wp]) => [sp, effectiveParams[wp]])
        )
      }
    : null
  const { data: qRows, isLoading: qLoading } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['query-stat', q?.slug, JSON.stringify(queryParams)],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          post(`/custom-queries/${q!.slug}/execute`, { params: queryParams })
        )
        .then((r) => r.data ?? []),
    enabled: !!q,
    staleTime: 60_000
  })

  const matchedRows = stat.row_match
    ? rows.filter((r) =>
        Object.entries(stat.row_match ?? {}).every(([k, v]) => String(r[k] ?? '') === String(v))
      )
    : rows

  const busy = q ? qLoading : loading
  const value = busy
    ? null
    : q
      ? sumField(qRows ?? [], q.value_field)
      : stat.field
        ? sumField(matchedRows, stat.field) -
          (stat.field_subtract ? sumField(matchedRows, stat.field_subtract) : 0)
        : null

  const detailItems: Array<{ label: string; value: number }> = q
    ? q.label_field
      ? (qRows ?? []).map((r) => ({
          label: String(r[q.label_field as string] ?? '—'),
          value: Number(r[q.value_field]) || 0
        }))
      : []
    : (stat.details ?? []).map((d) => ({ label: d.label, value: sumField(matchedRows, d.field) }))

  // EFP stat-card accent: colored 2px top border + colored value. A delta
  // that goes negative switches to accent_negative (red by default).
  const isNegativeDelta = stat.field_subtract && value !== null && value < 0
  const accent = isNegativeDelta
    ? (stat.accent_negative ?? '#ef4444')
    : (stat.accent ?? null)
  const accentDark = isNegativeDelta
    ? (stat.accent_negative ?? '#f87171')
    : (stat.accent_dark ?? stat.accent ?? null)
  const valueText =
    value !== null && stat.field_subtract && value > 0
      ? `+${fmtStat(value, stat.format)}`
      : fmtStat(value, stat.format)

  return (
    <div
      className={`relative min-w-[150px] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card ${
        accent ? 'border-t-2 border-t-[color:var(--qsa)] dark:border-t-[color:var(--qsad)]' : ''
      }`}
      style={
        accent
          ? ({ '--qsa': accent, '--qsad': accentDark } as unknown as React.CSSProperties)
          : undefined
      }
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* The configured tint renders as a small accent dot, not a card wash —
          six pastel-washed cards in a row read as noise, six neutral cards
          with color-keyed dots read as a system. */}
      <p className='flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
        {stat.bg && (
          <span
            aria-hidden='true'
            className='h-2 w-2 shrink-0 rounded-full border border-black/10'
            style={{ backgroundColor: stat.bg, filter: 'saturate(2.2)' }}
          />
        )}
        <span className='truncate'>{stat.label}</span>
      </p>
      {busy ? (
        <div className='mt-1 h-5 w-24 animate-pulse rounded bg-slate-200/60 dark:bg-[hsl(var(--nvr-skeleton))]' />
      ) : (
        <p
          className={`mt-0.5 truncate text-[15px] font-semibold tabular-nums ${
            accent
              ? 'text-[color:var(--qsa)] dark:text-[color:var(--qsad)]'
              : 'text-slate-800 dark:text-slate-100'
          }`}
        >
          {valueText}
        </p>
      )}
      {hover && detailItems.length > 0 && (
        <div className='absolute left-0 top-full z-40 mt-1 min-w-[220px] rounded-md border border-slate-200 bg-white p-2 shadow-lg dark:border-border dark:bg-popover'>
          {detailItems.map((d) => (
            <div key={d.label} className='flex justify-between gap-4 py-0.5 text-[12px]'>
              <span className='text-slate-500'>{d.label}</span>
              <span className='tabular-nums text-slate-700 dark:text-slate-200'>
                {fmtStat(d.value, stat.format)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function QueryStatStrip({
  stats,
  rows,
  effectiveParams,
  loading
}: {
  stats: QueryWidgetStat[]
  rows: Array<Record<string, unknown>>
  effectiveParams: Record<string, unknown>
  loading: boolean
}) {
  if (!stats.length) return null
  return (
    <div className='flex flex-wrap gap-2 pb-3'>
      {stats.map((s) => (
        <StatBox
          key={s.label}
          stat={s}
          rows={rows}
          effectiveParams={effectiveParams}
          loading={loading}
        />
      ))}
    </div>
  )
}
