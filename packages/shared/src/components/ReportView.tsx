import {
  type ReportDateRange,
  type ReportDef,
  type ReportEntityFilter,
  type ReportWidget,
  type ReportWidgetData,
  readReport,
  readReportFilterOptions,
  readReportWidgetData
} from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, RefreshCw, TrendingDown, TrendingUp, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { cn } from '../lib/utils'
import { useNivaroClient } from '../context'
import { Button } from './ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * ReportView — the full, styled, interactive Report Studio renderer for
 * headless frontends, matching how QueueWorklist / ItemEditForm ship.
 *
 * Fully Tailwind-styled (bring the styles via `@nivaro/react/full.css` or the
 * Tailwind preset, exactly like the other shared components) and interactive:
 * a global filter bar (date-range switcher + live entity-filter chips), and
 * per-widget freshness + one-click refresh. Every widget resolves as the
 * client identity — collection read permissions apply server-side. Charts use
 * recharts (bundled into the react package). Read-only: no drag/resize edit
 * surface (that lives in the admin builder).
 */

export interface ReportViewProps {
  reportId: string
  /** Show the global filter bar (date range + entity chips). Default true. */
  showFilterBar?: boolean
  /** Override the report's saved date range at view time. */
  dateRange?: ReportDateRange | null
  /** Initial report-level entity filters. */
  initialEntityFilters?: ReportEntityFilter[]
  /** Poll interval (ms) for live refresh; omit for one-shot. */
  refetchInterval?: number
  className?: string
  emptyState?: React.ReactNode
}

type WidgetFormat = { prefix?: string; suffix?: string; decimals?: number }

const CHART_COLORS = ['#00ceff', '#172940', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b']
const DATE_PRESETS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All time' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'last_3_months', label: 'Last 3 months' },
  { id: 'last_6_months', label: 'Last 6 months' },
  { id: 'last_12_months', label: 'Last 12 months' },
  { id: 'ytd', label: 'Year to date' }
]

function fmt(v: number | null | undefined, f?: WidgetFormat): string {
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
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 py-px text-[10.5px] font-medium',
        up
          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
          : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
      )}
    >
      {up ? <TrendingUp className='h-2.5 w-2.5' /> : <TrendingDown className='h-2.5 w-2.5' />}
      {Math.abs(pct)}%
    </span>
  )
}

// ── Entity filter chip (live multi-select over distinct values) ───────────────

