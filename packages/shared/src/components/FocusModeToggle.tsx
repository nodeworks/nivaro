import { Focus, RefreshCw } from 'lucide-react'
import { applyHeldLiveNow, setFocusMode, useFocusMode } from '../lib/focus-mode'

const STEPS = [1, 3, 5, 10]

/**
 * Focus mode switch for live updates (#2386). On: list rows, counters and
 * pills collect what others change and apply it together every few minutes;
 * the "N updates" pill applies the backlog at once. Critical notifications
 * are not part of the live list feed and still arrive immediately.
 */
export function FocusModeToggle({ className }: { className?: string }) {
  const { on, minutes, held } = useFocusMode()
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ''}`} data-focus-mode={on}>
      <button
        type='button'
        onClick={() => setFocusMode(!on)}
        aria-pressed={on}
        data-tip={
          on
            ? `Focus mode is on — live updates are held and applied every ${minutes} min. Click to turn off.`
            : 'Focus mode — hold live updates and apply them every few minutes instead of as they happen'
        }
        className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
          on
            ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
            : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
        }`}
      >
        <Focus className='h-3.5 w-3.5' aria-hidden />
        <span className='sr-only'>Focus mode</span>
      </button>
      {on && (
        <button
          type='button'
          onClick={() =>
            setFocusMode(true, STEPS[(STEPS.indexOf(minutes) + 1) % STEPS.length] ?? STEPS[1])
          }
          data-tip='How often held updates are applied — click to change'
          className='h-6 rounded-full border border-slate-200 px-2 text-[11px] tabular-nums text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'
        >
          {minutes} min
        </button>
      )}
      {on && held > 0 && (
        <button
          type='button'
          onClick={applyHeldLiveNow}
          data-focus-pill
          className='nvr-pop-in inline-flex h-8 items-center gap-1 rounded-full border border-nvr-cyan/40 bg-nvr-cyan/[0.08] px-2.5 text-[12px] font-medium text-nvr-navy transition-colors hover:bg-nvr-cyan/20 dark:text-nvr-cyan'
        >
          <RefreshCw className='h-3 w-3' aria-hidden />
          {held} update{held === 1 ? '' : 's'}
        </button>
      )}
    </span>
  )
}
