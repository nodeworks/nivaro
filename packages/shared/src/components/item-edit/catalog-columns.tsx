import { RotateCcw } from 'lucide-react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { cn } from '../../lib/utils'

/**
 * Resizable catalog columns (the inventory request catalog, its builders and
 * Summary): a person drags a header's right edge, double-clicks it to fit the
 * column to its widest cell, or resets every column of that table. Widths are
 * remembered per catalog and table in this browser (localStorage) — a layout
 * preference, never record data.
 */

export const COL_MIN = 48
export const COL_MAX = 800
const STORE_PREFIX = 'nvr:catalog-cols:v1:'

export type ColWidths = Record<string, number>

const clamp = (px: number, min = COL_MIN) => Math.round(Math.min(COL_MAX, Math.max(min, px)))

function readStored(key: string | null): ColWidths {
  if (!key) return {}
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: ColWidths = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = clamp(v)
    return out
  } catch {
    return {}
  }
}

function writeStored(key: string | null, widths: ColWidths) {
  if (!key) return
  try {
    if (Object.keys(widths).length === 0) localStorage.removeItem(STORE_PREFIX + key)
    else localStorage.setItem(STORE_PREFIX + key, JSON.stringify(widths))
  } catch {
    /* private mode / quota: the widths last for this page only */
  }
}

/** One table's column widths, remembered under `storageKey` (null = not remembered). */
export function useColumnWidths(storageKey: string | null) {
  const [widths, setWidths] = useState<ColWidths>(() => readStored(storageKey))
  const keyRef = useRef(storageKey)
  useEffect(() => {
    if (keyRef.current === storageKey) return
    keyRef.current = storageKey
    setWidths(readStored(storageKey))
  }, [storageKey])
  // Saved a beat after the last change: a drag moves the width on every pointer move.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(widths)
  latest.current = widths
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        writeStored(keyRef.current, latest.current)
      }
    },
    []
  )
  const setWidth = useCallback(
    (col: string, px: number, min?: number) =>
      setWidths((prev) => {
        const next = { ...prev, [col]: clamp(px, min) }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        // The table this change belongs to, even if the key moves before the save.
        const key = keyRef.current
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null
          writeStored(key, next)
        }, 250)
        return next
      }),
    []
  )
  const reset = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    writeStored(keyRef.current, {})
    setWidths({})
  }, [])
  /** A cell's class + style: the person's width when set, else the default classes. */
  const box = useCallback(
    (col: string, def: string, extra?: string) => {
      const w = widths[col]
      return {
        'data-cpf-col': col,
        // A set width still gives way when the row runs out of room (the card never
        // spills), down to the minimum.
        className: w != null ? cn('shrink grow-0', extra) : cn(def, extra),
        style:
          w != null
            ? ({ width: w, minWidth: Math.min(w, COL_MIN) } satisfies CSSProperties)
            : undefined
      }
    },
    [widths]
  )
  return { widths, setWidth, reset, box, customized: Object.keys(widths).length > 0 }
}

/** The width a column needs to show every cell whole (header included), within `root`. */
export function fitWidth(root: HTMLElement | null, col: string): number | null {
  if (!root) return null
  let max = 0
  for (const el of root.querySelectorAll<HTMLElement>(
    `[data-cpf-col="${col.replace(/["\\]/g, '\\$&')}"]`
  )) {
    // The text inside a truncating cell: its scroll width is the whole text.
    // A cell with several parts (a label + a "matched on" chip) needs them all, 6px apart.
    const parts = [...el.querySelectorAll<HTMLElement>('[data-cpf-fit]')]
    const need =
      parts.length > 0
        ? parts.reduce((sum, p) => sum + p.scrollWidth, 0) + (parts.length - 1) * 6
        : el.scrollWidth
    max = Math.max(max, need + (el.offsetWidth - el.clientWidth))
  }
  return max > 0 ? clamp(max + 6) : null
}

