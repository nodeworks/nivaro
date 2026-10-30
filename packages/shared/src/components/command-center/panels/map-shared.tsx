import { X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useCc } from '../state'
import { type CcMode, ccVars, FAINT, FOCUS, TITLE, useAppIsDark } from '../theme'
import type { GeoPin } from '../types'

/**
 * Shared bits of the map & place panels (slice 1): colours with their words, the board mode for
 * things portalled out of the board root (the CSS variables live on the root, so a portal must
 * set them again), and a right-side panel shell.
 */

export const MAP_COLORS = {
  breached: '#ef4444',
  warning: '#f59e0b',
  ok: '#00a5cc',
  people: '#10b981',
  out: '#8b5cf6',
  activity: '#0ea5e9'
} as const

/** Worst first: breached, warning, then everything else. */
export function slaRank(sla: GeoPin['sla'] | undefined): number {
  return sla === 'breached' ? 2 : sla === 'warning' ? 1 : 0
}

export function pinColor(p: Pick<GeoPin, 'sla' | 'state_color'>): string {
  if (p.sla === 'breached') return MAP_COLORS.breached
  if (p.sla === 'warning') return MAP_COLORS.warning
  return p.state_color ?? MAP_COLORS.ok
}

export function slaWords(sla: GeoPin['sla'] | undefined): string | null {
  return sla === 'breached' ? 'SLA breached' : sla === 'warning' ? 'SLA warning' : null
}

/** The board's colour mode (same rule as the shell): app dark or wall-screen mode. */
export function useCcMode(): CcMode {
  const { tv } = useCc()
  return useAppIsDark() || tv ? 'dark' : 'light'
}

/**
 * Right-side panel portalled to body (fixed overlays must escape the page-enter transform).
 * Non-modal: the board (and map) stay usable behind it. Esc or the close button closes; focus
 * moves to the close button on open and back to where it was on close.
 */
export function CcSidePanel({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 400,
  label,
  peek = false
}: {
  /** The record peek (the shell's focus handling finds it by data-cc-peek). */
  peek?: boolean
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  /** Accessible name of the panel. */
  label: string
}) {
  const mode = useCcMode()
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnTo = useRef<Element | null>(null)
  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const back = returnTo.current as HTMLElement | null
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus()
    }
  }, [open, onClose])
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <aside
      role='dialog'
      aria-label={label}
      data-cc-peek={peek ? '' : undefined}
      data-cc-mode={mode}
      style={{ ...ccVars(mode), width: `min(${width}px, 100vw)` }}
      className='fixed inset-y-0 right-0 z-[90] flex flex-col border-l border-[var(--cc-border)] bg-[var(--cc-panel)] text-[var(--cc-text)] shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right-4'
    >
      <div className='flex items-start gap-2 border-b border-[var(--cc-border)] px-4 py-3'>
        <div className='min-w-0 flex-1'>
          <h2 className={`${TITLE} text-[14px] leading-snug`}>{title}</h2>
          {subtitle && <div className={`mt-0.5 text-[11.5px] ${FAINT}`}>{subtitle}</div>}
        </div>
        <button
          ref={closeRef}
          type='button'
          onClick={onClose}
          aria-label='Close'
          className={`rounded-md p-1 text-[var(--cc-muted)] hover:bg-[var(--cc-chip)] ${FOCUS}`}
        >
          <X className='h-4 w-4' />
        </button>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto px-4 py-3'>{children}</div>
      {footer && <div className='border-t border-[var(--cc-border)] px-4 py-3'>{footer}</div>}
    </aside>,
    document.body
  )
}
