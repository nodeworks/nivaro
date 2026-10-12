import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellOff, ChevronDown, Eye, Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// Watched numbers (#1892, #1987, #1948): "Tell me when this goes over…" under a
// numeric answer, and the list of what the person is watching.

export interface WatchSummary {
  id: string
  label: string
  what: string
  rule: string
  mode: 'threshold' | 'trend'
  operator: 'gt' | 'gte' | 'lt' | 'lte'
  threshold: number | null
  frequency: 'hourly' | 'daily'
  active: boolean
  value: number | null
  change_since_yesterday: number | null
  near_threshold: boolean
  state: 'ok' | 'firing' | null
  last_checked_at: string | null
  last_error: string | null
  last_alert_at: string | null
  last_alert_text: string | null
}

const WATCHES_KEY = ['ask-ai-watches']

const OPERATORS = [
  { value: 'gt', label: 'goes over' },
  { value: 'gte', label: 'reaches' },
  { value: 'lt', label: 'drops under' },
  { value: 'lte', label: 'falls to' }
]
const FREQUENCIES = [
  { value: 'daily', label: 'Check daily' },
  { value: 'hourly', label: 'Check hourly' }
]
const MODES = [
  { value: 'threshold', label: 'a number' },
  { value: 'trend', label: 'a change in direction or an unusual move' }
]

const fmt = (n: number | null) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

interface AggregateInput {
  collection?: unknown
  op?: unknown
  field?: unknown
  filter?: unknown
  group_by?: unknown
}

/** The single, ungrouped aggregate in an answer's trace, when there is exactly one. */
export function watchableAggregate(
  trace: Array<{ tool: string; input: Record<string, unknown> }> | undefined
): AggregateInput | null {
  const aggs = (trace ?? []).filter((t) => t.tool === 'aggregate')
  if (aggs.length !== 1) return null
  const i = aggs[0].input as AggregateInput
  if (i.group_by || typeof i.collection !== 'string' || typeof i.op !== 'string') return null
  return i
}

