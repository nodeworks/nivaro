import { MoreHorizontal } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

/**
 * Collapses the record header's secondary tool buttons into a "⋯" popover
 * when the header row runs out of width. Group-level on purpose: either every
 * tool is inline or they all live in the menu — per-button granularity would
 * shuffle tools around as the window resizes, which reads as buttons randomly
 * appearing and disappearing.
 *
 * Measurement targets the header row (marked data-nvr-header-row): its
 * children don't wrap, so an overflowing row is exactly scrollWidth >
 * clientWidth. Collapse records the width the full row needed; expansion
 * waits for that width plus a margin, so resizing across the threshold
 * doesn't flap.
 */
/** An Escape pressed inside something a tool opened (its dialog, a Quick pick
 *  popover) belongs to that layer — only an Escape from the header itself, or
 *  the dialog hosting the form, folds the panel. */
function escapeIsOurs(e: KeyboardEvent, anchor: HTMLElement | null): boolean {
  const t = e.target as HTMLElement | null
  if (!t?.closest) return true
  if (t.closest('[data-radix-popper-content-wrapper]')) return false
  const dlg = t.closest('[role="dialog"]')
  return !dlg || !!(anchor && dlg.contains(anchor))
}

/** Whether the HeaderTools strip is on screen (inline, or folded with its panel open). A
 *  HeaderMenu nested in a folded panel closes with it — the panel keeps its tools mounted
 *  while hidden, so the menu would otherwise float on alone. */
const HeaderToolsShownContext = createContext(true)

/**
 * The header button a tool's own popover anchors to: the one that stays on screen when the menu
 * closes — HeaderTools' ⋯ while the tools are folded, else the More menu's button. Never the menu
 * row that opened it (it unmounts with the menu) and never a document query.
 */
const HeaderAnchorContext = createContext<(() => HTMLElement | null) | null>(null)

/** For a row in the record header's tools / More menu: the button its popover sits beside. */
export function useHeaderAnchor(): () => HTMLElement | null {
  const get = useContext(HeaderAnchorContext)
  return useCallback(() => get?.() ?? null, [get])
}

const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"]'

/** A sheet / dialog that `added` brings onto the page, which is not part of the panel itself
 *  (`isOwn`) and not a popover (Radix popovers also carry role=dialog, inside their popper
 *  wrapper — Quick pick, chat share — and those belong beside the panel). */
export function openedLayerIn(added: Node, isOwn: (el: Element) => boolean): boolean {
  if (!(added instanceof Element)) return false
  const found = added.matches(DIALOG_SELECTOR)
    ? [added]
    : Array.from(added.querySelectorAll(DIALOG_SELECTOR))
  return found.some((d) => !d.closest('[data-radix-popper-content-wrapper]') && !isOwn(d))
}

/** How long after a press inside the panel a sheet that appears still counts as opened by it
 *  (lazy sheets — Revision history — mount a beat after the click). */
const OPEN_WINDOW_MS = 1500

/**
 * While a header panel is open: a row pressed inside it (`isOwn`) that opens a drawer, a
 * dialog or navigates closes the panel, so it never sits on top of the sheet it opened
 * (2026-11-16: the clock opened Revision history and the ⋯ panel stayed over the dimmed page).
 * The panel keeps its rows mounted while hidden, so the sheet a row owns lives on.
 * Rows that open nothing outside (Find, Quick pick, two-press confirms) leave it open.
 */
