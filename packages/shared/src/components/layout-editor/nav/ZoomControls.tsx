import { Maximize2, Minus, Plus } from 'lucide-react'
import { createPortal } from 'react-dom'
import { cn } from '../../../lib/utils'
import { useBarMenu } from '../toolbar-kit'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './view-prefs'

// Canvas zoom (#3188): a slider finer than the compact toggle, with Fit to
// screen. A row in the Tools menu, plus a small chip on the canvas while the
// zoom is not 100% (so nobody forgets they zoomed). Editor-only, like
// compact; the record page is unchanged. Remembered per person (view-prefs).

export interface ZoomControl {
  /** The chosen zoom (1 = 100%). */
  value: number
  onChange: (z: number) => void
  /** Fit the canvas width to the pane. */
  onFit: () => void
}

const pct = (z: number) => `${Math.round(z * 100)}%`

const stepBtn =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
const textBtn =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[12px] font-medium text-slate-700 transition-colors hover:bg-muted dark:text-foreground'

function Steppers({ zoom }: { zoom: ZoomControl }) {
  return (
    <>
      <button
        type='button'
        aria-label='Zoom out'
        data-tip='Zoom out'
        data-zoom-out=''
        disabled={zoom.value <= ZOOM_MIN}
        onClick={() => zoom.onChange(zoom.value - ZOOM_STEP * 2)}
        className={stepBtn}
      >
        <Minus className='h-3.5 w-3.5' />
      </button>
      <button
        type='button'
        aria-label='Zoom in'
        data-tip='Zoom in'
        data-zoom-in=''
        disabled={zoom.value >= ZOOM_MAX}
        onClick={() => zoom.onChange(zoom.value + ZOOM_STEP * 2)}
        className={stepBtn}
      >
        <Plus className='h-3.5 w-3.5' />
      </button>
    </>
  )
}

/** The Tools menu's zoom row: − slider + · percentage · Fit · 100%. */
export function ZoomRow({ zoom }: { zoom: ZoomControl }) {
  const menu = useBarMenu()
  const body = (
    <div
      data-editor-zoom=''
      className='flex shrink-0 flex-col gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-slate-700 dark:text-foreground'
    >
      <div className='flex items-center justify-between gap-2'>
        <span className='font-medium text-slate-900 dark:text-foreground'>Zoom</span>
        <span
          data-zoom-value=''
          className='tabular-nums text-[12px] text-slate-500 dark:text-muted-foreground'
        >
          {pct(zoom.value)}
        </span>
      </div>
      <div className='flex items-center gap-1'>
        <Steppers zoom={zoom} />
        <input
          type='range'
          aria-label='Canvas zoom'
          aria-valuetext={pct(zoom.value)}
          data-zoom-slider=''
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={zoom.value}
          onChange={(e) => zoom.onChange(Number(e.target.value))}
          className='h-1.5 min-w-0 flex-1 cursor-pointer accent-nvr-cyan'
        />
      </div>
      <div className='flex items-center gap-1'>
        <button
          type='button'
          data-zoom-fit=''
          data-tip='Fit the form’s width to the canvas'
          onClick={zoom.onFit}
          className={textBtn}
        >
          <Maximize2 className='h-3 w-3' />
          Fit to screen
        </button>
        <button
          type='button'
          data-zoom-reset=''
          disabled={zoom.value === 1}
          onClick={() => zoom.onChange(1)}
          className={cn(textBtn, 'disabled:pointer-events-none disabled:opacity-40')}
        >
          100%
        </button>
      </div>
    </div>
  )
  if (!menu) return body
  if (!menu.open || !menu.list) return null
  return createPortal(body, menu.list)
}

/** On the canvas while zoomed: the percentage, − +, Fit, and back to 100%. */
export function ZoomChip({ zoom }: { zoom: ZoomControl }) {
  if (zoom.value === 1) return null
  return (
    <fieldset
      data-zoom-chip=''
      aria-label='Canvas zoom'
      // Sticky at the pane's bottom right; the negative margin keeps it from taking height.
      className='sticky bottom-3 z-30 -mt-10 mb-3 mr-3 flex h-7 min-w-0 items-center gap-0.5 self-end rounded-md border border-slate-200 bg-white px-1 shadow-sm dark:border-border dark:bg-card'
    >
      <Steppers zoom={zoom} />
      <span className='min-w-[3ch] px-1 text-center text-[12px] tabular-nums text-slate-700 dark:text-foreground'>
        {pct(zoom.value)}
      </span>
      <button
        type='button'
        aria-label='Fit to screen'
        data-tip='Fit the form’s width to the canvas'
        onClick={zoom.onFit}
        className={stepBtn}
      >
        <Maximize2 className='h-3 w-3' />
      </button>
      <button
        type='button'
        data-zoom-chip-reset=''
        data-tip='Back to 100%'
        onClick={() => zoom.onChange(1)}
        className={textBtn}
      >
        100%
      </button>
    </fieldset>
  )
}
