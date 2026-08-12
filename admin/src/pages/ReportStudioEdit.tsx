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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useGoBack } from '@/lib/nav'
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
import { QueryWidgetBody } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider } from '@nivaro/shared'
import { api } from '@/lib/api'
import { cn, formatNumber, formatRelative } from '@/lib/utils'

/**
 * Report Studio builder — 12-col drag/resize grid (react-grid-layout) of
 * user-defined widgets over any collection, with an EFP-grade global filter
 * bar (entity filters + date range + ask-AI), per-widget freshness/refresh,
 * prior-period comparison, multi-KPI cards, and Build-with-AI composition.
 * No Save button: edits debounce-persist automatically.
 */


type WidgetType = 'kpi' | 'kpi_group' | 'bar' | 'line' | 'donut' | 'table' | 'divider' | 'query'

// ─── Prebuilt widget catalog ──────────────────────────────────────────────────
// Data-driven presets (nivaro_report_widget_presets — EFP seeds its staging
// report library). Users pick a ready-made widget instead of building the
// metric by hand; Blank chips below keep the build-your-own path.

interface WidgetPreset {
  id: number
  name: string
  category: string
  description: string | null
  widget_type: WidgetType
  config: Record<string, unknown> | null
  w: number
  h: number
}

const PRESET_CATEGORY_LABELS: Record<string, string> = {
  overview: 'Overview',
  financial: 'Financial',
  workflows: 'Workflows',
  operations: 'Operations',
  integration: 'Integration',
  layout: 'Layout',
  general: 'General'
}

function WidgetCatalogDialog({
  open,
  onClose,
  onPick
}: {
  open: boolean
  onClose: () => void
  onPick: (p: WidgetPreset) => void
}) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string>('all')
  const { data: presets = [] } = useQuery<WidgetPreset[]>({
    queryKey: ['report-widget-presets'],
    queryFn: () => api.get('/report-studio/widget-presets').then((r) => r.data.data ?? []),
    enabled: open,
    staleTime: 5 * 60_000
  })
  if (!open) return null
  const cats = [...new Set(presets.map((p) => p.category))]
  const shown = presets.filter(
    (p) =>
      (cat === 'all' || p.category === cat) &&
      (!q.trim() ||
        `${p.name} ${p.description ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
  )
  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4' onClick={onClose}>
      <div
        className='flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='border-b border-slate-100 px-4 py-3 dark:border-border'>
          <p className='text-[14px] font-semibold text-slate-800 dark:text-foreground'>Add widgets</p>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='Search widgets…'
            className='mt-2 h-8 w-full rounded-md border border-slate-200 px-2.5 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-background'
          />
          <div className='mt-2 flex flex-wrap items-center gap-1'>
            {['all', ...cats].map((c) => (
              <button
                key={c}
                type='button'
                onClick={() => setCat(c)}
                className={[
                  'rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors',
                  cat === c
                    ? 'bg-nvr-cyan/10 font-semibold text-nvr-navy dark:text-nvr-cyan'
                    : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-accent'
                ].join(' ')}
              >
                {c === 'all'
                  ? `All (${presets.length})`
                  : `${PRESET_CATEGORY_LABELS[c] ?? c} (${presets.filter((p) => p.category === c).length})`}
              </button>
            ))}
          </div>
        </div>
        <div className='grid flex-1 grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2'>
          {shown.length === 0 ? (
            <p className='col-span-2 px-2 py-6 text-center text-[12.5px] text-slate-400'>
              No widgets match.
            </p>
          ) : (
            shown.map((p) => (
              <button
                key={p.id}
                type='button'
                onClick={() => {
                  onPick(p)
                  onClose()
                }}
                className='rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-left transition-colors hover:border-nvr-cyan hover:bg-[#f0fbfe] dark:border-border dark:bg-background dark:hover:bg-[#0b2530]'
              >
                <p className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>{p.name}</p>
                <p className='mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-slate-500 dark:text-slate-400'>
                  {p.description}
                </p>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

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

interface QueryWidgetCfg {
  slug: string
  params?: Record<string, string>
  display: 'table' | 'bar' | 'hbar' | 'stacked_bar' | 'line' | 'area' | 'donut' | 'kpis' | 'tree'
  columns?: Array<{ field: string; label?: string; format?: string; decimals?: number }>
  x_field?: string
  series?: Array<{ field: string; label?: string; color?: string; dash?: boolean }>
  value_format?: string
  limit?: number
  sort?: string
  totals?: boolean
  horizontal?: boolean
  group_rows?: boolean
  tree?: {
    levels: string[]
    badge?: string
    pct?: { num: string; den: string; label?: string }
    thresholds?: Array<{ gte: number; color: string }>
    drill?: { collection: string; id_field: string }
  }
}

interface WidgetConfig {
  metric?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string }
  dimension?: { field: string; bucket?: 'day' | 'week' | 'month' } | null
  filters?: WidgetFilter[]
  date_field?: string | null
  limit?: number
  columns?: Array<string | { field: string; label?: string; format?: string }>
  sort?: string
  format?: { prefix?: string; suffix?: string; decimals?: number }
  compare?: 'previous_period' | 'previous_year' | null
  orientation?: 'horizontal' | 'vertical'
  metrics?: KpiMetric[]
  query?: QueryWidgetCfg
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

// Category-axis ticks for date-heavy charts (mirrors shared ReportView):
// '2026-07' → "Jul '26", full dates → 'Jul 4'; dense axes thin to ~12 labels.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const compactCatTick = (v: unknown): string => {
  const raw = String(v ?? '')
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(raw)
  if (m) {
    const mon = MONTH_ABBR[Number(m[2]) - 1] ?? m[2]
    return m[3] ? `${mon} ${Number(m[3])}` : `${mon} '${m[1].slice(2)}`
  }
  return raw.length > 16 ? `${raw.slice(0, 15)}…` : raw
}
const catAxisProps = (count: number) => ({
  interval: count > 12 ? Math.ceil(count / 12) - 1 : 0,
  tickFormatter: compactCatTick,
  minTickGap: 4
})

interface EntityFilter {
  field: string
  values: Array<string | number>
  labels?: string[]
}

interface GlobalFilters {
  date_range?: { preset: string; start?: string; end?: string } | null
  filter_bar?: Array<{
    field: string
    label: string
    options?: { collection: string; value_field?: string; label_field?: string; sort?: string }
  }>
}

