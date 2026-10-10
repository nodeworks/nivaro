/**
 * #1356 — the event rail under the scrubber: what the person's tab did on the
 * server side while the recording ran (requests coloured by status, client
 * errors, page changes, workflow transitions). Markers that land within a few
 * pixels of each other merge into one, so a busy recording stays clickable.
 * Click seeks to just before the moment; Ctrl/⌘-click opens the issue or
 * record the marker points at.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { groupTip, type RailKind, type RailMarker, thinMarkers } from './logic'

export const EventRail = memo(function EventRail({
  markers,
  total,
  truncated,
  onSeek
}: {
  markers: RailMarker[]
  total: number
  truncated: RailKind[]
  onSeek: (ms: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth || 600)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const groups = useMemo(() => thinMarkers(markers, total, width), [markers, total, width])
  if (markers.length === 0) return null
  return (
    <div
      ref={ref}
      className='relative mt-0.5 h-2'
      data-replay-rail=''
      data-tip={
        truncated.length > 0
          ? `Busy recording — the rail shows the first of each: ${truncated.join(', ')}`
          : undefined
      }
    >
      {groups.map((g) => {
        const href = g.markers.length === 1 ? g.markers[0].href : undefined
        return (
          <button
            key={`${g.offset}:${g.markers.length}`}
            type='button'
            onClick={(e) => {
              if (href && (e.metaKey || e.ctrlKey)) {
                window.open(href, '_blank', 'noopener')
                return
              }
              onSeek(Math.max(0, g.offset - 500))
            }}
            className={`absolute top-0 h-2 -translate-x-1/2 rounded-sm hover:scale-y-125 ${g.markers.length > 1 ? 'w-[5px] opacity-90' : 'w-[3px]'}`}
            style={{ left: `${g.left * 100}%`, background: g.color }}
            data-tip={groupTip(g)}
            aria-label={groupTip(g, 1)}
          />
        )
      })}
    </div>
  )
})
