import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider, QueryWidgetBody } from '@nivaro/shared'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  BarChart2,
  Filter,
  LineChart,
  Loader2,
  Plus,
  Trash2,
  TrendingUp,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { toast } from 'sonner'
import { DashboardLinkPopover } from '@/components/dashboard-link-popover'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Collection, type Dashboard, type DashboardWidget } from '@/lib/api'
import { useGoBack } from '@/lib/nav'
import { adminRealtime } from '@/lib/socket'
import { cn, formatNumber } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type WidgetType = DashboardWidget['type'] | 'report_preset'

interface WidgetData {
  value?: number | null
  rows?: Array<Record<string, unknown>>
}

// Dashboard-level global filter (#635) — session state only; persistence on
// the dashboard row awaits a global_filters column (see migration note).
interface GlobalFilter {
  field: string
  op: 'eq' | 'contains'
  value: string
}

interface DrillSegment {
  field: string
  value: string
}

interface DrillTarget {
  widgetId: string
  title: string
  segment: DrillSegment | null
}

interface DrillRecord {
  id: string
  label: string
}

interface DrillData {
  collection: string
  total: number
  capped: boolean
  records: DrillRecord[]
}

interface AddWidgetForm {
  title: string
  type: WidgetType
  collection: string
  field: string
  col: number
  row: number
  width: number
  height: number
}

// ─── Widget type config ───────────────────────────────────────────────────────

