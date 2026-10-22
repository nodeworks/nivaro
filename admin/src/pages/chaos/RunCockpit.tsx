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
      <div className='flex flex-wrap items-center gap-5 rounded-lg border border-red-200 bg-white p-4 dark:border-red-900/50 dark:bg-card'>
        <CountdownRing frac={frac} label={countdown(ends, now)} />
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='relative flex h-2 w-2' aria-hidden>
              <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75 motion-reduce:animate-none' />
              <span className='relative inline-flex h-2 w-2 rounded-full bg-red-500' />
            </span>
            <h2 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
              {run.label} is armed
            </h2>
          </div>
          <p className='mt-1 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
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
          <p className='mt-0.5 font-mono text-[11px] text-slate-400 dark:text-muted-foreground/70'>
            {run.id}
          </p>
        </div>
        <div className='flex shrink-0 flex-col gap-2 sm:flex-row'>
          <button
            type='button'
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
            className='inline-flex h-10 items-center gap-2 rounded-md bg-red-600 px-4 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:focus-visible:ring-offset-card'
          >
            <Square className='h-4 w-4 fill-current' aria-hidden />
            Stop this run
          </button>
          <button
            type='button'
            onClick={() => all.mutate()}
            disabled={all.isPending}
            className='inline-flex h-10 items-center gap-2 rounded-md border border-red-300 px-4 text-[13px] font-medium text-red-700 transition-colors duration-150 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40 dark:focus-visible:ring-offset-card'
          >
            <OctagonX className='h-4 w-4' aria-hidden />
            Stop all
          </button>
        </div>
      </div>

      <section>
        <h3 className='mb-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
          What should stay true
          {typeof run.meta.node === 'string' && (
            <span className='ml-2 font-mono text-[10.5px] font-normal text-slate-400 dark:text-muted-foreground/70'>
              sampled on {run.meta.node}
            </span>
          )}
        </h3>
        <SamplerCharts run={run} events={events} />
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
      aria-label={`${label} left`}
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
