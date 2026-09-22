import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Timer } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PlanViewer } from '@/components/plan-viewer'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface TraceSpan {
  seq: number
  phase: string
  ms: number
  at: number
  detail?: string
  queries?: number
  repeat?: { sql: string; n: number; ms: number }
  wide?: Array<{ table: string; n: number }>
}

interface TraceStatement {
  sql: string
  bindings: unknown[]
  ms: number
  n: number
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
  queries?: number
  sql_ms?: number
  top_sql?: TraceStatement[]
  wide?: Array<{ table: string; n: number }>
}

interface PlanResult {
  source: 'cache' | 'estimated'
  plan: string | null
  stats: {
    execution_count: number
    avg_elapsed_ms: number
    last_elapsed_ms: number
    max_elapsed_ms: number
    avg_logical_reads: number
    last_execution_time: string | null
  } | null
  sql: string
  bindings: unknown[]
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
      <span
        className='w-12 shrink-0 text-right text-[10.5px] tabular-nums text-muted-foreground'
        title='Round trips this phase made'
      >
        {span.queries ? `${span.queries} rt` : ''}
      </span>
      <span className='w-28 shrink-0 truncate text-[10.5px] text-muted-foreground'>
        {span.repeat ? (
          <span
            data-trace-nplus1={span.repeat.n}
            className='rounded bg-[#fef3c7] px-1 py-px text-amber-800 dark:bg-[#4a3a10] dark:text-amber-200'
            title={`${span.repeat.n}× the same statement (${span.repeat.ms}ms): ${span.repeat.sql}`}
          >
            {span.repeat.n}× same statement
          </span>
        ) : span.wide?.length ? (
          <span
            data-trace-wide
            className='rounded bg-[#e0f2fe] px-1 py-px text-sky-800 dark:bg-[#0f2f45] dark:text-sky-200'
            title={span.wide.map((w) => `select * from ${w.table} ×${w.n}`).join(', ')}
          >
            wide select
          </span>
        ) : (
          (span.detail ?? '')
        )}
      </span>
    </div>
  )
}

/** The statements a slow request ran, heaviest first, each with its real plan on request. */
function StatementList({ trace }: { trace: Trace }) {
  const [open, setOpen] = useState<number | null>(null)
  const [result, setResult] = useState<PlanResult | null>(null)
  const explain = useMutation({
    mutationFn: (index: number) =>
      api
        .post<{ data: PlanResult }>(`/traces/${trace.id}/explain`, { index })
        .then((r) => r.data.data),
    onSuccess: (d, index) => {
      setResult(d)
      setOpen(index)
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Plan failed'
      )
  })
  const stmts = trace.top_sql ?? []
  if (stmts.length === 0) return null
  return (
    <div className='mt-2 border-t border-slate-200 pt-2 dark:border-border' data-trace-statements>
      <p className='mb-1 text-[11px] text-muted-foreground'>
        <span className='font-medium text-foreground tabular-nums'>{trace.queries ?? 0}</span> round
        trips ·{' '}
        <span className='font-medium text-foreground tabular-nums'>{trace.sql_ms ?? 0}ms</span>{' '}
        waiting on the database. Heaviest statement shapes:
      </p>
      <ul className='space-y-0.5'>
        {stmts.map((st, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional statements
          <li key={i} className='flex items-start gap-2 text-[11px]'>
            <span className='w-14 shrink-0 text-right tabular-nums'>{st.ms.toFixed(0)}ms</span>
            <span className='w-8 shrink-0 text-right tabular-nums text-muted-foreground'>
              {st.n > 1 ? `×${st.n}` : ''}
            </span>
            <code className='min-w-0 flex-1 truncate font-mono text-[10.5px]' title={st.sql}>
              {st.sql}
            </code>
            {/^\s*select\b/i.test(st.sql) && !st.sql.endsWith('…') && (
              <button
                type='button'
                data-trace-plan={i}
                className='shrink-0 rounded border border-slate-200 px-1.5 text-[10.5px] hover:bg-muted disabled:opacity-50 dark:border-border'
                disabled={explain.isPending}
                onClick={() => (open === i ? setOpen(null) : explain.mutate(i))}
              >
                {open === i ? 'Hide plan' : 'Plan'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {open != null && result && (
        <div className='mt-2 space-y-2' data-trace-plan-result={result.source}>
          <p className='text-[11px] text-muted-foreground'>
            {result.source === 'cache' && result.stats ? (
              <>
                From the plan cache — the plan the route really got.{' '}
                <span className='tabular-nums text-foreground'>
                  {result.stats.execution_count} runs · avg {result.stats.avg_elapsed_ms}ms · last{' '}
                  {result.stats.last_elapsed_ms}ms · max {result.stats.max_elapsed_ms}ms ·{' '}
                  {result.stats.avg_logical_reads.toLocaleString()} logical reads avg
                </span>
              </>
            ) : (
              <>
                <span className='font-medium text-amber-700 dark:text-amber-400'>Estimated</span> —
                the cached plan was evicted, so this is the optimizer's answer over declared
                variables (no parameter sniffing). It can differ from what the route got.
              </>
            )}
          </p>
          {result.plan ? (
            <PlanViewer xml={result.plan} />
          ) : (
            <p className='text-[11px] text-muted-foreground'>No plan returned.</p>
          )}
        </div>
      )}
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
        {trace.spans.some((s) => s.repeat) && (
          <span className='shrink-0 rounded bg-[#fef3c7] px-1.5 py-0.5 text-[10.5px] text-amber-800 dark:bg-[#4a3a10] dark:text-amber-200'>
            N+1
          </span>
        )}
        {(trace.wide?.length ?? 0) > 0 && (
          <span className='shrink-0 rounded bg-[#e0f2fe] px-1.5 py-0.5 text-[10.5px] text-sky-800 dark:bg-[#0f2f45] dark:text-sky-200'>
            wide
          </span>
        )}
        {trace.queries != null && (
          <span
            className='w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground'
            title='Database round trips'
          >
            {trace.queries} rt
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
          <StatementList trace={trace} />
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
