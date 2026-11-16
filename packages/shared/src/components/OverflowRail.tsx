import { Check, ChevronDown, MoreHorizontal } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { RailMenuContext, type RailMenuContextValue } from '../lib/rail-menu-context'
import { useBelowMd } from '../lib/use-below-md'
import { cn } from '../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** One action on a toolbar rail. Higher `priority` stays on the line longer. */
export interface RailItem {
  key: string
  priority: number
  node: ReactNode
  /** The words for an icon-only control in the ⋯ menu ("Copy link"). Without it the menu
   *  uses the control's aria-label / tip. Controls with visible text never need it. */
  label?: string
  /** 'filter': narrows the rows (Sent back, Changed by others…). In ⋯ the filters are grouped
   *  above a divider, the actions below. Default 'action'. */
  kind?: 'filter' | 'action'
  /** On / running (a filter applied, an export in progress): when folded into ⋯ the ⋯
   *  button carries a dot, so nothing switched on is out of sight unannounced. */
  active?: boolean
}

/** The ⋯ menu's sections: filters first, then actions, each in rail order. */
export function railMenuGroups<T extends { kind?: 'filter' | 'action' }>(
  hidden: T[]
): { filters: T[]; actions: T[] } {
  return {
    filters: hidden.filter((i) => i.kind === 'filter'),
    actions: hidden.filter((i) => i.kind !== 'filter')
  }
}

/** Text a person can see inside `el` (screen-reader-only and hidden text left out). */
function visibleText(el: Element): string {
  let out = ''
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      out += n.textContent ?? ''
      return
    }
    if (n.nodeType !== 1) return
    const e = n as Element
    if (e.classList.contains('sr-only') || e.hasAttribute('hidden')) return
    if (e.getAttribute('aria-hidden') === 'true') return
    for (const c of Array.from(e.childNodes)) walk(c)
  }
  walk(el)
  return out.trim()
}

const FOCUSABLE = 'button, a[href], [role="button"], input, select, textarea'

/**
 * Marks each ⋯ menu row's main control (`data-rail-primary`), the wrapper around it when it
 * has one (`data-rail-wrap`), and gives an icon-only control its words (`data-rail-label`,
 * drawn by CSS after the icon; its accessible name stays its aria-label). Exported for tests.
 */
export function markRailMenu(menu: HTMLElement, labels: ReadonlyMap<string, string>): void {
  for (const row of Array.from(menu.querySelectorAll<HTMLElement>('[data-rail-row]'))) {
    const primary = Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
      (el) => !el.closest('[hidden]')
    )
    if (!primary) continue
    if (!primary.hasAttribute('data-rail-primary')) primary.setAttribute('data-rail-primary', '')
    const wrap = primary.parentElement
    if (wrap && wrap !== row && wrap.parentElement === row) wrap.setAttribute('data-rail-wrap', '')
    const key = row.getAttribute('data-rail-item') ?? ''
    const label =
      visibleText(primary) === ''
        ? (labels.get(key) ??
          primary.getAttribute('aria-label') ??
          primary.getAttribute('data-tip') ??
          primary.getAttribute('title') ??
          '')
        : ''
    if (label) {
      if (primary.getAttribute('data-rail-label') !== label)
        primary.setAttribute('data-rail-label', label)
    } else if (primary.hasAttribute('data-rail-label')) primary.removeAttribute('data-rail-label')
  }
}

/** The menu's controls in order, for arrow keys (disabled ones skipped). */
function menuStops(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[data-rail-primary]')).filter(
    (el) => !(el as HTMLButtonElement).disabled
  )
}

/**
 * The ⋯ menu's look: every row's main control is a full-width, left-aligned row with its icon
 * and words; a pressed filter keeps its tint; extra controls in a row (a clear ×, a minutes
 * chip) stay at its end.
 */
/** Share of the first row below the fold the menu shows, so it reads as cut, not finished. */
const MENU_PEEK = 0.55

/**
 * When the menu is taller than the space it gets, end it part-way through a row
 * (MENU_PEEK of it) instead of wherever the space runs out: on a phone the cap often
 * fell on a row boundary, so the menu looked complete. Writes `--nvr-rail-menu-cut`,
 * which can only shorten Radix's available height (the class takes the min of both).
 */