interface ReportDetail {
  id: string
  name: string
  description?: string | null
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

// Query widgets render through the SAME shared component headless hosts use;
// the shared tree needs a Nivaro client context (admin is same-origin).
const nivaroClient = createNivaro(window.location.origin)
const toSharedRange = (r: { preset: string; start?: string; end?: string } | null | '') =>
  r && r.preset ? ({ preset: r.preset, start: r.start, end: r.end } as never) : null
const TILE_COLORS = ['#00ceff', '#10b981', '#172940', '#f59e0b', '#8b5cf6', '#ef4444']
const DATE_PRESETS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All time' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'last_3_months', label: 'Last 3 months' },
  { id: 'last_6_months', label: 'Last 6 months' },
  { id: 'last_12_months', label: 'Last 12 months' },
  { id: 'ytd', label: 'Year to date' },
  { id: 'custom', label: 'Custom range…' }
]
const WIDGET_TYPES: Array<{ id: WidgetType; label: string }> = [
  { id: 'kpi', label: 'KPI' },
  { id: 'kpi_group', label: 'KPI Group' },
  { id: 'bar', label: 'Bar' },
  { id: 'line', label: 'Line' },
  { id: 'donut', label: 'Donut' },
  { id: 'table', label: 'Table' },
  { id: 'query', label: 'Query' },
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
  optionSource,
  selected,
  onChange,
  onRemove,
  editable,
  allowedValues
}: {
  reportId: string
  field: string
  label: string
  optionSource?: { collection: string; value_field?: string; label_field?: string; sort?: string }
  selected: Array<string | number>
  onChange: (values: Array<string | number>, labels: string[]) => void
  onRemove?: () => void
  editable: boolean
  allowedValues?: Array<string | number>
}) {
  const [open, setOpen] = useState(false)
  const { data: options = [] } = useQuery({
    queryKey: ['rs-filter-options', reportId, field, optionSource ?? null],
    queryFn: async () => {
      if (optionSource) {
        const vf = optionSource.value_field ?? 'id'
        const lf = optionSource.label_field ?? vf
        const r = await api.get<{ data: Array<Record<string, unknown>> }>(
          `/items/${optionSource.collection}`,
          {
            params: {
              fields: [...new Set(['id', vf, lf])].join(','),
              ...(optionSource.sort ? { sort: optionSource.sort } : {}),
              limit: 200
            }
          }
        )
        return (r.data.data ?? []).map((row) => ({
          value: String(row[vf] ?? row.id),
          label: String(row[lf] ?? row[vf] ?? row.id)
        }))
      }
      return api
        .get<{ data: Array<{ value: string; label: string }> }>(
          `/report-studio/${reportId}/filter-options`,
          { params: { field } }
        )
        .then((r) => r.data.data)
    },
    enabled: open,
    staleTime: 120_000
  })
  // Restricted scope values narrow the visible options (server enforces anyway)
  const visibleOptions = allowedValues?.length
    ? options.filter((o) => allowedValues.some((v) => String(v) === o.value))
    : options
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
            {visibleOptions.map((o) => {
              const isOn = selected.some((v) => String(v) === o.value)
              return (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => {
                    const next = isOn
                      ? selected.filter((v) => String(v) !== o.value)
                      : [...selected, o.value]
                    const labelFor = (v: string | number) =>
                      options.find((x) => x.value === String(v))?.label ?? String(v)
                    onChange(next, next.map(labelFor))
                  }}
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
            onClick={() => onChange([], [])}
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
    enabled:
      widget.type !== 'divider' &&
      widget.type !== 'query' &&
      (!!widget.collection || widget.type === 'kpi_group'),
    staleTime: 60_000,
    retry: false
  })

  if (widget.type === 'divider') return null
  if (widget.type === 'query') {
    const qc = widget.config?.query
    if (!qc?.slug)
      return <p className='px-1 text-[12px] text-slate-400'>Set a query slug to see data.</p>
    return (
      <NivaroProvider client={nivaroClient}>
        <div className='flex h-full min-h-0 flex-col'>
          <QueryWidgetBody cfg={qc as never} dateRange={toSharedRange(dateRange ?? null)} entityFilters={entityFilters} />
        </div>
      </NivaroProvider>
    )
  }
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
              <XAxis
                dataKey='dim'
                tick={{ fontSize: 10 }}
                stroke='#94a3b8'
                {...catAxisProps(series.length)}
              />
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
                  <XAxis
                    dataKey='dim'
                    tick={{ fontSize: 10 }}
                    stroke='#94a3b8'
                    {...catAxisProps(series.length)}
                  />
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

          {widget.type === 'query' && (
            <QueryConfigEditor
              value={cfg.query ?? { slug: '', display: 'table' }}
              onChange={(query) => setCfg({ query })}
            />
          )}

          {widget.type === 'kpi_group' && (
            <KpiGroupEditor
              metrics={cfg.metrics ?? []}
              collections={collectionOpts}
              onChange={(metrics) => setCfg({ metrics })}
            />
          )}

          {widget.type !== 'divider' && widget.type !== 'kpi_group' && widget.type !== 'query' && (
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

              {(widget.type === 'bar' || widget.type === 'donut') && (
                <div className='flex items-center gap-2'>
                  <Label className='text-[11.5px]'>Top N</Label>
                  <Input
                    type='number'
                    value={cfg.limit ?? 12}
                    onChange={(e) => setCfg({ limit: Number(e.target.value) || 12 })}
                    className='h-7 w-16 text-[12px]'
                  />
                  <span className='text-[10.5px] text-slate-400'>groups (max 50)</span>
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

              {(widget.type as string) !== 'kpi_group' && (
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

function JsonArea({
  label,
  value,
  onCommit,
  rows = 3
}: {
  label: string
  value: unknown
  onCommit: (v: unknown) => void
  rows?: number
}) {
  const [text, setText] = useState(() => (value == null ? '' : JSON.stringify(value, null, 1)))
  const [bad, setBad] = useState(false)
  return (
    <div className='space-y-1.5'>
      <Label className='text-[11.5px]'>{label}</Label>
      <textarea
        value={text}
        rows={rows}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          const t = e.target.value.trim()
          if (!t) {
            setBad(false)
            onCommit(undefined)
            return
          }
          try {
            onCommit(JSON.parse(t))
            setBad(false)
          } catch {
            setBad(true)
          }
        }}
        className={cn(
          'w-full rounded-md border bg-white px-2 py-1.5 font-mono text-[11px] dark:bg-card',
          bad ? 'border-red-400' : 'border-slate-200 dark:border-border'
        )}
      />
    </div>
  )
}

const QUERY_DISPLAYS: Array<QueryWidgetCfg['display']> = [
  'table',
  'bar',
  'hbar',
  'stacked_bar',
  'line',
  'area',
  'donut',
  'kpis',
  'tree'
]
const COL_FORMATS = ['', 'currency', 'number', 'integer', 'percent', 'days', 'date', 'datetime']

function QueryConfigEditor({
  value,
  onChange
}: {
  value: QueryWidgetCfg
  onChange: (v: QueryWidgetCfg) => void
}) {
  const set = (patch: Partial<QueryWidgetCfg>) => onChange({ ...value, ...patch })
  return (
    <div className='space-y-4'>
      <div className='space-y-1.5'>
        <Label className='text-[11.5px]'>Custom query slug</Label>
        <Input
          value={value.slug}
          onChange={(e) => set({ slug: e.target.value })}
          placeholder='e.g. vendor-scorecard'
          className='h-8 font-mono text-[12px]'
        />
      </div>
      <div className='space-y-1.5'>
        <Label className='text-[11.5px]'>Display</Label>
        <div className='flex flex-wrap gap-1'>
          {QUERY_DISPLAYS.map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => set({ display: d })}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                value.display === d
                  ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-400 dark:border-border'
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <JsonArea
        label='Params — literals or $filters.<field> / $date.start / $date.end tokens'
        value={value.params}
        onCommit={(v) => set({ params: v as Record<string, string> | undefined })}
      />
      {value.display !== 'table' && value.display !== 'kpis' && (
        <div className='space-y-1.5'>
          <Label className='text-[11.5px]'>X / category field</Label>
          <Input
            value={value.x_field ?? ''}
            onChange={(e) => set({ x_field: e.target.value || undefined })}
            className='h-8 font-mono text-[12px]'
          />
        </div>
      )}
      <JsonArea
        label='Columns — [{"field","label","format"}] (table + kpis)'
        value={value.columns}
        onCommit={(v) => set({ columns: v as QueryWidgetCfg['columns'] })}
        rows={4}
      />
      <JsonArea
        label='Series — [{"field","label","color","dash"}] (charts)'
        value={value.series}
        onCommit={(v) => set({ series: v as QueryWidgetCfg['series'] })}
      />
      {value.display === 'tree' && (
        <JsonArea
          label='Tree — {"levels":[...],"badge","pct":{"num","den"},"drill":{"collection","id_field"}}'
          value={value.tree}
          onCommit={(v) => set({ tree: v as QueryWidgetCfg['tree'] })}
          rows={4}
        />
      )}
      <div className='grid grid-cols-2 gap-2'>
        <div className='space-y-1.5'>
          <Label className='text-[11.5px]'>Value format</Label>
          <select
            value={value.value_format ?? ''}
            onChange={(e) => set({ value_format: e.target.value || undefined })}
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-1.5 text-[12px] dark:border-border dark:bg-card'
          >
            {COL_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f || '(raw)'}
              </option>
            ))}
          </select>
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[11.5px]'>Sort (-field = desc)</Label>
          <Input
            value={value.sort ?? ''}
            onChange={(e) => set({ sort: e.target.value || undefined })}
            className='h-8 font-mono text-[12px]'
          />
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[11.5px]'>Row limit</Label>
          <Input
            type='number'
            value={value.limit ?? ''}
            onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : undefined })}
            className='h-8 text-[12px]'
          />
        </div>
        <div className='flex items-end gap-3 pb-1'>
          <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
            <Switch checked={!!value.totals} onCheckedChange={(v) => set({ totals: v })} />
            Totals
          </label>
          <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
            <Switch checked={!!value.horizontal} onCheckedChange={(v) => set({ horizontal: v })} />
            Horiz.
          </label>
        </div>
      </div>
    </div>
  )
}

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
      <div className='flex items-center gap-1.5'>
        <Input
          value={metric.format?.prefix ?? ''}
          onChange={(e) => onChange({ ...metric, format: { ...metric.format, prefix: e.target.value } })}
          placeholder='$'
          className='h-6 w-10 text-[11px]'
        />
        <Input
          type='number'
          value={metric.format?.decimals ?? ''}
          onChange={(e) =>
            onChange({
              ...metric,
              format: {
                ...metric.format,
                decimals: e.target.value === '' ? undefined : Number(e.target.value)
              }
            })
          }
          placeholder='dp'
          className='h-6 w-12 text-[11px]'
        />
        <span className='flex gap-1'>
          {TILE_COLORS.map((c) => (
            <button
              key={c}
              type='button'
              aria-label={`Tile color ${c}`}
              onClick={() => onChange({ ...metric, color: metric.color === c ? undefined : c })}
              className={cn(
                'h-4 w-4 rounded-full border',
                metric.color === c ? 'ring-2 ring-offset-1 ring-slate-400' : 'border-slate-200'
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </span>
      </div>
    </div>
  )
}

// ── Alerts sheet ──────────────────────────────────────────────────────────────

interface ReportAlert {
  id: string
  widget: string
  name: string
  conditions: Array<{ field: string; op: string; value: number }>
  filters?: EntityFilter[] | null
  is_active: boolean
  firing: boolean
  delivery_email?: boolean
  delivery_inapp?: boolean
  last_fired?: string | null
}

interface FilterPresetRow {
  id: number
  name: string
  date_range: GlobalFilters['date_range']
  entity_filters: EntityFilter[]
}

// Self-contained (memoized, own input state) so typing in the AI prompt or
// preset name never re-renders the widget canvas — a page-level prompt state
// re-rendered every chart per keystroke.
const FilterExtrasBar = memo(function FilterExtrasBar({
  reportId,
  filterBar,
  appliedRange,
  appliedFilters,
  onApply
}: {
  reportId: string
  filterBar: NonNullable<GlobalFilters['filter_bar']>
  appliedRange: GlobalFilters['date_range']
  appliedFilters: EntityFilter[]
  onApply: (d: { date_range?: GlobalFilters['date_range']; entity_filters?: EntityFilter[] }) => void
}) {
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const [presetName, setPresetName] = useState('')

  const { data: presets = [] } = useQuery({
    queryKey: ['rs-filter-presets', reportId],
    queryFn: () =>
      api
        .get<{ data: FilterPresetRow[] }>(`/report-studio/${reportId}/filter-presets`)
        .then((r) => r.data.data),
    staleTime: 60_000
  })
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['rs-filter-presets', reportId] })
  const save = useMutation({
    mutationFn: (name: string) =>
      api.post(`/report-studio/${reportId}/filter-presets`, {
        name,
        date_range: appliedRange ?? null,
        entity_filters: appliedFilters
      }),
    onSuccess: () => {
      toast.success('Preset saved')
      invalidate()
    }
  })
  const remove = useMutation({
    mutationFn: (pid: number) => api.delete(`/report-studio/${reportId}/filter-presets/${pid}`),
    onSuccess: invalidate
  })
  const ai = useMutation({
    mutationFn: (q: string) =>
      api.post<{
        data: { date_range?: GlobalFilters['date_range']; entity_filters?: EntityFilter[] }
      }>(`/report-studio/${reportId}/ai-filters`, {
        prompt: q,
        fields: filterBar.map((f) => ({ field: f.field, label: f.label }))
      }),
    onSuccess: (r) => {
      onApply(r.data.data)
      setPrompt('')
      toast.success('Filters applied')
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Could not parse that')
  })

  return (
    <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
      {presets.map((pr) => (
        <span
          key={pr.id}
          className='group/preset inline-flex h-6 items-center gap-1 rounded-full border border-slate-200 pl-2 pr-1 text-[11px] text-slate-500 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:hover:text-nvr-cyan'
        >
          <button
            type='button'
            onClick={() =>
              onApply({ date_range: pr.date_range ?? null, entity_filters: pr.entity_filters })
            }
          >
            {pr.name}
          </button>
          <button
            type='button'
            title='Delete preset'
            className='rounded-full p-0.5 text-slate-300 opacity-0 hover:text-red-500 group-hover/preset:opacity-100'
            onClick={() => remove.mutate(pr.id)}
          >
            <X className='h-2.5 w-2.5' />
          </button>
        </span>
      ))}
      {savingPreset ? (
        <input
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          placeholder='Preset name'
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && presetName.trim()) {
              save.mutate(presetName.trim())
              setPresetName('')
              setSavingPreset(false)
            }
            if (e.key === 'Escape') setSavingPreset(false)
          }}
          className='h-6 w-[130px] rounded-md border border-slate-200 bg-white px-2 text-[11px] dark:border-border dark:bg-card'
        />
      ) : (
        <button
          type='button'
          className='inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 text-[11px] text-slate-400 hover:border-nvr-cyan hover:text-slate-600 dark:border-border'
          onClick={() => setSavingPreset(true)}
        >
          <Plus className='h-2.5 w-2.5' /> Save preset
        </button>
      )}

      <form
        className='ml-auto flex items-center gap-1'
        onSubmit={(e) => {
          e.preventDefault()
          if (prompt.trim()) ai.mutate(prompt.trim())
        }}
      >
        <Sparkles className='h-3 w-3 text-nvr-cyan' />
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder='Ask AI to set filters… e.g. "Zone 1 this year"'
          className='h-7 w-64 rounded-md border border-slate-200 bg-white px-2 text-[11.5px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-card'
        />
        {ai.isPending && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
      </form>
    </div>
  )
})

