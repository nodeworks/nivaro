import { Pause, Play, RefreshCw } from 'lucide-react'

/**
 * Small list-toolbar controls for live lists (realtime round 2): the Pause button (#11) and
 * the burst pill (#10). Same 32 px height and pill look as the "N updates · Refresh" pill and
 * the focus-mode switch they sit beside; light + dark.
 */

/** "Pause live updates" — paused, it shows how many changes wait and resumes on click. */
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
  if (!paused)
    return (
      <button
        type='button'
        onClick={onToggle}
        aria-pressed={false}
        data-live-pause
        data-tip='Pause live updates — changes wait here until you resume'
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 ${className ?? ''}`}
      >
        <Pause className='h-3.5 w-3.5' aria-hidden />
        <span className='sr-only'>Pause live updates</span>
      </button>
    )
  const waiting = held > 0 ? `${held.toLocaleString('en-US')} waiting` : 'nothing waiting yet'
  return (
    <button
      type='button'
      onClick={onToggle}
      aria-pressed
      data-live-pause='paused'
      data-tip={`Live updates paused — ${waiting}. Click to resume and apply them.`}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20 ${className ?? ''}`}
    >
      <Play className='h-3.5 w-3.5' aria-hidden />
      <span>Paused</span>
      {held > 0 && (
        <span
          data-live-pause-count
          className='min-w-[18px] rounded-full bg-amber-200/80 px-1.5 text-center text-[11px] font-semibold tabular-nums text-amber-900 dark:bg-amber-400/20 dark:text-amber-200'
        >
          {held > 999 ? '999+' : held}
        </span>
      )}
      <span className='sr-only'>— resume live updates</span>
    </button>
  )
}

/** One quiet pill for an import or bulk change: "Import added 500 records · Show". */
export function LiveBurstPill({ label, onShow }: { label: string; onShow: () => void }) {
  return (
    <button
      type='button'
      onClick={onShow}
      data-live-burst
      className='nvr-pop-in inline-flex h-8 max-w-[22rem] shrink-0 items-center gap-1 rounded-full border border-nvr-cyan/40 bg-nvr-cyan/[0.08] px-2.5 text-[12px] font-medium text-nvr-navy transition-colors hover:bg-nvr-cyan/20 dark:text-nvr-cyan'
    >
      <RefreshCw className='h-3 w-3 shrink-0' aria-hidden />
      <span className='truncate'>{label}</span>
      <span className='shrink-0'>· Show</span>
    </button>
  )
}
