import { useMutation, useQueryClient } from '@tanstack/react-query'
import { OctagonX, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  type ChaosRun,
  type ChaosRunEvent,
  countdown,
  describeTarget,
  errText,
  stopAll,
  stopRun
} from './api'
import { Timeline } from './RunDetail'
import { SamplerCharts } from './SamplerCharts'
import { ScribeBar, useRunNotes } from './Scribe'

/**
 * The live cockpit (#2845) while a run is armed: countdown ring, Stop (this run) and Stop all,
 * the hypothesis sparklines against the baseline band (filled in with the steady-state
 * watcher, #2828) and the events ticker. Live over the `chaos` watch room; the 5 s poll in
 * RunDetail is the net under it.
 */
export function RunCockpit({ run, events }: { run: ChaosRun; events: ChaosRunEvent[] }) {
  const qc = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const started = run.started_at ? new Date(run.started_at).getTime() : now
  const ends = run.ends_at ? new Date(run.ends_at).getTime() : now
  const total = Math.max(1, ends - started)
  const left = Math.max(0, ends - now)
  const frac = Math.min(1, Math.max(0, left / total))
  // Scribe marks (#2853): a game day's fault run reads (and stamps) the day's notes.
  const notes = useRunNotes(run.id, true).data?.notes ?? []

  const stop = useMutation({
    mutationFn: () => stopRun(run.id),
    onSuccess: () => {
      toast.success('Fault stopped')
      void qc.invalidateQueries({ queryKey: ['chaos'] })
    },
    onError: (e) => toast.error(errText(e, 'Stop failed'))
  })
  const all = useMutation({
    mutationFn: stopAll,
    onSuccess: () => {
      toast.success('Everything stopped')
      void qc.invalidateQueries({ queryKey: ['chaos'] })
    },
    onError: (e) => toast.error(errText(e, 'Stop all failed'))
  })

  return (
    <div className='space-y-5 p-4 sm:p-6'>
      <div className='flex flex-col gap-4 rounded-lg border border-red-200 bg-white p-4 sm:flex-row sm:items-center sm:gap-5 dark:border-red-900/50 dark:bg-card'>
        <div className='flex min-w-0 flex-1 items-center gap-4 sm:gap-5'>
          <CountdownRing frac={frac} label={left > 0 ? countdown(ends, now) : 'ending'} />
          <div className='min-w-0 flex-1'>
            <div className='flex items-start gap-2'>
              <span className='relative mt-[7px] flex h-2 w-2 shrink-0' aria-hidden>
                <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75 motion-reduce:animate-none' />
                <span className='relative inline-flex h-2 w-2 rounded-full bg-red-500' />
              </span>
              <h2 className='min-w-0 text-[15px] font-semibold text-balance text-slate-900 dark:text-foreground'>
                {run.label} is armed
              </h2>
            </div>
            <p className='mt-1 break-words text-[12.5px] text-slate-600 dark:text-muted-foreground'>
              On {describeTarget(run.target)}
              {Object.keys(run.params).length
                ? ` · ${Object.entries(run.params)
                    .map(([k, v]) => `${k} ${String(v)}`)
                    .join(', ')}`
                : ''}
              {typeof run.meta.started_by_name === 'string'
                ? ` · started by ${run.meta.started_by_name}`
                : ''}
            </p>
            <p className='mt-0.5 truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {run.id}
            </p>
          </div>
        </div>
        <div className='grid shrink-0 grid-cols-2 gap-2 sm:flex'>
          <button
            type='button'
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
            data-tip='Disarm this fault now; the run keeps its verdict so far'
            className='inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-red-600 px-4 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:focus-visible:ring-offset-card'
          >
            <Square className='h-3.5 w-3.5 fill-current' aria-hidden />
            {stop.isPending ? 'Stopping…' : 'Stop this run'}
          </button>
          <button
            type='button'
            onClick={() => all.mutate()}
            disabled={all.isPending}
            data-tip='Disarm every fault on every replica'
            className='inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-red-300 bg-white px-4 text-[13px] font-medium text-red-700 transition-colors duration-150 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:border-red-900/60 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/40 dark:focus-visible:ring-offset-card'
          >
            <OctagonX className='h-4 w-4' aria-hidden />
            {all.isPending ? 'Stopping…' : 'Stop all'}
          </button>
        </div>
      </div>

      <section aria-label='Scribe'>
        <h3 className='mb-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
          Scribe
        </h3>
        <ScribeBar runId={run.id} />
      </section>

      <section>
        <h3 className='mb-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
          What should stay true
          {typeof run.meta.node === 'string' && (
            <span className='ml-2 font-mono text-[10.5px] font-normal text-slate-400 dark:text-muted-foreground/70'>
              sampled on {run.meta.node}
            </span>
          )}
        </h3>
        <SamplerCharts run={run} events={events} notes={notes} />
      </section>

      <Timeline events={events} compact />
    </div>
  )
}

/** A thin ring that empties as the window runs out; the time left sits inside. */
export function CountdownRing({
  frac,
  label,
  size = 72
}: {
  frac: number
  label: string
  size?: number
}) {
  const r = (size - 6) / 2
  const c = 2 * Math.PI * r
  return (
    <div
      className='relative shrink-0'
      style={{ width: size, height: size }}
      role='timer'
      aria-label={label === 'ending' ? 'Window over, disarming' : `${label} left`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className='-rotate-90'
        aria-hidden='true'
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill='none'
          strokeWidth={4}
          className='stroke-slate-200 dark:stroke-border'
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill='none'
          strokeWidth={4}
          strokeLinecap='round'
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          className={cn(
            'transition-[stroke-dashoffset] duration-500 ease-linear motion-reduce:transition-none',
            frac < 0.15 ? 'stroke-red-500' : 'stroke-red-400'
          )}
        />
      </svg>
      <span className='absolute inset-0 flex items-center justify-center font-mono text-[13px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {label}
      </span>
    </div>
  )
}
