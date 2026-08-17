import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Timer } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface TraceSpan {
  seq: number
  phase: string
  ms: number
  at: number
  detail?: string
}

interface Trace {
  id: string
  method: string
  route: string
  url: string
  status: number
  user: string | null
  total_ms: number
  spans: TraceSpan[]
  ts: string
  unaccounted_ms: number
  slowest_phase: string | null
}

interface TracesResponse {
  config: { slow_ms: number; capacity: number; buffered: number }
  traces: Trace[]
}

/**
 * One span as a positioned bar. Offset and width are percentages of the
 * request's own total, so the row reads as a waterfall — concurrent phases
 * genuinely overlap rather than being stacked into a misleading sequence.
 */
function SpanBar({ span, total, slowest }: { span: TraceSpan; total: number; slowest: boolean }) {
  const left = total > 0 ? (span.at / total) * 100 : 0
  const width = total > 0 ? Math.max((span.ms / total) * 100, 0.6) : 0

  return (
    <div className='flex items-center gap-3 py-[3px]'>
      <span className='w-48 shrink-0 truncate text-[11px] text-muted-foreground' title={span.phase}>
        {span.phase}
      </span>
      <div className='relative h-3 flex-1 overflow-hidden rounded-sm bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]'>
        <div
          className={cn(
            'absolute inset-y-0 rounded-sm',
            slowest ? 'bg-amber-400 dark:bg-amber-500' : 'bg-nvr-cyan/70'
          )}
          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
        />
      </div>
      <span className='w-16 shrink-0 text-right text-[11px] tabular-nums'>
        {span.ms.toFixed(0)}ms
      </span>
      <span className='w-28 shrink-0 truncate text-[10.5px] text-muted-foreground'>
        {span.detail ?? ''}
      </span>
    </div>
  )
}

function TraceRow({ trace }: { trace: Trace }) {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className='border-b border-slate-200 last:border-0 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted'
      >
        <Chevron className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />
        <span className='w-14 shrink-0 text-[11px] font-medium text-muted-foreground'>
          {trace.method}
        </span>
        <span className='min-w-0 flex-1 truncate font-mono text-[12px]'>{trace.route}</span>
        {trace.slowest_phase && (
          <span className='shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400'>
            {trace.slowest_phase}
          </span>
        )}
        <span
          className={cn(
            'w-16 shrink-0 text-right text-[12px] font-semibold tabular-nums',
            trace.status >= 400 ? 'text-red-600 dark:text-red-400' : ''
          )}
        >
          {trace.total_ms}ms
        </span>
        <span className='w-20 shrink-0 text-right text-[11px] text-muted-foreground'>
          {new Date(trace.ts).toLocaleTimeString()}
        </span>
      </button>

      {open && (
        <div className='bg-slate-50 px-3 pb-3 pt-1 dark:bg-background'>
          <p className='mb-2 break-all font-mono text-[10.5px] text-muted-foreground'>
            {trace.url}
          </p>
          {trace.spans.length === 0 ? (
            <p className='text-[11px] text-muted-foreground'>
              No instrumented phases on this route yet — the whole request is unaccounted.
            </p>
          ) : (
            trace.spans.map((s) => (
              <SpanBar
                key={s.seq}
                span={s}
                total={trace.total_ms}
                slowest={s.phase === trace.slowest_phase}
              />
            ))
          )}
          <div className='mt-2 border-t border-slate-200 pt-1.5 text-[11px] text-muted-foreground dark:border-border'>
            Unaccounted{' '}
            <span className='font-medium tabular-nums text-foreground'>
              {trace.unaccounted_ms}ms
            </span>{' '}
            — time inside the request that nothing has instrumented yet. Where the next span goes.
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Slow-request waterfalls. Answers "why was THIS request slow", which the p50/p95
 * charts above cannot: they give the shape of a route's latency, not the phase
 * inside one request that spent it.
 */
export function SlowTracesPanel() {
  const qc = useQueryClient()
  const { data } = useQuery<TracesResponse>({
    queryKey: ['traces'],
    queryFn: () => api.get<{ data: TracesResponse }>('/traces?limit=50').then((r) => r.data.data),
    refetchInterval: 15_000
  })

  const clear = useMutation({
    mutationFn: () => api.delete('/traces'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['traces'] })
  })

  const traces = data?.traces ?? []

  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-border'>
        <div className='flex items-center gap-2'>
          <Timer className='h-4 w-4 text-muted-foreground' />
          <h2 className='text-[13px] font-medium'>Slow requests</h2>
          {data && (
            <span className='text-[11px] text-muted-foreground'>
              over {data.config.slow_ms}ms · {data.config.buffered}/{data.config.capacity} buffered
              · this instance only
            </span>
          )}
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-7 px-2.5 text-[12px]'
          disabled={traces.length === 0 || clear.isPending}
          onClick={() => clear.mutate()}
        >
          Clear
        </Button>
      </div>

      {traces.length === 0 ? (
        <p className='px-4 py-6 text-center text-[12px] text-muted-foreground'>
          No slow requests recorded. Anything under {data?.config.slow_ms ?? 1000}ms is discarded
          rather than stored.
        </p>
      ) : (
        <div>
          {traces.map((t) => (
            <TraceRow key={t.id} trace={t} />
          ))}
        </div>
      )}
    </div>
  )
}
