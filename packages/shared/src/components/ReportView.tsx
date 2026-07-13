import {
  type ReportDateRange,
  type ReportDef,
  type ReportEntityFilter,
  type ReportWidget,
  type ReportWidgetData,
  readReport,
  readReportWidgetData
} from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNivaroClient } from '../context'

/**
 * ReportView — headless-friendly, read-only renderer for a Report Studio
 * report. Drop it into any app wrapped in <NivaroProvider>; it fetches the
 * report definition and resolves each widget's data as the current client
 * identity (collection permissions apply server-side).
 *
 * Charts are inline SVG so this component adds NO charting dependency to the
 * shared bundle — hosts that want richer charts can render their own from the
 * SDK data commands. Styling is minimal + inline so it works with or without
 * the host's Tailwind. Pass `className`/`style` to theme the shell.
 */

export interface ReportViewProps {
  reportId: string
  /** Override the report's saved date range at view time. */
  dateRange?: ReportDateRange | null
  /** Report-level entity filters applied to every widget. */
  entityFilters?: ReportEntityFilter[]
  /** Poll interval (ms) for live refresh; omit for one-shot. */
  refetchInterval?: number
  className?: string
  style?: React.CSSProperties
  /** Rendered when the report has no widgets. */
  emptyState?: React.ReactNode
}