export function fitMenuPeek(el: HTMLElement): void {
  const avail = Number.parseFloat(
    getComputedStyle(el).getPropertyValue('--radix-popover-content-available-height')
  )
  if (!Number.isFinite(avail) || avail <= 0 || el.scrollHeight <= avail + 1) {
    el.style.removeProperty('--nvr-rail-menu-cut')
    return
  }
  const box = el.getBoundingClientRect()
  const border = el.offsetHeight - el.clientHeight
  let cut = 0
  for (const row of el.querySelectorAll<HTMLElement>('[data-rail-row]')) {
    const r = row.getBoundingClientRect()
    if (r.height <= 0) continue
    const end = r.top - box.top + el.scrollTop + r.height * MENU_PEEK + border
    if (end > avail) break
    cut = end
  }
  if (cut > 0) el.style.setProperty('--nvr-rail-menu-cut', `${Math.floor(cut)}px`)
  else el.style.removeProperty('--nvr-rail-menu-cut')
}

const MENU_ROWS = cn(
  '[&_[data-rail-wrap]]:flex [&_[data-rail-wrap]]:w-full [&_[data-rail-wrap]]:max-w-none [&_[data-rail-wrap]]:items-center [&_[data-rail-wrap]]:gap-1',
  '[&_[data-rail-primary]]:flex [&_[data-rail-primary]]:h-9 [&_[data-rail-primary]]:w-full [&_[data-rail-primary]]:min-w-0 [&_[data-rail-primary]]:flex-1 [&_[data-rail-primary]]:items-center [&_[data-rail-primary]]:justify-start [&_[data-rail-primary]]:gap-2 [&_[data-rail-primary]]:whitespace-nowrap [&_[data-rail-primary]]:rounded-md [&_[data-rail-primary]]:!border-transparent [&_[data-rail-primary]]:px-2.5 [&_[data-rail-primary]]:text-left [&_[data-rail-primary]]:text-[12.5px] [&_[data-rail-primary]]:font-medium [&_[data-rail-primary]]:!shadow-none',
  // `!`: the hosts' dark sheet re-points bg-white / border-slate-200 with !important.
  '[&_[data-rail-primary]:not([aria-pressed=true]):not([aria-expanded=true])]:!bg-transparent [&_[data-rail-primary]:not([aria-pressed=true])]:!text-slate-700 dark:[&_[data-rail-primary]:not([aria-pressed=true])]:!text-slate-200',
  '[&_[data-rail-primary]:not([aria-pressed=true]):not(:disabled):hover]:!bg-slate-100 dark:[&_[data-rail-primary]:not([aria-pressed=true]):not(:disabled):hover]:!bg-muted [&_[data-rail-primary][aria-expanded=true]]:!bg-slate-100 dark:[&_[data-rail-primary][aria-expanded=true]]:!bg-muted',
  '[&_[data-rail-primary]:focus-visible]:outline-none [&_[data-rail-primary]:focus-visible]:ring-2 [&_[data-rail-primary]:focus-visible]:ring-inset [&_[data-rail-primary]:focus-visible]:ring-nvr-cyan/60',
  '[&_[data-rail-primary]_svg]:h-3.5 [&_[data-rail-primary]_svg]:w-3.5 [&_[data-rail-primary]_svg]:shrink-0 [&_[data-rail-primary]:not([aria-pressed=true])_svg]:text-slate-500 dark:[&_[data-rail-primary]:not([aria-pressed=true])_svg]:text-slate-400',
  '[&_[data-rail-label]]:after:content-[attr(data-rail-label)]',
  // A colour dot (8 px) leading a row takes an icon's 14 px, so every label starts in line.
  '[&_[data-rail-primary]>span:first-child:empty]:mx-[3px]',
  // A control with a wrapper (an active chip with its ×, Focus mode with its minutes): the
  // wrapper is the row, the control fills it.
  '[&_[data-rail-wrap]]:h-9 [&_[data-rail-wrap]]:rounded-md [&_[data-rail-wrap]]:pl-0 [&_[data-rail-wrap]_[data-rail-primary]]:h-full',
  // A toggle that is on says so with a check at the row's end, not only a tint.
  '[&_[data-rail-row]:has([data-rail-primary][aria-pressed=true])_[data-rail-check]]:block'
)

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
 * `lead` sits at the rail's left and never folds (e.g. who else is viewing the list): it is
 * part of the line like the trail, so its width is taken out before items are placed.
 */