export function useCloseWhenRowOpensLayer(
  open: boolean,
  close: () => void,
  isOwn: (el: Element) => boolean
) {
  const closeRef = useRef(close)
  closeRef.current = close
  const isOwnRef = useRef(isOwn)
  isOwnRef.current = isOwn
  useEffect(() => {
    if (!open) return
    let armedUntil = 0
    const timers: ReturnType<typeof setTimeout>[] = []
    // Capture on window, so a row whose handler stops propagation is still seen; the checks
    // run after the row's own handler (a navigate() changes the address there, a sheet mounts
    // then or a beat later through the observer below).
    const onPress = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!t?.closest || !isOwnRef.current(t)) return
      const href = window.location.href
      const link = !!t.closest('a[href]')
      armedUntil = Date.now() + OPEN_WINDOW_MS
      const checkNav = () => {
        if (link || window.location.href !== href) closeRef.current()
      }
      timers.push(setTimeout(checkNav, 0), setTimeout(checkNav, 250))
    }
    const mo =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            if (Date.now() > armedUntil) return
            for (const r of records)
              for (const n of Array.from(r.addedNodes))
                if (openedLayerIn(n, isOwnRef.current)) {
                  armedUntil = 0
                  closeRef.current()
                  return
                }
          })
    mo?.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('click', onPress, true)
    return () => {
      mo?.disconnect()
      window.removeEventListener('click', onPress, true)
      for (const t of timers) clearTimeout(t)
    }
  }, [open])
}

/**
 * How much wider the record title's line would have to be for its chips (Changed after
 * approval, Help requested…) to sit beside the id instead of wrapping under it — 0 when they
 * already fit, or when the tool strip is not on the title's line (phones put the actions on a
 * line of their own, so folding the tools would give the title nothing). An inline toolbar that
 * squeezes the title into a 5–6 line block without ever overflowing the row folds on this
 * (2026-11-16 design review: the 1548 px header was taller than the 1248 px one).
 */
export function titleChipDeficit(header: HTMLElement, strip: HTMLElement | null): number {
  const block = header.querySelector<HTMLElement>('[data-nvr-header-title]')
  const id = block?.querySelector<HTMLElement>('[data-nvr-record-title]')
  const line = id?.parentElement
  if (!block || !id || !line || !strip) return 0
  const blockBox = block.getBoundingClientRect()
  const stripBox = strip.getBoundingClientRect()
  // The tools sit on a line below the title (phones, the wrapped stage): nothing to win.
  if (stripBox.top >= blockBox.bottom - 1) return 0
  const idTop = id.getBoundingClientRect().top
  const items = Array.from(line.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement && c.offsetWidth > 0
  )
  if (!items.some((c) => c.getBoundingClientRect().top > idTop + 2)) return 0
  const gap = Number.parseFloat(getComputedStyle(line).columnGap) || 0
  const oneLine = items.reduce((w, c) => w + c.offsetWidth, 0) + gap * (items.length - 1)
  return Math.max(0, Math.ceil(oneLine - line.clientWidth))
}

