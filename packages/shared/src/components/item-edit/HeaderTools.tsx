import { MoreHorizontal } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
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

export function HeaderTools({ children }: { children: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [collapsed, setCollapsed] = useState(false)
  const collapsedRef = useRef(false)
  collapsedRef.current = collapsed
  const neededRef = useRef(0)
  const [open, setOpen] = useState(false)

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
        }
      } else if (neededRef.current > 0 && header.clientWidth > neededRef.current + 32) {
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
    return () => ro.disconnect()
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
        {children}
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
      {open &&
        rect &&
        createPortal(
          <div
            data-nvr-header-tools-panel
            // A transformed dialog re-anchors position: fixed — inside a sheet
            // the coords must be container-relative absolute instead.
            style={
              container === document.body
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
            {children}
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
    const check = () => {
      if (!foldedRef.current) {
        if (header.scrollWidth <= header.clientWidth + 2) return
        // The tool strip folds first; wait while it still has tools inline.
        const tools = header.querySelector('[data-nvr-header-tools]')
        if (
          tools?.getAttribute('data-nvr-header-tools') === 'inline' &&
          tools.childElementCount > 0
        )
          return
        neededRef.current = header.scrollWidth
        setFolded(true)
      } else if (neededRef.current > 0 && header.clientWidth > neededRef.current + 32) {
        setFolded(false)
      }
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(header)
    if (el.parentElement && el.parentElement !== header) ro.observe(el.parentElement)
    return () => ro.disconnect()
  })
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
  const [open, setOpen] = useState(false)

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
      {open &&
        rect &&
        createPortal(
          <div
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
              container === document.body
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
            {children}
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
