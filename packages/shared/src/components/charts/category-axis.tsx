import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

/**
 * The category axis of a HORIZONTAL bar chart (bars run left → right, one label per bar).
 *
 * Recharts' default tick wraps a label at the axis width, and a fixed 140 px axis cut
 * "Waiting on Level 4 Approval" into two clipped lines ("Waiting on Level 4 / Appr…",
 * Executive Dashboard, 2026-11-16). Here the label column is as wide as the longest label
 * (capped at 40% of the chart), every label is one line, and only a label that still does
 * not fit is cut with an ellipsis and carries its full text in an instant tooltip (data-tip).
 */

export const CATEGORY_TICK_FONT_PX = 10.5
/** Space recharts leaves between a tick's x and the axis line (tickSize 6 + tickMargin 2),
 *  plus 2 px so a label's first glyph never touches the chart's left edge. */
const TICK_GAP = 10
const CAP_SHARE = 0.4
const MIN_WIDTH = 40

type Measure = (text: string) => number

let canvasCtx: CanvasRenderingContext2D | null | undefined
/** Width of `text` at the tick font in px — canvas when there is one, else an estimate. */
export function measureTickText(text: string, fontPx = CATEGORY_TICK_FONT_PX): number {
  if (canvasCtx === undefined) {
    try {
      canvasCtx =
        typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
    } catch {
      canvasCtx = null
    }
  }
  if (canvasCtx) {
    const family =
      typeof getComputedStyle === 'function' && typeof document !== 'undefined'
        ? getComputedStyle(document.body).fontFamily || 'sans-serif'
        : 'sans-serif'
    canvasCtx.font = `${fontPx}px ${family}`
    const w = canvasCtx.measureText(text).width
    if (w > 0) return w
  }
  return text.length * fontPx * 0.56
}

/** The label column's width: the longest label plus the gap, never above 40% of the chart. */
export function categoryAxisWidth(longestPx: number, chartPx: number): number {
  const want = Math.ceil(longestPx + TICK_GAP)
  const cap = chartPx > 0 ? Math.floor(chartPx * CAP_SHARE) : 200
  return Math.max(MIN_WIDTH, Math.min(want, Math.max(MIN_WIDTH, cap)))
}

/** `text` cut (with …) to fit `maxPx`; `cut` says whether anything was dropped. */
export function fitLabel(
  text: string,
  maxPx: number,
  measure: Measure = (t) => measureTickText(t)
): { text: string; cut: boolean } {
  if (measure(text) <= maxPx) return { text, cut: false }
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= maxPx) lo = mid
    else hi = mid - 1
  }
  return { text: `${text.slice(0, lo).trimEnd()}…`, cut: true }
}

interface TickProps {
  x?: number | string
  y?: number | string
  payload?: { value?: unknown }
}

/**
 * Size and draw a horizontal chart's category axis. Put `ref` on the box the chart fills;
 * spread `yAxisProps` on the category `<YAxis>`.
 */
export function useCategoryAxis(labels: unknown[], format: (v: unknown) => string = String) {
  const ref = useRef<HTMLDivElement>(null)
  const [chartPx, setChartPx] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setChartPx(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setChartPx(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Measured again once web fonts arrive: a label measured in the fallback face came out
  // narrower than it draws in DM Sans and ran off the chart's left edge.
  const [fontsSeen, setFontsSeen] = useState(0)
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts) return
    let live = true
    const bump = () => live && setFontsSeen((n) => n + 1)
    void fonts.ready.then(bump)
    fonts.addEventListener?.('loadingdone', bump)
    return () => {
      live = false
      fonts.removeEventListener?.('loadingdone', bump)
    }
  }, [])
  const key = labels.map((l) => format(l)).join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the formatted labels; fontsSeen re-measures
  const longest = useMemo(
    () => Math.max(0, ...labels.map((l) => measureTickText(format(l)))),
    [key, fontsSeen]
  )
  const width = categoryAxisWidth(longest, chartPx)
  const room = width - TICK_GAP
  const tick = (p: TickProps) => {
    const full = format(p.payload?.value ?? '')
    const { text, cut } = fitLabel(full, room)
    return (
      <g transform={`translate(${p.x ?? 0},${p.y ?? 0})`} data-tip={cut ? full : undefined}>
        <text
          x={0}
          y={0}
          dy='0.35em'
          textAnchor='end'
          fontSize={CATEGORY_TICK_FONT_PX}
          fill='currentColor'
        >
          {text}
        </text>
      </g>
    )
  }
  return {
    ref,
    yAxisProps: { width, tick, interval: 0 as const, tickLine: false }
  }
}

/**
 * useCategoryAxis as a component, for a chart drawn after an early return (hooks can't be
 * called there). The box fills its parent; `children` gets the category YAxis props.
 */
export function CategoryAxisBox({
  labels,
  format,
  className,
  children
}: {
  labels: unknown[]
  format?: (v: unknown) => string
  className?: string
  children: (yAxisProps: ReturnType<typeof useCategoryAxis>['yAxisProps']) => ReactNode
}) {
  const axis = useCategoryAxis(labels, format)
  return (
    <div ref={axis.ref} className={className}>
      {children(axis.yAxisProps)}
    </div>
  )
}