export function HeaderTools({ children }: { children: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const anchorOfFold = useCallback(() => btnRef.current, [])
  const [collapsed, setCollapsed] = useState(false)
  const collapsedRef = useRef(false)
  collapsedRef.current = collapsed
  const neededRef = useRef(0)
  const wrapNeededRef = useRef(0)
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // Once opened, the folded panel keeps its tools mounted while hidden: a tool owns the sheet
  // it opens (Revision history, Help videos, Send), so closing the panel must not unmount it.
  // Mounted on first open only — the folded tools fetch nothing until someone looks.
  const keptRef = useRef(false)
  if (!collapsed) keptRef.current = false
  else if (open) keptRef.current = true
  useCloseWhenRowOpensLayer(
    open,
    () => setOpen(false),
    (el) => {
      return !!(panelRef.current?.contains(el) || el.closest('[data-nvr-header-menu-panel]'))
    }
  )

  // No deps on purpose: the tool set changes as queries land (custom actions,
  // PDF layouts…), and each render re-checks. The check is a couple of layout
  // reads — cheap enough to run unconditionally.
  useEffect(() => {
    const header = wrapRef.current?.closest('[data-nvr-header-row]') as HTMLElement | null
    if (!header) return
    const check = () => {
      if (!collapsedRef.current) {
        if (header.scrollWidth > header.clientWidth + 2) {
          neededRef.current = header.scrollWidth
          setCollapsed(true)
          setOpen(false)
          return
        }
        // The row fits, but only by squeezing the title until its chips wrap under the id:
        // fold too. neededRef is the width at which they would fit beside it, so the same
        // +32 px margin below keeps it from unfolding straight back into the squeeze.
        const deficit = titleChipDeficit(header, wrapRef.current?.parentElement ?? null)
        if (deficit > 0) {
          neededRef.current = header.clientWidth + deficit
          setCollapsed(true)
          setOpen(false)
        }
        return
      }
      // Second stage: still too wide with the tools folded (a narrow pane beside the sidebar),
      // so the row may wrap — the actions drop under the title instead of running off the edge.
      // Unwraps once the folded row fits again, with the same margin against flapping.
      // The squeeze counts here too (2026-11-16 r2: the pipeline moves landed after the tools
      // had folded; the row still fit, so nothing reacted and the title ran to five lines).
      // It waits for a foldable control still inline (the moves, useHeaderFold) to fold first:
      // that alone usually gives the title its line back, and wrapping now would race it.
      const wrapped = header.hasAttribute('data-nvr-header-wrap')
      const overflow = header.scrollWidth > header.clientWidth + 2
      const deficit =
        wrapped || header.querySelector('[data-nvr-header-fold="inline"]')
          ? 0
          : titleChipDeficit(header, wrapRef.current?.parentElement ?? null)
      if (!wrapped && (overflow || deficit > 0)) {
        wrapNeededRef.current = Math.max(
          overflow ? header.scrollWidth : 0,
          header.clientWidth + deficit
        )
        header.setAttribute('data-nvr-header-wrap', '')
      } else if (wrapped && header.clientWidth > wrapNeededRef.current + 32) {
        header.removeAttribute('data-nvr-header-wrap')
      } else if (!wrapped && neededRef.current > 0 && header.clientWidth > neededRef.current + 32) {
        setCollapsed(false)
      }
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(header)
    // The row's content grows without the row resizing (transition buttons
    // land after their query) — watch the actions strip this sits in too.
    const strip = wrapRef.current?.parentElement
    if (strip && strip !== header) ro.observe(strip)
    // Buttons that land later OUTSIDE this strip (the pipeline moves, Approve / Send Back) grow
    // the row without resizing it or the strip: a 1600 px header ran its last move off the
    // edge. Re-check when anything in the row is added or removed (one check per frame).
    let raf = 0
    const mo =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            if (raf) return
            raf = requestAnimationFrame(() => {
              raf = 0
              check()
            })
          })
    mo?.observe(header, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo?.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  })

  useEffect(() => {
    if (!open) return
    // Escape folds the panel only. Window capture runs before the hosting
    // sheet's own (document-level) Escape handler, which would otherwise close
    // the whole record sheet along with the panel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !escapeIsOurs(e, wrapRef.current)) return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      // Portaled popovers opened FROM a tool (Quick pick) render outside the
      // panel — a click inside them must not read as "outside".
      // The More menu (HeaderMenu) is its own portal too: pressing one of its
      // rows used to close this panel — and unmount the menu — before the
      // click landed, so no More action worked while the tools were folded.
      if (
        t.closest('[data-nvr-header-tools-panel]') ||
        t.closest('[data-nvr-header-tools-btn]') ||
        t.closest('[data-nvr-header-menu-panel]') ||
        t.closest('[data-radix-popper-content-wrapper]')
      )
        return
      // A dialog opened FROM a tool (Clone, Import) is portaled to body; a
      // click inside it must not fold the panel and unmount the dialog. A
      // dialog that HOSTS the form (a drill sheet) is not one of those.
      const dlg = t.closest('[role="dialog"]')
      if (dlg && !dlg.contains(wrapRef.current)) return
      setOpen(false)
    }
    // A row that closes the More menu (data-nvr-menu-close) is done with the
    // tools as well — fold the panel away once its click has run.
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-nvr-header-menu-panel] [data-nvr-menu-close]')) setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('click', onClick)
    }
  }, [open])

  if (!collapsed) {
    // display: contents — the tools sit directly in the header flex row, the
    // wrapper contributes no box of its own.
    return (
      <div ref={wrapRef} className='contents' data-nvr-header-tools='inline'>
        <HeaderToolsShownContext.Provider value>{children}</HeaderToolsShownContext.Provider>
      </div>
    )
  }

  const rect = open ? btnRef.current?.getBoundingClientRect() : undefined
  // Inside a modal sheet, body-level portals inherit the modal lock's
  // pointer-events: none — portal into the dialog content instead.
  const container =
    (btnRef.current?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
  // The panel grows leftwards from the button: never wider than the room
  // between the button and its host's left edge (a phone sheet clipped it).
  const roomLeft = rect
    ? rect.right - (container === document.body ? 0 : container.getBoundingClientRect().left) - 16
    : 440

  return (
    <div ref={wrapRef} className='flex shrink-0 items-center' data-nvr-header-tools='folded'>
      <button
        ref={btnRef}
        type='button'
        data-nvr-header-tools-btn
        aria-expanded={open}
        aria-label='More tools'
        data-tip='More tools'
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent',
          open && 'bg-accent text-accent-foreground dark:bg-accent'
        )}
      >
        <MoreHorizontal className='h-4 w-4' />
      </button>
      {keptRef.current &&
        createPortal(
          <div
            ref={panelRef}
            data-nvr-header-tools-panel
            // A transformed dialog re-anchors position: fixed — inside a sheet
            // the coords must be container-relative absolute instead.
            style={
              !(open && rect)
                ? { display: 'none' }
                : container === document.body
                  ? {
                      position: 'fixed',
                      top: rect.bottom + 6,
                      right: Math.max(8, window.innerWidth - rect.right),
                      maxWidth: Math.min(440, roomLeft),
                      zIndex: 110
                    }
                  : {
                      position: 'absolute',
                      top: rect.bottom - container.getBoundingClientRect().top + 6,
                      right: Math.max(8, container.getBoundingClientRect().right - rect.right),
                      maxWidth: Math.min(440, roomLeft),
                      zIndex: 110
                    }
            }
            // A tool group is one unbreakable pill in the header row; here it
            // must wrap, or a group wider than the panel ran off its LEFT edge
            // (justify-end) and the first tools could not be reached on a phone.
            className='flex flex-wrap items-center justify-end gap-1.5 rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-border dark:bg-card [&_[data-nvr-header-tool-group]]:h-auto [&_[data-nvr-header-tool-group]]:min-h-9 [&_[data-nvr-header-tool-group]]:max-w-full [&_[data-nvr-header-tool-group]]:shrink [&_[data-nvr-header-tool-group]]:flex-wrap'
          >
            <HeaderAnchorContext.Provider value={anchorOfFold}>
              <HeaderToolsShownContext.Provider value={open}>
                {children}
              </HeaderToolsShownContext.Provider>
            </HeaderAnchorContext.Provider>
          </div>,
          container
        )}
    </div>
  )
}

