/**
 * #2158 — memory the API process still holds right after garbage collection, with a trend line,
 * beside the event loop tile. A heap that keeps climbing between collections is a leak; the tile
 * turns amber and says how fast it grows and how long until the limit.
 */
import { useTrafficMap } from '../../context'
import { register } from '../../registry/registry'
import { stripTiles } from '../../registry/stripTiles'
import { Sparkline } from '../../Sparkline'
import { inMapOnly, isObj, StripCell, useTmRoute } from '../ops-common'
import { fmtMb, type HeapSummary, heapWarning } from './logic'

interface HealthWithHeap {
  heap?: HeapSummary
}

export function HeapTile() {
  const { win } = useTrafficMap()
  // the same key as the event loop tile's read, so the two share one request
  const { data } = useTmRoute<HealthWithHeap>(['health', win], `/health?window=${win}`, 15_000)
  const heap = isObj(data) && isObj(data.heap) ? (data.heap as unknown as HeapSummary) : null
  const warning = heapWarning(heap?.trend)
  const shown = heap?.after_gc_mb ?? heap?.used_mb ?? null
  return (
    <StripCell
      label='Memory after GC'
      value={shown != null ? String(Math.round(shown)) : '—'}
      unit='MB'
      tone={warning ? 'warn' : undefined}
      testId='tm-strip-heap'
    >
      <span
        className='truncate tabular-nums'
        title='Heap in use right after the last major garbage collection — what the process cannot give back'
      >
        {heap
          ? heap.after_gc_mb == null
            ? `in use ${fmtMb(heap.used_mb)} · no major GC yet`
            : `in use ${fmtMb(heap.used_mb)} · RSS ${fmtMb(heap.rss_mb)}${heap.limit_mb ? ` · limit ${fmtMb(heap.limit_mb)}` : ''}`
          : '—'}
      </span>
      <span className='flex min-w-0 items-center gap-2'>
        <span
          className={`truncate ${warning ? 'font-medium text-[var(--tm-update)]' : ''}`}
          data-testid='tm-strip-heap-trend'
        >
          {warning ??
            (heap && heap.trend.points >= 6
              ? 'Steady between collections'
              : 'Trend after a few collections')}
        </span>
        {heap && heap.series.length > 1 && (
          <Sparkline
            data={heap.series}
            color={warning ? 'var(--tm-update)' : 'var(--tm-accent)'}
            className='h-[14px] min-w-[36px] flex-1'
          />
        )}
      </span>
    </StripCell>
  )
}

register(stripTiles, { id: 'ops-heap', order: 10.5, Component: inMapOnly(HeapTile) })
