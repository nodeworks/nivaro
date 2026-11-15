import { QueryClientContext } from '@tanstack/react-query'
import { Check, RotateCw } from 'lucide-react'
import { useContext, useEffect } from 'react'
import {
  refreshScreenData,
  screenRefreshClient,
  setScreenRefreshClient,
  useScreenRefreshState
} from '../lib/screen-refresh'
import { cn } from '../lib/utils'

/**
 * The small ↻ that refreshes this screen's data in place (realtime idea 12) — never the page.
 * Spins while the reads run, then shows a quiet ✓ for a moment. No toast: a read that failed
 * shows its own error where it renders, and the button keeps a small amber dot with a tip.
 *
 * `variant`:
 * - `header` (default): beside a page or record header's actions, a 32 px ghost button.
 * - `rail`: the admin sidebar's always-dark footer strip.
 * - `bar`: a portal top bar (inherits the bar's text colour).
 */
export function ScreenRefreshButton({
  variant = 'header',
  className
}: {
  variant?: 'header' | 'rail' | 'bar'
  className?: string
}) {
  const qc = useContext(QueryClientContext)
  // The first button mounted inside the app's QueryClientProvider binds it for the palette and
  // the idle resync too (the live bridge binds it as well; both point at the same client).
  useEffect(() => {
    if (qc && !screenRefreshClient()) setScreenRefreshClient(qc)
  }, [qc])
  const { phase } = useScreenRefreshState()
  const running = phase === 'running'
  const label =
    phase === 'running'
      ? 'Refreshing this page’s data…'
      : phase === 'partial'
        ? 'Some parts of this page did not refresh. Refresh again'
        : 'Refresh this page’s data (keeps your edits and place)'
  return (
    <button
      type='button'
      aria-label={label}
      data-tip={label}
      data-screen-refresh={phase}
      aria-busy={running || undefined}
      onClick={() => {
        if (!running) void refreshScreenData({ reason: 'button', qc: qc ?? undefined })
      }}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        variant === 'rail' &&
          'h-8 w-8 text-slate-400 hover:bg-white/[0.05] hover:text-white focus-visible:ring-offset-0',
        variant === 'header' &&
          'h-8 w-8 text-slate-400 hover:bg-muted hover:text-slate-700 dark:text-muted-foreground dark:hover:text-foreground',
        variant === 'bar' && 'h-8 w-8 opacity-80 hover:opacity-100',
        className
      )}
    >
      {phase === 'done' ? (
        <Check
          aria-hidden
          className={cn(
            'h-[15px] w-[15px] motion-safe:animate-in motion-safe:fade-in',
            variant === 'rail' ? 'text-emerald-400' : 'text-emerald-600 dark:text-emerald-400'
          )}
        />
      ) : (
        <RotateCw
          aria-hidden
          className={cn(
            'h-[15px] w-[15px]',
            running && 'animate-spin [animation-duration:900ms] motion-reduce:animate-none'
          )}
        />
      )}
      {phase === 'partial' && (
        <span
          aria-hidden
          className='absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400'
        />
      )}
    </button>
  )
}
