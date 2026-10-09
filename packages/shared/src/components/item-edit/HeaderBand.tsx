import { type ReactElement, useCallback, useRef, useState } from 'react'
import { type FoldedCell, headerFoldedCells, headerNeedsDense } from '../../lib/header-strip'
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
  const headerWidthCache = useRef(new Map<number, number>())
  const headerStackedCache = useRef(new Map<number, number>())
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
      const folded = dense
        ? headerFoldedCells(el, headerDenseRef.current, headerWidthCache.current)
        : []
      const key = (list: FoldedCell[]) => list.map((c) => `${c.index}${c.empty ? 'e' : ''}`).join()
      if (key(folded) !== key(headerFoldedRef.current)) setHeaderFolded(folded)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    const mo = new MutationObserver((records) => {
      for (const child of el.children) ro.observe(child)
      // Something changed inside a cell (a value loaded, a rollup updated):
      // its remembered widths are stale. Changes at the group level itself
      // are our own folding; the "+N more" chip's count is not a cell.
      if (
        records.some((r) => {
          if (r.target === el) return false
          const node = r.target instanceof Element ? r.target : r.target.parentElement
          return !node?.closest('[data-header-more]')
        })
      ) {
        headerWidthCache.current.clear()
        headerStackedCache.current.clear()
      }
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
  return { headerDense, headerFolded, headerTilesRef }
}

/**
 * The band's tiles in sort order, the folded ones (`folded`, from
 * `useHeaderBand`) behind the "+N more" chip. Each tile is one keyed element
 * that renders one cell.
 */
export function HeaderTiles({ tiles, folded }: { tiles: ReactElement[]; folded: FoldedCell[] }) {
  const foldSet = new Set(folded.map((c) => c.index))
  const foldedTiles = tiles.filter((_, k) => foldSet.has(k))
  return (
    <>
      {tiles.map((t, k) =>
        foldSet.has(k) ? (
          // Folded: out of flow but in the DOM, in place, so the
          // measurer's cell index stays the tile index.
          <div
            key={`__folded_${k}`}
            data-header-folded
            aria-hidden='true'
            className='pointer-events-none invisible absolute'
          >
            {t}
          </div>
        ) : (
          t
        )
      )}
      {foldedTiles.length > 0 && (
        <HeaderOverflowChip
          count={foldedTiles.length}
          allEmpty={folded.every((c) => c.empty)}
          labels={folded.map((c) => c.label)}
        >
          {foldedTiles}
        </HeaderOverflowChip>
      )}
    </>
  )
}
