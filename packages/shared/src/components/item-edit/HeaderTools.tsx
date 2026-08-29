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
      if (t.closest('[data-nvr-header-tools-panel]') || t.closest('[data-nvr-header-tools-btn]'))
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
                    right: Math.max(
                      8,
                      container.getBoundingClientRect().right - rect.right
                    ),
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
