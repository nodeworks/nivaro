import { MoreHorizontal } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
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
    return () => ro.disconnect()
  })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      // Portaled popovers opened FROM a tool (Quick pick) render outside the
      // panel — a click inside them must not read as "outside".
      if (
        t.closest('[data-nvr-header-tools-panel]') ||
        t.closest('[data-nvr-header-tools-btn]') ||
        t.closest('[data-radix-popper-content-wrapper]')
      )
        return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open])

  if (!collapsed) {
    // display: contents — the tools sit directly in the header flex row, the
    // wrapper contributes no box of its own.
    return (
      <div ref={wrapRef} className='contents'>
        {children}
      </div>
    )
  }

  const rect = open ? btnRef.current?.getBoundingClientRect() : undefined
  // Inside a modal sheet, body-level portals inherit the modal lock's
  // pointer-events: none — portal into the dialog content instead.
  const container =
    (btnRef.current?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body

  return (
    <div ref={wrapRef} className='flex shrink-0 items-center'>
      <button
        ref={btnRef}
        type='button'
        data-nvr-header-tools-btn
        title='More tools'
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground',
          open && 'bg-accent text-accent-foreground'
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
                    zIndex: 110
                  }
                : {
                    position: 'absolute',
                    top: rect.bottom - container.getBoundingClientRect().top + 6,
                    right: Math.max(8, container.getBoundingClientRect().right - rect.right),
                    zIndex: 110
                  }
            }
            className='flex max-w-[440px] flex-wrap items-center justify-end gap-1.5 rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-border dark:bg-card'
          >
            {children}
          </div>,
          container
        )}
    </div>
  )
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
        t.closest('[role="dialog"]')
      )
        return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
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
        title='More actions'
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-9 items-center gap-1 rounded-md border border-input bg-background px-2.5 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground',
          open && 'bg-accent text-accent-foreground'
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
                    right: Math.max(8, window.innerWidth - rect.right),
                    zIndex: 110
                  }
                : {
                    position: 'absolute',
                    top: rect.bottom - container.getBoundingClientRect().top + 6,
                    right: Math.max(8, container.getBoundingClientRect().right - rect.right),
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
