import { ChevronsLeft, ChevronsRight } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'

/** Always-visible horizontal scrollbar proxy for the table scroller —
 *  overlay-OS scrollbars hide, so wide tables get a persistent draggable
 *  track pinned above the pagination footer. */
export function HScrollProxy({ scrollerRef }: { scrollerRef: React.RefObject<HTMLDivElement | null> }) {
  const [st, setSt] = useState({ visible: false, thumbW: 0, thumbX: 0, atStart: true, atEnd: false })
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startScroll: number } | null>(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const update = () => {
      const trackW = trackRef.current?.clientWidth ?? el.clientWidth
      const max = el.scrollWidth - el.clientWidth
      const visible = max > 2
      const thumbW = visible ? Math.max(48, (el.clientWidth / el.scrollWidth) * trackW) : 0
      const thumbX = visible && max > 0 ? (el.scrollLeft / max) * (trackW - thumbW) : 0
      const atStart = el.scrollLeft <= 2
      const atEnd = el.scrollLeft >= max - 2
      setSt((prev) =>
        prev.visible === visible &&
        Math.abs(prev.thumbW - thumbW) < 1 &&
        Math.abs(prev.thumbX - thumbX) < 1 &&
        prev.atStart === atStart &&
        prev.atEnd === atEnd
          ? prev
          : { visible, thumbW, thumbX, atStart, atEnd }
      )
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    // overflow-x is hidden (single-bar guarantee), so horizontal trackpad /
    // shift-wheel panning is translated manually.
    const onWheel = (e: WheelEvent) => {
      const dx = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (dx !== 0) el.scrollLeft += dx
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // The table mounts AFTER this effect (skeleton renders first, columns
    // arrive async) — watch for it so the bar appears without a manual scroll.
    let observedTable: Element | null = null
    const attachTable = () => {
      const t = el.querySelector('table')
      if (t && t !== observedTable) {
        if (observedTable) ro.unobserve(observedTable)
        ro.observe(t)
        observedTable = t
      }
      update()
    }
    const mo = new MutationObserver(attachTable)
    mo.observe(el, { childList: true, subtree: true })
    attachTable()
    return () => {
      el.removeEventListener('scroll', update)
      el.removeEventListener('wheel', onWheel)
      ro.disconnect()
      mo.disconnect()
    }
  }, [scrollerRef])

  const onThumbDown = (e: React.PointerEvent) => {
    const el = scrollerRef.current
    if (!el) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startScroll: el.scrollLeft }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      const track = trackRef.current
      if (!d || !track) return
      const max = el.scrollWidth - el.clientWidth
      const trackRange = track.clientWidth - st.thumbW
      if (trackRange <= 0) return
      el.scrollLeft = d.startScroll + ((ev.clientX - d.startX) / trackRange) * max
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const onTrackDown = (e: React.PointerEvent) => {
    if (e.target !== trackRef.current) return
    const el = scrollerRef.current
    const track = trackRef.current
    if (!el || !track) return
    const rect = track.getBoundingClientRect()
    const ratio = (e.clientX - rect.left - st.thumbW / 2) / (track.clientWidth - st.thumbW)
    el.scrollLeft = Math.max(0, Math.min(1, ratio)) * (el.scrollWidth - el.clientWidth)
  }

  if (!st.visible) return null
  const jump = (to: 'start' | 'end') => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTo({ left: to === 'start' ? 0 : el.scrollWidth, behavior: 'smooth' })
  }
  return (
    <div className='flex shrink-0 items-stretch border-t border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60'>
      <button
        type='button'
        disabled={st.atStart}
        onClick={() => jump('start')}
        title='Scroll to first column'
        aria-label='Scroll to first column'
        className='flex w-7 items-center justify-center border-r border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-700'
      >
        <ChevronsLeft className='h-3.5 w-3.5' />
      </button>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: scrollbar proxy */}
      <div
        ref={trackRef}
        onPointerDown={onTrackDown}
        className='relative h-4 min-w-0 flex-1 cursor-pointer'
        aria-hidden
      >
        <div
          onPointerDown={onThumbDown}
          style={{ width: `${st.thumbW}px`, transform: `translateX(${st.thumbX}px)` }}
          className='absolute top-1/2 h-2 -translate-y-1/2 cursor-grab rounded-full bg-slate-400 transition-colors hover:bg-slate-500 active:cursor-grabbing dark:bg-slate-500 dark:hover:bg-slate-400'
        />
      </div>
      <button
        type='button'
        disabled={st.atEnd}
        onClick={() => jump('end')}
        title='Scroll to last column'
        aria-label='Scroll to last column'
        className='flex w-7 items-center justify-center border-l border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-700'
      >
        <ChevronsRight className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
