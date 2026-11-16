import { QueryClientContext } from '@tanstack/react-query'
import { Check, RotateCw } from 'lucide-react'
import { useContext, useEffect } from 'react'
import { useLivePreference } from '../lib/live-preference'
import {
  refreshScreenData,
  registerPageRefreshButton,
  screenRefreshClient,
  setScreenRefreshClient,
  usePageRefreshButtonShown,
  useScreenRefreshState
} from '../lib/screen-refresh'
import { cn } from '../lib/utils'
import { LiveOffNote } from './LiveOffNote'

/**
 * The small ↻ that refreshes this screen's data in place (realtime idea 12) — never the page.
 * Spins while the reads run, then shows a quiet ✓ for a moment. No toast: a read that failed
 * shows its own error where it renders, and the button keeps a small amber dot with a tip.
 *
 * `variant`:
 * - `header` (default): beside a page or record header's actions, a 36 px bordered button
 *   matching the toolbar boxes around it (44 px hit area).
 * - `rail`: the admin sidebar's always-dark footer strip.
 * - `bar`: a portal top bar (inherits the bar's text colour).
 *
 * One ↻ per screen: a `header` button (a page's own) registers while mounted, and the app-wide
 * `rail` / `bar` button renders nothing meanwhile.
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
  const pageOwn = variant === 'header'
  useEffect(() => (pageOwn ? registerPageRefreshButton() : undefined), [pageOwn])
  const pageHasOne = usePageRefreshButtonShown()
  const { phase, failed = 0 } = useScreenRefreshState()
  const running = phase === 'running'
  // Live updates Off (Profile → Display): the ↻ is how this person sees others' changes, so a
  // small note says so beside it (a corner dot on the narrow rail).
  const { off: liveOff } = useLivePreference()
  const label =
    liveOff && phase !== 'running' && phase !== 'partial'
      ? 'Live updates are off. Refresh this page’s data (keeps your edits and place)'
      : phase === 'running'
        ? 'Refreshing this page’s data…'
        : phase === 'partial'
          ? `${failed > 1 ? `${failed} parts` : 'One part'} of this page did not refresh — ${failed > 1 ? 'each shows' : 'it shows'} its own error. Refresh again`
          : 'Refresh this page’s data (keeps your edits and place)'
  if (!pageOwn && pageHasOne) return null
  const button = (
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
        // A toolbar control like its bordered neighbours (a bare glyph read as stray), with an
        // invisible 44 px hit area for touch.
        variant === 'header' &&
          "h-9 w-9 border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-800 after:absolute after:-inset-1 after:content-[''] dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted dark:hover:text-foreground",
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
      {variant === 'rail' && <LiveOffNote variant='dot' />}
    </button>
  )
  if (!liveOff || variant === 'rail') return button
  return (
    <span className='inline-flex items-center gap-1.5'>
      <LiveOffNote variant={variant === 'bar' ? 'bar' : 'header'} />
      {button}
    </span>
  )
}
