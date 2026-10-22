import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { CHAOS_TABS, type ChaosTab } from './tabs'

export const tabDomId = (id: string) => `chaos-tab-${id}`
export const PANEL_ID = 'chaos-tabpanel'

/** The edge fade shows only on the side that still has tabs scrolled out of view. */
const FADE = 32
function fadeMask(left: boolean, right: boolean): string | undefined {
  if (!left && !right) return undefined
  const l = left ? `transparent 0, #000 ${FADE}px` : '#000 0'
  const r = right ? `#000 calc(100% - ${FADE}px), transparent 100%` : '#000 100%'
  return `linear-gradient(to right, ${l}, ${r})`
}

/**
 * The console's tab strip: one row, keyboard-walkable, scrolls when it overflows. The active tab
 * is scrolled into view (a deep link to Settings on a phone lands with Settings showing) and the
 * overflowing edge fades so it reads as "more this way".
 */
export function ChaosTabNav({
  active,
  onSelect
}: {
  active: ChaosTab
  onSelect: (id: string) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = () => {
      const left = el.scrollLeft > 1
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setEdges((p) => (p.left === left && p.right === right ? p : { left, right }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [])
  useEffect(() => {
    document
      .getElementById(tabDomId(active.id))
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [active.id])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = CHAOS_TABS.findIndex((t) => t.id === active.id)
    const n = CHAOS_TABS.length
    const next =
      e.key === 'ArrowRight'
        ? CHAOS_TABS[(i + 1) % n]
        : e.key === 'ArrowLeft'
          ? CHAOS_TABS[(i - 1 + n) % n]
          : e.key === 'Home'
            ? CHAOS_TABS[0]
            : e.key === 'End'
              ? CHAOS_TABS[n - 1]
              : null
    if (!next) return
    e.preventDefault()
    onSelect(next.id)
    requestAnimationFrame(() => document.getElementById(tabDomId(next.id))?.focus())
  }
  return (
    <div className='shrink-0 border-b border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div
        ref={listRef}
        role='tablist'
        aria-label='Chaos views'
        onKeyDown={onKeyDown}
        style={{
          maskImage: fadeMask(edges.left, edges.right),
          WebkitMaskImage: fadeMask(edges.left, edges.right)
        }}
        className='flex items-stretch gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden'
      >
        {CHAOS_TABS.map((t) => {
          const on = t.id === active.id
          return (
            <button
              key={t.id}
              id={tabDomId(t.id)}
              type='button'
              role='tab'
              aria-selected={on}
              aria-controls={PANEL_ID}
              tabIndex={on ? 0 : -1}
              onClick={() => onSelect(t.id)}
              className={cn(
                'shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-[12px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                on
                  ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                  : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {t.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
