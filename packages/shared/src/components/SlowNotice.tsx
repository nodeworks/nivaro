import { Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import { type SlowReason, type UseSlowReasonOptions, useSlowReason } from '../hooks/useSlowReason'
import { elapsedLabel } from '../lib/slow-reason'
import { cn } from '../lib/utils'

/**
 * "This is taking a while" with a reason (#3231). Renders nothing until the read has been
 * loading ~3 s, then says what it is waiting on in plain words ("Reading 48,000 invoices",
 * "Waiting for Fusion", "Waiting for a free slot — busy right now") with the elapsed time.
 *
 *   variant 'inline' — a line inside a loading area (widgets, query results, forms)
 *   variant 'pill'   — a floating chip; the caller positions it (absolute) so nothing moves
 *
 * `children` ride beside the text (e.g. a Run in background button). Reads that can run in the
 * background use BackgroundRunOffer, which shows the same reason.
 */
export function SlowNotice({
  variant = 'inline',
  className,
  children,
  reason: given,
  ...opts
}: UseSlowReasonOptions & {
  variant?: 'inline' | 'pill'
  className?: string
  children?: ReactNode
  /** A reason the host already computed with useSlowReason (skips the hook's own asking). */
  reason?: SlowReason
}) {
  const own = useSlowReason({ ...opts, enabled: !given && opts.enabled !== false })
  const r = given ?? own
  if (!r.slow) return null
  return <SlowNoticeView reason={r} variant={variant} className={className} extra={children} />
}

export function SlowNoticeView({
  reason,
  variant = 'inline',
  className,
  extra
}: {
  reason: SlowReason
  variant?: 'inline' | 'pill'
  className?: string
  extra?: ReactNode
}) {
  const text = reason.text ?? 'This is taking a while'
  const time = elapsedLabel(reason.elapsedMs)
  if (variant === 'pill')
    return (
      <span
        role='status'
        aria-live='polite'
        data-slow-notice={reason.answer?.kind ?? 'generic'}
        className={cn(
          'nvr-pop-in inline-flex max-w-[min(92vw,520px)] items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 shadow-lg motion-reduce:animate-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300',
          className
        )}
      >
        <Timer aria-hidden className='h-3.5 w-3.5 shrink-0 text-[#00a5cc]' />
        <span className='min-w-0 truncate'>{text}</span>
        <span className='shrink-0 tabular-nums text-slate-400 dark:text-slate-500'>{time}</span>
        {extra}
      </span>
    )
  return (
    <div
      role='status'
      aria-live='polite'
      data-slow-notice={reason.answer?.kind ?? 'generic'}
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]', className)}
    >
      <Timer aria-hidden className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500' />
      <span className='min-w-0 text-slate-600 dark:text-slate-300'>
        {reason.text ? (
          <>
            <span className='text-slate-500 dark:text-slate-400'>This is taking a while · </span>
            {reason.text}
          </>
        ) : (
          text
        )}
      </span>
      <span className='tabular-nums text-slate-400 dark:text-slate-500'>{time}</span>
      {extra}
    </div>
  )
}
