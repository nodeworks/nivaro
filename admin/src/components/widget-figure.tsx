import { AiMarkdown } from '@nivaro/shared'
import { formatNumber } from '@/lib/utils'

/**
 * The figure inside a dashboard widget, drawn from what GET /dashboards/widgets/:id/data
 * (or a dashboard draft's preview) returned — the same data shapes, so a drafted widget
 * looks like the widget it becomes. Charts render through the Ask AI chart (#2738): a
 * pinned answer chart reads the same on the dashboard as it did in the answer.
 */

export interface WidgetFigureData {
  value?: number | null
  rows?: Array<Record<string, unknown>>
  chart?: { type: 'bar' | 'line' | 'pie'; data: Array<{ label: string; value: number }> }
  note?: string
}

function chartFence(spec: NonNullable<WidgetFigureData['chart']>): string {
  return `\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\``
}

/** Daily-count rows ({date, count}) as a chart the Ask AI chart draws. */
function dailyChart(rows: Array<Record<string, unknown>>, type: 'bar' | 'line') {
  return {
    type,
    data: rows.map((r) => ({ label: String(r.date ?? '').slice(5, 10), value: Number(r.count) }))
  }
}

function Empty({ text }: { text: string }) {
  return <p className='text-[12px] text-slate-500 dark:text-slate-400'>{text}</p>
}

export function WidgetFigure({ type, data }: { type: string; data: WidgetFigureData | null }) {
  if (!data) return <Empty text='No data' />
  if (type === 'count' || type === 'sum' || type === 'avg' || type === 'saved_view') {
    return (
      <p className='text-4xl font-bold tabular-nums text-slate-800 dark:text-slate-100'>
        {data.value != null ? formatNumber(data.value) : '—'}
      </p>
    )
  }
  if (type === 'latest') {
    const rows = (data.rows ?? []).slice(0, 5)
    if (!rows.length) return <Empty text='No records yet' />
    return (
      <ul className='w-full divide-y divide-slate-100 text-[12px] dark:divide-border'>
        {rows.map((r, i) => {
          const label = Object.entries(r)
            .filter(([k, v]) => k !== 'id' && v != null && typeof v !== 'object')
            .map(([, v]) => String(v))
            .slice(0, 2)
            .join(' · ')
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: preview rows
            <li key={i} className='flex items-center gap-2 py-1'>
              <span className='font-mono text-[11px] text-slate-500 dark:text-slate-400'>
                #{String(r.id ?? '')}
              </span>
              <span className='truncate text-slate-700 dark:text-slate-200'>{label}</span>
            </li>
          )
        })}
      </ul>
    )
  }
  if (type === 'bar_chart' || type === 'line_chart') {
    const rows = data.rows ?? []
    if (rows.length < 2) return <Empty text='Not enough days with records to draw yet' />
    return (
      <div className='w-full'>
        <AiMarkdown
          content={chartFence(dailyChart(rows, type === 'line_chart' ? 'line' : 'bar'))}
        />
      </div>
    )
  }
  if (type === 'ai_query') {
    if (data.chart) {
      if (data.chart.data.length < 2)
        return (
          <Empty text={data.chart.data.length ? 'Only one group so far' : 'No matching records'} />
        )
      return (
        <div className='w-full'>
          <AiMarkdown content={chartFence(data.chart)} />
        </div>
      )
    }
    if (data.value !== undefined)
      return (
        <p className='text-4xl font-bold tabular-nums text-slate-800 dark:text-slate-100'>
          {data.value != null ? formatNumber(data.value) : '—'}
        </p>
      )
    return <Empty text={data.note ?? 'No data'} />
  }
  return <Empty text='No preview for this widget type' />
}
