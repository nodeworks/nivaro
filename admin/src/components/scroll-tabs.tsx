import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * A row of tabs that scrolls sideways: when it overflows, ‹ and › buttons sit at
 * the ends (the native scrollbar is hidden, so nothing depends on a hover-only
 * overlay scrollbar), and the selected tab ([aria-selected=true]) is scrolled
 * into view whenever `activeKey` changes.
 */
export function ScrollTabs({
  children,
  activeKey,
  className,
  ...rest
}: {
  children: ReactNode
  activeKey?: string | null
  className?: string
  role?: string
  'aria-label'?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ left: false, right: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    setEdge({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    })
  }, [])
  // Every render: the tabs (children to observe) change with the search.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const c of Array.from(el.children)) ro.observe(c)
    return () => ro.disconnect()
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeKey is the trigger, read from the DOM
  useEffect(() => {
    const on = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    on?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [activeKey, measure])
  const nudge = (dir: 1 | -1) =>
    ref.current?.scrollBy({
      left: dir * Math.max(120, (ref.current.clientWidth ?? 0) * 0.6),
      behavior: 'smooth'
    })
  const arrow =
    'absolute top-0 bottom-0 z-[1] flex w-7 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
  return (
    <div className='relative min-w-0 flex-1'>
      <div
        ref={ref}
        onScroll={measure}
        className={cn(
          'flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          className
        )}
        {...rest}
      >
        {children}
      </div>
      {edge.left && (
        <button
          type='button'
          aria-label='Scroll tabs left'
          tabIndex={-1}
          onClick={() => nudge(-1)}
          className={cn(
            arrow,
            'left-0 bg-gradient-to-r from-background via-background to-transparent'
          )}
        >
          <ChevronLeft className='h-4 w-4' />
        </button>
      )}
      {edge.right && (
        <button
          type='button'
          aria-label='Scroll tabs right'
          tabIndex={-1}
          onClick={() => nudge(1)}
          className={cn(
            arrow,
            'right-0 bg-gradient-to-l from-background via-background to-transparent'
          )}
        >
          <ChevronRight className='h-4 w-4' />
        </button>
      )}
    </div>
  )
}
