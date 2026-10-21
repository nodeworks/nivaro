import {
  type KeyboardEvent,
  type PointerEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { cn } from '../../lib/utils'
import { useLayoutDesign } from './design-context'
import { DndStoreContext } from './dnd/node'
import { GRID_WIDTHS, WIDTH_LABELS } from './field-zones'

// Column grid guides (#2701): faint 12-column tracks on the canvas's field
// grids while something is dragged or a width is dragged, so widths line up
// across sections. And the width handle a selected field shows on its right
// edge: it snaps to the widths the form's grid takes (Full, ½, ⅓, ¼).

const noSubscribe = () => () => {}

/** Are the guides on (inside a LayoutDndProvider on the canvas)? */
export function useGridGuides(): boolean {
  const store = useContext(DndStoreContext)
  return useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => !!store?.guidesOn(),
    () => false
  )
}

/**
 * The guides for one 12-column grid: render as the grid's FIRST child (the
 * grid must be `relative`), with the grid's own column gap. Nothing outside
 * the canvas or while nothing moves.
 */
export function GridGuides({ gapClass = 'gap-x-4' }: { gapClass?: string }) {
  const design = useLayoutDesign()
  const on = useGridGuides()
  if (!design || !on) return null
  return (
    <div
      aria-hidden
      data-design-grid-guides=''
      className={cn('pointer-events-none absolute inset-0 grid grid-cols-12', gapClass)}
    >
      {Array.from({ length: 12 }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: twelve fixed tracks
          key={i}
          className='rounded-sm bg-nvr-cyan/[0.05] ring-1 ring-inset ring-nvr-cyan/10 dark:bg-nvr-cyan/[0.06] dark:ring-nvr-cyan/15'
        />
      ))}
    </div>
  )
}

/** The grid width (one of 12/6/4/3) closest to `px` measured from the cell's left edge. */
export function snapSpan(px: number, gridWidth: number, gap: number): number {
  const col = (gridWidth - 11 * gap) / 12
  if (!(col > 0)) return 12
  const tracks = (px + gap) / (col + gap)
  let best = 12
  for (const w of GRID_WIDTHS) if (Math.abs(w - tracks) < Math.abs(best - tracks)) best = w
  return best
}

const SPANS: number[] = [...GRID_WIDTHS].sort((a, b) => a - b)
const spanOf = (el: HTMLElement) => {
  const m = /span\s+(\d+)/.exec(el.style.gridColumn)
  return m ? Number(m[1]) : 12
}
const twelveTracks = (grid: HTMLElement | null) =>
  !!grid &&
  getComputedStyle(grid).display === 'grid' &&
  getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length === 12

/**
 * The width handle of a selected field (#2701). Only shows when the field is
 * a cell of a 12-column grid (not inside a row of fields side by side).
 * Dragging writes the cell's width straight to the DOM; letting go applies
 * one change (one undo step). Escape cancels; ← → step through the widths.
 */
export function ResizeHandle({ onCommit }: { onCommit: (span: number) => void }) {
  const store = useContext(DndStoreContext)
  const ref = useRef<HTMLSpanElement>(null)
  const drag = useRef<{
    cell: HTMLElement
    left: number
    width: number
    gap: number
    start: number
    span: number
    original: string
  } | null>(null)
  const [usable, setUsable] = useState(false)
  const [live, setLive] = useState<number | null>(null)
  const cellOf = () => (ref.current?.closest('[data-design-target]') as HTMLElement | null) ?? null

  // biome-ignore lint/correctness/useExhaustiveDependencies: measured once, on mount
  useLayoutEffect(() => {
    setUsable(twelveTracks(cellOf()?.parentElement ?? null))
  }, [])

  const end = (commit: boolean) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    d.cell.style.gridColumn = d.original
    store?.setResizing(false)
    setLive(null)
    if (commit && d.span !== d.start) onCommit(d.span)
  }
  // Escape while dragging puts the width back.
  useEffect(() => {
    if (live === null) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      end(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  // Unmounted mid-drag (the selection moved): the cell gets its width back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount only
  useEffect(() => () => end(false), [])

  // Rendered (hidden) before it knows its grid: the ref is how it finds the cell.
  const cell = cellOf()
  const current = cell ? spanOf(cell) : 12

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    const c = cellOf()
    const grid = c?.parentElement
    if (!c || !grid || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const cs = getComputedStyle(grid)
    const start = spanOf(c)
    drag.current = {
      cell: c,
      left: c.getBoundingClientRect().left,
      width: grid.getBoundingClientRect().width,
      gap: Number.parseFloat(cs.columnGap) || 0,
      start,
      span: start,
      original: c.style.gridColumn
    }
    store?.setResizing(true)
    setLive(start)
  }
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current
    if (!d) return
    const span = snapSpan(e.clientX - d.left, d.width, d.gap)
    if (span === d.span) return
    d.span = span
    d.cell.style.gridColumn = `span ${span}`
    setLive(span)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    const i = SPANS.indexOf(current)
    const next =
      SPANS[Math.max(0, Math.min(SPANS.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]
    if (next !== undefined && next !== current) onCommit(next)
  }
  const shown = live ?? current
  return (
    <>
      <span
        ref={ref}
        role='slider'
        tabIndex={0}
        aria-label='Width'
        aria-valuemin={3}
        aria-valuemax={12}
        aria-valuenow={shown}
        aria-valuetext={WIDTH_LABELS[shown] ?? `${shown} of 12 columns`}
        data-design-resize=''
        data-design-pass=''
        data-tip={live === null ? 'Drag to change the width' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => end(true)}
        onPointerCancel={() => end(false)}
        onLostPointerCapture={() => end(true)}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'absolute -right-[7px] top-1/2 z-20 flex h-7 w-3 -translate-y-1/2 cursor-col-resize items-center justify-center gap-[2px] rounded-sm bg-white ring-1 ring-nvr-cyan transition-colors hover:bg-nvr-cyan/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan dark:bg-card motion-reduce:transition-none',
          live !== null && 'bg-nvr-cyan/10',
          !usable && 'hidden'
        )}
      >
        <span className='h-3 w-px bg-nvr-cyan' />
        <span className='h-3 w-px bg-nvr-cyan' />
      </span>
      {live !== null && (
        <span
          aria-hidden
          data-design-resize-chip=''
          className='pointer-events-none absolute -top-2.5 right-3 z-20 rounded bg-nvr-cyan px-1.5 text-[11px] font-medium leading-5 text-white'
        >
          {WIDTH_LABELS[live] ?? live}
        </span>
      )}
    </>
  )
}