export function OverflowRail({
  items,
  lead,
  trail,
  leadMinWidth = 304,
  moreLabel = 'More actions',
  className
}: {
  items: RailItem[]
  /** Pinned at the rail's left, never moved into ⋯. */
  lead?: ReactNode
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
  const pinRef = useRef<HTMLDivElement | null>(null)
  const widths = useRef(new Map<string, number>())
  const nodes = useRef(new Map<string, HTMLElement>())
  const [overflow, setOverflow] = useState<Set<string>>(() => new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  // On a line of its own (phones) the rail spans it: actions start at the left edge like the
  // rows below, the primary action keeps the right.
  const [ownLine, setOwnLine] = useState(false)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const compact = useBelowMd()
  // Popovers open from the menu right now (Group, Columns…). On a phone the menu steps aside
  // while one is open: there is no room beside it, and the two would sit on top of each other.
  const [nestedOpen, setNestedOpen] = useState(0)
  const nested = useCallback((d: 1 | -1) => setNestedOpen((n) => Math.max(0, n + d)), [])
  const railMenu = useMemo<RailMenuContextValue>(
    () => ({
      nested,
      compact,
      // Popovers from the menu stay inside the page's own area, clear of the app sidebar.
      boundary: () => railRef.current?.closest('main') ?? null
    }),
    [nested, compact]
  )
  const menuRef = useRef<HTMLDivElement | null>(null)
  // The menu mounts a render after it opens (Radix's portal): keeping the element in state
  // re-renders the rail then, so the effect below marks its rows and measures it.
  const [menuEl, setMenuEl] = useState<HTMLDivElement | null>(null)
  const setMenuNode = useCallback((el: HTMLDivElement | null) => {
    menuRef.current = el
    setMenuEl(el)
  }, [])
  // More rows below the menu's fold (a phone, a long menu): the menu ends part-way through
  // a row so that row peeks out, and a "More" tag sits at its foot. A menu that ended on a
  // whole row read as finished (design review round 4: Bulk select was never found).
  const [moreBelow, setMoreBelow] = useState(false)
  const checkMoreBelow = useCallback(() => {
    const el = menuRef.current
    if (el) fitMenuPeek(el)
    const next = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 4
    setMoreBelow((prev) => (prev === next ? prev : next))
  }, [])
  const labelsKey = items.map((i) => `${i.key}=${i.label ?? ''}`).join('\u0001')
  // biome-ignore lint/correctness/useExhaustiveDependencies: labelsKey stands for items' labels
  const labels = useMemo(
    () => new Map(items.filter((i) => i.label).map((i) => [i.key, i.label as string])),
    [labelsKey]
  )

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
    const pinW = pinRef.current?.offsetWidth ?? 0
    // The pinned lead costs its width plus one gap, exactly like the trail.
    const ownTrailW = trailRef.current?.offsetWidth ?? 0
    const trailW = ownTrailW + (pinW > 0 ? pinW + gap : 0)
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
      ownTrailW > 0 ? avail : avail + gap,
      gap
    )
    setOverflow((prev) =>
      prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next
    )
    setOwnLine(lineOfOwn)
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

  // Mark the menu's rows every time it renders and whenever a control inside re-renders
  // itself (a chip turning on swaps its markup). No deps: every render while open.
  useLayoutEffect(() => {
    const menu = menuEl
    if (!menuOpen || !menu) return
    markRailMenu(menu, labels)
    checkMoreBelow()
    // The menu's height cap lands after it is placed: check again when its size settles.
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => requestAnimationFrame(checkMoreBelow))
    ro?.observe(menu)
    const settled = setTimeout(checkMoreBelow, 250)
    const mo =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => markRailMenu(menu, labels))
    mo?.observe(menu, { childList: true, subtree: true })
    return () => {
      clearTimeout(settled)
      mo?.disconnect()
      ro?.disconnect()
    }
  })
  useLayoutEffect(() => {
    if (!menuOpen) setNestedOpen(0)
  }, [menuOpen])

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current
    // Keys typed in a popover opened from the menu bubble here through React's tree: not ours.
    if (!menu?.contains(e.target as Node)) return
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]'))
      return
    const stops = menuStops(menu)
    if (stops.length === 0) return
    const at = stops.findIndex(
      (el) => el === document.activeElement || el.contains(document.activeElement)
    )
    let next = -1
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % stops.length
    else if (e.key === 'ArrowUp')
      next = at < 0 ? stops.length - 1 : (at - 1 + stops.length) % stops.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = stops.length - 1
    if (next < 0) return
    e.preventDefault()
    stops[next].focus()
  }

  const measure = (key: string) => (el: HTMLDivElement | null) => {
    if (el) nodes.current.set(key, el)
    else nodes.current.delete(key)
  }

  const inline = items.filter((i) => !overflow.has(i.key))
  const hidden = items.filter((i) => overflow.has(i.key))
  const hiddenActive = hidden.some((i) => i.active)

  return (
    <div
      ref={railRef}
      data-overflow-rail=''
      data-rail-own-line={ownLine ? '' : undefined}
      className={cn(
        'ml-auto flex shrink-0 flex-nowrap items-center gap-2',
        ownLine && 'w-full',
        className
      )}
    >
      {lead != null && (
        <div
          ref={pinRef}
          data-rail-lead=''
          className='flex shrink-0 items-center gap-2 empty:hidden'
        >
          {lead}
        </div>
      )}
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
              aria-label={hiddenActive ? `${moreLabel} (some are on)` : moreLabel}
              data-tip={hiddenActive ? `${moreLabel} — some are on` : moreLabel}
              data-rail-more={hidden.length}
              data-rail-more-active={hiddenActive ? '' : undefined}
              // Keyboard focus only, in the app's own ring: no browser outline left on ⋯ after its
              // menu closes, which beside an amber "Paused" read as a second state (rt2 review).
              className='relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
            >
              <MoreHorizontal className='h-4 w-4' />
              {hiddenActive && (
                <span
                  aria-hidden
                  className='absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-nvr-cyan ring-2 ring-white dark:ring-background'
                />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            ref={setMenuNode}
            align='end'
            collisionPadding={16}
            aria-label={moreLabel}
            onOpenAutoFocus={(e) => {
              // Land on the first control (the menu's own box is not a stop).
              e.preventDefault()
              const menu = menuRef.current
              if (!menu) return
              markRailMenu(menu, labels)
              menuStops(menu)[0]?.focus()
            }}
            onKeyDown={onMenuKey}
            onScroll={checkMoreBelow}
            className={cn(
              'flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-px overflow-y-auto overscroll-contain p-1',
              // The peek cut (fitMenuPeek) only ever shortens the space Radix gives.
              'max-h-[min(var(--radix-popover-content-available-height),var(--nvr-rail-menu-cut,100000px))]',
              MENU_ROWS,
              compact && nestedOpen > 0 && 'pointer-events-none opacity-0'
            )}
            data-rail-menu=''
          >
            {/* The same controls as on the line, one per row (their own menus open beside). */}
            <RailMenuContext.Provider value={railMenu}>
              {(() => {
                const { filters, actions } = railMenuGroups(hidden)
                const row = (i: RailItem) => (
                  <div
                    key={i.key}
                    data-rail-item={i.key}
                    data-rail-row=''
                    data-rail-kind={i.kind ?? 'action'}
                    className='relative flex min-w-0 items-center gap-1 empty:hidden'
                  >
                    {i.node}
                    {/* Over the row's end, so a pressed row's tint runs under it. */}
                    <Check
                      aria-hidden
                      data-rail-check=''
                      className='pointer-events-none absolute right-2.5 top-1/2 hidden h-3.5 w-3.5 -translate-y-1/2 text-[#007a99] dark:text-nvr-cyan'
                    />
                  </div>
                )
                return (
                  <>
                    {filters.length > 0 && (
                      <p className='px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
                        Show only
                      </p>
                    )}
                    {filters.map(row)}
                    {filters.length > 0 && actions.length > 0 && (
                      <hr
                        data-rail-divider=''
                        className='mx-1 my-1 h-px shrink-0 border-0 bg-slate-100 dark:bg-border'
                      />
                    )}
                    {actions.map(row)}
                    {moreBelow && (
                      // A short fade (the peeking row stays readable) and a tag at the
                      // corner, clear of the row's icon and words.
                      <div
                        aria-hidden
                        data-rail-more-below=''
                        className='pointer-events-none sticky -bottom-1 -mt-2.5 flex h-2.5 shrink-0 items-end justify-end bg-gradient-to-t from-popover to-transparent'
                      >
                        <span className='mb-1.5 mr-1 inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-popover py-0.5 pl-2 pr-1.5 text-[11px] font-medium text-slate-600 shadow-sm dark:border-border dark:text-slate-300'>
                          More
                          <ChevronDown className='h-3 w-3' />
                        </span>
                      </div>
                    )}
                  </>
                )
              })()}
            </RailMenuContext.Provider>
          </PopoverContent>
        </Popover>
      )}
      {trail != null && (
        <div ref={trailRef} className='ml-auto flex shrink-0 items-center gap-2 empty:hidden'>
          {trail}
        </div>
      )}
    </div>
  )
}