/**
 * Second fold stage for a control in the record header row (the pipeline
 * transition buttons): true once the row still overflows with the tool strip
 * already folded into ⋯, so the control can fold into a single menu. Unfolds
 * when the row has the room it needed plus a margin — before the tool strip
 * unfolds (its threshold was measured with this control inline, so it is
 * wider), so the two never flap against each other.
 */
export function useHeaderFold(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [folded, setFolded] = useState(false)
  const foldedRef = useRef(false)
  foldedRef.current = folded
  const neededRef = useRef(0)
  // No deps on purpose, as in HeaderTools: re-checked on every render.
  useEffect(() => {
    const el = ref.current
    const header = el?.closest('[data-nvr-header-row]') as HTMLElement | null
    if (!enabled || !el || !header) {
      if (!enabled && foldedRef.current) setFolded(false)
      return
    }
    // HeaderTools' wrap stage waits while a foldable control is still inline.
    el.setAttribute('data-nvr-header-fold', foldedRef.current ? 'folded' : 'inline')
    const check = () => {
      if (!foldedRef.current) {
        const overflow = header.scrollWidth > header.clientWidth + 2
        // The tool strip folds first; wait while it still has tools inline.
        const tools = header.querySelector('[data-nvr-header-tools]')
        if (
          tools?.getAttribute('data-nvr-header-tools') === 'inline' &&
          tools.childElementCount > 0
        )
          return
        // The row fits only by squeezing the title until its chips wrap: fold too.
        const deficit = overflow ? 0 : titleChipDeficit(header, el.parentElement)
        if (!overflow && deficit <= 0) return
        neededRef.current = overflow ? header.scrollWidth : header.clientWidth + deficit
        setFolded(true)
      } else if (neededRef.current > 0 && header.clientWidth > neededRef.current + 32) {
        setFolded(false)
      }
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(header)
    if (el.parentElement && el.parentElement !== header) ro.observe(el.parentElement)
    // The moves and the title chips land after their own queries without resizing the row
    // (the title block absorbs them): re-check when anything in the row changes, once a frame.
    let raf = 0
    const mo =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            if (raf) return
            raf = requestAnimationFrame(() => {
              raf = 0
              check()
            })
          })
    mo?.observe(header, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo?.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  })
  useEffect(() => {
    if (!enabled) ref.current?.removeAttribute('data-nvr-header-fold')
  }, [enabled, ref])
  return folded
}

