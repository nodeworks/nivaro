import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type StripTab = {
  id: string
  label: ReactNode
  /** Tabs with the same group sit together; a thin rule separates groups. */
  group?: string
}

/**
 * One row of underline tabs that scrolls when it does not fit: the edges fade
 * while there is more to scroll to, and the active tab is kept in view (deep
 * links, keyboard, a narrow menu choosing it). Arrow keys, Home and End move
 * between tabs (roving tabindex); focus follows the selection once it lands,
 * so a host that navigates on select keeps keyboard focus on the strip.
 * `variant='sub'` is a quieter second-level strip (12px, on the slate-50 page
 * band) for a screen that has its own sections under a hub tab.
 */
export function ScrollTabStrip({
  tabs,
  active,
  onSelect,
  ariaLabel,
  tabDomId,
  panelId,
  variant = 'default',
  className
}: {
  tabs: StripTab[]
  active: string
  onSelect: (id: string) => void
  ariaLabel: string
  tabDomId: (id: string) => string
  panelId: string
  variant?: 'default' | 'sub'
  className?: string
}) {
  const sub = variant === 'sub'
  const scroller = useRef<HTMLDivElement>(null)
  const fromKeyboard = useRef(false)
  const [edges, setEdges] = useState({ left: false, right: false })

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () =>
      setEdges((prev) => {
        const left = el.scrollLeft > 1
        const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
        return prev.left === left && prev.right === right ? prev : { left, right }
      })
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [])

  // Keep the active tab visible, and move focus to it after a keyboard move.
  useEffect(() => {
    const el = scroller.current
    const tab = el?.querySelector<HTMLElement>(`#${tabDomId(active)}`)
    if (!el || !tab) return
    const pad = 32
    if (tab.offsetLeft - pad < el.scrollLeft) el.scrollLeft = tab.offsetLeft - pad
    else if (tab.offsetLeft + tab.offsetWidth + pad > el.scrollLeft + el.clientWidth)
      el.scrollLeft = tab.offsetLeft + tab.offsetWidth + pad - el.clientWidth
    if (fromKeyboard.current) {
      fromKeyboard.current = false
      tab.focus()
    }
  }, [active, tabDomId])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active)
    const next =
      e.key === 'ArrowRight'
        ? tabs[(i + 1) % tabs.length]
        : e.key === 'ArrowLeft'
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === 'Home'
            ? tabs[0]
            : e.key === 'End'
              ? tabs[tabs.length - 1]
              : null
    if (!next) return
    e.preventDefault()
    fromKeyboard.current = true
    onSelect(next.id)
  }

  return (
    <div className={cn('relative', className)}>
      <div
        ref={scroller}
        role='tablist'
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className='flex items-stretch gap-0.5 overflow-x-auto px-2.5 [scrollbar-width:none] sm:px-4 [&::-webkit-scrollbar]:hidden'
      >
        {tabs.map((t, i) => {
          const on = t.id === active
          const newGroup = i > 0 && t.group !== undefined && t.group !== tabs[i - 1].group
          return (
            <Fragment key={t.id}>
              {newGroup && (
                <span
                  aria-hidden
                  className='mx-1.5 my-2.5 w-px shrink-0 bg-slate-200 dark:bg-border'
                />
              )}
              <button
                id={tabDomId(t.id)}
                type='button'
                role='tab'
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={on ? 0 : -1}
                onClick={() => !on && onSelect(t.id)}
                className={cn(
                  'shrink-0 whitespace-nowrap border-b-2 px-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                  sub ? 'py-2 text-[12px]' : 'py-2.5 text-[12.5px]',
                  on
                    ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                    : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            </Fragment>
          )
        })}
      </div>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r to-transparent transition-opacity duration-150',
          sub ? 'from-slate-50 dark:from-background' : 'from-white dark:from-card',
          edges.left ? 'opacity-100' : 'opacity-0'
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l to-transparent transition-opacity duration-150',
          sub ? 'from-slate-50 dark:from-background' : 'from-white dark:from-card',
          edges.right ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  )
}
