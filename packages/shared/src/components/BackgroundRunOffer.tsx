import { AlertCircle, Loader2, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSlowReason } from '../hooks/useSlowReason'
import {
  clock,
  runProgress,
  type UseBackgroundRunOptions,
  useBackgroundRun
} from '../lib/background-runs'
import { cn } from '../lib/utils'
import { SlowNoticeView } from './SlowNotice'

/**
 * The "Run in background" strip for a slow read (#2759). Render it inside the loading state of
 * a custom query, report widget, page widget or dashboard widget; it stays empty until the read
 * has been loading for a moment AND is known to be slow (or has simply been loading a long time),
 * then offers to hand the read to the server. While the server runs it, the strip shows elapsed
 * time against the usual time; when the result is ready it fills the page's own query and the
 * strip goes away. Every state is inline — no dialog.
 *
 * #3231 — from ~3 s it also says what the read is waiting on ("Waiting for a free slot — busy
 * right now", "Running PUB health — not cached yet"), before and beside the offer.
 */
export function BackgroundRunOffer({
  className,
  ...opts
}: UseBackgroundRunOptions & { className?: string }) {
  const bg = useBackgroundRun(opts)
  const slow = useSlowReason({
    pending: opts.pending && bg.phase !== 'running' && bg.phase !== 'done',
    request: opts.request,
    label: opts.label
  })
  const startedAt = bg.run?.started_at ? Date.parse(bg.run.started_at) : null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (bg.phase !== 'running') return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [bg.phase])

  if (bg.phase === 'done') return null
  if (bg.phase === 'idle')
    return slow.slow ? <SlowNoticeView reason={slow} className={className} /> : null

  if (bg.phase === 'error') {
    return (
      <div
        data-background-run='error'
        role='alert'
        className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]', className)}
      >
        <AlertCircle className='h-3.5 w-3.5 shrink-0 text-rose-500' />
        <span className='min-w-0 text-rose-700 dark:text-rose-300'>
          {bg.error ?? 'The background run failed.'}
        </span>
        <button
          type='button'
          onClick={bg.start}
          className='rounded text-[12px] font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-300 dark:hover:text-white'
        >
          Try again
        </button>
      </div>
    )
  }

  if (bg.phase === 'running') {
    const elapsed = startedAt ? Math.max(0, now - startedAt) : 0
    const expected = bg.run?.expected_ms ?? null
    const pct = runProgress(elapsed, expected)
    return (
      <div
        data-background-run='running'
        aria-live='polite'
        className={cn('flex w-full min-w-0 flex-col gap-1.5', className)}
      >
        <div
          role='progressbar'
          aria-label='Background run'
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct == null ? undefined : Math.round(pct * 100)}
          className='relative h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800'
        >
          {pct == null ? (
            <div className='nvr-bgrun-sweep absolute inset-y-0 left-0 w-1/3 rounded-full bg-nvr-cyan/70' />
          ) : (
            <div
              className='h-full w-full origin-left rounded-full bg-nvr-cyan transition-transform duration-1000 ease-linear motion-reduce:transition-none'
              style={{ transform: `scaleX(${pct})` }}
            />
          )}
        </div>
        <p className='text-[12px] text-slate-600 dark:text-slate-300'>
          Running in the background
          <span className='text-slate-400 dark:text-slate-500'> · </span>
          <span className='tabular-nums'>
            {clock(elapsed)}
            {expected ? ` of about ${clock(expected)}` : ''}
          </span>
        </p>
        <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
          You can leave this page. Your jobs tray says when it is ready.
        </p>
        <style>{SWEEP_CSS}</style>
      </div>
    )
  }

  // offer / starting
  const typical = bg.typicalMs
  return (
    <div
      data-background-run='offer'
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}
    >
      <span className='inline-flex min-w-0 items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
        <Timer className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        {typical && typical >= 1000
          ? `This usually takes about ${clock(typical)}.`
          : 'This is taking a while.'}
        {slow.text && (
          <span data-slow-reason className='text-slate-500 dark:text-slate-400'>
            {slow.text}.
          </span>
        )}
      </span>
      <button
        type='button'
        onClick={bg.start}
        disabled={bg.phase === 'starting'}
        data-background-run-start
        className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:pointer-events-none disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
      >
        {bg.phase === 'starting' && <Loader2 className='h-3 w-3 animate-spin' />}
        Run in background
      </button>
    </div>
  )
}

const SWEEP_CSS = `
@keyframes nvr-bgrun-sweep { from { transform: translateX(-100%) } to { transform: translateX(300%) } }
.nvr-bgrun-sweep { animation: nvr-bgrun-sweep 1.6s cubic-bezier(0.25, 1, 0.5, 1) infinite }
@media (prefers-reduced-motion: reduce) { .nvr-bgrun-sweep { animation: none; width: 100%; opacity: .5 } }
`