export function WatchThisNumber({ aggregate }: { aggregate: AggregateInput }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('threshold')
  const [operator, setOperator] = useState('gt')
  const [threshold, setThreshold] = useState('')
  const [frequency, setFrequency] = useState('daily')
  const [done, setDone] = useState(false)

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.post('/ai/watches', {
          collection: aggregate.collection,
          op: aggregate.op,
          field: aggregate.field,
          filter: aggregate.filter,
          mode,
          operator,
          threshold: mode === 'threshold' ? Number(threshold) : null,
          frequency
        })
      ).data,
    onSuccess: () => {
      setDone(true)
      setOpen(false)
      qc.invalidateQueries({ queryKey: WATCHES_KEY })
      toast.success('Watching this number')
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Could not set the watch')
    }
  })

  if (done)
    return (
      <div className='mt-2 flex items-center gap-1.5 text-[11px] text-slate-500' data-ask-watch-set>
        <Eye className='h-3 w-3' /> You are watching this number.
      </div>
    )

  return (
    <div className='mt-2 border-t border-slate-100 pt-2 dark:border-border' data-ask-watch>
      {!open ? (
        <button
          type='button'
          onClick={() => setOpen(true)}
          className='inline-flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-nvr-cyan'
        >
          <Bell className='h-3 w-3' /> Tell me when this goes over…
        </button>
      ) : (
        <div className='flex flex-wrap items-center gap-2 text-[12px]'>
          <span>Tell me when it shows</span>
          <SimpleSelect
            value={mode}
            onChange={setMode}
            options={MODES}
            ariaLabel='What to watch for'
            className='h-7 w-auto text-[12px]'
          />
          {mode === 'threshold' && (
            <>
              <SimpleSelect
                value={operator}
                onChange={setOperator}
                options={OPERATORS}
                ariaLabel='Comparison'
                className='h-7 w-auto text-[12px]'
              />
              <input
                type='number'
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder='number'
                aria-label='Threshold'
                className='h-7 w-24 rounded-md border border-slate-200 px-2 text-[12px] dark:border-border dark:bg-background'
              />
            </>
          )}
          <SimpleSelect
            value={frequency}
            onChange={setFrequency}
            options={FREQUENCIES}
            ariaLabel='Check frequency'
            className='h-7 w-auto text-[12px]'
          />
          <Button
            size='sm'
            disabled={create.isPending || (mode === 'threshold' && threshold.trim() === '')}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Watch'}
          </Button>
          <Button size='sm' variant='ghost' onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}

function WatchRow({ w }: { w: WatchSummary }) {
  const qc = useQueryClient()
  const [threshold, setThreshold] = useState(w.threshold == null ? '' : String(w.threshold))
  const refresh = () => qc.invalidateQueries({ queryKey: WATCHES_KEY })
  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => api.patch(`/ai/watches/${w.id}`, body),
    onSuccess: refresh,
    onError: () => toast.error('Could not update the watch')
  })
  const remove = useMutation({
    mutationFn: async () => api.delete(`/ai/watches/${w.id}`),
    onSuccess: refresh
  })

  return (
    <div
      className='flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[12px]'
      data-ask-watch-row
    >
      <div className='min-w-0 flex-1'>
        <div className='truncate font-medium text-slate-700 dark:text-slate-200'>{w.label}</div>
        <div className='text-[11px] text-slate-400'>
          {w.rule} · {w.frequency}
          {w.last_alert_at
            ? ` · last alert ${formatRelative(w.last_alert_at)}`
            : ' · no alerts yet'}
        </div>
      </div>
      <div className={cn('tabular-nums', w.state === 'firing' && 'font-semibold text-red-600')}>
        {fmt(w.value)}
        {w.change_since_yesterday != null && (
          <span className='ml-1 text-[11px] text-slate-400'>
            ({w.change_since_yesterday > 0 ? '+' : ''}
            {fmt(w.change_since_yesterday)} today)
          </span>
        )}
      </div>
      {w.mode === 'threshold' && (
        <input
          type='number'
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          onBlur={() => {
            if (threshold.trim() !== '' && Number(threshold) !== w.threshold)
              patch.mutate({ threshold: Number(threshold) })
          }}
          aria-label='Threshold'
          className='h-7 w-24 rounded-md border border-slate-200 px-2 text-[12px] dark:border-border dark:bg-background'
        />
      )}
      <Button
        size='sm'
        variant='ghost'
        data-tip={w.active ? 'Pause alerts' : 'Resume alerts'}
        onClick={() => patch.mutate({ active: !w.active })}
      >
        {w.active ? <Bell className='h-3.5 w-3.5' /> : <BellOff className='h-3.5 w-3.5' />}
      </Button>
      <Button size='sm' variant='ghost' data-tip='Stop watching' onClick={() => remove.mutate()}>
        <Trash2 className='h-3.5 w-3.5' />
      </Button>
      {w.last_error && <div className='w-full text-[11px] text-amber-600'>{w.last_error}</div>}
    </div>
  )
}

/** The numbers this person is watching, folded under the transcript header. */
export function MyWatchesPanel() {
  const [open, setOpen] = useState(false)
  const { data = [] } = useQuery({
    queryKey: WATCHES_KEY,
    queryFn: async () => (await api.get('/ai/watches')).data.data as WatchSummary[]
  })
  if (!data.length) return null
  return (
    <div
      className='mx-auto mb-3 w-full max-w-3xl rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-ask-watches
    >
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-slate-600 dark:text-slate-300'
      >
        <Eye className='h-3.5 w-3.5' /> Numbers you watch ({data.length})
        <ChevronDown
          className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className='divide-y divide-slate-100 border-t border-slate-100 dark:divide-border dark:border-border'>
          {data.map((w) => (
            <WatchRow key={w.id} w={w} />
          ))}
        </div>
      )}
    </div>
  )
}
