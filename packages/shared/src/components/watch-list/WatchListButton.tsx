import { Binoculars } from 'lucide-react'
import { useWatchActions, useWatchUi, watchUi } from '../../lib/watch-list'

/**
 * The app-header icon for the watch list (rt5 #1). Wide screens: it opens a closed or
 * minimized dock and closes an open one. Narrow screens (and phones): it opens the dock as a
 * sheet. A small dot says a pinned record changed, or a mention waits, while the list was
 * out of sight. Renders nothing in an app without a dock.
 *
 * `variant`: 'rail' = the admin's dark icon rail; 'bar' = a light/dark top bar.
 */
export function WatchListButton({
  variant = 'bar',
  className = '',
  ringClass
}: {
  variant?: 'rail' | 'bar'
  className?: string
  /** The dot's ring = the bar's own background, so the dot reads as cut out of it. */
  ringClass?: string
}) {
  const ui = useWatchUi()
  const { prefs, setDock } = useWatchActions()
  if (!ui.mounted) return null
  const state = prefs.dock.state
  const docked = ui.wide && state === 'open'
  const attention = ui.changed + ui.unreadMentions
  // The dot only matters while the list is out of sight.
  const showDot = attention > 0 && !(docked || (!ui.wide && ui.sheet))
  const label = docked ? 'Close watch list' : 'Open watch list'
  const detail = showDot
    ? [
        ui.changed > 0 ? `${ui.changed} changed` : '',
        ui.unreadMentions > 0
          ? `${ui.unreadMentions} new mention${ui.unreadMentions === 1 ? '' : 's'}`
          : ''
      ]
        .filter(Boolean)
        .join(', ')
    : ''
  return (
    <button
      type='button'
      aria-label={detail ? `${label} (${detail})` : label}
      aria-pressed={docked || (!ui.wide && ui.sheet)}
      data-tip={detail ? `Watch list · ${detail}` : 'Watch list (Shift W)'}
      data-watch-list-button={showDot ? 'dot' : 'plain'}
      onClick={() => {
        if (!ui.wide) {
          if (ui.sheet) watchUi.closeSheet()
          else watchUi.openSheet()
          return
        }
        setDock({ state: docked ? 'closed' : 'open' })
      }}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 ${
        variant === 'rail'
          ? `h-8 w-8 ${docked ? 'bg-white/[0.08] text-white' : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'}`
          : `h-8 w-8 ${
              docked
                ? 'bg-slate-100 text-slate-800 dark:bg-white/[0.08] dark:text-slate-100'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-100'
            }`
      } ${className}`}
    >
      <Binoculars className='h-[15px] w-[15px]' />
      {showDot && (
        <span
          aria-hidden
          className={`absolute right-1 top-1 h-2 w-2 rounded-full bg-nvr-cyan ring-2 ${
            ringClass ??
            (variant === 'rail'
              ? 'ring-nvr-navy dark:ring-[#090c10]'
              : 'ring-white dark:ring-slate-900')
          }`}
        />
      )}
    </button>
  )
}