let measureCanvas: HTMLCanvasElement | null = null
/** Pixel width of the longest text in `font` (for dropdowns, whose options are not on screen). */
export function textWidth(texts: string[], font: string): number {
  measureCanvas ??= document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  return Math.max(0, ...texts.map((t) => ctx.measureText(t).width))
}

/**
 * The drag handle on a header cell's right edge (the cell must be `relative`).
 * Drag to resize, double-click to fit, or focus it and use ← / → (Shift for
 * bigger steps) and Enter to fit.
 */
export function ColResizeHandle({
  label,
  onResize,
  onFit,
  min = COL_MIN
}: {
  label: string
  /** The new width in px. */
  onResize: (px: number) => void
  onFit: () => void
  min?: number
}) {
  const [dragging, setDragging] = useState(false)
  // The column's width, for assistive tech; read when the handle is used.
  const [now, setNow] = useState(0)
  const start = useRef<{ x: number; w: number } | null>(null)
  const cellWidth = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width ?? 0

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    start.current = { x: e.clientX, w: cellWidth(e.currentTarget) }
    e.currentTarget.setPointerCapture(e.pointerId)
    // The cursor holds while the pointer runs ahead of the handle.
    document.documentElement.style.cursor = 'col-resize'
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (!start.current) return
    onResize(Math.max(min, start.current.w + e.clientX - start.current.x))
  }
  const end = (e: PointerEvent<HTMLSpanElement>) => {
    if (!start.current) return
    start.current = null
    document.documentElement.style.cursor = ''
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = e.shiftKey ? 32 : 8
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const w = cellWidth(e.currentTarget)
      const next = Math.max(min, w + (e.key === 'ArrowRight' ? step : -step))
      setNow(Math.round(next))
      onResize(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onFit()
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: an interactive splitter has no native element
    <span
      role='separator'
      aria-orientation='vertical'
      aria-label={`Resize ${label}`}
      aria-valuenow={now || undefined}
      aria-valuemin={min}
      aria-valuemax={COL_MAX}
      tabIndex={0}
      onFocus={(e) => setNow(Math.round(cellWidth(e.currentTarget)))}
      data-cpf-resize
      data-tip={`${label}: drag to resize · double-click to fit`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => {
        e.preventDefault()
        onFit()
      }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        // Centred in the 16px gap after the cell (rows and headers use gap-4), so the
        // rule sits 8px clear of any label, right-aligned ones (On-Hand, Price) too,
        // and the cell's own width is unchanged.
        'group/resize absolute -top-1 -right-[14px] -bottom-1 z-[1] flex w-3 cursor-col-resize touch-none select-none justify-center rounded-sm focus-visible:bg-nvr-cyan/10 focus-visible:outline-none'
      )}
    >
      <span
        className={cn(
          'my-1.5 w-px rounded-full transition-colors duration-150 group-focus-visible/resize:w-0.5',
          dragging
            ? 'bg-nvr-cyan'
            : // Always a faint rule so the column's edge is visible; stronger on hover.
              'bg-slate-300 group-hover/resize:bg-slate-400 group-focus-visible/resize:bg-nvr-cyan dark:bg-white/10 dark:group-hover/resize:bg-slate-500'
        )}
      />
    </span>
  )
}

/** "Reset column widths": shown only once a column in that table was resized. */
export function ResetColumnsButton({
  show,
  onReset,
  className
}: {
  show: boolean
  onReset: () => void
  className?: string
}) {
  if (!show) return null
  return (
    <button
      type='button'
      data-cpf-reset
      aria-label='Reset column widths'
      data-tip='Reset column widths'
      onClick={(e) => {
        e.stopPropagation()
        onReset()
      }}
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition-colors dark:text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-white/10 dark:hover:text-slate-200',
        className
      )}
    >
      <RotateCcw className='h-3 w-3' />
    </button>
  )
}
