import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * The pager below `md`: one line — previous, "1–25 of 2,431", next. The full pager (First,
 * page n / m, Last, page size) wrapped to four lines on a phone and was cut off under the
 * table. Hosts render this with `md:hidden` beside their own pager (`hidden md:flex`).
 */
export function PhonePager({
  range,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  busy,
  className
}: {
  /** "1–25 of 2,431" — the host's own words (approximate totals keep their "about"). */
  range: ReactNode
  onPrev: () => void
  onNext: () => void
  prevDisabled: boolean
  nextDisabled: boolean
  /** Next is waiting on something (a count): spinner instead of the arrow. */
  busy?: boolean
  className?: string
}) {
  const btn =
    'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-800'
  return (
    <div
      data-phone-pager=''
      className={cn('flex min-w-0 items-center justify-between gap-2 md:hidden', className)}
    >
      <button
        type='button'
        disabled={prevDisabled}
        onClick={onPrev}
        aria-label='Previous page'
        className={btn}
      >
        <ChevronLeft className='h-4 w-4' aria-hidden />
      </button>
      <p className='min-w-0 truncate whitespace-nowrap text-center text-[12.5px] tabular-nums text-slate-500 dark:text-slate-400'>
        {range}
      </p>
      <button
        type='button'
        disabled={nextDisabled}
        onClick={onNext}
        aria-label='Next page'
        aria-busy={busy || undefined}
        className={btn}
      >
        {busy ? (
          <Loader2 className='h-4 w-4 animate-spin' aria-hidden />
        ) : (
          <ChevronRight className='h-4 w-4' aria-hidden />
        )}
      </button>
    </div>
  )
}
