import { Sparkles } from 'lucide-react'

/**
 * Payload shape returned by POST /widgets-internal/:id/render for a
 * widget_type 'report_widget' row — a Report Studio widget's resolved data
 * hosted inside a record-form slot.
 */
export interface ReportSlotPayload {
  type: 'report_widget'
  widget_type: string
  title: string
  config?: {
    format?: { prefix?: string; suffix?: string; decimals?: number }
    [k: string]: unknown
  } | null
  /** Configured entity filter has no bound record value yet — nothing rendered. */
  awaiting_filter?: boolean
  unsupported?: string
  data: {
    value?: number | null
    prev_value?: number | null
    change_pct?: number | null
    rows?: Array<Record<string, unknown>>
    series?: Array<{ dim: string; value: number }>
    cells?: Array<{ dim: string; dim2: string; value: number }>
    narrative?: string
    row_count?: number
    tiles?: Array<{
      label: string
      value: number | null
      change_pct?: number | null
      format?: { prefix?: string; suffix?: string; decimals?: number }
    }>
  } | null
}

function fmtNum(
  v: number | null | undefined,
  format?: { prefix?: string; suffix?: string; decimals?: number }
): string {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  const body = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: format?.decimals ?? undefined,
    maximumFractionDigits: format?.decimals ?? 2
  }).format(n)
  return `${format?.prefix ?? ''}${body}${format?.suffix ?? ''}`
}

/**
 * Reduce a report-widget payload to the {value, display} shape the slot's
 * strip/pill cells render — a KPI's value, else a series sum, else row count.
 */
export function reportSlotScalar(payload: ReportSlotPayload): {
  value: number | null
  display: Record<string, unknown>
} {
  const d = payload.data
  const f = payload.config?.format
  const display = { prefix: f?.prefix ?? '', suffix: f?.suffix ?? '', format: '' }
  if (!d) return { value: null, display }
  if (d.value != null) return { value: d.value, display }
  if (d.series) {
    return { value: d.series.reduce((a, b) => a + (Number(b.value) || 0), 0), display }
  }
  if (d.tiles?.length) return { value: d.tiles[0]?.value ?? null, display }
  if (d.row_count != null) return { value: d.row_count, display }
  return { value: null, display }
}

const ROW_CAP = 20
const COL_CAP = 6

function CompactTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) return <p className='text-[12px] text-slate-400'>No rows</p>
  const cols = Object.keys(rows[0] ?? {}).slice(0, COL_CAP)
  const shown = rows.slice(0, ROW_CAP)
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-[12px] tabular-nums'>
        <thead>
          <tr className='border-b border-slate-100 dark:border-border'>
            {cols.map((c) => (
              <th
                key={c}
                className='py-1 pr-3 text-left font-medium text-slate-500 dark:text-slate-400'
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} className='border-b border-slate-50 dark:border-border/50'>
              {cols.map((c) => {
                const v = row[c]
                return (
                  <td key={c} className='py-1 pr-3 text-slate-700 dark:text-slate-300'>
                    {v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > ROW_CAP && (
        <p className='mt-1 text-[11px] text-slate-400'>+{rows.length - ROW_CAP} more rows</p>
      )}
    </div>
  )
}

function SeriesTable({
  series,
  format
}: {
  series: Array<{ dim: string; value: number }>
  format?: { prefix?: string; suffix?: string; decimals?: number }
}) {
  if (series.length === 0) return <p className='text-[12px] text-slate-400'>No data</p>
  const shown = series.slice(0, ROW_CAP)
  const max = Math.max(...shown.map((s) => Math.abs(Number(s.value) || 0)), 1)
  return (
    <div className='space-y-1'>
      {shown.map((s, i) => (
        <div key={i} className='flex items-center gap-2 text-[12px]'>
          <span className='w-32 shrink-0 truncate text-slate-600 dark:text-slate-400' title={s.dim}>
            {s.dim}
          </span>
          <span className='relative h-2 flex-1 overflow-hidden rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]'>
            <span
              className='absolute inset-y-0 left-0 rounded bg-nvr-cyan/70'
              style={{ width: `${Math.max(2, (Math.abs(Number(s.value) || 0) / max) * 100)}%` }}
            />
          </span>
          <span className='w-24 shrink-0 text-right tabular-nums font-medium text-slate-800 dark:text-slate-200'>
            {fmtNum(s.value, format)}
          </span>
        </div>
      ))}
      {series.length > ROW_CAP && (
        <p className='text-[11px] text-slate-400'>+{series.length - ROW_CAP} more</p>
      )}
    </div>
  )
}

export function ReportSlotWidget({ payload }: { payload: ReportSlotPayload }) {
  if (payload.unsupported) {
    return <p className='text-[12px] text-slate-400'>{payload.unsupported}</p>
  }
  if (payload.awaiting_filter) {
    return (
      <p className='text-[12px] italic text-slate-400'>
        Waiting for this record's value to scope the report…
      </p>
    )
  }
  const d = payload.data
  if (!d) return <p className='text-[12px] text-slate-400'>No data</p>
  const format = payload.config?.format

  return (
    <div className='space-y-2' data-nvr-report-slot={payload.widget_type}>
      {d.narrative != null && (
        <div className='flex items-start gap-2'>
          <Sparkles className='mt-0.5 h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
          <p className='whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300'>
            {d.narrative}
          </p>
        </div>
      )}
      {d.tiles && d.tiles.length > 0 && (
        <div
          className='grid gap-3'
          style={{ gridTemplateColumns: `repeat(${Math.min(d.tiles.length, 3)}, minmax(0, 1fr))` }}
        >
          {d.tiles.map((t, i) => (
            <div key={i} className='flex flex-col gap-0.5'>
              <span className='text-[11px] text-slate-400 dark:text-slate-500'>{t.label}</span>
              <span className='text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100'>
                {fmtNum(t.value, t.format ?? format)}
              </span>
              {t.change_pct != null && (
                <span
                  className={`text-[11px] tabular-nums ${t.change_pct >= 0 ? 'text-emerald-600' : 'text-red-500'}`}
                >
                  {t.change_pct >= 0 ? '+' : ''}
                  {t.change_pct}%
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {d.value != null && !d.tiles?.length && d.narrative == null && (
        <div className='flex items-baseline gap-2'>
          <span className='text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100'>
            {fmtNum(d.value, format)}
          </span>
          {d.change_pct != null && (
            <span
              className={`text-[12px] tabular-nums ${d.change_pct >= 0 ? 'text-emerald-600' : 'text-red-500'}`}
            >
              {d.change_pct >= 0 ? '+' : ''}
              {d.change_pct}% vs prev
            </span>
          )}
        </div>
      )}
      {d.series && d.series.length > 0 && <SeriesTable series={d.series} format={format} />}
      {d.cells && d.cells.length > 0 && (
        <CompactTable
          rows={d.cells.map((c) => ({
            row: c.dim,
            column: c.dim2,
            value: fmtNum(c.value, format)
          }))}
        />
      )}
      {d.rows && d.rows.length > 0 && <CompactTable rows={d.rows} />}
      {d.value == null &&
        d.narrative == null &&
        !d.tiles?.length &&
        !d.series?.length &&
        !d.cells?.length &&
        !d.rows?.length && <p className='text-[12px] text-slate-400'>No data</p>}
    </div>
  )
}
