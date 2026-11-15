import { ChevronRight, CirclePause, CirclePlay, RefreshCw } from 'lucide-react'

/**
 * Small controls for live lists (realtime round 2): the Pause button (#11) and the burst
 * pill (#10). Neither may move the toolbar when live state changes: the pause button keeps
 * ONE width paused or not, and the burst pill floats over the list (the host gives it a
 * positioned container) instead of entering the toolbar. Light + dark.
 */

/** "Pause live" / "Paused 7" — one fixed width, so pausing never reflows the toolbar. */
export function LivePauseButton({
  paused,
  held,
  onToggle,
  className
}: {
  paused: boolean
  held: number
  onToggle: () => void
  className?: string
}) {
  const base =
    'inline-flex h-8 w-[7.5rem] shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
  if (!paused)
    return (
      <button
        type='button'
        onClick={onToggle}
        aria-pressed={false}
        data-live-pause
        data-tip='Live updates are on. Pause them to work through this list without it changing; changes wait until you resume.'
        className={`${base} border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100 ${className ?? ''}`}
      >
        <CirclePause className='h-3.5 w-3.5 shrink-0' aria-hidden />
        <span>Pause live</span>
      </button>
    )
  const n = held.toLocaleString('en-US')
  const tip =
    held > 0
      ? `Live updates are paused. ${n} ${held === 1 ? 'change is' : 'changes are'} waiting — click to apply ${held === 1 ? 'it' : 'them'} and resume.`
      : 'Live updates are paused. Nothing is waiting yet — click to resume.'
  return (
    <button
      type='button'
      onClick={onToggle}
      aria-pressed
      aria-label={held > 0 ? `Resume live updates, ${n} waiting` : 'Resume live updates'}
      data-live-pause='paused'
      data-tip={tip}
      className={`${base} border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20 ${className ?? ''}`}
    >
      <CirclePlay className='h-3.5 w-3.5 shrink-0' aria-hidden />
      <span>Paused</span>
      {held > 0 && (
        <span
          data-live-pause-count
          className='min-w-[18px] rounded-full bg-amber-200/80 px-1.5 text-center text-[11px] font-semibold tabular-nums text-amber-900 dark:bg-amber-400/20 dark:text-amber-200'
        >
          {held > 999 ? '999+' : held}
        </span>
      )}
    </button>
  )
}

/**
 * One quiet pill for an import or bulk change: "Import added 500 records  Show ›". It floats
 * centred over the list (the host's list container is `relative`), so it never pushes the
 * toolbar; `className` positions it vertically for the host.
 */
export function LiveBurstPill({
  label,
  onShow,
  className
}: {
  label: string
  onShow: () => void
  className?: string
}) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-[8] flex justify-center px-4 ${className ?? 'bottom-16'}`}
    >
      <button
        type='button'
        onClick={onShow}
        data-live-burst
        className='nvr-pop-in group pointer-events-auto inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-nvr-cyan/40 bg-white px-3 text-[12px] text-slate-700 shadow-[0_4px_14px_-4px_rgba(15,23,42,0.25)] transition-colors hover:border-nvr-cyan/70 hover:bg-[#f2fcff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:border-nvr-cyan/40 dark:bg-[#0f2530] dark:text-slate-200 dark:shadow-[0_4px_14px_-4px_rgba(0,0,0,0.6)] dark:hover:bg-[#123140]'
      >
        <RefreshCw className='h-3 w-3 shrink-0 text-[#007a99] dark:text-nvr-cyan' aria-hidden />
        <span className='min-w-[5rem] truncate'>{label}</span>
        <span className='ml-1 inline-flex shrink-0 items-center font-semibold text-[#007a99] underline-offset-2 group-hover:underline dark:text-nvr-cyan'>
          Show
          <ChevronRight className='h-3.5 w-3.5' aria-hidden />
        </span>
      </button>
    </div>
  )
}
