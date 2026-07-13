import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  BarChart3,
  Bell,
  BellRing,
  Check,
  ChevronsUpDown,
  Copy,
  Download,
  Eye,
  Globe,
  GripVertical,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GridLayout, { WidthProvider } from 'react-grid-layout/legacy'
import { useNavigate, useParams } from 'react-router'
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
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatNumber, formatRelative } from '@/lib/utils'
import 'react-grid-layout/css/styles.css'

/**
 * Report Studio builder — 12-col drag/resize grid (react-grid-layout) of
 * user-defined widgets over any collection, with an EFP-grade global filter
 * bar (entity filters + date range + ask-AI), per-widget freshness/refresh,
 * prior-period comparison, multi-KPI cards, and Build-with-AI composition.
 * No Save button: edits debounce-persist automatically.
 */

const Grid = WidthProvider(GridLayout)

type WidgetType = 'kpi' | 'kpi_group' | 'bar' | 'line' | 'donut' | 'table' | 'divider'

interface WidgetFilter {
  field: string
  op: string
  value?: string
}

interface KpiMetric {
  label: string
  collection: string
  aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'
  field?: string
  date_field?: string | null
  format?: { prefix?: string; suffix?: string; decimals?: number }
  color?: string
}

interface WidgetConfig {
  metric?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string }
  dimension?: { field: string; bucket?: 'day' | 'week' | 'month' } | null
  filters?: WidgetFilter[]
  date_field?: string | null
  limit?: number
  columns?: string[]
  sort?: string
  format?: { prefix?: string; suffix?: string; decimals?: number }
  compare?: 'previous_period' | 'previous_year' | null
  orientation?: 'horizontal' | 'vertical'
  metrics?: KpiMetric[]
}

interface Widget {
  id: string
  type: WidgetType
  title: string
  collection: string | null
  config: WidgetConfig | null
  x: number
  y: number
  w: number
  h: number
}

interface EntityFilter {
  field: string
  values: Array<string | number>
}

interface GlobalFilters {
  date_range?: { preset: string; start?: string; end?: string } | null
  filter_bar?: Array<{ field: string; label: string }>
}

interface ReportDetail {
  id: string
  name: string
  is_shared: boolean
  role_id: string | null
  global_filters: GlobalFilters | null
  widgets: Widget[]
  editable: boolean
}

interface FieldMeta {
  field: string
  type: string | null
  label?: string | null
}

interface WidgetDataShape {
  value?: number | null
  prev_value?: number | null
  change_pct?: number | null
  row_count?: number
  rows?: Array<Record<string, unknown>>
  series?: Array<{ dim: string; value: number; prev?: number }>
  tiles?: Array<{
    label: string
    value: number | null
    change_pct?: number | null
    format?: KpiMetric['format']
    color?: string
  }>
}

const NUMERIC_TYPES = new Set(['integer', 'bigInteger', 'decimal', 'float', 'number'])
const DATE_TYPES = new Set(['date', 'datetime', 'dateTime', 'timestamp'])
const CHART_COLORS = ['#00ceff', '#172940', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b']
const TILE_COLORS = ['#00ceff', '#10b981', '#172940', '#f59e0b', '#8b5cf6', '#ef4444']
const DATE_PRESETS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All time' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'last_3_months', label: 'Last 3 months' },
  { id: 'last_6_months', label: 'Last 6 months' },
  { id: 'last_12_months', label: 'Last 12 months' },
  { id: 'ytd', label: 'Year to date' }
]
const WIDGET_TYPES: Array<{ id: WidgetType; label: string }> = [
  { id: 'kpi', label: 'KPI' },
  { id: 'kpi_group', label: 'KPI Group' },
  { id: 'bar', label: 'Bar' },
  { id: 'line', label: 'Line' },
  { id: 'donut', label: 'Donut' },
  { id: 'table', label: 'Table' },
  { id: 'divider', label: 'Divider' }
]
const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'null', 'nnull']

function fmtValue(v: number | null | undefined, format?: WidgetConfig['format']): string {
  if (v == null) return '—'
  const num =
    format?.decimals != null
      ? v.toLocaleString(undefined, {
          minimumFractionDigits: format.decimals,
          maximumFractionDigits: format.decimals
        })
      : formatNumber(v)
  return `${format?.prefix ?? ''}${num}${format?.suffix ?? ''}`
}