// Alertable metric fields per widget — mirrors the server's deriveAlertMetric
// syntax: value | row_count | <col> (sum) | avg:/max:/min:<col> | tile:<label>.
function alertFieldOptionsFor(widget: Widget | undefined): Array<{ value: string; label: string }> {
  const base = [
    { value: 'value', label: 'value (widget metric)' },
    { value: 'row_count', label: 'row count' }
  ]
  if (!widget) return base
  const qc = widget.config?.query
  if (widget.type === 'query' && qc) {
    const cols =
      qc.columns && qc.columns.length > 0
        ? qc.columns.map((c) => ({ value: c.field, label: c.label ?? c.field }))
        : (qc.series ?? []).map((sd) => ({ value: sd.field, label: sd.label ?? sd.field }))
    return [
      ...base,
      ...cols.flatMap((c) => [
        { value: c.value, label: `sum ${c.label}` },
        { value: `avg:${c.value}`, label: `avg ${c.label}` },
        { value: `max:${c.value}`, label: `max ${c.label}` },
        { value: `min:${c.value}`, label: `min ${c.label}` }
      ])
    ]
  }
  if (widget.type === 'kpi_group') {
    return [
      ...base,
      ...(widget.config?.metrics ?? []).map((m) => ({
        value: `tile:${m.label}`,
        label: `tile ${m.label}`
      }))
    ]
  }
  if (widget.type === 'table') {
    const cols = (widget.config?.columns ?? []).map((c) =>
      typeof c === 'string' ? { field: c, label: c } : { field: c.field, label: c.label ?? c.field }
    )
    return [...base, ...cols.map((c) => ({ value: c.field, label: `sum ${c.label}` }))]
  }
  return base
}

