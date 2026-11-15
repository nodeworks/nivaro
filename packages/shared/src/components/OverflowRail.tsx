import { MoreHorizontal } from 'lucide-react'
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** One action on a toolbar rail. Higher `priority` stays on the line longer. */
export interface RailItem {
  key: string
  priority: number
  node: ReactNode
}

/** Width assumed for an item that has never been on the line (it is measured once it is). */
const UNMEASURED_WIDTH = 96
/** The ⋯ button (h-8 w-8). */
const MORE_WIDTH = 32

/**
 * Which items fit on the line. Pure, so it can be tested without a browser.
 * Every element on the line (an item, the ⋯ button) costs its width plus one gap; `avail` is
 * the room for them including one trailing gap (the trail is already taken out). Items that
 * render nothing (width 0) never cost room or a gap.
 * Returns the keys that go into the ⋯ menu.
 */
export function railOverflow(
  items: Array<{ key: string; priority: number }>,
  widths: ReadonlyMap<string, number>,
  avail: number,
  gap: number
): Set<string> {
  const w = (k: string) => widths.get(k) ?? UNMEASURED_WIDTH
  const cost = (keys: string[]) => {
    const real = keys.filter((k) => w(k) > 0)
    return real.reduce((s, k) => s + w(k), 0) + gap * real.length
  }
  const all = items.map((i) => i.key)
  // Everything fits without a ⋯ button.
  if (cost(all) <= avail) return new Set()
  // Drop the lowest priority first (later items first among equals) until the rest + ⋯ fit.
  const byLow = [...items]
    .map((it, idx) => ({ ...it, idx }))
    .sort((a, b) => a.priority - b.priority || b.idx - a.idx)
  const out = new Set<string>()
  for (const it of byLow) {
    if (cost(all.filter((k) => !out.has(k))) + MORE_WIDTH + gap <= avail) break
    if (w(it.key) === 0) continue
    out.add(it.key)
  }
  return out
}

/**
 * A toolbar's action rail that never wraps: it sits at the end of a flex-wrap toolbar whose
 * first child is a flexible lead (the filter bar, at least `leadMinWidth` wide), keeps the
 * `trail` (the primary action) always visible at the right, and moves lower-priority items
 * into a ⋯ menu as the toolbar narrows. Widths are measured (ResizeObserver), never guessed
 * from breakpoints. When even the lead and the trail cannot share a line (phones), the rail
 * takes its own full line and still collapses into ⋯ instead of stacking.
 */
export function OverflowRail({
  items,
  trail,
  leadMinWidth = 304,
  moreLabel = 'More actions',
  className
}: {
  items: RailItem[]
  trail?: ReactNode
  /** Room the toolbar's lead needs beside the rail: a number (a flexible lead such as a
   *  filter bar, at least this wide) or 'siblings' (the natural width of everything before
   *  the rail, e.g. a scope switch and filter pills). */
  leadMinWidth?: number | 'siblings'
  moreLabel?: string
  className?: string
}) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const trailRef = useRef<HTMLDivElement | null>(null)
  const widths = useRef(new Map<string, number>())
  const nodes = useRef(new Map<string, HTMLElement>())
  const [overflow, setOverflow] = useState<Set<string>>(() => new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const recompute = useCallback(() => {
    const rail = railRef.current
    const bar = rail?.parentElement
    if (!rail || !bar) return
    for (const [k, el] of nodes.current) widths.current.set(k, el.offsetWidth)
    const cs = getComputedStyle(bar)
    const inner =
      bar.clientWidth -
      (Number.parseFloat(cs.paddingLeft) || 0) -
      (Number.parseFloat(cs.paddingRight) || 0)
    const barGap = Number.parseFloat(cs.columnGap) || 8
    const gap = Number.parseFloat(getComputedStyle(rail).columnGap) || 8
    const trailW = trailRef.current?.offsetWidth ?? 0
    let lead = 0
    if (leadMinWidth === 'siblings') {
      for (let el = rail.previousElementSibling; el; el = el.previousElementSibling) {
        const w = (el as HTMLElement).offsetWidth
        if (w > 0) lead += w + barGap
      }
      lead = Math.max(0, lead - barGap)
    } else lead = leadMinWidth
    // Beside the lead when the lead's minimum, the trail and a ⋯ fit; else a line of its own.
    const besideLead = inner - Math.min(lead, inner) - barGap
    const lineOfOwn = besideLead < trailW + MORE_WIDTH + gap
    const avail = (lineOfOwn ? inner : besideLead) - trailW
    const next = railOverflow(
      itemsRef.current.map(({ key, priority }) => ({ key, priority })),
      widths.current,
      // The trail's own leading gap is part of the items' gaps (one per real item / the ⋯).
      trailW > 0 ? avail : avail + gap,
      gap
    )
    setOverflow((prev) =>
      prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next
    )
  }, [leadMinWidth])

  // Re-measure on every render (an item's label can change: "Group" → "Group: State").
  useLayoutEffect(() => {
    recompute()
  })

  useLayoutEffect(() => {
    const rail = railRef.current
    const bar = rail?.parentElement
    if (!rail || !bar || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => recompute())
    ro.observe(bar)
    ro.observe(rail)
    return () => ro.disconnect()
  }, [recompute])

  const measure = (key: string) => (el: HTMLDivElement | null) => {
    if (el) nodes.current.set(key, el)
    else nodes.current.delete(key)
  }

  const inline = items.filter((i) => !overflow.has(i.key))
  const hidden = items.filter((i) => overflow.has(i.key))

  return (
    <div
      ref={railRef}
      data-overflow-rail=''
      className={cn('ml-auto flex shrink-0 flex-nowrap items-center gap-2', className)}
    >
      {inline.map((i) => (
        <div
          key={i.key}
          ref={measure(i.key)}
          data-rail-item={i.key}
          className='flex shrink-0 items-center gap-2 empty:hidden'
        >
          {i.node}
        </div>
      ))}
      {hidden.length > 0 && (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              aria-label={moreLabel}
              data-tip={moreLabel}
              data-rail-more={hidden.length}
              className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
            >
              <MoreHorizontal className='h-4 w-4' />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align='end'
            className='w-auto max-w-[min(22rem,calc(100vw-2rem))] overflow-visible p-2'
            data-rail-menu=''
          >
            {/* The same controls as on the line (their own menus open from here). */}
            <div className='flex flex-wrap items-center justify-end gap-2'>
              {hidden.map((i) => (
                <div key={i.key} data-rail-item={i.key} className='flex shrink-0 items-center gap-2 empty:hidden'>
                  {i.node}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
      {trail != null && (
        <div ref={trailRef} className='flex shrink-0 items-center gap-2 empty:hidden'>
          {trail}
        </div>
      )}
    </div>
  )
}
