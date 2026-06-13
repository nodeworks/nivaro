import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, BarChart2, LineChart, Loader2, Plus, Trash2, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
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
import { cn, formatNumber } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type WidgetType = DashboardWidget['type']

interface WidgetData {
  value?: number | null
  rows?: Array<Record<string, unknown>>
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
  line_chart: { label: 'Line Chart', color: 'bg-pink-50 text-pink-700 border-pink-200' }
}

// ─── Widget card ──────────────────────────────────────────────────────────────

function WidgetCard({ widget, onDelete }: { widget: DashboardWidget; onDelete: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['widget-data', widget.id],
    queryFn: () =>
      api
        .get<{ data: WidgetData | null }>(`/dashboards/widgets/${widget.id}/data`)
        .then((r) => r.data.data),
    refetchInterval: 60_000
  })

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
      <div className='flex flex-1 items-center justify-center'>
        {isLoading ? (
          <Loader2 className='h-5 w-5 animate-spin text-slate-300' />
        ) : !data ? (
          <p className='text-[12px] text-slate-400'>No data</p>
        ) : widget.type === 'count' || widget.type === 'sum' || widget.type === 'avg' ? (
          <div className='text-center'>
            <p className='text-4xl font-bold tabular-nums text-slate-800 dark:text-slate-100'>
              {data.value !== null && data.value !== undefined ? formatNumber(data.value) : '—'}
            </p>
          </div>
        ) : widget.type === 'latest' ? (
          <LatestTable rows={(data.rows ?? []).slice(0, 5)} />
        ) : widget.type === 'bar_chart' ? (
          <ChartWrapper data={data.rows ?? []} type='bar' />
        ) : widget.type === 'line_chart' ? (
          <ChartWrapper data={data.rows ?? []} type='line' />
        ) : null}
      </div>
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
  type
}: {
  data: Array<Record<string, unknown>>
  type: 'bar' | 'line'
}) {
  const points = data as unknown as ChartPoint[]

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
        <BarChart data={points} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray='3 3' stroke='rgba(0,0,0,0.06)' />
          <XAxis dataKey='date' tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
          <Tooltip
            contentStyle={{ fontSize: 12 }}
            formatter={(v) => [formatNumber(Number(v ?? 0)), 'Count']}
          />
          <Bar dataKey='count' fill='#00ceff' radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width='100%' height={160}>
      <RechartsLineChart data={points} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray='3 3' stroke='rgba(0,0,0,0.06)' />
        <XAxis dataKey='date' tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
        <Tooltip
          contentStyle={{ fontSize: 12 }}
          formatter={(v) => [formatNumber(Number(v ?? 0)), 'Count']}
        />
        <Line type='monotone' dataKey='count' stroke='#00ceff' strokeWidth={2} dot={false} />
      </RechartsLineChart>
    </ResponsiveContainer>
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
              </SelectContent>
            </Select>
          </div>

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

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showAddWidget, setShowAddWidget] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')

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
            onClick={() => navigate('/dashboards')}
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
                onDelete={() => deleteWidget.mutate(widget.id)}
              />
            ))}
          </div>
        )}
      </div>

      <AddWidgetSheet dashboardId={id ?? ''} open={showAddWidget} onOpenChange={setShowAddWidget} />
    </>
  )
}
