import {
  type CSSProperties,
  cloneElement,
  type ReactElement,
  useCallback,
  useRef,
  useState
} from 'react'
import {
  type FoldedCell,
  HEADER_MORE_ROW_KEY,
  type HeaderWidthCache,
  headerChangedCells,
  headerFoldPlan,
  headerNeedsDense
} from '../../lib/header-strip'
import { useLayoutDesign } from '../layout-editor/design-context'
import { HeaderOverflowChip } from './HeaderOverflowChip'

/**
 * The record sub-header's measurer (lib/header-strip.ts): stacked (label over
 * value, 52px) while the tiles fit one row; dense (label · value inline,
 * 34px, wrapping) the moment they would not. Measured, not breakpointed: it
 * is the record's own tile count and values that decide. Dense and STILL
 * past two rows: tile indices folded behind "+N more" (empties first).
 * Attach `headerTilesRef` to the tile group (HEADER_TILES).
 */
export function useHeaderBand() {
  const [headerDense, setHeaderDense] = useState(false)
  const headerDenseRef = useRef(false)
  headerDenseRef.current = headerDense
  // Empty = all shown.
  const [headerFolded, setHeaderFolded] = useState<FoldedCell[]>([])
  const headerFoldedRef = useRef<FoldedCell[]>([])
  headerFoldedRef.current = headerFolded
  // Row per cell key when the fold packs rows first-fit; null = layout order.
  const [headerRows, setHeaderRows] = useState<Record<string, number> | null>(null)
  const headerRowsRef = useRef<Record<string, number> | null>(null)
  headerRowsRef.current = headerRows
  const headerWidthCache = useRef<HeaderWidthCache>(new Map())
  const headerStackedCache = useRef<HeaderWidthCache>(new Map())
  // Callback ref: the band mounts only once the layout has loaded, so a
  // mount-time effect would never see it.
  const headerTilesCleanup = useRef<(() => void) | null>(null)
  const headerTilesRef = useCallback((el: HTMLDivElement | null) => {
    headerTilesCleanup.current?.()
    headerTilesCleanup.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const measure = () => {
      frame = 0
      const dense = headerNeedsDense(el, headerDenseRef.current, headerStackedCache.current)
      if (dense !== headerDenseRef.current) setHeaderDense(dense)
      const plan = dense
        ? headerFoldPlan(el, headerDenseRef.current, headerWidthCache.current)
        : { folded: [], rows: null }
      const key = (list: FoldedCell[]) => list.map((c) => `${c.key}${c.empty ? 'e' : ''}`).join()
      if (key(plan.folded) !== key(headerFoldedRef.current)) setHeaderFolded(plan.folded)
      const rowsKey = (r: Record<string, number> | null) => (r ? JSON.stringify(r) : '')
      if (rowsKey(plan.rows) !== rowsKey(headerRowsRef.current)) setHeaderRows(plan.rows)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    const mo = new MutationObserver((records) => {
      for (const child of el.children) ro.observe(child)
      // Something changed inside a shown cell (a value loaded, a rollup
      // updated): THAT cell's remembered widths are stale. A folded cell
      // keeps its dense width — it cannot be re-measured, and clearing every
      // width let a folded five-figure widget be costed as one figure, so the
      // band unfolded, refolded, and looped until React threw. Its stacked
      // width (maybe a loading skeleton's) goes (headerChangedCells).
      const changed = headerChangedCells(el, records)
      for (const key of changed.shown) {
        headerWidthCache.current.delete(key)
        headerStackedCache.current.delete(key)
      }
      for (const key of changed.folded) headerStackedCache.current.delete(key)
      schedule()
    })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    // Synchronous first pass: runs in the commit phase, so the first painted
    // frame already has the right format (no stacked→dense jump on load).
    measure()
    headerTilesCleanup.current = () => {
      ro.disconnect()
      mo.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])
  return { headerDense, headerFolded, headerRows, headerTilesRef }
}

/**
 * The band's tiles in sort order, the folded ones (`folded`, from
 * `useHeaderBand`) behind the "+N more" chip. Each tile is one keyed element
 * that renders one cell (or nothing) and passes `data-header-cell` /
 * `data-header-folded` / `aria-hidden` to it (HEADER_TILE styles the folded
 * state). Folding goes by that cell key, so a tile that renders nothing
 * never shifts which tile folds.
 */
export function HeaderTiles({
  tiles,
  folded,
  rows = null
}: {
  tiles: ReactElement[]
  folded: FoldedCell[]
  /** `useHeaderBand`'s row per cell key: each shown tile gets that row as its
   *  flex `order`, so a narrower later tile fills an earlier row's room. */
  rows?: Record<string, number> | null
}) {
  const foldSet = new Set(folded.map((c) => String(c.key)))
  // A repeated key gets `key#position`, as headerCellKeys does: two tiles
  // never share a cell key.
  const seen = new Set<string>()
  const cellKeys = tiles.map((t, k) => {
    let key = String(t.key ?? k)
    if (seen.has(key)) key = `${key}#${k}`
    seen.add(key)
    return key
  })
  const foldedTiles = tiles.filter((_, k) => foldSet.has(cellKeys[k]))
  // Layout editor canvas: the chip's copies are the same design targets as
  // the folded tiles in the row; marked so only the row tile registers for
  // drag and drop.
  const design = useLayoutDesign()
  const chipTiles = design
    ? foldedTiles.map((t) =>
        cloneElement(t as ReactElement<Record<string, unknown>>, { 'data-design-copy': '' })
      )
    : foldedTiles
  return (
    <>
      {tiles.map((t, k) => {
        // Folded: marked on the tile itself, which keeps its own key — a
        // wrapper changed the key and remounted the tile on every fold, so a
        // widget refetched and re-rendered each time. Out of flow but in the
        // DOM, in place.
        if (foldSet.has(cellKeys[k]))
          return cloneElement(t as ReactElement<Record<string, unknown>>, {
            'data-header-cell': cellKeys[k],
            'data-header-folded': '',
            'aria-hidden': 'true'
          })
        const row = rows?.[cellKeys[k]]
        const own = (t.props as { style?: CSSProperties }).style
        return cloneElement(t as ReactElement<Record<string, unknown>>, {
          'data-header-cell': cellKeys[k],
          ...(row != null || own ? { style: row != null ? { ...own, order: row } : own } : {})
        })
      })}
      {foldedTiles.length > 0 && (
        <HeaderOverflowChip
          count={foldedTiles.length}
          allEmpty={folded.every((c) => c.empty)}
          labels={folded.map((c) => c.label)}
          order={rows?.[HEADER_MORE_ROW_KEY]}
        >
          {chipTiles}
        </HeaderOverflowChip>
      )}
    </>
  )
}