/**
 * The record header's "More" menu: secondary tools (re-import, exports,
 * duplicate, templates, clone, raw edit, delete) live behind one trigger
 * instead of a strip of equal-weight buttons. Children are the SAME button
 * components the header used to render inline — the panel lays them out as
 * full-width rows (so their dialogs, sheets and confirms keep working
 * unchanged). Closes on outside click; portals into a hosting dialog when
 * inside a sheet (body portals inherit the modal lock's pointer-events: none).
 */
/** Width of the HeaderMenu panel (its `w-[240px]`). */
const MENU_WIDTH = 240

/** The menu's right offset: under its button's right edge, but never so far
 *  right that its left edge leaves the host (a button near the left edge of a
 *  phone sheet put four rows off screen). */
export function menuRight(fromButton: number, hostWidth: number): number {
  return Math.max(8, Math.min(fromButton, hostWidth - MENU_WIDTH - 8))
}

export function HeaderMenu({
  children,
  label = 'More',
  className
}: {
  children: ReactNode
  label?: string
  className?: string
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // Folded into HeaderTools' ⋯: that button stays on screen, this one goes with the panel.
  const parentAnchor = useContext(HeaderAnchorContext)
  const anchor = useCallback(() => parentAnchor?.() ?? btnRef.current, [parentAnchor])
  // Rows stay mounted after the first open (hidden while closed): a row owns the dialog or
  // sheet it opens (Clone, Import, Delete), so closing the menu must not unmount it.
  const keptRef = useRef(false)
  if (open) keptRef.current = true
  useCloseWhenRowOpensLayer(
    open,
    () => setOpen(false),
    (el) => !!panelRef.current?.contains(el)
  )
  // Folded into a ⋯ panel that just closed (a tool there opened a sheet, or the panel was
  // dismissed): the menu goes with it instead of floating on alone.
  const stripShown = useContext(HeaderToolsShownContext)
  useEffect(() => {
    if (!stripShown) setOpen(false)
  }, [stripShown])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (
        t.closest('[data-nvr-header-menu-panel]') ||
        t.closest('[data-nvr-header-menu-btn]') ||
        t.closest('[data-radix-popper-content-wrapper]') ||
        // A dialog opened from a menu row, not one hosting the form.
        (t.closest('[role="dialog"]') && !t.closest('[role="dialog"]')?.contains(btnRef.current))
      )
        return
      setOpen(false)
    }
    // Capture + stop, as in HeaderTools: Escape closes this menu, not the
    // record sheet hosting it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !escapeIsOurs(e, btnRef.current)) return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const rect = open ? btnRef.current?.getBoundingClientRect() : undefined
  const container =
    (btnRef.current?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body

  return (
    <div className={cn('relative shrink-0', className)}>
      <button
        ref={btnRef}
        type='button'
        data-nvr-header-menu-btn
        aria-haspopup='menu'
        aria-expanded={open}
        aria-label={label}
        data-tip='More actions'
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-9 items-center gap-1 rounded-md border border-input bg-background px-2.5 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent',
          open && 'bg-accent text-accent-foreground dark:bg-accent'
        )}
      >
        <MoreHorizontal className='h-4 w-4' />
        <span className='hidden lg:inline'>{label}</span>
      </button>
      {keptRef.current &&
        createPortal(
          <div
            ref={panelRef}
            data-nvr-header-menu-panel
            role='menu'
            // Rows that open something OUTSIDE the menu (Raw edit's sheet
            // renders beside the header now) mark themselves
            // `data-nvr-menu-close`; the menu otherwise stays open so rows
            // whose dialogs/confirms render inside them keep working. Without
            // this the panel sat on top of the Raw edit sheet (user report).
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('[data-nvr-menu-close]')) setOpen(false)
            }}
            style={
              !(open && rect)
                ? { display: 'none' }
                : container === document.body
                  ? {
                      position: 'fixed',
                      top: rect.bottom + 6,
                      right: menuRight(window.innerWidth - rect.right, window.innerWidth),
                      zIndex: 110
                    }
                  : {
                      position: 'absolute',
                      top: rect.bottom - container.getBoundingClientRect().top + 6,
                      right: menuRight(
                        container.getBoundingClientRect().right - rect.right,
                        container.getBoundingClientRect().width
                      ),
                      zIndex: 110
                    }
            }
            // Every child button becomes a menu row: full width, left-aligned,
            // no border/shadow of its own. Rows keep their own handlers.
            className={cn(
              'flex w-[240px] flex-col gap-px rounded-lg border border-slate-200 bg-white p-1 shadow-xl dark:border-border dark:bg-card',
              '[&_button]:h-8 [&_button]:w-full [&_button]:justify-start [&_button]:gap-2 [&_button]:rounded-sm [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-2 [&_button]:text-[12.5px] [&_button]:font-medium [&_button]:shadow-none',
              '[&_button:hover]:bg-accent [&_button:hover]:text-accent-foreground [&_button_svg]:h-3.5 [&_button_svg]:w-3.5 [&_button_svg]:shrink-0 [&_button_svg]:text-slate-500',
              '[&>[data-nvr-menu-divider]]:my-1 [&>[data-nvr-menu-divider]]:h-px [&>[data-nvr-menu-divider]]:bg-slate-100 dark:[&>[data-nvr-menu-divider]]:bg-border'
            )}
          >
            <HeaderAnchorContext.Provider value={anchor}>{children}</HeaderAnchorContext.Provider>
          </div>,
          container
        )}
    </div>
  )
}

/** Compact icon-only tool group: one bordered pill, dividers between tools.
 *  NO overflow-hidden: the tools open absolute popups (chat share, Find,
 *  Insights) that must escape the pill.
 *  Children render `compact` buttons (h-8 w-8) — the group supplies border,
 *  background and the dividers. */
export function HeaderToolGroup({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-nvr-header-tool-group
      className={cn(
        'inline-flex h-9 shrink-0 items-center rounded-md border border-input bg-background px-0.5 shadow-sm [&>*+*]:border-l [&>*+*]:border-input/70',
        className
      )}
    >
      {children}
    </div>
  )
}
