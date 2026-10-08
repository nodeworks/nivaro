import { type MutableRefObject, type RefObject, useEffect } from 'react'

/** The playhead line. While the video plays it keeps itself in view (not
 *  while a bar or the ruler is being dragged). */
export function Playhead({
  srcMs,
  pps,
  scroller,
  dragging
}: {
  srcMs: number
  pps: number
  scroller: RefObject<HTMLDivElement | null>
  dragging: MutableRefObject<boolean>
}) {
  const x = (srcMs / 1000) * pps
  useEffect(() => {
    const el = scroller.current
    if (!el || dragging.current) return
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 16)
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.1)
  }, [x, scroller, dragging])
  return (
    <div
      className='pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 -translate-x-1/2 bg-rose-600 dark:bg-rose-400'
      style={{ left: x }}
      data-hv-playhead
    >
      <span className='absolute -top-px left-1/2 h-2 w-2.5 -translate-x-1/2 rounded-b-[2px] bg-rose-600 dark:bg-rose-400' />
    </div>
  )
}