function FilterChip({
  reportId,
  field,
  label,
  selected,
  onChange
}: {
  reportId: string
  field: string
  label: string
  selected: Array<string | number>
  onChange: (v: Array<string | number>) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data: options = [] } = useQuery({
    queryKey: ['nivaro-report-filter-opts', reportId, field],
    queryFn: () =>
      client
        .request(readReportFilterOptions(reportId, field))
        .then((r) => (r as { data: Array<{ value: string; label: string }> }).data),
    enabled: open,
    staleTime: 120_000
  })
  const active = selected.length > 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px]',
            active
              ? 'border-nvr-cyan bg-accent font-medium text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-border'
          )}
        >
          {label}
          {active && (
            <span className='rounded-full bg-white/60 px-1 text-[10px] dark:bg-black/20'>
              {selected.length}
            </span>
          )}
          <ChevronsUpDown className='h-3 w-3 opacity-50' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder={`Filter ${label}…`} className='h-8 text-[12.5px]' />
          <CommandList className='max-h-52'>
            <CommandEmpty>No values.</CommandEmpty>
            {options.map((o) => {
              const isOn = selected.some((v) => String(v) === o.value)
              return (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() =>
                    onChange(
                      isOn ? selected.filter((v) => String(v) !== o.value) : [...selected, o.value]
                    )
                  }
                  className='text-[12.5px]'
                >
                  <Check className={cn('mr-1.5 h-3 w-3', isOn ? 'opacity-100' : 'opacity-0')} />
                  {o.label}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ── Widget card ───────────────────────────────────────────────────────────────

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
  const { data, isLoading, error, refetch, isFetching } = useQuery<ReportWidgetData>({
    queryKey: ['nivaro-report-widget', reportId, widget.id, dateRange, entityFilters],
    queryFn: () =>
      client
        .request(
          readReportWidgetData(reportId, widget.id, {
            date_range: dateRange,
            entity_filters: entityFilters
          })
        )
        .then((r) => (r as { data: ReportWidgetData }).data),
    enabled: widget.type !== 'divider',
    staleTime: 60_000,
    refetchInterval,
    retry: false
  })

  const format = widget.config?.format as WidgetFormat | undefined
  const span = Math.min(4, Math.max(1, Math.round(widget.w / 3)))

  if (widget.type === 'divider') {
    return (
      <div className='col-span-full border-b border-slate-200 pb-1 dark:border-border'>
        <h3 className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
          {widget.title}
        </h3>
      </div>
    )
  }

  let body: React.ReactNode = null
  if (isLoading) body = <p className='px-1 text-[12px] text-slate-300'>Loading…</p>
  else if (error) {
    const msg =
      (error as { response?: { data?: { error?: string } } }).response?.data?.error ??
      'Failed to load'
    body = <p className='px-1 text-[12px] text-red-400'>{msg}</p>
  } else if (data) {
    if (widget.type === 'kpi') {
      body = (
        <div className='flex items-baseline gap-2'>
          <p className='text-[28px] font-semibold leading-none tracking-tight text-slate-900 dark:text-foreground'>
            {fmt(data.value, format)}
          </p>
          <Delta pct={data.change_pct} />
        </div>
      )
    } else if (widget.type === 'kpi_group') {
      const tiles = data.tiles ?? []
      body = (
        <div
          className='grid gap-2'
          style={{ gridTemplateColumns: `repeat(${Math.max(1, tiles.length)}, 1fr)` }}
        >
          {tiles.map((t, i) => (
            <div
              key={t.label}
              className='flex flex-col justify-center rounded-md border border-slate-100 px-3 py-2 dark:border-border/60'
              style={{ borderTopColor: t.color ?? CHART_COLORS[i % CHART_COLORS.length], borderTopWidth: 2 }}
            >
              <p className='truncate text-[10.5px] uppercase tracking-wide text-slate-400'>
                {t.label}
              </p>
              <div className='flex items-baseline gap-1.5'>
                <p className='text-[19px] font-semibold leading-tight text-slate-900 dark:text-foreground'>
                  {fmt(t.value, t.format)}
                </p>
                <Delta pct={t.change_pct} />
              </div>
            </div>
          ))}
        </div>
      )
    } else if (widget.type === 'table') {
      const rows = data.rows ?? []
      const cols = rows[0] ? Object.keys(rows[0]).filter((c) => c !== 'id') : []
      body =
        rows.length === 0 ? (
          <p className='px-1 text-[12px] text-slate-400'>No rows.</p>
        ) : (
          <div className='max-h-[200px] overflow-auto'>
            <table className='w-full text-[11.5px]'>
              <thead className='sticky top-0 bg-white dark:bg-card'>
                <tr>
                  {cols.map((c) => (
                    <th
                      key={c}
                      className='border-b border-slate-100 px-1.5 py-1 text-left font-medium text-slate-400 dark:border-border'
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    {cols.map((c) => (
                      <td
                        key={c}
                        className={cn(
                          'max-w-[180px] truncate border-b border-slate-50 px-1.5 py-1 text-slate-700 dark:border-border/40 dark:text-slate-300',
                          typeof r[c] === 'number' && 'text-right tabular-nums'
                        )}
                      >
                        {String(r[c] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    } else {
      const series = data.series ?? []
      if (series.length === 0) body = <p className='px-1 text-[12px] text-slate-400'>No data.</p>
      else if (widget.type === 'donut') {
        const total = series.reduce((a, s) => a + s.value, 0)
        body = (
          <div className='flex items-center gap-3'>
            <div className='relative h-[130px] flex-1'>
              <ResponsiveContainer width='100%' height='100%'>
                <PieChart>
                  <Pie
                    data={series}
                    dataKey='value'
                    nameKey='dim'
                    innerRadius='58%'
                    outerRadius='88%'
                    paddingAngle={2}
                    strokeWidth={0}
                  >
                    {series.map((s, i) => (
                      <Cell key={s.dim} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center'>
                <span className='text-[17px] font-semibold leading-none text-slate-900 dark:text-foreground'>
                  {total.toLocaleString()}
                </span>
                <span className='text-[9.5px] text-slate-400'>total</span>
              </div>
            </div>
            <div className='max-h-[130px] w-[40%] shrink-0 space-y-0.5 overflow-y-auto pr-1'>
              {series.slice(0, 10).map((s, i) => (
                <div key={s.dim} className='flex items-center gap-1.5 text-[10.5px]'>
                  <span
                    className='h-2 w-2 shrink-0 rounded-sm'
                    style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                  />
                  <span className='truncate text-slate-600 dark:text-slate-300'>{s.dim}</span>
                  <span className='ml-auto tabular-nums text-slate-400'>
                    {s.value.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      } else if (widget.type === 'line') {
        body = (
          <div className='h-[130px]'>
            <ResponsiveContainer width='100%' height='100%'>
              <LineChart data={series} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <XAxis dataKey='dim' tick={{ fontSize: 10 }} stroke='#94a3b8' />
                <YAxis tick={{ fontSize: 10 }} stroke='#94a3b8' />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                {widget.config?.compare && (
                  <Line
                    type='monotone'
                    dataKey='prev'
                    stroke='#94a3b8'
                    strokeWidth={1.5}
                    strokeDasharray='4 3'
                    dot={false}
                    name='previous'
                  />
                )}
                <Line
                  type='monotone'
                  dataKey='value'
                  stroke='#00ceff'
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )
      } else {
        const horizontal = widget.config?.orientation === 'horizontal'
        body = (
          <div className='h-[130px]'>
            <ResponsiveContainer width='100%' height='100%'>
              <BarChart
                data={series}
                layout={horizontal ? 'vertical' : 'horizontal'}
                margin={{ top: 6, right: 8, left: horizontal ? 30 : -18, bottom: 0 }}
              >
                {horizontal ? (
                  <>
                    <XAxis type='number' tick={{ fontSize: 10 }} stroke='#94a3b8' />
                    <YAxis
                      type='category'
                      dataKey='dim'
                      tick={{ fontSize: 10 }}
                      stroke='#94a3b8'
                      width={90}
                    />
                  </>
                ) : (
                  <>
                    <XAxis dataKey='dim' tick={{ fontSize: 10 }} stroke='#94a3b8' />
                    <YAxis tick={{ fontSize: 10 }} stroke='#94a3b8' />
                  </>
                )}
                <Tooltip contentStyle={{ fontSize: 12 }} />
                {widget.config?.compare && (
                  <Bar dataKey='prev' fill='#cbd5e1' radius={[3, 3, 0, 0]} name='previous' />
                )}
                <Bar dataKey='value' fill='#00ceff' radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )
      }
    }
  }

  return (
    <div
      className='flex flex-col rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
      style={{ gridColumn: `span ${span} / span ${span}` }}
    >
      <div className='mb-1.5 flex items-center gap-1.5'>
        <p className='truncate text-[11.5px] font-medium uppercase tracking-wide text-slate-400'>
          {widget.title}
        </p>
        <button
          type='button'
          title='Refresh'
          className='ml-auto rounded p-0.5 text-slate-300 hover:text-slate-500'
          onClick={() => refetch()}
        >
          <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
        </button>
      </div>
      <div className='min-h-0 flex-1'>{body}</div>
    </div>
  )
}

// ── ReportView ────────────────────────────────────────────────────────────────

export function ReportView({
  reportId,
  showFilterBar = true,
  dateRange,
  initialEntityFilters = [],
  refetchInterval,
  className,
  emptyState
}: ReportViewProps) {
  const client = useNivaroClient()
  const [localRange, setLocalRange] = useState<ReportDateRange | null | undefined>(undefined)
  const [entityFilters, setEntityFilters] = useState<ReportEntityFilter[]>(initialEntityFilters)

  const { data: report, isLoading } = useQuery<ReportDef>({
    queryKey: ['nivaro-report', reportId],
    queryFn: () => client.request(readReport(reportId)).then((r) => (r as { data: ReportDef }).data),
    staleTime: 30_000
  })

  const savedRange = report?.global_filters?.date_range ?? null
  const effectiveRange = useMemo(() => {
    if (localRange !== undefined) return localRange
    if (dateRange !== undefined) return dateRange
    return savedRange
  }, [localRange, dateRange, savedRange])

  const filterBar = report?.global_filters?.filter_bar ?? []
  const widgets = report?.widgets ?? []
  const anyFilterActive = entityFilters.some((f) => f.values.length > 0)

  if (isLoading) {
    return (
      <div className={cn('p-6 text-[13px] text-slate-400', className)}>Loading report…</div>
    )
  }
  if (!report) {
    return <div className={cn('p-6 text-[13px] text-slate-400', className)}>Report not found.</div>
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {showFilterBar && (widgets.length > 0 || filterBar.length > 0) && (
        <div className='flex flex-wrap items-center gap-1.5'>
          <select
            value={effectiveRange?.preset ?? ''}
            onChange={(e) =>
              setLocalRange(e.target.value ? { preset: e.target.value as never } : null)
            }
            className='h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[12px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
          >
            {DATE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {filterBar.map((f) => (
            <FilterChip
              key={f.field}
              reportId={reportId}
              field={f.field}
              label={f.label}
              selected={entityFilters.find((e) => e.field === f.field)?.values ?? []}
              onChange={(values) =>
                setEntityFilters((prev) => [
                  ...prev.filter((e) => e.field !== f.field),
                  ...(values.length > 0 ? [{ field: f.field, values }] : [])
                ])
              }
            />
          ))}
          {anyFilterActive && (
            <button
              type='button'
              className='flex items-center gap-1 text-[11.5px] text-slate-400 hover:text-red-500'
              onClick={() => setEntityFilters([])}
            >
              <X className='h-3 w-3' /> Clear
            </button>
          )}
        </div>
      )}

      {widgets.length === 0 ? (
        <div className='p-6 text-[13px] text-slate-400'>
          {emptyState ?? 'This report has no widgets yet.'}
        </div>
      ) : (
        <div className='grid grid-cols-4 items-start gap-3'>
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
      )}
    </div>
  )
}