function AlertsSheet({
  reportId,
  widgets,
  initialWidget,
  filterBar = [],
  onClose
}: {
  reportId: string
  widgets: Widget[]
  initialWidget?: string | null
  filterBar?: NonNullable<GlobalFilters['filter_bar']>
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  // Every data widget is alertable — the checker derives `value` (kpi value,
  // series total, first tile) and `row_count` (rows / buckets / tiles) per type.
  const alertable = widgets.filter((w) => w.type !== 'divider')
  const [widgetId, setWidgetId] = useState<string | null>(initialWidget ?? alertable[0]?.id ?? null)
  const [conds, setConds] = useState<Array<{ field: string; op: string; value: string }>>([
    { field: 'value', op: 'gt', value: '' }
  ])
  const [emailOn, setEmailOn] = useState(true)
  const [inappOn, setInappOn] = useState(true)
  const [scope, setScope] = useState<EntityFilter[]>([])
  const [showHistory, setShowHistory] = useState(false)

  const { data: alerts = [] } = useQuery({
    queryKey: ['rs-alerts', reportId],
    queryFn: () =>
      api
        .get<{ data: ReportAlert[] }>(`/report-studio/${reportId}/alerts`)
        .then((r) => r.data.data)
  })
  const { data: log = [] } = useQuery({
    queryKey: ['rs-alert-log', reportId],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            id: number
            alert: string
            status: string
            fired_at: string
            resolved_at: string | null
            metric_snapshot?: Record<string, number> | null
          }>
        }>(`/report-studio/${reportId}/alerts-log`)
        .then((r) => r.data.data),
    enabled: showHistory
  })

  const validConds = conds.filter((c) => c.value !== '' && Number.isFinite(Number(c.value)))
  const create = useMutation({
    mutationFn: () => {
      const widget = widgets.find((w) => w.id === widgetId)
      const first = validConds[0]
      return api.post(`/report-studio/${reportId}/alerts`, {
        widget: widgetId,
        name: `${widget?.title ?? 'Widget'} ${first?.field} ${first?.op} ${first?.value}${validConds.length > 1 ? ` +${validConds.length - 1}` : ''}`,
        conditions: validConds.map((c) => ({ field: c.field, op: c.op, value: Number(c.value) })),
        delivery_email: emailOn,
        delivery_inapp: inappOn,
        filters: scope.filter((f) => f.values.length > 0)
      })
    },
    onSuccess: () => {
      toast.success('Alert created — checked hourly')
      setConds([{ field: 'value', op: 'gt', value: '' }])
      setScope([])
      queryClient.invalidateQueries({ queryKey: ['rs-alerts', reportId] })
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Could not create alert')
  })

  const patchAlert = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/report-studio/${reportId}/alerts/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rs-alerts', reportId] })
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/report-studio/${reportId}/alerts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rs-alerts', reportId] })
  })

  const widgetTitle = (id: string) => widgets.find((w) => w.id === id)?.title ?? 'deleted widget'
  const alertName = (id: string) => alerts.find((a) => a.id === id)?.name ?? id

  const condRow = (c: { field: string; op: string; value: string }, i: number) => (
    <div key={i} className='flex items-center gap-1.5'>
      <select
        value={c.field}
        onChange={(e) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
        className='h-8 max-w-[180px] rounded-md border border-slate-200 bg-white px-1.5 text-[12px] dark:border-border dark:bg-card'
      >
        {alertFieldOptionsFor(widgets.find((w) => w.id === widgetId)).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        value={c.op}
        onChange={(e) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}
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
        value={c.value}
        onChange={(e) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
        placeholder='threshold'
        className='h-8 flex-1 text-[12px]'
      />
      {conds.length > 1 && (
        <button
          type='button'
          aria-label='Remove condition'
          onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}
          className='p-1 text-slate-300 hover:text-red-500'
        >
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      )}
    </div>
  )

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='w-[420px] overflow-y-auto sm:max-w-[420px]'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-[14px]'>
            <BellRing className='h-4 w-4 text-nvr-cyan' /> Report alerts
          </SheetTitle>
        </SheetHeader>
        <p className='mt-1 text-[11.5px] text-slate-400'>
          Checked hourly. Fires once when all conditions hold, resolves when back in range.
          Charts alert on their series total; tables on row count.
        </p>

        {alertable.length === 0 ? (
          <p className='mt-6 text-[12.5px] text-slate-400'>Add a data widget first.</p>
        ) : (
          <div className='mt-4 space-y-2 rounded-lg border border-slate-200 p-3 dark:border-border'>
            <Combo
              value={widgetId}
              options={alertable.map((w) => ({ id: w.id, label: w.title }))}
              placeholder='Widget'
              onChange={(v) => setWidgetId(v)}
            />
            {conds.map(condRow)}
            <button
              type='button'
              onClick={() => setConds((cs) => [...cs, { field: 'value', op: 'gt', value: '' }])}
              className='text-[11.5px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
            >
              + AND condition
            </button>
            {filterBar.length > 0 && (
              <div className='pt-1'>
                <Label className='mb-1 block text-[10.5px] uppercase tracking-wide text-slate-400'>
                  Alert scope (optional — evaluates in this filter scope)
                </Label>
                <div className='flex flex-wrap gap-1'>
                  {filterBar.map((f) => (
                    <FilterChip
                      key={f.field}
                      reportId={reportId}
                      field={f.field}
                      label={f.label}
                      optionSource={f.options}
                      selected={scope.find((e) => e.field === f.field)?.values ?? []}
                      editable={false}
                      onChange={(values, labels) =>
                        setScope((prev) => [
                          ...prev.filter((e) => e.field !== f.field),
                          ...(values.length > 0 ? [{ field: f.field, values, labels }] : [])
                        ])
                      }
                    />
                  ))}
                </div>
              </div>
            )}
            <div className='flex items-center gap-4 pt-1'>
              <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
                <Switch checked={emailOn} onCheckedChange={setEmailOn} /> Email
              </label>
              <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
                <Switch checked={inappOn} onCheckedChange={setInappOn} /> In-app
              </label>
            </div>
            <Button
              size='sm'
              className='w-full'
              disabled={!widgetId || validConds.length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              <Bell className='mr-1.5 h-3.5 w-3.5' /> Create alert
            </Button>
          </div>
        )}

        <div className='mt-4 space-y-1.5'>
          {alerts.map((a) => (
            <div key={a.id} className='rounded-lg border border-slate-200 px-3 py-2 dark:border-border'>
              <div className='flex items-center gap-2'>
                <div className='min-w-0 flex-1'>
                  <p className='truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                    {a.name}
                    {a.firing && (
                      <Badge className='ml-1.5 h-4 bg-red-500 px-1.5 text-[9.5px] text-white'>
                        firing
                      </Badge>
                    )}
                  </p>
                  <p className='truncate text-[10.5px] text-slate-400'>
                    on “{widgetTitle(a.widget)}”
                    {a.filters && a.filters.length > 0 &&
                      ` · scoped: ${a.filters.map((f) => (f.labels ?? f.values).join('/')).join(', ')}`}
                    {' · Last fired: '}
                    {a.last_fired ? formatRelative(a.last_fired) : 'never'}
                  </p>
                </div>
                <Switch
                  checked={a.is_active}
                  onCheckedChange={() => patchAlert.mutate({ id: a.id, body: { is_active: !a.is_active } })}
                />
                <button
                  type='button'
                  className='p-1 text-slate-300 hover:text-red-500'
                  onClick={() => remove.mutate(a.id)}
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              </div>
              <div className='mt-1 flex items-center gap-3'>
                <label className='flex items-center gap-1 text-[10.5px] text-slate-400'>
                  <Switch
                    checked={(a as { delivery_email?: boolean }).delivery_email !== false}
                    onCheckedChange={(v) => patchAlert.mutate({ id: a.id, body: { delivery_email: v } })}
                  />
                  Email
                </label>
                <label className='flex items-center gap-1 text-[10.5px] text-slate-400'>
                  <Switch
                    checked={(a as { delivery_inapp?: boolean }).delivery_inapp !== false}
                    onCheckedChange={(v) => patchAlert.mutate({ id: a.id, body: { delivery_inapp: v } })}
                  />
                  In-app
                </label>
              </div>
            </div>
          ))}
          {alerts.length === 0 && (
            <p className='text-[11.5px] text-slate-400'>No alerts on this report yet.</p>
          )}
        </div>

        <button
          type='button'
          onClick={() => setShowHistory((h) => !h)}
          className='mt-4 text-[11.5px] font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400'
        >
          {showHistory ? '▾' : '▸'} Alert history
        </button>
        {showHistory && (
          <div className='mt-1.5 space-y-1'>
            {log.length === 0 && <p className='text-[11px] text-slate-400'>No firings recorded.</p>}
            {log.map((l) => (
              <div
                key={l.id}
                className='flex items-center gap-2 rounded-md border border-slate-100 px-2.5 py-1.5 text-[11px] dark:border-border'
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${l.status === 'firing' ? 'bg-red-500' : 'bg-emerald-400'}`}
                />
                <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                  {alertName(l.alert)}
                </span>
                <span className='shrink-0 text-slate-400'>
                  {new Date(l.fired_at).toLocaleString()}
                </span>
                <span className={`shrink-0 ${l.status === 'firing' ? 'text-red-500' : 'text-emerald-500'}`}>
                  {l.status}
                </span>
              </div>
            ))}
          </div>
        )}
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
        .get<{
          data: { cadence: string; delivery_email?: boolean; delivery_inapp?: boolean } | null
        }>(`/report-studio/${reportId}/subscription`)
        .then((r) => r.data.data)
  })
  const save = useMutation({
    mutationFn: (
      body: { cadence: string; delivery_email?: boolean; delivery_inapp?: boolean } | null
    ) => api.put(`/report-studio/${reportId}/subscription`, body),
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
          <>
            <div className='mt-2 flex items-center gap-4 border-t border-slate-100 pt-2 dark:border-border'>
              <label className='flex items-center gap-1.5 text-[11px] text-slate-500'>
                <Switch
                  checked={sub.delivery_email !== false}
                  onCheckedChange={(v) =>
                    save.mutate({ cadence: sub.cadence, delivery_email: v, delivery_inapp: sub.delivery_inapp !== false })
                  }
                />
                Email
              </label>
              <label className='flex items-center gap-1.5 text-[11px] text-slate-500'>
                <Switch
                  checked={sub.delivery_inapp !== false}
                  onCheckedChange={(v) =>
                    save.mutate({ cadence: sub.cadence, delivery_email: sub.delivery_email !== false, delivery_inapp: v })
                  }
                />
                In-app
              </label>
            </div>
            <Button
              size='sm'
              variant='ghost'
              className='mt-1.5 h-7 w-full text-[11.5px] text-slate-400 hover:text-red-500'
              onClick={() => save.mutate(null)}
            >
              Unsubscribe
            </Button>
          </>
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
  const goBack = useGoBack('/report-studio')
  const queryClient = useQueryClient()
  const [editMode, setEditMode] = useState(false)
  const [widgets, setWidgets] = useState<Widget[]>([])
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [alertsFor, setAlertsFor] = useState<string | null | false>(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [entityFilters, setEntityFilters] = useState<EntityFilter[]>([])
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

  // User Scopes: the viewer's DEFAULTS pre-select the preview filter chips
  // (view state only — never written into the saved report config). Widget
  // previews render behind the gate so their first fetch is already filtered.
  const { data: myScopes, isFetched: scopesReady } = useQuery({
    queryKey: ['my-scopes'],
    queryFn: () =>
      api
        .get<{
          data: {
            dimensions: Array<{ name: string; target_collection: string }>
            defaults: Record<string, Array<string | number>>
            restricted: Record<string, Array<string | number>>
          }
        }>('/users/me/scopes')
        .then((r) => r.data.data),
    staleTime: 5 * 60_000,
    retry: false
  })
  const [scopeGateOpen, setScopeGateOpen] = useState(false)
  const [scopeAllowed, setScopeAllowed] = useState<Record<string, Array<string | number>>>({})
  useEffect(() => {
    if (scopeGateOpen) return
    if (!report || !scopesReady) return
    const scopes = myScopes
    const hasMaterial =
      Object.values(scopes?.defaults ?? {}).some((v) => v.length > 0) ||
      Object.values(scopes?.restricted ?? {}).some((v) => v.length > 0)
    if (!scopes || filterBar.length === 0 || !hasMaterial) {
      setScopeGateOpen(true)
      return
    }
    void (async () => {
      const seeds: EntityFilter[] = []
      const allowed: Record<string, Array<string | number>> = {}
      const translate = async (
        target: string,
        ids: Array<string | number>,
        vf: string
      ): Promise<Array<string | number>> => {
        if (vf === 'id' || ids.length === 0) return ids
        return api
          .get<{ data: Array<Record<string, unknown>> }>(`/items/${target}`, {
            params: { fields: `id,${vf}`, limit: 1000 }
          })
          .then((r) => {
            const map = new Map((r.data.data ?? []).map((row) => [String(row.id), row[vf]]))
            return ids
              .map((v) => map.get(String(v)))
              .filter((v): v is string | number => v != null)
          })
          .catch(() => [])
      }
      for (const f of filterBar) {
        const dim =
          scopes.dimensions.find((d) => d.name === f.field) ??
          scopes.dimensions.find((d) => f.options && d.target_collection === f.options.collection)
        if (!dim) continue
        const vf = f.options ? (f.options.value_field ?? 'id') : 'id'
        const restrictedIds = scopes.restricted[dim.name] ?? []
        if (restrictedIds.length > 0) {
          const vals = await translate(dim.target_collection, restrictedIds, vf)
          if (vals.length > 0) allowed[f.field] = vals
        }
        // seed = defaults ∩ restricted; falls back to ALL restricted values
        const defaults = scopes.defaults[dim.name] ?? []
        let ids = defaults
        if (restrictedIds.length > 0) {
          const set = new Set(restrictedIds.map(String))
          const kept = defaults.filter((v) => set.has(String(v)))
          ids = kept.length > 0 ? kept : restrictedIds
        }
        if (ids.length === 0) continue
        const vals = await translate(dim.target_collection, ids, vf)
        if (vals.length > 0) seeds.push({ field: f.field, values: vals, labels: vals.map(String) })
      }
      if (Object.keys(allowed).length > 0) setScopeAllowed(allowed)
      if (seeds.length > 0) {
        setEntityFilters((prev) => {
          const next = [...prev]
          for (const sd of seeds) if (!next.some((e) => e.field === sd.field)) next.push(sd)
          return next
        })
      }
      setScopeGateOpen(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeGateOpen, scopesReady, myScopes, report, filterBar])

  const applyFilterState = useCallback(
    (d: { date_range?: GlobalFilters['date_range']; entity_filters?: EntityFilter[] }) => {
      if (d.entity_filters) setEntityFilters(d.entity_filters.filter((f) => f.values?.length))
      if (d.date_range !== undefined) {
        patchReport.mutate({
          global_filters: { ...(report?.global_filters ?? {}), date_range: d.date_range }
        })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report?.global_filters]
  )

  // ── Hand-rolled drag / resize over the 12-col × 72px grid ──────────────────
  // react-grid-layout v2's dist ships NO interaction code (pure layout
  // renderer) — its isDraggable/isResizable props are inert, so the canvas
  // implements pointer-based drag + resize itself and RGL is gone entirely.
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const canvasRO = useRef<ResizeObserver | null>(null)
  const [canvasW, setCanvasW] = useState(0)
  // Ref callback, NOT a mount effect — the canvas div only exists once the
  // report has loaded, long after mount.
  const setCanvasEl = useCallback((el: HTMLDivElement | null) => {
    canvasRO.current?.disconnect()
    canvasRO.current = null
    canvasRef.current = el
    if (el) {
      setCanvasW(el.clientWidth)
      const ro = new ResizeObserver(() => setCanvasW(el.clientWidth))
      ro.observe(el)
      canvasRO.current = ro
    }
  }, [])
  const GAP = 12
  const ROW = 72
  const colUnit = canvasW > 0 ? (canvasW - GAP * 11) / 12 : 0
  const cellW = colUnit + GAP
  const cellH = ROW + GAP

  // Interactions are DOM-driven: pointermove never touches React state (a
  // state update would re-render every chart per frame). Positions preview via
  // direct style writes; React commits once on pointerup.
  const ghostElRef = useRef<HTMLDivElement | null>(null)
  const interactRef = useRef<{
    mode: 'drag' | 'resize'
    id: string
    startX: number
    startY: number
    orig: { x: number; y: number; w: number; h: number }
    snapshot: Widget[]
    lastKey: string
    preview: Widget[] | null
    raf: number
  } | null>(null)

  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number }
  ) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

  // RGL-style: pin the active item at its target cell, push colliding items
  // down, compact everything else up.
  const layoutWithPinned = useCallback(
    (list: Widget[], id: string, target: { x: number; y: number; w: number; h: number }): Widget[] => {
      const pinned = { ...(list.find((w) => w.id === id) as Widget), ...target }
      const others = list.filter((w) => w.id !== id).sort((a, b) => a.y - b.y || a.x - b.x)
      const placed: Array<{ x: number; y: number; w: number; h: number }> = [
        { x: pinned.x, y: pinned.y, w: pinned.w, h: pinned.h }
      ]
      const out: Widget[] = [pinned]
      for (const w of others) {
        let y = Math.max(0, w.y)
        while (y > 0 && !placed.some((pl) => overlaps({ x: w.x, y: y - 1, w: w.w, h: w.h }, pl))) y--
        while (placed.some((pl) => overlaps({ x: w.x, y, w: w.w, h: w.h }, pl))) y++
        placed.push({ x: w.x, y, w: w.w, h: w.h })
        out.push({ ...w, y })
      }
      return list.map((w) => out.find((o) => o.id === w.id) ?? w)
    },
    []
  )

  const compactUp = useCallback((list: Widget[]): Widget[] => {
    const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x)
    const placed: Array<{ x: number; y: number; w: number; h: number }> = []
    const out: Widget[] = []
    for (const w of sorted) {
      let y = Math.max(0, w.y)
      while (y > 0 && !placed.some((pl) => overlaps({ x: w.x, y: y - 1, w: w.w, h: w.h }, pl))) y--
      while (placed.some((pl) => overlaps({ x: w.x, y, w: w.w, h: w.h }, pl))) y++
      placed.push({ x: w.x, y, w: w.w, h: w.h })
      out.push({ ...w, y })
    }
    return list.map((w) => out.find((o) => o.id === w.id) ?? w)
  }, [])

  const px = useCallback(
    (g: { x: number; y: number; w: number; h: number }) => ({
      left: g.x * cellW,
      top: g.y * cellH,
      width: g.w * colUnit + (g.w - 1) * GAP,
      height: g.h * ROW + (g.h - 1) * GAP
    }),
    [cellW, cellH, colUnit]
  )

  const applyPreviewStyles = useCallback(
    (preview: Widget[], activeId: string) => {
      const canvas = canvasRef.current
      if (!canvas) return
      for (const w of preview) {
        if (w.id === activeId) continue
        const el = canvas.querySelector<HTMLElement>(`[data-wid="${w.id}"]`)
        if (!el) continue
        const r = px(w)
        el.style.transition = 'left 120ms ease, top 120ms ease'
        el.style.left = `${r.left}px`
        el.style.top = `${r.top}px`
      }
    },
    [px]
  )

  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!editMode || e.button !== 0) return
      const target = e.target as HTMLElement
      const card = target.closest<HTMLElement>('[data-wid]')
      if (!card) return
      const mode = target.closest('.rs-resize') ? 'resize' : target.closest('.rs-drag') ? 'drag' : null
      if (!mode) return
      if (colUnit <= 0) return
      const id = card.dataset.wid as string
      const w = widgets.find((x) => x.id === id)
      if (!w) return
      e.preventDefault()
      const it = {
        mode: mode as 'drag' | 'resize',
        id,
        startX: e.clientX,
        startY: e.clientY,
        orig: { x: w.x, y: w.y, w: w.w, h: w.h },
        snapshot: widgets,
        lastKey: '',
        preview: null as Widget[] | null,
        raf: 0
      }
      interactRef.current = it
      card.style.transition = 'none'
      card.style.zIndex = '20'
      card.style.opacity = '0.92'
      card.style.boxShadow = '0 8px 24px -8px rgba(0,206,255,0.45)'
      const ghostEl = ghostElRef.current
      const showGhost = (g: { x: number; y: number; w: number; h: number }) => {
        if (!ghostEl) return
        const r = px(g)
        ghostEl.style.display = 'block'
        ghostEl.style.left = `${r.left}px`
        ghostEl.style.top = `${r.top}px`
        ghostEl.style.width = `${r.width}px`
        ghostEl.style.height = `${r.height}px`
      }
      showGhost(it.orig)

      const step = (ev: PointerEvent) => {
        const dxPx = ev.clientX - it.startX
        const dyPx = ev.clientY - it.startY
        // active card follows the pointer raw (drag) / stretches raw (resize)
        if (it.mode === 'drag') {
          const o = px(it.orig)
          card.style.left = `${o.left + dxPx}px`
          card.style.top = `${Math.max(0, o.top + dyPx)}px`
        } else {
          const o = px(it.orig)
          card.style.width = `${Math.max(colUnit, o.width + dxPx)}px`
          card.style.height = `${Math.max(ROW, o.height + dyPx)}px`
        }
        // snapped target cell
        const dx = Math.round(dxPx / cellW)
        const dy = Math.round(dyPx / cellH)
        const g =
          it.mode === 'drag'
            ? {
                x: Math.max(0, Math.min(12 - it.orig.w, it.orig.x + dx)),
                y: Math.max(0, it.orig.y + dy),
                w: it.orig.w,
                h: it.orig.h
              }
            : {
                x: it.orig.x,
                y: it.orig.y,
                w: Math.max(2, Math.min(12 - it.orig.x, it.orig.w + dx)),
                h: Math.max(1, it.orig.h + dy)
              }
        const key = `${g.x}:${g.y}:${g.w}:${g.h}`
        if (key !== it.lastKey) {
          it.lastKey = key
          it.preview = layoutWithPinned(it.snapshot, it.id, g)
          showGhost(g)
          applyPreviewStyles(it.preview, it.id)
        }
      }
      // Synchronous — the work per move is a handful of style writes plus a
      // cell-key-guarded relayout; rAF indirection only added dropped frames.
      const onMove = (ev: PointerEvent) => step(ev)
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        interactRef.current = null
        if (ghostEl) ghostEl.style.display = 'none'
        card.style.zIndex = ''
        card.style.opacity = ''
        card.style.boxShadow = ''
        card.style.transition = ''
        const finalLayout = it.preview ? compactUp(it.preview) : null
        if (finalLayout) {
          setWidgets(finalLayout)
          // let React own the styles again (values match the committed layout)
          requestAnimationFrame(() => {
            const canvas = canvasRef.current
            if (!canvas) return
            for (const w of finalLayout) {
              const el = canvas.querySelector<HTMLElement>(`[data-wid="${w.id}"]`)
              if (el) {
                el.style.transition = ''
                const r = px(w)
                el.style.left = `${r.left}px`
                el.style.top = `${r.top}px`
                el.style.width = `${r.width}px`
                el.style.height = `${r.height}px`
              }
            }
          })
        } else {
          const r = px(it.orig)
          card.style.left = `${r.left}px`
          card.style.top = `${r.top}px`
          card.style.width = `${r.width}px`
          card.style.height = `${r.height}px`
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [editMode, widgets, cellW, cellH, colUnit, px, layoutWithPinned, compactUp, applyPreviewStyles]
  )

  const cardStyle = (w: Widget): React.CSSProperties => ({
    position: 'absolute',
    left: w.x * cellW,
    top: w.y * cellH,
    width: w.w * colUnit + (w.w - 1) * GAP,
    height: w.h * ROW + (w.h - 1) * GAP
  })
  const canvasH = (Math.max(0, ...widgets.map((w) => w.y + w.h)) + 2) * cellH

  const [catalogOpen, setCatalogOpen] = useState(false)

  function addPresetWidget(p: WidgetPreset) {
    const maxY = Math.max(0, ...widgets.map((w) => w.y + w.h))
    setWidgets((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        type: p.widget_type,
        title: p.name,
        collection: null,
        config: (p.config ?? (p.widget_type === 'query' ? { query: { slug: '', display: 'table' } } : {})) as Widget['config'],
        x: 0,
        y: maxY,
        w: Math.min(12, Math.max(2, p.w)),
        h: Math.max(1, p.h)
      }
    ])
    setEditMode(true)
  }

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
        config:
          type === 'kpi_group'
            ? { metrics: [] }
            : type === 'query'
              ? { query: { slug: '', display: 'table' } }
              : { metric: { aggregate: 'count' } },
        x: 0,
        y: maxY,
        w: type === 'kpi' ? 3 : type === 'divider' || type === 'kpi_group' ? 12 : 6,
        h: type === 'kpi' ? 2 : type === 'divider' ? 1 : type === 'kpi_group' ? 2 : type === 'query' ? 4 : 3
      }
    ])
    setEditMode(true)
  }

  const resetCache = useMutation({
    mutationFn: () => api.post(`/report-studio/${id}/reset-cache`),
    onSuccess: (r: { data: { data: { queries: number; cleared: number } } }) => {
      // drop every client-side widget result too — fresh fetches repopulate
      queryClient.invalidateQueries({ queryKey: ['rs-widget'] })
      queryClient.invalidateQueries({ queryKey: ['nivaro-report-query'] })
      toast.success(`Cache cleared — ${r.data.data.queries} queries reset`)
    }
  })

  function exportJson() {
    const payload = {
      version: 2,
      name: report?.name,
      description: report?.description ?? null,
      global_filters: gf,
      widgets
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
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
        const parsed = JSON.parse(String(reader.result)) as {
          version?: number
          widgets?: Widget[]
          global_filters?: GlobalFilters
          description?: string | null
        }
        if (!parsed.version || !Array.isArray(parsed.widgets)) throw new Error('bad format')
        setWidgets(parsed.widgets.map((w) => ({ ...w, id: crypto.randomUUID() })))
        if (parsed.global_filters || parsed.description !== undefined) {
          patchReport.mutate({
            ...(parsed.global_filters ? { global_filters: parsed.global_filters } : {}),
            ...(parsed.description !== undefined ? { description: parsed.description } : {})
          })
        }
        setEditMode(true)
        toast.success(
          `Imported ${parsed.widgets.length} widgets${parsed.global_filters ? ' + filters' : ''}`
        )
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

  if (!report || !scopeGateOpen) {
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
            onClick={goBack}
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
                <Button
                  size='sm'
                  variant='outline'
                  className='h-8 gap-1.5 text-[12px]'
                  disabled={resetCache.isPending}
                  onClick={() => resetCache.mutate()}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', resetCache.isPending && 'animate-spin')} /> Reset cache
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
                <Button
                  size='sm'
                  variant='outline'
                  className='gap-1.5 text-slate-400 hover:border-red-200 hover:text-red-500'
                  onClick={() => {
                    if (window.confirm(`Delete report “${report.name}”? Widgets, subscriptions and alerts go with it.`)) {
                      void api.delete(`/report-studio/${report.id}`).then(() => {
                        toast.success('Report deleted')
                        navigate('/report-studio')
                      })
                    }
                  }}
                >
                  <Trash2 className='h-3.5 w-3.5' /> Delete
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
                  date_range: e.target.value
                    ? e.target.value === 'custom'
                      ? { preset: 'custom', start: gf.date_range?.start, end: gf.date_range?.end }
                      : { preset: e.target.value }
                    : null
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

          {gf.date_range?.preset === 'custom' && (
            <span className='flex items-center gap-1'>
              <input
                type='date'
                value={gf.date_range?.start?.slice(0, 10) ?? ''}
                onChange={(e) =>
                  patchReport.mutate({
                    global_filters: {
                      ...gf,
                      date_range: { preset: 'custom', start: e.target.value, end: gf.date_range?.end }
                    }
                  })
                }
                className='h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[11.5px] dark:border-border dark:bg-card'
              />
              <span className='text-[10px] text-slate-400'>–</span>
              <input
                type='date'
                value={gf.date_range?.end?.slice(0, 10) ?? ''}
                onChange={(e) =>
                  patchReport.mutate({
                    global_filters: {
                      ...gf,
                      date_range: { preset: 'custom', start: gf.date_range?.start, end: e.target.value }
                    }
                  })
                }
                className='h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[11.5px] dark:border-border dark:bg-card'
              />
            </span>
          )}

          {filterBar.map((f) => (
            <FilterChip
              key={f.field}
              reportId={report.id}
              field={f.field}
              label={f.label}
              optionSource={f.options}
              allowedValues={scopeAllowed[f.field]}
              selected={entityFilters.find((e) => e.field === f.field)?.values ?? []}
              editable={!!report.editable}
              onChange={(values, labels) =>
                setEntityFilters((prev) => [
                  ...prev.filter((e) => e.field !== f.field),
                  ...(values.length > 0 ? [{ field: f.field, values, labels }] : [])
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

        </div>

        <FilterExtrasBar
          reportId={report.id}
          filterBar={filterBar}
          appliedRange={dateRange}
          appliedFilters={entityFilters}
          onApply={applyFilterState}
        />

        {editMode && (
          <div className='mt-2 flex items-center gap-1.5'>
            <span className='text-[11px] text-slate-400'>Add widget:</span>
            <button
              type='button'
              onClick={() => setCatalogOpen(true)}
              className='rounded-full border border-nvr-cyan/50 bg-nvr-cyan/5 px-2.5 py-0.5 text-[11.5px] font-semibold text-nvr-navy hover:bg-nvr-cyan/10 dark:text-nvr-cyan'
            >
              ▦ From catalog…
            </button>
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
        <WidgetCatalogDialog
          open={catalogOpen}
          onClose={() => setCatalogOpen(false)}
          onPick={addPresetWidget}
        />
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
          <>
          <style>{`
            .rs-resize {
              position: absolute; right: 0; bottom: 0; width: 22px; height: 22px;
              cursor: nwse-resize; z-index: 3;
            }
            .rs-resize::after {
              content: '';
              position: absolute; right: 5px; bottom: 5px;
              width: 9px; height: 9px;
              border-right: 2px solid #94a3b8;
              border-bottom: 2px solid #94a3b8;
              border-bottom-right-radius: 2px;
            }
            .rs-resize:hover::after { border-color: #00ceff; }
          `}</style>
          <div
            ref={setCanvasEl}
            className='relative'
            style={{ height: canvasH || undefined }}
            onPointerDown={onCanvasPointerDown}
          >
            <div
              ref={ghostElRef}
              className='pointer-events-none absolute rounded-lg border border-dashed border-[#00ceff] bg-[#00ceff1a]'
              style={{ display: 'none' }}
            />
            {widgets.map((w) => (
              <div
                key={w.id}
                data-wid={w.id}
                style={cardStyle(w)}
                className={cn(
                  'group/widget overflow-hidden',
                  w.type === 'divider'
                    ? 'flex items-end'
                    : 'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
                )}
              >
                {w.type === 'divider' ? (
                  <div className='flex w-full items-center gap-2 border-b border-slate-200 pb-1 dark:border-border'>
                    <span
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2',
                        editMode && 'rs-drag cursor-grab active:cursor-grabbing'
                      )}
                    >
                      {editMode && <GripVertical className='h-3.5 w-3.5 text-slate-300' />}
                      <h3 className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
                        {w.title}
                      </h3>
                    </span>
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
                      <span
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-1.5',
                          editMode && 'rs-drag cursor-grab active:cursor-grabbing'
                        )}
                      >
                        {editMode && (
                          <GripVertical className='h-3.5 w-3.5 shrink-0 text-slate-300' />
                        )}
                        <p className='truncate text-[11.5px] font-medium uppercase tracking-wide text-slate-400'>
                          {w.title}
                        </p>
                      </span>
                      <span className='ml-auto flex shrink-0 gap-0.5'>
                        <button
                          type='button'
                          title='Alert on this widget'
                          className='rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-amber-500 dark:text-slate-600 dark:hover:bg-muted'
                          onClick={() => setAlertsFor(w.id)}
                        >
                          <Bell className='h-3.5 w-3.5' />
                        </button>
                        <span className='flex gap-0.5 opacity-0 transition-opacity group-hover/widget:opacity-100'>
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
                              title='Duplicate widget'
                              className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                              onClick={() =>
                                setWidgets((p) => {
                                  const maxY = Math.max(0, ...p.map((x) => x.y + x.h))
                                  return [
                                    ...p,
                                    {
                                      ...w,
                                      id: crypto.randomUUID(),
                                      title: `${w.title} (copy)`,
                                      y: maxY,
                                      sort: p.length
                                    }
                                  ]
                                })
                              }
                            >
                              <Copy className='h-3.5 w-3.5' />
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
                      </span>
                    </div>
                    <div className='min-h-0 flex-1'>
                      <WidgetBody widget={w} dateRange={dateRange} entityFilters={entityFilters} />
                    </div>
                  </div>
                )}
                {editMode && w.type !== 'divider' && <span className='rs-resize' />}
              </div>
            ))}
          </div>
          </>
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
          filterBar={filterBar}
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