function DeltaChip({ pct }: { pct: number | null | undefined }) {
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

// ── Small searchable combobox ─────────────────────────────────────────────────

function Combo({
  value,
  options,
  placeholder,
  onChange,
  allowEmpty
}: {
  value: string | null | undefined
  options: Array<{ id: string; label: string }>
  placeholder: string
  onChange: (v: string | null) => void
  allowEmpty?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className='h-8 w-full justify-between text-[12.5px] font-normal'
        >
          <span className={cn('truncate', !current && 'text-slate-400')}>
            {current?.label ?? placeholder}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12.5px]' />
          <CommandList className='max-h-56'>
            <CommandEmpty>No match.</CommandEmpty>
            {allowEmpty && (
              <CommandItem
                value='__none__'
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className='text-[12.5px] italic text-slate-400'
              >
                (none)
              </CommandItem>
            )}
            {options.map((o) => (
              <CommandItem
                key={o.id}
                value={o.label}
                onSelect={() => {
                  onChange(o.id)
                  setOpen(false)
                }}
                className='text-[12.5px]'
              >
                <Check
                  className={cn('mr-1.5 h-3 w-3', value === o.id ? 'opacity-100' : 'opacity-0')}
                />
                {o.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ── Entity filter chip (multi-select over live distinct values) ───────────────

function FilterChip({
  reportId,
  field,
  label,
  selected,
  onChange,
  onRemove,
  editable
}: {
  reportId: string
  field: string
  label: string
  selected: Array<string | number>
  onChange: (values: Array<string | number>) => void
  onRemove?: () => void
  editable: boolean
}) {
  const [open, setOpen] = useState(false)
  const { data: options = [] } = useQuery({
    queryKey: ['rs-filter-options', reportId, field],
    queryFn: () =>
      api
        .get<{ data: Array<{ value: string; label: string }> }>(
          `/report-studio/${reportId}/filter-options`,
          { params: { field } }
        )
        .then((r) => r.data.data),
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
        <div className='flex items-center justify-between border-t border-slate-100 px-2 py-1.5 dark:border-border'>
          <button
            type='button'
            className='text-[11px] text-slate-400 hover:text-slate-600'
            onClick={() => onChange([])}
          >
            Clear
          </button>
          {editable && onRemove && (
            <button
              type='button'
              className='text-[11px] text-slate-400 hover:text-red-500'
              onClick={onRemove}
            >
              Remove from bar
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── Widget body renderer ──────────────────────────────────────────────────────

function WidgetBody({
  widget,
  dateRange,
  entityFilters
}: {
  widget: Widget
  dateRange: GlobalFilters['date_range']
  entityFilters: EntityFilter[]
}) {
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: [
      'rs-widget',
      widget.id,
      widget.type,
      widget.collection,
      widget.config,
      dateRange,
      entityFilters
    ],
    queryFn: () =>
      api
        .post<{ data: WidgetDataShape }>('/report-studio/preview', {
          type: widget.type,
          collection: widget.collection,
          config: widget.config,
          date_range: dateRange || null,
          entity_filters: entityFilters
        })
        .then((r) => r.data.data),
    enabled: widget.type !== 'divider' && (!!widget.collection || widget.type === 'kpi_group'),
    staleTime: 60_000,
    retry: false
  })

  if (widget.type === 'divider') return null
  if (!widget.collection && widget.type !== 'kpi_group') {
    return <p className='px-1 text-[12px] text-slate-400'>Configure this widget to see data.</p>
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
        <div className='flex h-full flex-col justify-center px-1'>
          <div className='flex items-baseline gap-2'>
            <p className='text-[30px] font-semibold leading-none tracking-tight text-slate-900 dark:text-foreground'>
              {fmtValue(data.value, widget.config?.format)}
            </p>
            <DeltaChip pct={data.change_pct} />
          </div>
          {widget.config?.compare && data.prev_value != null && (
            <p className='mt-1.5 text-[11px] text-slate-400'>
              was {fmtValue(data.prev_value, widget.config?.format)}{' '}
              {widget.config.compare === 'previous_year' ? 'a year ago' : 'last period'}
            </p>
          )}
        </div>
      )
    } else if (widget.type === 'kpi_group') {
      const tiles = data.tiles ?? []
      body = (
        <div
          className='grid h-full gap-2'
          style={{ gridTemplateColumns: `repeat(${Math.max(1, tiles.length)}, 1fr)` }}
        >
          {tiles.map((t, i) => (
            <div
              key={t.label}
              className='flex flex-col justify-center rounded-md border border-slate-100 px-3 py-2 dark:border-border/60'
              style={{
                borderTopColor: t.color ?? TILE_COLORS[i % TILE_COLORS.length],
                borderTopWidth: 2
              }}
            >
              <p className='truncate text-[10.5px] uppercase tracking-wide text-slate-400'>
                {t.label}
              </p>
              <div className='flex items-baseline gap-1.5'>
                <p className='text-[20px] font-semibold leading-tight text-slate-900 dark:text-foreground'>
                  {fmtValue(t.value, t.format)}
                </p>
                <DeltaChip pct={t.change_pct} />
              </div>
            </div>
          ))}
          {tiles.length === 0 && (
            <p className='self-center px-1 text-[12px] text-slate-400'>Add metrics in settings.</p>
          )}
        </div>
      )
    } else if (widget.type === 'table') {
      const rows = data.rows ?? []
      if (rows.length === 0) body = <p className='px-1 text-[12px] text-slate-400'>No rows.</p>
      else {
        const cols = Object.keys(rows[0]).filter((c) => c !== 'id')
        body = (
          <div className='h-full overflow-auto'>
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
      }
    } else {
      const series = data.series ?? []
      if (series.length === 0) body = <p className='px-1 text-[12px] text-slate-400'>No data.</p>
      else if (widget.type === 'donut') {
        const total = series.reduce((a, s) => a + s.value, 0)
        body = (
          <div className='flex h-full items-center gap-3'>
            <div className='relative h-full flex-1'>
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
                <span className='text-[18px] font-semibold leading-none text-slate-900 dark:text-foreground'>
                  {formatNumber(total)}
                </span>
                <span className='text-[9.5px] text-slate-400'>total</span>
              </div>
            </div>
            <div className='max-h-full w-[38%] shrink-0 space-y-0.5 overflow-y-auto pr-1'>
              {series.slice(0, 10).map((s, i) => (
                <div key={s.dim} className='flex items-center gap-1.5 text-[10.5px]'>
                  <span
                    className='h-2 w-2 shrink-0 rounded-sm'
                    style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                  />
                  <span className='truncate text-slate-600 dark:text-slate-300'>{s.dim}</span>
                  <span className='ml-auto tabular-nums text-slate-400'>
                    {formatNumber(s.value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      } else if (widget.type === 'line') {
        body = (
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
              <Line type='monotone' dataKey='value' stroke='#00ceff' strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )
      } else {
        const horizontal = widget.config?.orientation === 'horizontal'
        body = (
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
        )
      }
    }
  }

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='min-h-0 flex-1'>{body}</div>
      <div className='mt-1 flex shrink-0 items-center gap-1 text-[9.5px] text-slate-300 dark:text-slate-500'>
        <span className='h-1.5 w-1.5 rounded-full bg-emerald-400/70' />
        Updated {dataUpdatedAt ? formatRelative(new Date(dataUpdatedAt).toISOString()) : '…'}
        <button
          type='button'
          title='Refresh'
          className='ml-auto rounded p-0.5 hover:text-slate-500'
          onClick={() => refetch()}
        >
          <RefreshCw className={cn('h-2.5 w-2.5', isFetching && 'animate-spin')} />
        </button>
      </div>
    </div>
  )
}

// ── Widget config sheet ───────────────────────────────────────────────────────

function ConfigSheet({
  widget,
  onChange,
  onClose
}: {
  widget: Widget
  onChange: (w: Widget) => void
  onClose: () => void
}) {
  const { data: collections = [] } = useQuery({
    queryKey: ['collections-registry'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string; display_name?: string | null }> }>('/collections')
        .then((r) => r.data.data)
  })
  const { data: fields = [] } = useQuery({
    queryKey: ['field-config', widget.collection],
    queryFn: () =>
      api
        .get<{ data: FieldMeta[] }>(`/field-config/${widget.collection}`)
        .then((r) => r.data.data.filter((f) => !f.field.includes('.'))),
    enabled: !!widget.collection
  })

  const cfg = widget.config ?? {}
  const set = (patch: Partial<Widget>) => onChange({ ...widget, ...patch })
  const setCfg = (patch: Partial<WidgetConfig>) => set({ config: { ...cfg, ...patch } })

  const fieldOpts = fields.map((f) => ({ id: f.field, label: f.label || f.field }))
  const numericOpts = fields
    .filter((f) => NUMERIC_TYPES.has(f.type ?? ''))
    .map((f) => ({ id: f.field, label: f.label || f.field }))
  const dateOpts = fields
    .filter((f) => DATE_TYPES.has(f.type ?? ''))
    .map((f) => ({ id: f.field, label: f.label || f.field }))
  const collectionOpts = collections
    .filter((c) => !c.collection.startsWith('nivaro_'))
    .map((c) => ({ id: c.collection, label: c.display_name || c.collection }))

  const aggregate = cfg.metric?.aggregate ?? 'count'
  const isChart = widget.type === 'bar' || widget.type === 'line' || widget.type === 'donut'

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='w-[400px] overflow-y-auto sm:max-w-[400px]'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-[14px]'>
            <Settings2 className='h-4 w-4 text-nvr-cyan' /> Widget settings
          </SheetTitle>
        </SheetHeader>

        <div className='mt-4 space-y-4'>
          <div className='space-y-1.5'>
            <Label className='text-[11.5px]'>Title</Label>
            <Input
              value={widget.title}
              onChange={(e) => set({ title: e.target.value })}
              className='h-8 text-[13px]'
            />
          </div>

          <div className='space-y-1.5'>
            <Label className='text-[11.5px]'>Type</Label>
            <div className='flex flex-wrap gap-1'>
              {WIDGET_TYPES.map((t) => (
                <button
                  key={t.id}
                  type='button'
                  onClick={() => set({ type: t.id })}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                    widget.type === t.id
                      ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                      : 'border-slate-200 text-slate-400 dark:border-border'
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {widget.type === 'kpi_group' && (
            <KpiGroupEditor
              metrics={cfg.metrics ?? []}
              collections={collectionOpts}
              onChange={(metrics) => setCfg({ metrics })}
            />
          )}

          {widget.type !== 'divider' && widget.type !== 'kpi_group' && (
            <>
              <div className='space-y-1.5'>
                <Label className='text-[11.5px]'>Collection</Label>
                <Combo
                  value={widget.collection}
                  options={collectionOpts}
                  placeholder='Pick a collection'
                  onChange={(v) =>
                    set({
                      collection: v,
                      config: {
                        ...cfg,
                        metric: { aggregate: 'count' },
                        dimension: null,
                        filters: [],
                        columns: []
                      }
                    })
                  }
                />
              </div>

              {widget.type !== 'table' && (
                <div className='space-y-1.5'>
                  <Label className='text-[11.5px]'>Metric</Label>
                  <div className='flex flex-wrap gap-1'>
                    {(['count', 'sum', 'avg', 'min', 'max'] as const).map((a) => (
                      <button
                        key={a}
                        type='button'
                        onClick={() =>
                          setCfg({ metric: { aggregate: a, field: cfg.metric?.field } })
                        }
                        className={cn(
                          'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                          aggregate === a
                            ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                            : 'border-slate-200 text-slate-400 dark:border-border'
                        )}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                  {aggregate !== 'count' && (
                    <Combo
                      value={cfg.metric?.field}
                      options={numericOpts}
                      placeholder='Numeric field'
                      onChange={(v) => setCfg({ metric: { aggregate, field: v ?? undefined } })}
                    />
                  )}
                </div>
              )}

              {isChart && (
                <div className='space-y-1.5'>
                  <Label className='text-[11.5px]'>Group by</Label>
                  <Combo
                    value={cfg.dimension?.field}
                    options={fieldOpts}
                    placeholder='Dimension field'
                    onChange={(v) =>
                      setCfg({ dimension: v ? { field: v, bucket: cfg.dimension?.bucket } : null })
                    }
                  />
                  <div className='flex gap-1'>
                    {([undefined, 'day', 'week', 'month'] as const).map((b) => (
                      <button
                        key={b ?? 'none'}
                        type='button'
                        onClick={() =>
                          cfg.dimension &&
                          setCfg({ dimension: { field: cfg.dimension.field, bucket: b } })
                        }
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[11px]',
                          (cfg.dimension?.bucket ?? undefined) === b
                            ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                            : 'border-slate-200 text-slate-400 dark:border-border'
                        )}
                      >
                        {b ?? 'values'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {widget.type === 'bar' && (
                <div className='flex items-center gap-2'>
                  <Label className='text-[11.5px]'>Horizontal bars</Label>
                  <Switch
                    checked={cfg.orientation === 'horizontal'}
                    onCheckedChange={(v) => setCfg({ orientation: v ? 'horizontal' : 'vertical' })}
                  />
                </div>
              )}

              {widget.type === 'table' && (
                <div className='space-y-1.5'>
                  <Label className='text-[11.5px]'>Columns</Label>
                  <div className='flex flex-wrap gap-1'>
                    {fieldOpts.slice(0, 40).map((f) => {
                      const active = (cfg.columns ?? []).includes(f.id)
                      return (
                        <button
                          key={f.id}
                          type='button'
                          onClick={() =>
                            setCfg({
                              columns: active
                                ? (cfg.columns ?? []).filter((c) => c !== f.id)
                                : [...(cfg.columns ?? []), f.id]
                            })
                          }
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-[10.5px]',
                            active
                              ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                              : 'border-slate-200 text-slate-400 dark:border-border'
                          )}
                        >
                          {f.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className='flex items-center gap-2'>
                    <Label className='text-[11px] text-slate-400'>Sort</Label>
                    <Input
                      value={cfg.sort ?? ''}
                      onChange={(e) => setCfg({ sort: e.target.value })}
                      placeholder='-created_at'
                      className='h-7 w-36 text-[12px]'
                    />
                    <Label className='text-[11px] text-slate-400'>Limit</Label>
                    <Input
                      type='number'
                      value={cfg.limit ?? 10}
                      onChange={(e) => setCfg({ limit: Number(e.target.value) || 10 })}
                      className='h-7 w-16 text-[12px]'
                    />
                  </div>
                </div>
              )}

              <div className='space-y-1.5'>
                <Label className='text-[11.5px]'>Date field (for the report date range)</Label>
                <Combo
                  value={cfg.date_field}
                  options={dateOpts}
                  placeholder='(none — ignores date range)'
                  onChange={(v) => setCfg({ date_field: v })}
                  allowEmpty
                />
              </div>

              {widget.type !== 'table' && (
                <div className='space-y-1.5'>
                  <Label className='text-[11.5px]'>Compare</Label>
                  <div className='flex gap-1'>
                    {(
                      [
                        [null, 'off'],
                        ['previous_period', 'vs prev period'],
                        ['previous_year', 'vs prev year']
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={label}
                        type='button'
                        onClick={() => setCfg({ compare: v })}
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[11px]',
                          (cfg.compare ?? null) === v
                            ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                            : 'border-slate-200 text-slate-400 dark:border-border'
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className='text-[10.5px] text-slate-400'>
                    Needs a date field and an active date range.
                  </p>
                </div>
              )}

              <div className='space-y-1.5'>
                <div className='flex items-center justify-between'>
                  <Label className='text-[11.5px]'>Filters</Label>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-6 px-1.5 text-[11px]'
                    onClick={() =>
                      setCfg({
                        filters: [...(cfg.filters ?? []), { field: '', op: 'eq', value: '' }]
                      })
                    }
                  >
                    <Plus className='mr-1 h-3 w-3' /> Add
                  </Button>
                </div>
                {(cfg.filters ?? []).map((f, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional editing
                  <div key={i} className='flex items-center gap-1'>
                    <div className='w-32 shrink-0'>
                      <Combo
                        value={f.field}
                        options={fieldOpts}
                        placeholder='field'
                        onChange={(v) => {
                          const next = [...(cfg.filters ?? [])]
                          next[i] = { ...next[i], field: v ?? '' }
                          setCfg({ filters: next })
                        }}
                      />
                    </div>
                    <select
                      value={f.op}
                      onChange={(e) => {
                        const next = [...(cfg.filters ?? [])]
                        next[i] = { ...next[i], op: e.target.value }
                        setCfg({ filters: next })
                      }}
                      className='h-8 rounded-md border border-slate-200 bg-white px-1 text-[11.5px] dark:border-border dark:bg-card'
                    >
                      {FILTER_OPS.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </select>
                    {!['null', 'nnull'].includes(f.op) && (
                      <Input
                        value={String(f.value ?? '')}
                        onChange={(e) => {
                          const next = [...(cfg.filters ?? [])]
                          next[i] = { ...next[i], value: e.target.value }
                          setCfg({ filters: next })
                        }}
                        className='h-8 flex-1 text-[12px]'
                        placeholder='value'
                      />
                    )}
                    <button
                      type='button'
                      className='p-1 text-slate-300 hover:text-red-500'
                      onClick={() =>
                        setCfg({ filters: (cfg.filters ?? []).filter((_, j) => j !== i) })
                      }
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>
                ))}
              </div>

              {widget.type === 'kpi' && (
                <div className='space-y-1.5'>
                  <Label className='text-[11.5px]'>Format</Label>
                  <div className='flex items-center gap-2'>
                    <Input
                      value={cfg.format?.prefix ?? ''}
                      onChange={(e) =>
                        setCfg({ format: { ...cfg.format, prefix: e.target.value } })
                      }
                      placeholder='$'
                      className='h-7 w-14 text-[12px]'
                    />
                    <Input
                      value={cfg.format?.suffix ?? ''}
                      onChange={(e) =>
                        setCfg({ format: { ...cfg.format, suffix: e.target.value } })
                      }
                      placeholder='%'
                      className='h-7 w-14 text-[12px]'
                    />
                    <Input
                      type='number'
                      value={cfg.format?.decimals ?? ''}
                      onChange={(e) =>
                        setCfg({
                          format: {
                            ...cfg.format,
                            decimals: e.target.value === '' ? undefined : Number(e.target.value)
                          }
                        })
                      }
                      placeholder='decimals'
                      className='h-7 w-20 text-[12px]'
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── KPI group metrics editor ──────────────────────────────────────────────────

function KpiGroupEditor({
  metrics,
  collections,
  onChange
}: {
  metrics: KpiMetric[]
  collections: Array<{ id: string; label: string }>
  onChange: (m: KpiMetric[]) => void
}) {
  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between'>
        <Label className='text-[11.5px]'>Tiles (max 6)</Label>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 px-1.5 text-[11px]'
          disabled={metrics.length >= 6}
          onClick={() =>
            onChange([
              ...metrics,
              { label: `Metric ${metrics.length + 1}`, collection: '', aggregate: 'count' }
            ])
          }
        >
          <Plus className='mr-1 h-3 w-3' /> Add tile
        </Button>
      </div>
      {metrics.map((m, i) => (
        <MetricRow
          // biome-ignore lint/suspicious/noArrayIndexKey: positional editing
          key={i}
          metric={m}
          collections={collections}
          onChange={(next) => onChange(metrics.map((x, j) => (j === i ? next : x)))}
          onDelete={() => onChange(metrics.filter((_, j) => j !== i))}
        />
      ))}
      {metrics.length === 0 && (
        <p className='text-[11.5px] text-slate-400'>
          Each tile is its own collection + aggregate — like EFP's KPI Summary.
        </p>
      )}
    </div>
  )
}

function MetricRow({
  metric,
  collections,
  onChange,
  onDelete
}: {
  metric: KpiMetric
  collections: Array<{ id: string; label: string }>
  onChange: (m: KpiMetric) => void
  onDelete: () => void
}) {
  const { data: fields = [] } = useQuery({
    queryKey: ['field-config', metric.collection],
    queryFn: () =>
      api
        .get<{ data: FieldMeta[] }>(`/field-config/${metric.collection}`)
        .then((r) => r.data.data.filter((f) => !f.field.includes('.'))),
    enabled: !!metric.collection
  })
  const numericOpts = fields
    .filter((f) => NUMERIC_TYPES.has(f.type ?? ''))
    .map((f) => ({ id: f.field, label: f.label || f.field }))

  return (
    <div className='space-y-1.5 rounded-md border border-slate-200 p-2 dark:border-border'>
      <div className='flex items-center gap-1.5'>
        <Input
          value={metric.label}
          onChange={(e) => onChange({ ...metric, label: e.target.value })}
          className='h-7 flex-1 text-[12px]'
          placeholder='Tile label'
        />
        <button type='button' className='p-1 text-slate-300 hover:text-red-500' onClick={onDelete}>
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      </div>
      <Combo
        value={metric.collection || null}
        options={collections}
        placeholder='Collection'
        onChange={(v) => onChange({ ...metric, collection: v ?? '' })}
      />
      <div className='flex items-center gap-1'>
        {(['count', 'sum', 'avg', 'min', 'max'] as const).map((a) => (
          <button
            key={a}
            type='button'
            onClick={() => onChange({ ...metric, aggregate: a })}
            className={cn(
              'rounded-full border px-1.5 py-0.5 text-[10.5px]',
              metric.aggregate === a
                ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                : 'border-slate-200 text-slate-400 dark:border-border'
            )}
          >
            {a}
          </button>
        ))}
      </div>
      {metric.aggregate !== 'count' && (
        <Combo
          value={metric.field}
          options={numericOpts}
          placeholder='Numeric field'
          onChange={(v) => onChange({ ...metric, field: v ?? undefined })}
        />
      )}
    </div>
  )
}

// ── Alerts sheet ──────────────────────────────────────────────────────────────

interface ReportAlert {
  id: string
  widget: string
  name: string
  conditions: Array<{ field: string; op: string; value: number }>
  is_active: boolean
  firing: boolean
}

function AlertsSheet({
  reportId,
  widgets,
  initialWidget,
  onClose
}: {
  reportId: string
  widgets: Widget[]
  initialWidget?: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const alertable = widgets.filter(
    (w) => w.type === 'kpi' || w.type === 'table' || w.type === 'kpi_group'
  )
  const [widgetId, setWidgetId] = useState<string | null>(initialWidget ?? alertable[0]?.id ?? null)
  const [field, setField] = useState<'value' | 'row_count'>('value')
  const [op, setOp] = useState('gt')
  const [threshold, setThreshold] = useState('')

  const { data: alerts = [] } = useQuery({
    queryKey: ['rs-alerts', reportId],
    queryFn: () =>
      api
        .get<{ data: ReportAlert[] }>(`/report-studio/${reportId}/alerts`)
        .then((r) => r.data.data)
  })

  const create = useMutation({
    mutationFn: () => {
      const widget = widgets.find((w) => w.id === widgetId)
      return api.post(`/report-studio/${reportId}/alerts`, {
        widget: widgetId,
        name: `${widget?.title ?? 'Widget'} ${field} ${op} ${threshold}`,
        conditions: [{ field, op, value: Number(threshold) }]
      })
    },
    onSuccess: () => {
      toast.success('Alert created — checked hourly')
      setThreshold('')
      queryClient.invalidateQueries({ queryKey: ['rs-alerts', reportId] })
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Could not create alert')
  })

  const toggle = useMutation({
    mutationFn: (a: ReportAlert) =>
      api.patch(`/report-studio/${reportId}/alerts/${a.id}`, { is_active: !a.is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rs-alerts', reportId] })
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/report-studio/${reportId}/alerts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rs-alerts', reportId] })
  })

  const widgetTitle = (id: string) => widgets.find((w) => w.id === id)?.title ?? 'deleted widget'

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='w-[380px] overflow-y-auto sm:max-w-[380px]'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-[14px]'>
            <BellRing className='h-4 w-4 text-nvr-cyan' /> Report alerts
          </SheetTitle>
        </SheetHeader>
        <p className='mt-1 text-[11.5px] text-slate-400'>
          Checked hourly. Fires once when crossed, resolves when back in range.
        </p>

        {alertable.length === 0 ? (
          <p className='mt-6 text-[12.5px] text-slate-400'>
            Add a KPI or table widget first — alerts watch their value / row count.
          </p>
        ) : (
          <div className='mt-4 space-y-2 rounded-lg border border-slate-200 p-3 dark:border-border'>
            <Combo
              value={widgetId}
              options={alertable.map((w) => ({ id: w.id, label: w.title }))}
              placeholder='Widget'
              onChange={(v) => setWidgetId(v)}
            />
            <div className='flex items-center gap-1.5'>
              <select
                value={field}
                onChange={(e) => setField(e.target.value as never)}
                className='h-8 rounded-md border border-slate-200 bg-white px-1.5 text-[12px] dark:border-border dark:bg-card'
              >
                <option value='value'>value</option>
                <option value='row_count'>row count</option>
              </select>
              <select
                value={op}
                onChange={(e) => setOp(e.target.value)}
                className='h-8 rounded-md border border-slate-200 bg-white px-1.5 text-[12px] dark:border-border dark:bg-card'
              >
                {['gt', 'gte', 'lt', 'lte', 'eq'].map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <Input
                type='number'
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder='threshold'
                className='h-8 flex-1 text-[12px]'
              />
            </div>
            <Button
              size='sm'
              className='w-full'
              disabled={!widgetId || threshold === '' || create.isPending}
              onClick={() => create.mutate()}
            >
              <Bell className='mr-1.5 h-3.5 w-3.5' /> Create alert
            </Button>
          </div>
        )}

        <div className='mt-4 space-y-1.5'>
          {alerts.map((a) => (
            <div
              key={a.id}
              className='flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-border'
            >
              <div className='min-w-0 flex-1'>
                <p className='truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                  {a.name}
                  {a.firing && (
                    <Badge className='ml-1.5 h-4 bg-red-500 px-1.5 text-[9.5px] text-white'>
                      firing
                    </Badge>
                  )}
                </p>
                <p className='text-[10.5px] text-slate-400'>on “{widgetTitle(a.widget)}”</p>
              </div>
              <Switch checked={a.is_active} onCheckedChange={() => toggle.mutate(a)} />
              <button
                type='button'
                className='p-1 text-slate-300 hover:text-red-500'
                onClick={() => remove.mutate(a.id)}
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            </div>
          ))}
          {alerts.length === 0 && (
            <p className='text-[11.5px] text-slate-400'>No alerts on this report yet.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── Subscribe popover ─────────────────────────────────────────────────────────

function SubscribePopover({ reportId }: { reportId: string }) {
  const queryClient = useQueryClient()
  const { data: sub } = useQuery({
    queryKey: ['rs-sub', reportId],
    queryFn: () =>
      api
        .get<{ data: { cadence: string } | null }>(`/report-studio/${reportId}/subscription`)
        .then((r) => r.data.data)
  })
  const save = useMutation({
    mutationFn: (body: { cadence: string } | null) =>
      api.put(`/report-studio/${reportId}/subscription`, body),
    onSuccess: (_r, body) => {
      toast.success(body ? `Subscribed — ${body.cadence} email digest` : 'Unsubscribed')
      queryClient.invalidateQueries({ queryKey: ['rs-sub', reportId] })
    }
  })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline' className='gap-1.5'>
          <Mail className='h-3.5 w-3.5' />
          {sub ? `Subscribed (${sub.cadence})` : 'Subscribe'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-64 p-3' align='end'>
        <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Email me this report
        </p>
        <p className='mt-0.5 text-[11px] text-slate-400'>
          Rendered fresh — daily at 07:00 or weekly on Mondays.
        </p>
        <div className='mt-2.5 flex gap-1.5'>
          <Button
            size='sm'
            variant={sub?.cadence === 'daily' ? 'default' : 'outline'}
            className='h-7 flex-1 text-[11.5px]'
            onClick={() => save.mutate({ cadence: 'daily' })}
          >
            Daily
          </Button>
          <Button
            size='sm'
            variant={sub?.cadence === 'weekly' ? 'default' : 'outline'}
            className='h-7 flex-1 text-[11.5px]'
            onClick={() => save.mutate({ cadence: 'weekly' })}
          >
            Weekly
          </Button>
        </div>
        {sub && (
          <Button
            size='sm'
            variant='ghost'
            className='mt-1.5 h-7 w-full text-[11.5px] text-slate-400 hover:text-red-500'
            onClick={() => save.mutate(null)}
          >
            Unsubscribe
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── AI build popover ──────────────────────────────────────────────────────────

function AiBuildPopover({
  reportId,
  onWidgets
}: {
  reportId: string
  onWidgets: (widgets: Widget[]) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [open, setOpen] = useState(false)
  const build = useMutation({
    mutationFn: () =>
      api.post<{ data: { widgets: Widget[] } }>(`/report-studio/${reportId}/ai-build`, { prompt }),
    onSuccess: (r) => {
      const widgets = r.data.data.widgets.map((w) => ({
        ...w,
        id: crypto.randomUUID(),
        collection: w.collection ?? null,
        config: w.config ?? null
      }))
      onWidgets(widgets)
      toast.success(`AI composed ${widgets.length} widgets`)
      setOpen(false)
      setPrompt('')
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'AI build failed')
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline' className='gap-1.5'>
          <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' /> Build with AI
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-80 p-3' align='end'>
        <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Describe the report
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder='e.g. an executive overview of workflows: totals, monthly trend, breakdown by state, and the 10 newest records'
          className='mt-2 w-full rounded-md border border-slate-200 bg-white p-2 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-card'
        />
        <Button
          size='sm'
          className='mt-2 w-full gap-1.5'
          disabled={!prompt.trim() || build.isPending}
          onClick={() => build.mutate()}
        >
          {build.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Sparkles className='h-3.5 w-3.5' />
          )}
          Compose widgets
        </Button>
        <p className='mt-1.5 text-[10.5px] text-slate-400'>
          Replaces the current layout — Clone first if you want to keep it.
        </p>
      </PopoverContent>
    </Popover>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function ReportStudioEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [editMode, setEditMode] = useState(false)
  const [widgets, setWidgets] = useState<Widget[]>([])
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [alertsFor, setAlertsFor] = useState<string | null | false>(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [entityFilters, setEntityFilters] = useState<EntityFilter[]>([])
  const [aiFilterPrompt, setAiFilterPrompt] = useState('')
  const skipSaveRef = useRef(true)
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: report } = useQuery({
    queryKey: ['report-def', id],
    queryFn: () => api.get<{ data: ReportDetail }>(`/report-studio/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  useEffect(() => {
    if (report) {
      skipSaveRef.current = true
      setWidgets(report.widgets)
    }
  }, [report])

  useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    if (!report?.editable || !id) return
    const t = setTimeout(() => {
      void api.put(`/report-studio/${id}/widgets`, { widgets }).catch(() => {
        toast.error('Could not save the report layout')
      })
    }, 800)
    return () => clearTimeout(t)
  }, [widgets, id, report?.editable])

  const patchReport = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/report-studio/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['report-def', id] })
  })

  const gf: GlobalFilters = report?.global_filters ?? {}
  const dateRange = gf.date_range ?? null
  const filterBar = gf.filter_bar ?? []

  const aiFilters = useMutation({
    mutationFn: () =>
      api.post<{
        data: { date_range?: GlobalFilters['date_range']; entity_filters?: EntityFilter[] }
      }>(`/report-studio/${id}/ai-filters`, {
        prompt: aiFilterPrompt,
        fields: filterBar.map((f) => f.field)
      }),
    onSuccess: (r) => {
      const d = r.data.data
      if (d.entity_filters) setEntityFilters(d.entity_filters.filter((f) => f.values?.length))
      if (d.date_range !== undefined) {
        patchReport.mutate({ global_filters: { ...gf, date_range: d.date_range } })
      }
      setAiFilterPrompt('')
      toast.success('Filters applied')
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Could not parse that')
  })

  const layout = useMemo(
    () => widgets.map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 1 })),
    [widgets]
  )

  const onLayoutChange = useCallback(
    (next: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>) => {
      if (!editMode) return
      setWidgets((prev) =>
        prev.map((w) => {
          const l = next.find((n) => n.i === w.id)
          return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w
        })
      )
    },
    [editMode]
  )

  function addWidget(type: WidgetType) {
    const maxY = Math.max(0, ...widgets.map((w) => w.y + w.h))
    setWidgets((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        type,
        title:
          type === 'divider' ? 'Section' : type === 'kpi_group' ? 'KPI Summary' : `New ${type}`,
        collection: null,
        config: type === 'kpi_group' ? { metrics: [] } : { metric: { aggregate: 'count' } },
        x: 0,
        y: maxY,
        w: type === 'kpi' ? 3 : type === 'divider' || type === 'kpi_group' ? 12 : 6,
        h: type === 'kpi' ? 2 : type === 'divider' ? 1 : type === 'kpi_group' ? 2 : 3
      }
    ])
    setEditMode(true)
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ version: 1, name: report?.name, widgets }, null, 2)], {
      type: 'application/json'
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(report?.name ?? 'report').replace(/\s+/g, '_')}_report.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function importJson(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as { version?: number; widgets?: Widget[] }
        if (!parsed.version || !Array.isArray(parsed.widgets)) throw new Error('bad format')
        setWidgets(parsed.widgets.map((w) => ({ ...w, id: crypto.randomUUID() })))
        setEditMode(true)
        toast.success(`Imported ${parsed.widgets.length} widgets`)
      } catch {
        toast.error('Not a valid report export')
      }
    }
    reader.readAsText(file)
  }

  const clone = useMutation({
    mutationFn: () => api.post<{ data: { id: string } }>(`/report-studio/${id}/clone`),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['report-defs'] })
      navigate(`/report-studio/${r.data.data.id}`)
      toast.success('Report cloned')
    }
  })

  if (!report) {
    return (
      <div className='flex flex-1 items-center justify-center text-[13px] text-slate-400'>
        Loading report…
      </div>
    )
  }

  const configuringWidget = widgets.find((w) => w.id === configuring)
  const anyFilterActive = entityFilters.some((f) => f.values.length > 0)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-3 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <button
            type='button'
            onClick={() => navigate('/report-studio')}
            className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
          >
            <ArrowLeft className='h-4 w-4' />
          </button>
          <BarChart3 className='h-4 w-4 text-nvr-cyan' />
          {renaming !== null ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                patchReport.mutate({ name: renaming })
                setRenaming(null)
              }}
            >
              <Input
                autoFocus
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={() => {
                  patchReport.mutate({ name: renaming })
                  setRenaming(null)
                }}
                className='h-7 w-64 text-[14px] font-semibold'
              />
            </form>
          ) : (
            <button
              type='button'
              className='text-[15px] font-semibold tracking-[-0.01em] text-slate-900 hover:underline dark:text-foreground'
              onClick={() => report.editable && setRenaming(report.name)}
              title={report.editable ? 'Rename' : undefined}
            >
              {report.name}
            </button>
          )}

          <div className='ml-auto flex items-center gap-1.5'>
            {report.editable && <AiBuildPopover reportId={report.id} onWidgets={setWidgets} />}
            <SubscribePopover reportId={report.id} />
            <Button size='sm' variant='outline' className='gap-1.5' onClick={() => setAlertsFor(null)}>
              <Bell className='h-3.5 w-3.5' /> Alerts
            </Button>
            {report.editable && (
              <>
                <Button
                  size='sm'
                  variant='outline'
                  className='gap-1.5'
                  onClick={() => patchReport.mutate({ is_shared: !report.is_shared })}
                >
                  <Globe className={cn('h-3.5 w-3.5', report.is_shared && 'text-nvr-cyan')} />
                  {report.is_shared ? 'Shared' : 'Share'}
                </Button>
                <Button size='sm' variant='outline' className='gap-1.5' onClick={() => clone.mutate()}>
                  <Copy className='h-3.5 w-3.5' /> Clone
                </Button>
                <Button size='sm' variant='outline' className='gap-1.5' onClick={exportJson}>
                  <Download className='h-3.5 w-3.5' /> Export
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  className='gap-1.5'
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className='h-3.5 w-3.5' /> Import
                </Button>
                <input
                  ref={fileRef}
                  type='file'
                  accept='.json'
                  className='hidden'
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) importJson(f)
                    e.target.value = ''
                  }}
                />
                <Button
                  size='sm'
                  variant={editMode ? 'default' : 'outline'}
                  className='gap-1.5'
                  onClick={() => setEditMode((v) => !v)}
                >
                  {editMode ? <Eye className='h-3.5 w-3.5' /> : <Pencil className='h-3.5 w-3.5' />}
                  {editMode ? 'Done' : 'Edit'}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Global filter bar — EFP-style */}
        <div className='mt-2 flex flex-wrap items-center gap-1.5'>
          <select
            value={dateRange?.preset ?? ''}
            onChange={(e) =>
              patchReport.mutate({
                global_filters: {
                  ...gf,
                  date_range: e.target.value ? { preset: e.target.value } : null
                }
              })
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
              reportId={report.id}
              field={f.field}
              label={f.label}
              selected={entityFilters.find((e) => e.field === f.field)?.values ?? []}
              editable={!!report.editable}
              onChange={(values) =>
                setEntityFilters((prev) => [
                  ...prev.filter((e) => e.field !== f.field),
                  ...(values.length > 0 ? [{ field: f.field, values }] : [])
                ])
              }
              onRemove={() =>
                patchReport.mutate({
                  global_filters: {
                    ...gf,
                    filter_bar: filterBar.filter((x) => x.field !== f.field)
                  }
                })
              }
            />
          ))}

          {report.editable && (
            <AddFilterField
              gf={gf}
              widgets={widgets}
              onSave={(next) => patchReport.mutate({ global_filters: next })}
            />
          )}

          {anyFilterActive && (
            <button
              type='button'
              className='flex items-center gap-1 text-[11.5px] text-slate-400 hover:text-red-500'
              onClick={() => setEntityFilters([])}
            >
              <X className='h-3 w-3' /> Clear
            </button>
          )}

          <form
            className='ml-auto flex items-center gap-1'
            onSubmit={(e) => {
              e.preventDefault()
              if (aiFilterPrompt.trim()) aiFilters.mutate()
            }}
          >
            <Sparkles className='h-3 w-3 text-nvr-cyan' />
            <input
              value={aiFilterPrompt}
              onChange={(e) => setAiFilterPrompt(e.target.value)}
              placeholder='Ask AI to set filters… e.g. "last 6 months"'
              className='h-7 w-64 rounded-md border border-slate-200 bg-white px-2 text-[11.5px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-card'
            />
            {aiFilters.isPending && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
          </form>
        </div>

        {editMode && (
          <div className='mt-2 flex items-center gap-1.5'>
            <span className='text-[11px] text-slate-400'>Add widget:</span>
            {WIDGET_TYPES.map((t) => (
              <button
                key={t.id}
                type='button'
                onClick={() => addWidget(t.id)}
                className='rounded-full border border-dashed border-slate-300 px-2.5 py-0.5 text-[11.5px] text-slate-500 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:hover:text-nvr-cyan'
              >
                + {t.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 px-4 py-4 dark:bg-background'>
        {widgets.length === 0 ? (
          <div className='max-w-md px-2 py-8'>
            <BarChart3 className='h-8 w-8 text-slate-300' />
            <h2 className='mt-4 text-[15px] font-semibold text-slate-800 dark:text-foreground'>
              Empty report
            </h2>
            <p className='mt-1.5 text-[12.5px] text-slate-500'>
              Hit Edit and add widgets — or let Build with AI compose a starting layout.
            </p>
          </div>
        ) : (
          <Grid
            layout={layout}
            cols={12}
            rowHeight={72}
            margin={[12, 12]}
            isDraggable={editMode}
            isResizable={editMode}
            draggableHandle='.rs-drag'
            onLayoutChange={onLayoutChange}
          >
            {widgets.map((w) => (
              <div
                key={w.id}
                className={cn(
                  'group/widget overflow-hidden',
                  w.type === 'divider'
                    ? 'flex items-end'
                    : 'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
                )}
              >
                {w.type === 'divider' ? (
                  <div className='flex w-full items-center gap-2 border-b border-slate-200 pb-1 dark:border-border'>
                    {editMode && (
                      <GripVertical className='rs-drag h-3.5 w-3.5 cursor-grab text-slate-300' />
                    )}
                    <h3 className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
                      {w.title}
                    </h3>
                    {editMode && (
                      <span className='ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover/widget:opacity-100'>
                        <button
                          type='button'
                          className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                          onClick={() => setConfiguring(w.id)}
                        >
                          <Settings2 className='h-3.5 w-3.5' />
                        </button>
                        <button
                          type='button'
                          className='rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-500'
                          onClick={() => setWidgets((p) => p.filter((x) => x.id !== w.id))}
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </button>
                      </span>
                    )}
                  </div>
                ) : (
                  <div className='flex h-full flex-col p-3'>
                    <div className='mb-1.5 flex items-center gap-1.5'>
                      {editMode && (
                        <GripVertical className='rs-drag h-3.5 w-3.5 shrink-0 cursor-grab text-slate-300' />
                      )}
                      <p className='truncate text-[11.5px] font-medium uppercase tracking-wide text-slate-400'>
                        {w.title}
                      </p>
                      <span className='ml-auto flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover/widget:opacity-100'>
                        {(w.type === 'kpi' || w.type === 'table' || w.type === 'kpi_group') && (
                          <button
                            type='button'
                            title='Alert on this widget'
                            className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-amber-500 dark:hover:bg-muted'
                            onClick={() => setAlertsFor(w.id)}
                          >
                            <Bell className='h-3.5 w-3.5' />
                          </button>
                        )}
                        {editMode && (
                          <>
                            <button
                              type='button'
                              className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                              onClick={() => setConfiguring(w.id)}
                            >
                              <Settings2 className='h-3.5 w-3.5' />
                            </button>
                            <button
                              type='button'
                              className='rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-500'
                              onClick={() => setWidgets((p) => p.filter((x) => x.id !== w.id))}
                            >
                              <Trash2 className='h-3.5 w-3.5' />
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                    <div className='min-h-0 flex-1'>
                      <WidgetBody widget={w} dateRange={dateRange} entityFilters={entityFilters} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </Grid>
        )}
      </div>

      {configuringWidget && (
        <ConfigSheet
          widget={configuringWidget}
          onChange={(next) => setWidgets((p) => p.map((w) => (w.id === next.id ? next : w)))}
          onClose={() => setConfiguring(null)}
        />
      )}
      {alertsFor !== false && (
        <AlertsSheet
          reportId={report.id}
          widgets={widgets}
          initialWidget={alertsFor}
          onClose={() => setAlertsFor(false)}
        />
      )}
    </div>
  )
}

// ── "+ Filter" — add a field to the report's filter bar ───────────────────────

function AddFilterField({
  gf,
  widgets,
  onSave
}: {
  gf: GlobalFilters
  widgets: Widget[]
  onSave: (next: GlobalFilters) => void
}) {
  const collections = [...new Set(widgets.map((w) => w.collection).filter(Boolean))] as string[]
  const first = collections[0]
  const { data: fields = [] } = useQuery({
    queryKey: ['field-config', first],
    queryFn: () =>
      api
        .get<{ data: FieldMeta[] }>(`/field-config/${first}`)
        .then((r) => r.data.data.filter((f) => !f.field.includes('.'))),
    enabled: !!first
  })
  const existing = new Set((gf.filter_bar ?? []).map((f) => f.field))
  const opts = fields
    .filter((f) => !existing.has(f.field) && f.field !== 'id')
    .map((f) => ({ id: f.field, label: f.label || f.field }))
  const [open, setOpen] = useState(false)

  if (!first) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-7 items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-[11.5px] text-slate-400 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:hover:text-nvr-cyan'
        >
          <Plus className='h-3 w-3' /> Filter
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Add filter field…' className='h-8 text-[12.5px]' />
          <CommandList className='max-h-52'>
            <CommandEmpty>No fields.</CommandEmpty>
            {opts.map((o) => (
              <CommandItem
                key={o.id}
                value={o.label}
                onSelect={() => {
                  onSave({
                    ...gf,
                    filter_bar: [...(gf.filter_bar ?? []), { field: o.id, label: o.label }]
                  })
                  setOpen(false)
                }}
                className='text-[12.5px]'
              >
                {o.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