const CHART_COLORS = ['#00ceff', '#172940', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b']

function fmt(v: number | null | undefined, f?: { prefix?: string; suffix?: string; decimals?: number }): string {
  if (v == null) return '—'
  const n =
    f?.decimals != null
      ? v.toLocaleString(undefined, {
          minimumFractionDigits: f.decimals,
          maximumFractionDigits: f.decimals
        })
      : v.toLocaleString()
  return `${f?.prefix ?? ''}${n}${f?.suffix ?? ''}`
}

function Delta({ pct }: { pct?: number | null }) {
  if (pct == null) return null
  const up = pct >= 0
  return (
    <span
      style={{
        marginLeft: 6,
        fontSize: 11,
        fontWeight: 600,
        color: up ? '#059669' : '#dc2626'
      }}
    >
      {up ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  )
}

function BarChartSvg({ series }: { series: Array<{ dim: string; value: number }> }) {
  const max = Math.max(1, ...series.map((s) => s.value))
  const w = 100
  const n = series.length
  const bw = n > 0 ? w / n : 0
  return (
    <svg viewBox={`0 0 ${w} 40`} preserveAspectRatio='none' style={{ width: '100%', height: 120 }}>
      <title>bar chart</title>
      {series.map((s, i) => {
        const h = (s.value / max) * 36
        return (
          <rect
            key={s.dim}
            x={i * bw + bw * 0.15}
            y={40 - h}
            width={bw * 0.7}
            height={h}
            fill='#00ceff'
            rx={0.5}
          />
        )
      })}
    </svg>
  )
}

function LineChartSvg({ series }: { series: Array<{ dim: string; value: number }> }) {
  const max = Math.max(1, ...series.map((s) => s.value))
  const n = series.length
  const pts = series
    .map((s, i) => `${(i / Math.max(1, n - 1)) * 100},${40 - (s.value / max) * 36}`)
    .join(' ')
  return (
    <svg viewBox='0 0 100 40' preserveAspectRatio='none' style={{ width: '100%', height: 120 }}>
      <title>line chart</title>
      <polyline points={pts} fill='none' stroke='#00ceff' strokeWidth={1} />
    </svg>
  )
}

function DonutSvg({ series }: { series: Array<{ dim: string; value: number }> }) {
  const total = series.reduce((a, s) => a + s.value, 0) || 1
  let acc = 0
  const R = 16
  const C = 2 * Math.PI * R
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <svg viewBox='0 0 40 40' style={{ width: 100, height: 100 }}>
        <title>donut chart</title>
        {series.map((s, i) => {
          const frac = s.value / total
          const dash = frac * C
          const el = (
            <circle
              key={s.dim}
              cx={20}
              cy={20}
              r={R}
              fill='none'
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={7}
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={-acc * C}
              transform='rotate(-90 20 20)'
            />
          )
          acc += frac
          return el
        })}
      </svg>
      <div style={{ fontSize: 11, flex: 1 }}>
        {series.slice(0, 8).map((s, i) => (
          <div key={s.dim} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: CHART_COLORS[i % CHART_COLORS.length]
              }}
            />
            <span style={{ flex: 1, color: '#475569' }}>{s.dim}</span>
            <span style={{ color: '#94a3b8' }}>{s.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function WidgetCard({
  reportId,
  widget,
  dateRange,
  entityFilters,
  refetchInterval
}: {
  reportId: string
  widget: ReportWidget
  dateRange: ReportDateRange | null
  entityFilters: ReportEntityFilter[]
  refetchInterval?: number
}) {
  const client = useNivaroClient()
  const { data } = useQuery<ReportWidgetData>({
    queryKey: ['nivaro-report-widget', reportId, widget.id, dateRange, entityFilters],
    queryFn: () =>
      client
        .request(readReportWidgetData(reportId, widget.id, { date_range: dateRange, entity_filters: entityFilters }))
        .then((r) => (r as { data: ReportWidgetData }).data),
    enabled: widget.type !== 'divider',
    staleTime: 60_000,
    refetchInterval,
    retry: false
  })

  if (widget.type === 'divider') {
    return (
      <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid #e2e8f0', paddingBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#172940' }}>{widget.title}</h3>
      </div>
    )
  }

  const span = Math.min(4, Math.max(1, Math.round(widget.w / 3)))
  let body: React.ReactNode = <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</span>
  if (data) {
    if (widget.type === 'kpi') {
      body = (
        <div>
          <span style={{ fontSize: 28, fontWeight: 600, color: '#111827' }}>
            {fmt(data.value, widget.config?.format)}
          </span>
          <Delta pct={data.change_pct} />
        </div>
      )
    } else if (widget.type === 'kpi_group') {
      body = (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {(data.tiles ?? []).map((t) => (
            <div key={t.label} style={{ flex: '1 1 120px' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#94a3b8' }}>
                {t.label}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: '#111827' }}>
                {fmt(t.value, t.format)}
                <Delta pct={t.change_pct} />
              </div>
            </div>
          ))}
        </div>
      )
    } else if (widget.type === 'table') {
      const rows = data.rows ?? []
      const cols = rows[0] ? Object.keys(rows[0]).filter((c) => c !== 'id') : []
      body = (
        <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  style={{ textAlign: 'left', padding: '3px 6px', color: '#94a3b8', borderBottom: '1px solid #e2e8f0' }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((r) => (
              <tr key={String(r.id)}>
                {cols.map((c) => (
                  <td key={c} style={{ padding: '3px 6px', color: '#334155', borderBottom: '1px solid #f1f5f9' }}>
                    {String(r[c] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    } else {
      const series = data.series ?? []
      if (series.length === 0) body = <span style={{ fontSize: 12, color: '#94a3b8' }}>No data</span>
      else if (widget.type === 'donut') body = <DonutSvg series={series} />
      else if (widget.type === 'line') body = <LineChartSvg series={series} />
      else body = <BarChartSvg series={series} />
    }
  }

  return (
    <div
      style={{
        gridColumn: `span ${span}`,
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        background: '#fff',
        padding: 12
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: '#94a3b8',
          marginBottom: 8
        }}
      >
        {widget.title}
      </div>
      {body}
    </div>
  )
}

export function ReportView({
  reportId,
  dateRange,
  entityFilters = [],
  refetchInterval,
  className,
  style,
  emptyState
}: ReportViewProps) {
  const client = useNivaroClient()
  const { data: report, isLoading } = useQuery<ReportDef>({
    queryKey: ['nivaro-report', reportId],
    queryFn: () => client.request(readReport(reportId)).then((r) => (r as { data: ReportDef }).data),
    staleTime: 30_000
  })

  const effectiveRange = useMemo(
    () => (dateRange !== undefined ? dateRange : (report?.global_filters?.date_range ?? null)),
    [dateRange, report]
  )

  const widgets = report?.widgets ?? []

  if (isLoading) {
    return <div className={className} style={style}>Loading report…</div>
  }
  if (!report) {
    return <div className={className} style={style}>Report not found.</div>
  }
  if (widgets.length === 0) {
    return <div className={className} style={style}>{emptyState ?? 'This report has no widgets yet.'}</div>
  }

  return (
    <div className={className} style={style}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          alignItems: 'start'
        }}
      >
        {[...widgets]
          .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
          .map((w) => (
            <WidgetCard
              key={w.id}
              reportId={reportId}
              widget={w}
              dateRange={effectiveRange}
              entityFilters={entityFilters}
              refetchInterval={refetchInterval}
            />
          ))}
      </div>
    </div>
  )
}