const TYPE_CONFIG: Record<WidgetType, { label: string; color: string }> = {
  count: { label: 'Count', color: 'bg-nvr-cyan/10 text-nvr-cyan border-nvr-cyan/20' },
  sum: { label: 'Sum', color: 'bg-violet-50 text-violet-700 border-violet-200' },
  avg: { label: 'Average', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  latest: { label: 'Latest', color: 'bg-orange-50 text-orange-700 border-orange-200' },
  bar_chart: { label: 'Bar Chart', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  line_chart: { label: 'Line Chart', color: 'bg-pink-50 text-pink-700 border-pink-200' },
  report_preset: { label: 'Prebuilt', color: 'bg-amber-50 text-amber-700 border-amber-200' }
}

// ─── Widget card ──────────────────────────────────────────────────────────────

function WidgetCard({
  widget,
  globalFilters,
  onDelete,
  onDrill
}: {
  widget: DashboardWidget
  globalFilters: GlobalFilter[]
  onDelete: () => void
  onDrill: (segment: DrillSegment | null) => void
}) {
  const qc = useQueryClient()
  const filtersKey = JSON.stringify(globalFilters)
  const { data, isLoading } = useQuery({
    queryKey: ['widget-data', widget.id, filtersKey],
    queryFn: () =>
      api
        .get<{ data: WidgetData | null }>(`/dashboards/widgets/${widget.id}/data`, {
          params: globalFilters.length ? { extra_filters: filtersKey } : {}
        })
        .then((r) => r.data.data),
    refetchInterval: 60_000
  })

  // Live dashboards (#264): a write to this widget's source collection
  // refreshes its number within ~2s instead of the 60s poll. Debounced so
  // bulk writes coalesce into one refetch.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!widget.collection) return
    const unsub = adminRealtime.subscribeCollections([widget.collection], () => {
      if (debounceRef.current) return
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void qc.invalidateQueries({ queryKey: ['widget-data', widget.id] })
      }, 2000)
    })
    return () => {
      unsub()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [widget.collection, widget.id, qc])

  const cfg = TYPE_CONFIG[widget.type]

  return (
    <div
      className='flex flex-col rounded-xl border border-slate-200 dark:border-white/[0.07] bg-white dark:bg-[#161b22] p-4 shadow-sm'
      style={{
        gridColumn: `span ${widget.width}`,
        gridRow: `span ${widget.height}`
      }}
    >
      {/* Header */}
      <div className='mb-3 flex items-start justify-between gap-2'>
        <div className='min-w-0'>
          <p className='truncate text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
            {widget.title}
          </p>
          {widget.collection && (
            <p className='text-[11px] text-slate-400 dark:text-slate-500'>{widget.collection}</p>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-1.5'>
          <Badge variant='outline' className={cn('h-5 px-1.5 text-[10px]', cfg.color)}>
            {cfg.label}
          </Badge>
          <button
            type='button'
            onClick={onDelete}
            className='rounded p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10'
            aria-label='Delete widget'
          >
            <Trash2 className='h-3.5 w-3.5' />
          </button>
        </div>
      </div>

      {/* Body */}
      {widget.type === 'report_preset' ? (
        <div className='min-h-0 flex-1'>
          <PresetWidgetBody presetId={widget.field} />
        </div>
      ) : (
        <div className='flex flex-1 items-center justify-center'>
          {isLoading ? (
            <Loader2 className='h-5 w-5 animate-spin text-slate-300' />
          ) : !data ? (
            <p className='text-[12px] text-slate-400'>No data</p>
          ) : widget.type === 'count' || widget.type === 'sum' || widget.type === 'avg' ? (
            <button
              type='button'
              onClick={() => onDrill(null)}
              className='rounded-lg px-3 py-1 text-center transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.05]'
              title='View matching records'
            >
              <p className='text-4xl font-bold tabular-nums text-slate-800 dark:text-slate-100'>
                {data.value !== null && data.value !== undefined ? formatNumber(data.value) : '—'}
              </p>
            </button>
          ) : widget.type === 'latest' ? (
            <button
              type='button'
              onClick={() => onDrill(null)}
              className='w-full cursor-pointer text-left'
              title='View matching records'
            >
              <LatestTable rows={(data.rows ?? []).slice(0, 5)} />
            </button>
          ) : widget.type === 'bar_chart' ? (
            <ChartWrapper
              data={data.rows ?? []}
              type='bar'
              onPointClick={(date) => onDrill({ field: 'date', value: date })}
            />
          ) : widget.type === 'line_chart' ? (
            <ChartWrapper
              data={data.rows ?? []}
              type='line'
              onPointClick={(date) => onDrill({ field: 'date', value: date })}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

// ─── Latest table ─────────────────────────────────────────────────────────────

function LatestTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) {
    return <p className='text-[12px] text-slate-400'>No records</p>
  }

  const keys = Object.keys(rows[0]).slice(0, 4)

  return (
    <div className='w-full overflow-x-auto'>
      <table className='w-full text-left text-[11px]'>
        <thead>
          <tr className='border-b border-slate-100 dark:border-white/[0.06]'>
            {keys.map((k) => (
              <th
                key={k}
                className='pb-1 pr-3 font-medium text-slate-500 dark:text-slate-400 capitalize'
              >
                {k.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-50 dark:divide-white/[0.04]'>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton list
            <tr key={i}>
              {keys.map((k) => (
                <td
                  key={k}
                  className='py-1 pr-3 text-slate-600 dark:text-slate-300 truncate max-w-[120px]'
                >
                  {String(row[k] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Chart wrapper ────────────────────────────────────────────────────────────

interface ChartPoint {
  date: string
  count: number
}

function ChartWrapper({
  data,
  type,
  onPointClick
}: {
  data: Array<Record<string, unknown>>
  type: 'bar' | 'line'
  onPointClick?: (date: string) => void
}) {
  const points = data as unknown as ChartPoint[]
  // Recharts chart-level onClick passes activeLabel = the hovered X value.
  const handleChartClick = (state: unknown) => {
    const label = (state as { activeLabel?: string | number } | null)?.activeLabel
    if (label !== undefined && label !== null && onPointClick) onPointClick(String(label))
  }

  if (points.length === 0) {
    return (
      <div className='flex flex-col items-center gap-1 text-slate-400'>
        {type === 'bar' ? (
          <BarChart2 className='h-8 w-8 opacity-30' />
        ) : (
          <LineChart className='h-8 w-8 opacity-30' />
        )}
        <p className='text-[12px]'>No data for last 30 days</p>
      </div>
    )
  }

  if (type === 'bar') {
    return (
      <ResponsiveContainer width='100%' height={160}>
        <BarChart
          data={points}
          margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
          onClick={handleChartClick}
          className={onPointClick ? 'cursor-pointer' : undefined}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='rgba(0,0,0,0.06)' />
          <XAxis dataKey='date' tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              fontSize: 12,
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 8,
              color: '#f1f5f9'
            }}
            labelStyle={{ color: '#f1f5f9' }}
            itemStyle={{ color: '#e2e8f0' }}
            formatter={(v) => [formatNumber(Number(v ?? 0)), 'Count']}
          />
          <Bar dataKey='count' fill='#00ceff' radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width='100%' height={160}>
      <RechartsLineChart
        data={points}
        margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
        onClick={handleChartClick}
        className={onPointClick ? 'cursor-pointer' : undefined}
      >
        <CartesianGrid strokeDasharray='3 3' stroke='rgba(0,0,0,0.06)' />
        <XAxis dataKey='date' tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 8,
            color: '#f1f5f9'
          }}
          labelStyle={{ color: '#f1f5f9' }}
          itemStyle={{ color: '#e2e8f0' }}
          formatter={(v) => [formatNumber(Number(v ?? 0)), 'Count']}
        />
        <Line type='monotone' dataKey='count' stroke='#00ceff' strokeWidth={2} dot={false} />
      </RechartsLineChart>
    </ResponsiveContainer>
  )
}

// ─── Prebuilt widget renderer (#227): catalog presets on dashboards ─────────

const presetClient = createNivaro(window.location.origin)

function PresetWidgetBody({ presetId }: { presetId: string | null }) {
  const { data: presets = [] } = useQuery({
    queryKey: ['report-widget-presets'],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            id: number
            name: string
            widget_type: string
            config: Record<string, unknown> | null
          }>
        }>('/report-studio/widget-presets')
        .then((r) => r.data.data)
  })
  const preset = presets.find((p) => String(p.id) === String(presetId))
  if (!preset) return <p className='text-[12px] text-slate-400'>Preset not found.</p>
  if (preset.widget_type !== 'query' || !preset.config?.query) {
    return (
      <p className='text-[12px] text-slate-400'>
        "{preset.name}" is a {preset.widget_type} widget — open it in Report Studio.
      </p>
    )
  }
  return (
    <NivaroProvider client={presetClient}>
      <QueryWidgetBody
        cfg={preset.config.query as Parameters<typeof QueryWidgetBody>[0]['cfg']}
        dateRange={null}
        entityFilters={[]}
      />
    </NivaroProvider>
  )
}

// ─── Prebuilt catalog picker (#227) ──────────────────────────────────────────

function PresetPicker({
  value,
  onPick
}: {
  value: string
  onPick: (id: string, name: string) => void
}) {
  const [q, setQ] = useState('')
  const { data: presets = [] } = useQuery({
    queryKey: ['report-widget-presets'],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: number; name: string; category: string; description?: string }> }>(
          '/report-studio/widget-presets'
        )
        .then((r) => r.data.data)
  })
  const needle = q.trim().toLowerCase()
  const hits = needle
    ? presets.filter(
        (p) => p.name.toLowerCase().includes(needle) || p.category.toLowerCase().includes(needle)
      )
    : presets
  return (
    <div className='space-y-1.5'>
      <Label>Catalog widget</Label>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search the catalog…' />
      <div className='max-h-52 overflow-y-auto rounded-md border border-slate-200'>
        {hits.length === 0 ? (
          <p className='p-2 text-[12px] text-slate-400'>No presets match.</p>
        ) : (
          hits.map((p) => (
            <button
              key={p.id}
              type='button'
              onClick={() => onPick(String(p.id), p.name)}
              className={`block w-full px-2.5 py-1.5 text-left text-[12.5px] hover:bg-slate-50 ${
                value === String(p.id) ? 'bg-nvr-cyan/10 font-medium' : ''
              }`}
            >
              {p.name}
              <span className='ml-1.5 text-[10.5px] text-slate-400'>{p.category}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Add widget sheet ─────────────────────────────────────────────────────────

function AddWidgetSheet({
  dashboardId,
  open,
  onOpenChange
}: {
  dashboardId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<AddWidgetForm>({
    title: '',
    type: 'count',
    collection: '',
    field: '',
    col: 0,
    row: 0,
    width: 1,
    height: 1
  })

  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.get<{ data: Collection[] }>('/collections').then((r) => r.data.data)
  })
  const collections = collectionsData ?? []

  const needsField = form.type === 'sum' || form.type === 'avg'

  const addWidget = useMutation({
    mutationFn: (body: AddWidgetForm) =>
      api
        .post(`/dashboards/${dashboardId}/widgets`, {
          ...body,
          collection: body.collection || null,
          field: body.field || null
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard', dashboardId] })
      onOpenChange(false)
      setForm({
        title: '',
        type: 'count',
        collection: '',
        field: '',
        col: 0,
        row: 0,
        width: 1,
        height: 1
      })
      toast.success('Widget added')
    },
    onError: () => toast.error('Failed to add widget')
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    addWidget.mutate(form)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='w-[400px]'>
        <SheetHeader>
          <SheetTitle>Add Widget</SheetTitle>
        </SheetHeader>
        <form onSubmit={handleSubmit} className='flex flex-col gap-4 px-6 py-4'>
          {/* Title */}
          <div className='space-y-1.5'>
            <Label htmlFor='w-title'>
              Title <span className='text-red-500'>*</span>
            </Label>
            <Input
              id='w-title'
              value={form.title}
              onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
              placeholder='e.g. Total Projects'
              required
              autoFocus
            />
          </div>

          {/* Type */}
          <div className='space-y-1.5'>
            <Label htmlFor='w-type'>Widget Type</Label>
            <Select
              value={form.type}
              onValueChange={(v) => setForm((p) => ({ ...p, type: v as WidgetType }))}
            >
              <SelectTrigger id='w-type'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='count'>Count — total records</SelectItem>
                <SelectItem value='sum'>Sum — sum of a field</SelectItem>
                <SelectItem value='avg'>Average — avg of a field</SelectItem>
                <SelectItem value='latest'>Latest — most recent records</SelectItem>
                <SelectItem value='bar_chart'>Bar Chart — last 30 days</SelectItem>
                <SelectItem value='line_chart'>Line Chart — last 30 days</SelectItem>
                <SelectItem value='report_preset'>Prebuilt — widget catalog</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Prebuilt catalog picker (#227): field carries the preset id */}
          {form.type === 'report_preset' && (
            <PresetPicker
              value={form.field}
              onPick={(id, name) =>
                setForm((p) => ({ ...p, field: id, title: p.title || name, width: 2, height: 2 }))
              }
            />
          )}

          {/* Collection */}
          <div className='space-y-1.5'>
            <Label htmlFor='w-collection'>Collection</Label>
            <Select
              value={form.collection || '__none__'}
              onValueChange={(v) =>
                setForm((p) => ({ ...p, collection: v === '__none__' ? '' : v }))
              }
            >
              <SelectTrigger id='w-collection'>
                <SelectValue placeholder='Select a collection…' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__none__'>— None —</SelectItem>
                {collections.map((c) => (
                  <SelectItem key={c.collection} value={c.collection}>
                    {c.display_name ?? c.collection}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Field (sum / avg) */}
          {needsField && (
            <div className='space-y-1.5'>
              <Label htmlFor='w-field'>
                Field <span className='text-red-500'>*</span>
              </Label>
              <Input
                id='w-field'
                value={form.field}
                onChange={(e) => setForm((p) => ({ ...p, field: e.target.value }))}
                placeholder='e.g. amount'
                required={needsField}
              />
            </div>
          )}

          {/* Grid placement */}
          <div className='grid grid-cols-2 gap-3'>
            <div className='space-y-1.5'>
              <Label htmlFor='w-col'>Column</Label>
              <Input
                id='w-col'
                type='number'
                min={0}
                max={3}
                value={form.col}
                onChange={(e) => setForm((p) => ({ ...p, col: Number(e.target.value) }))}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='w-row'>Row</Label>
              <Input
                id='w-row'
                type='number'
                min={0}
                value={form.row}
                onChange={(e) => setForm((p) => ({ ...p, row: Number(e.target.value) }))}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='w-width'>Width (cols)</Label>
              <Input
                id='w-width'
                type='number'
                min={1}
                max={4}
                value={form.width}
                onChange={(e) => setForm((p) => ({ ...p, width: Number(e.target.value) }))}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='w-height'>Height (rows)</Label>
              <Input
                id='w-height'
                type='number'
                min={1}
                max={4}
                value={form.height}
                onChange={(e) => setForm((p) => ({ ...p, height: Number(e.target.value) }))}
              />
            </div>
          </div>

          <SheetFooter className='mt-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={addWidget.isPending || !form.title.trim()}>
              {addWidget.isPending ? 'Adding…' : 'Add Widget'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

// ─── Global filter bar (#635) ────────────────────────────────────────────────
// Session-scoped: filters live in component state + sessionStorage per
// dashboard. Persisting them on the dashboard row needs a global_filters
// column (migration) — see the item report.

function GlobalFilterBar({
  widgets,
  filters,
  onChange
}: {
  widgets: DashboardWidget[]
  filters: GlobalFilter[]
  onChange: (next: GlobalFilter[]) => void
}) {
  const [field, setField] = useState('')
  const [op, setOp] = useState<'eq' | 'contains'>('eq')
  const [value, setValue] = useState('')

  const collections = useMemo(
    () => [...new Set(widgets.map((w) => w.collection).filter((c): c is string => !!c))],
    [widgets]
  )

  // Union of registered fields across every widget collection — the same set
  // the server validates filters against.
  const fieldQueries = useQueries({
    queries: collections.map((c) => ({
      queryKey: ['collection-meta', c],
      queryFn: () =>
        api
          .get<{ data: { fields?: Array<{ field: string }> } }>(`/collections/${c}`)
          .then((r) => r.data.data),
      staleTime: 120_000,
      retry: false
    }))
  })
  const fieldOptions = useMemo(() => {
    const byField = new Map<string, number>()
    for (const q of fieldQueries) {
      for (const f of q.data?.fields ?? []) {
        byField.set(f.field, (byField.get(f.field) ?? 0) + 1)
      }
    }
    return [...byField.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [fieldQueries])

  function addFilter() {
    if (!field || value.trim() === '') return
    onChange([...filters.filter((f) => f.field !== field), { field, op, value: value.trim() }])
    setField('')
    setValue('')
    setOp('eq')
  }

  return (
    <div className='mb-5 flex flex-wrap items-center gap-2'>
      <Filter className='h-3.5 w-3.5 text-slate-400' />
      {filters.map((f) => (
        <span
          key={f.field}
          className='inline-flex items-center gap-1 rounded-full border border-nvr-cyan/30 bg-nvr-cyan/10 px-2.5 py-1 text-[11px] font-medium text-nvr-navy dark:text-nvr-cyan'
        >
          {f.field} {f.op === 'contains' ? 'contains' : '='} {f.value}
          <button
            type='button'
            onClick={() => onChange(filters.filter((x) => x.field !== f.field))}
            className='ml-0.5 rounded-full p-0.5 hover:bg-nvr-cyan/20'
            aria-label={`Remove filter on ${f.field}`}
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <div className='flex items-center gap-1.5'>
        <Select
          value={field || '__none__'}
          onValueChange={(v) => setField(v === '__none__' ? '' : v)}
        >
          <SelectTrigger className='h-7 w-[170px] text-[12px]'>
            <SelectValue placeholder='Add a filter…' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='__none__'>Add a filter…</SelectItem>
            {fieldOptions.map(([f, n]) => (
              <SelectItem key={f} value={f}>
                {f}
                {collections.length > 1 && n < collections.length
                  ? ` (${n}/${collections.length})`
                  : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field && (
          <>
            <Select value={op} onValueChange={(v) => setOp(v as 'eq' | 'contains')}>
              <SelectTrigger className='h-7 w-[100px] text-[12px]'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='eq'>equals</SelectItem>
                <SelectItem value='contains'>contains</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addFilter()
                }
              }}
              placeholder='Value'
              className='h-7 w-[140px] text-[12px]'
            />
            <Button
              size='sm'
              variant='outline'
              className='h-7 px-2 text-[12px]'
              onClick={addFilter}
            >
              Apply
            </Button>
          </>
        )}
      </div>
      {filters.length > 0 && (
        <button
          type='button'
          onClick={() => onChange([])}
          className='text-[11px] text-slate-400 hover:text-slate-600 hover:underline'
        >
          Clear all
        </button>
      )}
    </div>
  )
}

// ─── Drill-through sheet (#636) ──────────────────────────────────────────────

function DrillSheet({
  target,
  globalFilters,
  onClose
}: {
  target: DrillTarget | null
  globalFilters: GlobalFilter[]
  onClose: () => void
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: [
      'widget-drill',
      target?.widgetId,
      JSON.stringify(target?.segment ?? null),
      JSON.stringify(globalFilters)
    ],
    queryFn: () =>
      api
        .post<{ data: DrillData }>(`/dashboards/widgets/${target?.widgetId}/drill`, {
          segment: target?.segment ?? null,
          extra_filters: globalFilters
        })
        .then((r) => r.data.data),
    enabled: !!target
  })

  return (
    <Sheet open={!!target} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side='right' className='w-[420px]'>
        <SheetHeader>
          <SheetTitle>
            {target?.title ?? 'Records'}
            {target?.segment && (
              <span className='ml-2 text-[12px] font-normal text-slate-400'>
                {target.segment.value}
              </span>
            )}
          </SheetTitle>
        </SheetHeader>
        <div className='overflow-y-auto px-6 py-4'>
          {isLoading ? (
            <div className='flex justify-center py-10'>
              <Loader2 className='h-5 w-5 animate-spin text-slate-300' />
            </div>
          ) : error ? (
            <p className='py-8 text-center text-[13px] text-slate-400'>
              Could not load matching records.
            </p>
          ) : !data || data.records.length === 0 ? (
            <p className='py-8 text-center text-[13px] text-slate-400'>No matching records.</p>
          ) : (
            <>
              <p className='mb-2 text-[11px] text-slate-400'>
                {formatNumber(data.total)} matching record{data.total === 1 ? '' : 's'}
                {data.capped ? ' · showing the first 100' : ''}
              </p>
              <div className='divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-white/[0.05] dark:border-white/[0.08]'>
                {data.records.map((r) => (
                  <Link
                    key={r.id}
                    to={`/collections/${data.collection}/${r.id}`}
                    onClick={onClose}
                    className='block px-3 py-2 text-[12.5px] text-slate-700 transition-colors hover:bg-slate-50 hover:text-nvr-navy dark:text-slate-300 dark:hover:bg-white/[0.05]'
                  >
                    {r.label}
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const goBack = useGoBack('/dashboards')
  const queryClient = useQueryClient()
  const [showAddWidget, setShowAddWidget] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [drill, setDrill] = useState<DrillTarget | null>(null)

  // #635 — global filters are session state (sessionStorage per dashboard);
  // no server column exists for them yet.
  const [globalFilters, setGlobalFilters] = useState<GlobalFilter[]>(() => {
    try {
      const raw = sessionStorage.getItem(`nvr_dash_filters_${id}`)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(`nvr_dash_filters_${id}`, JSON.stringify(globalFilters))
    } catch {
      // storage full/unavailable — filters just don't survive navigation
    }
  }, [globalFilters, id])

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => api.get<{ data: Dashboard }>(`/dashboards/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  const updateDashboard = useMutation({
    mutationFn: (body: { name?: string; is_shared?: boolean }) =>
      api.patch(`/dashboards/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard', id] })
      queryClient.invalidateQueries({ queryKey: ['dashboards'] })
      setEditingName(false)
      toast.success('Dashboard updated')
    },
    onError: () => toast.error('Failed to update dashboard')
  })

  const deleteWidget = useMutation({
    mutationFn: (widgetId: string) => api.delete(`/dashboards/widgets/${widgetId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard', id] })
      toast.success('Widget removed')
    },
    onError: () => toast.error('Failed to remove widget')
  })

  if (isLoading) {
    return (
      <div className='p-8'>
        <Skeleton className='mb-6 h-8 w-48' />
        <div className='grid grid-cols-4 gap-4'>
          {(['a', 'b', 'c', 'd'] as const).map((k) => (
            <Skeleton key={k} className='h-40 rounded-xl' />
          ))}
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className='flex flex-col items-center justify-center p-20 text-slate-400'>
        <p>Dashboard not found.</p>
        <Button variant='outline' className='mt-4' onClick={() => navigate('/dashboards')}>
          Back to Dashboards
        </Button>
      </div>
    )
  }

  const widgets = data.widgets ?? []

  // Sort widgets by row then col
  const sorted = [...widgets].sort((a, b) => a.row - b.row || a.col - b.col)

  function startEditName() {
    setNameInput(data?.name ?? '')
    setEditingName(true)
  }

  function saveName() {
    if (!nameInput.trim() || nameInput.trim() === data?.name) {
      setEditingName(false)
      return
    }
    updateDashboard.mutate({ name: nameInput.trim() })
  }

  return (
    <>
      {/* ── Header ────────────────────────────────────────────────── */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white dark:border-white/[0.07] dark:bg-[#0d1117] px-8 py-4'>
        <div className='flex items-center gap-4'>
          <button
            type='button'
            onClick={goBack}
            className='rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/[0.06]'
            aria-label='Back to Dashboards'
          >
            <ArrowLeft className='h-4 w-4' />
          </button>

          <div className='flex flex-1 items-center gap-3'>
            {editingName ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  saveName()
                }}
                className='flex items-center gap-2'
              >
                <Input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className='h-8 text-[15px] font-semibold'
                  autoFocus
                  onBlur={saveName}
                />
              </form>
            ) : (
              <button
                type='button'
                onClick={startEditName}
                className='rounded px-1 text-[18px] font-semibold text-slate-900 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors'
              >
                {data.name}
              </button>
            )}

            {data.is_shared && (
              <Badge variant='outline' className='text-[10px] text-slate-500'>
                Shared
              </Badge>
            )}
          </div>

          <div className='flex items-center gap-2'>
            <DashboardLinkPopover dashboardId={data.id} />
            <Button
              size='sm'
              variant='outline'
              onClick={() => updateDashboard.mutate({ is_shared: !data.is_shared })}
            >
              {data.is_shared ? 'Make Private' : 'Share'}
            </Button>
            <Button size='sm' onClick={() => setShowAddWidget(true)}>
              <Plus className='mr-1.5 h-3.5 w-3.5' />
              Add Widget
            </Button>
          </div>
        </div>
      </div>

      {/* ── Widget grid ───────────────────────────────────────────── */}
      <div className='flex-1 overflow-auto p-8'>
        {sorted.length > 0 && (
          <GlobalFilterBar widgets={widgets} filters={globalFilters} onChange={setGlobalFilters} />
        )}
        {sorted.length === 0 ? (
          <div className='flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 dark:border-white/[0.10] bg-white dark:bg-[#161b22] py-20'>
            <div className='flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 dark:bg-white/[0.06]'>
              <TrendingUp className='h-8 w-8 text-slate-400' />
            </div>
            <h3 className='mt-4 text-[15px] font-semibold text-slate-700 dark:text-slate-300'>
              No widgets yet
            </h3>
            <p className='mt-1.5 max-w-xs text-center text-[13px] text-slate-400'>
              Add KPI widgets to display counts, sums, charts, and more from your collections.
            </p>
            <Button className='mt-6' onClick={() => setShowAddWidget(true)}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> Add Widget
            </Button>
          </div>
        ) : (
          <div
            className='grid gap-4'
            style={{
              gridTemplateColumns: 'repeat(4, 1fr)',
              gridAutoRows: '180px'
            }}
          >
            {sorted.map((widget) => (
              <WidgetCard
                key={widget.id}
                widget={widget}
                globalFilters={globalFilters}
                onDelete={() => deleteWidget.mutate(widget.id)}
                onDrill={(segment) =>
                  widget.collection &&
                  setDrill({ widgetId: widget.id, title: widget.title, segment })
                }
              />
            ))}
          </div>
        )}
      </div>

      <AddWidgetSheet dashboardId={id ?? ''} open={showAddWidget} onOpenChange={setShowAddWidget} />
      <DrillSheet target={drill} globalFilters={globalFilters} onClose={() => setDrill(null)} />
    </>
  )
}
