import {
  type ComponentType,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { flushSync } from 'react-dom'
import { byOrder, FeatureBoundary, type Registered } from './registry'

/**
 * Page-level panels (in-flight requests, compare views…) below the live events / hot entities
 * row. The block is not rendered when none is registered. Use the same card frame as the ticker:
 * `rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]`.
 *
 * From 1100px the panels pack as a masonry: each run of half-width panels splits into two
 * columns that end as level as possible (order kept inside each column), and a `wide` panel spans
 * both and starts below everything before it. A plain two-column grid sized every row to its
 * tallest panel and left holes beside the short ones. A panel keeps its column while its content changes (live figures never make
 * panels hop); the packing is redone when a panel appears or disappears, or when redoing it
 * would save REPACK_SAVES_PX of height. Narrower screens (and jsdom) get one plain column.
 */
export interface PagePanel extends Registered {
  Component: ComponentType
  /** Spans both columns (tables, tabbed panels) — packed as a full-width break. */
  wide?: boolean
}

export const pagePanels: PagePanel[] = []

const TWO_COLUMNS = '(min-width: 1100px)'
/** gap-3.5 */
const GAP = 14
const REPACK_SAVES_PX = 40

type Col = 0 | 1
interface Slot {
  start: number
  span: number
  col: Col | 'both'
}
interface Packed {
  slots: Record<string, Slot>
  cols: Record<string, Col>
  height: number
}

/** Brute-force search past this many panels in one run falls back to shortest-column-first. */
const EXACT_SPLIT_MAX = 12

/**
 * Columns for one run of half panels (between wide ones) that end the run as level as possible.
 * Order is kept inside each column and the first panel always starts on the left.
 */
function splitRun(spans: number[]): Col[] {
  const n = spans.length
  if (n > EXACT_SPLIT_MAX) {
    const tops = [0, 0]
    return spans.map((s) => {
      const c: Col = tops[0] <= tops[1] ? 0 : 1
      tops[c] += s
      return c
    })
  }
  let best = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 1 << Math.max(0, n - 1); mask++) {
    let l = spans[0] ?? 0
    let r = 0
    for (let i = 1; i < n; i++) {
      if ((mask >> (i - 1)) & 1) r += spans[i]
      else l += spans[i]
    }
    const cost = Math.max(l, r)
    if (cost < bestCost) {
      bestCost = cost
      best = mask
    }
  }
  return spans.map((_, i) => (i > 0 && (best >> (i - 1)) & 1 ? 1 : 0))
}

/** Places visible panels in order; `keep` pins half panels to the column they had. */
function pack(
  items: { id: string; wide: boolean; h: number }[],
  keep: Record<string, Col> | null
): Packed {
  const shown = items.filter((it) => it.h > 0)
  const cols: Record<string, Col> = {}
  let run: typeof shown = []
  const closeRun = () => {
    const split = keep ? null : splitRun(run.map((it) => it.h + GAP))
    run.forEach((it, i) => {
      cols[it.id] = keep?.[it.id] ?? split?.[i] ?? 0
    })
    run = []
  }
  for (const it of shown) {
    if (it.wide) closeRun()
    else run.push(it)
  }
  closeRun()

  const tops: [number, number] = [0, 0]
  const slots: Record<string, Slot> = {}
  for (const it of shown) {
    const span = it.h + GAP
    if (it.wide) {
      const start = Math.max(tops[0], tops[1])
      slots[it.id] = { start, span, col: 'both' }
      tops[0] = tops[1] = start + span
      continue
    }
    const col = cols[it.id]
    slots[it.id] = { start: tops[col], span, col }
    tops[col] += span
  }
  return { slots, cols, height: Math.max(0, Math.max(tops[0], tops[1]) - GAP) }
}

function useTwoColumns(): boolean {
  const supported =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    typeof ResizeObserver !== 'undefined'
  const [on, setOn] = useState(() => supported && window.matchMedia(TWO_COLUMNS).matches)
  useEffect(() => {
    if (!supported) return
    const mq = window.matchMedia(TWO_COLUMNS)
    const sync = () => setOn(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [supported])
  return on
}

export function PagePanels() {
  const twoCols = useTwoColumns()
  const panels = byOrder(pagePanels)
  const els = useRef(new Map<string, HTMLDivElement>())
  const kept = useRef<{ visible: string; cols: Record<string, Col> } | null>(null)
  const [packed, setPacked] = useState<Packed | null>(null)
  const panelsRef = useRef(panels)
  panelsRef.current = panels

  const measure = useCallback(() => {
    const items = panelsRef.current.map((p) => {
      const el = els.current.get(p.id)
      return { id: p.id, wide: !!p.wide, h: el ? Math.ceil(el.getBoundingClientRect().height) : 0 }
    })
    const visible = items
      .filter((i) => i.h > 0)
      .map((i) => i.id)
      .join('|')
    const fresh = pack(items, null)
    let next = fresh
    if (kept.current && kept.current.visible === visible) {
      const held = pack(items, kept.current.cols)
      if (held.height - fresh.height < REPACK_SAVES_PX) next = held
    }
    kept.current = { visible, cols: next.cols }
    return next
  }, [])

  const apply = useCallback(
    (sync: boolean) => {
      const next = measure()
      const same = (prev: Packed | null) =>
        !!prev && JSON.stringify(prev.slots) === JSON.stringify(next.slots)
      // inside a ResizeObserver callback: commit before paint so a grown panel never overlaps the next one
      if (sync) flushSync(() => setPacked((prev) => (same(prev) ? prev : next)))
      else setPacked((prev) => (same(prev) ? prev : next))
    },
    [measure]
  )

  useLayoutEffect(() => {
    if (!twoCols) {
      kept.current = null
      setPacked(null)
      return
    }
    apply(false)
    const ro = new ResizeObserver(() => apply(true))
    for (const el of els.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [twoCols, apply])

  if (panels.length === 0) return null

  if (!twoCols) {
    return (
      <div className='mt-3.5 flex flex-col gap-3.5' data-tm-page-panels=''>
        {panels.map((p) => (
          <div key={p.id} className='min-w-0 empty:hidden'>
            <FeatureBoundary id={p.id}>
              <p.Component />
            </FeatureBoundary>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      className='relative mt-3.5 grid grid-cols-2'
      // explicit height drops the trailing gap row the last panel's span carries
      style={{ gridAutoRows: '1px', columnGap: GAP, height: packed?.height ?? 0 }}
      data-tm-page-panels=''
    >
      {panels.map((p) => {
        const slot = packed?.slots[p.id]
        // not placed yet (or rendering nothing): measured off-grid at the width it will get
        const style: CSSProperties = slot
          ? {
              gridColumn: slot.col === 'both' ? '1 / -1' : slot.col + 1,
              gridRow: `${slot.start + 1} / span ${slot.span}`
            }
          : {
              position: 'absolute',
              top: 0,
              left: 0,
              width: p.wide ? '100%' : `calc(50% - ${GAP / 2}px)`,
              visibility: 'hidden'
            }
        return (
          <div
            key={p.id}
            ref={(el) => {
              if (el) els.current.set(p.id, el)
              else els.current.delete(p.id)
            }}
            className='min-w-0 self-start'
            style={style}
          >
            <FeatureBoundary id={p.id}>
              <p.Component />
            </FeatureBoundary>
          </div>
        )
      })}
    </div>
  )
}
