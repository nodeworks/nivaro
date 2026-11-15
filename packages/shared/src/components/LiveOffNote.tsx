import { CirclePause } from 'lucide-react'
import { useLivePreference } from '../lib/live-preference'
import { cn } from '../lib/utils'

export const LIVE_OFF_TIP =
  'Live updates are off — others’ changes show when you press ↻ or open the page again. Change it in Profile → Display.'

/**
 * The quiet "Live updates off" note (realtime round 3, item 24). Shown only when the person set
 * Profile → Display → Live updates to Off, so a screen that does not move is never mistaken for
 * one with nothing new. `ScreenRefreshButton` renders it beside every ↻ (record headers, the
 * portal bar); a host may also place it itself.
 *
 * `variant`: `header` (a small outlined pill on a page header), `bar` (inherits a top bar's text
 * colour), `dot` (a corner mark for a narrow rail button — the caller positions it).
 */
export function LiveOffNote({
  variant = 'header',
  className
}: {
  variant?: 'header' | 'bar' | 'dot'
  className?: string
}) {
  const { off } = useLivePreference()
  if (!off) return null
  if (variant === 'dot')
    return (
      <span
        aria-hidden
        data-live-off-note='dot'
        className={cn(
          'absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-slate-400 ring-2 ring-[#0f172a]',
          className
        )}
      />
    )
  return (
    <span
      role='note'
      data-live-off-note={variant}
      data-tip={LIVE_OFF_TIP}
      aria-label={LIVE_OFF_TIP}
      className={cn(
        'inline-flex h-6 shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium leading-none',
        variant === 'header' &&
          'border-slate-200 bg-white text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground',
        variant === 'bar' && 'border-current opacity-70',
        className
      )}
    >
      <CirclePause aria-hidden className='h-3 w-3' />
      Live updates off
    </span>
  )
}
