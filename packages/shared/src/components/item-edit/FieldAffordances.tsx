import { Copy, ExternalLink, Eye, History, Lock, Sigma, X } from 'lucide-react'
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
import { toast } from 'sonner'
import { cn, formatRelative } from '../../lib/utils'
import type { CMSField, CMSRelation } from './types'

/**
 * Per-field affordances the record form hands down to every FieldRow without
 * threading a dozen props through GroupSection: remote-change ghosts (#2),
 * read-only reasons (#7), the apply-to-lines button (#5) and the related-record
 * opener the field context menu (#9) uses. Absent context = plain FieldRow.
 */
export interface RemoteFieldChange {
  /** The value this field held before the remote write. */
  was: unknown
  by: string | null
  at: string
  /** Set when the user had ALSO edited this field: the remote value is kept
   *  aside instead of overwriting their draft, and the ghost offers a choice. */
  theirs?: unknown
  conflict?: boolean
}

export interface ApplyToLinesSpec {
  /** Button label — "Apply to lines" by default. */
  label?: string
  /** How many lines the grid currently shows (for the confirm copy); null = unknown. */
  count?: number | null
  onApply: (value: unknown) => void
}

export interface FieldAffordances {
  remoteChanges: Record<string, RemoteFieldChange>
  dismissRemoteChange: (field: string) => void
  /** Conflict ghosts (#6): replace the user's draft value with the remote one. */
  takeRemoteChange?: (field: string) => void
  /** field → human reason the input is read-only (shown on the lock glyph + hover). */
  lockReasons: Record<string, string>
  applyToLines: Record<string, ApplyToLinesSpec>
  openRelated?: (collection: string, id: string) => void
}

export const FieldAffordancesContext = createContext<FieldAffordances | null>(null)
export const useFieldAffordances = () => useContext(FieldAffordancesContext)

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v)
      return s.length > 80 ? `${s.slice(0, 80)}…` : s
    } catch {
      return String(v)
    }
  }
  const s = String(v).replace(/<[^>]+>/g, '')
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

/** "was X · Beth, just now" under a field another person changed while this
 *  form was open. Dismisses per field; the form drops it on the next save. */
export function RemoteChangeGhost({
  change,
  onDismiss,
  onTakeTheirs
}: {
  change: RemoteFieldChange
  onDismiss: () => void
  onTakeTheirs?: () => void
}) {
  if (change.conflict && onTakeTheirs)
    return (
      <div
        data-remote-change-ghost
        data-remote-conflict
        className='nvr-expand-in flex flex-wrap items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100'
      >
        <span className='h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500' />
        <span className='min-w-0 flex-1'>
          {change.by ?? 'Someone'} changed this to{' '}
          <span className='font-medium'>{fmt(change.theirs)}</span> while you were editing
          <span className='text-amber-700/80 dark:text-amber-200/70'>
            {' '}
            · {formatRelative(change.at)}
          </span>
        </span>
        <button
          type='button'
          onClick={onTakeTheirs}
          data-remote-take-theirs
          className='shrink-0 rounded border border-amber-400 bg-white px-1.5 py-0.5 text-[10.5px] font-medium text-amber-900 hover:bg-amber-100 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-500/20'
        >
          Take theirs
        </button>
        <button
          type='button'
          onClick={onDismiss}
          data-remote-keep-mine
          className='shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20'
        >
          Keep mine
        </button>
      </div>
    )
  return (
    <div
      data-remote-change-ghost
      className='nvr-expand-in flex items-start gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-[11.5px] text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200'
    >
      <span className='mt-0.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-500' />
      <span className='min-w-0 flex-1'>
        was{' '}
        <span className='font-medium line-through decoration-sky-400/70'>{fmt(change.was)}</span>
        <span className='text-sky-700/80 dark:text-sky-300/80'>
          {' '}
          · {change.by ?? 'someone'}, {formatRelative(change.at)}
        </span>
      </span>
      <button
        type='button'
        onClick={onDismiss}
        aria-label='Dismiss'
        className='shrink-0 rounded p-0.5 text-sky-500 hover:bg-sky-100 hover:text-sky-800 dark:hover:bg-sky-500/20'
      >
        <X className='h-3 w-3' />
      </button>
    </div>
  )
}

/** Lock glyph beside a read-only field's label carrying the reason. */
export function LockReasonBadge({ reason }: { reason: string }) {
  return (
    <span
      className='inline-flex cursor-help items-center gap-1 text-amber-500 dark:text-amber-400'
      data-tip={reason}
      data-lock-reason
      aria-label={reason}
      role='img'
    >
      <Lock className='h-3 w-3' />
    </span>
  )
}

// ─── Field context menu (#9) ─────────────────────────────────────────────────

interface MenuItem {
  key: string
  label: string
  icon: ReactNode
  hint?: string
  run: () => void
  disabled?: boolean
}

/**
 * What "Copy value" should yield for the element the menu was opened on:
 * an input's current value, else the text of the table cell (grid rows),
 * else null so the caller falls back to the field's own value.
 */
function textUnderCursor(t: HTMLElement | null, wrapper: HTMLElement | null): string | null {
  if (!t || !wrapper?.contains(t)) return null
  const input = t.closest<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select'
  )
  if (
    input &&
    wrapper.contains(input) &&
    !(input instanceof HTMLInputElement && input.type === 'checkbox')
  )
    return input.value
  const cell = t.closest<HTMLElement>('td, th')
  if (cell && wrapper.contains(cell)) return cell.innerText.replace(/\s+/g, ' ').trim()
  return null
}

export function useFieldContextMenu({
  wrapperRef,
  field,
  value,
  relations,
  collection,
  itemId,
  openRelated
}: {
  wrapperRef: RefObject<HTMLDivElement | null>
  field: CMSField
  value: unknown
  relations: CMSRelation[]
  collection: string
  itemId: string
  openRelated?: (collection: string, id: string) => void
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const openAt = useCallback((x: number, y: number) => setAt({ x, y }), [])
  const close = useCallback(() => setAt(null), [])
  // The element under the cursor when the menu opened. "Copy value" reads
  // THIS, not the field's draft value: an inline grid is one FieldRow whose
  // alias value is never in the draft (rows live in their own query), so the
  // draft-only copy pasted blank on every line cell (Rob, 2026-09-14).
  const targetRef = useRef<HTMLElement | null>(null)

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as HTMLElement
      // Let text inputs keep the native menu when the user has selected text
      // (paste / spelling) — right-click on the label / empty space opens ours.
      const sel = window.getSelection()?.toString()
      if (sel && t.closest('input, textarea, [contenteditable]')) return
      e.preventDefault()
      targetRef.current = t
      openAt(e.clientX, e.clientY)
    },
    [openAt]
  )
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault()
        const r = wrapperRef.current?.getBoundingClientRect()
        targetRef.current = document.activeElement as HTMLElement | null
        openAt(r ? r.left + 16 : 16, r ? r.top + 28 : 16)
      }
    },
    [openAt, wrapperRef]
  )

  const m2o = relations.find(
    (r) => r.many_collection === collection && r.many_field === field.field && r.one_collection
  )
  const saved = itemId && itemId !== 'new'
  const clickInside = (selector: string) => {
    const el = wrapperRef.current?.querySelector<HTMLElement>(selector)
    if (el) {
      el.click()
      return true
    }
    return false
  }
  const items: MenuItem[] = [
    {
      key: 'copy',
      label: 'Copy value',
      icon: <Copy className='h-3.5 w-3.5' />,
      run: () => {
        const fromDom = textUnderCursor(targetRef.current, wrapperRef.current)
        const text =
          fromDom ??
          (value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))
        if (!text) {
          toast.info('Nothing to copy')
          return
        }
        navigator.clipboard.writeText(text).then(
          () => toast.success('Value copied'),
          () => toast.error('Could not copy')
        )
      }
    },
    {
      key: 'copy-key',
      label: 'Copy field key',
      icon: <Copy className='h-3.5 w-3.5' />,
      hint: field.field,
      run: () => {
        navigator.clipboard.writeText(field.field).then(
          () => toast.success(`Copied “${field.field}”`),
          () => toast.error('Could not copy')
        )
      }
    },
    {
      key: 'history',
      label: 'Value history',
      icon: <History className='h-3.5 w-3.5' />,
      disabled: !saved,
      run: () => {
        if (!clickInside('[data-field-history]')) toast.info('No history for this field yet')
      }
    },
    {
      key: 'watch',
      label: 'Watch this field',
      icon: <Eye className='h-3.5 w-3.5' />,
      disabled: !saved,
      run: () => {
        if (!clickInside('[data-field-watch]'))
          toast.info('Field watching is off — an admin can enable it in Settings → Content')
      }
    },
    {
      key: 'explain',
      label: 'Explain value',
      icon: <Sigma className='h-3.5 w-3.5' />,
      disabled: !saved || !wrapperRef.current?.querySelector('[data-field-lineage]'),
      run: () => {
        clickInside('[data-field-lineage]')
      }
    },
    ...(m2o && openRelated
      ? [
          {
            key: 'open',
            label: `Open related ${m2o.one_collection?.replace(/_/g, ' ')}`,
            icon: <ExternalLink className='h-3.5 w-3.5' />,
            disabled: value == null || value === '',
            run: () => {
              const id =
                typeof value === 'object' && value && 'id' in (value as Record<string, unknown>)
                  ? String((value as Record<string, unknown>).id)
                  : String(value)
              openRelated(String(m2o.one_collection), id)
            }
          } satisfies MenuItem
        ]
      : [])
  ]

  const menu = at ? <FieldContextMenu at={at} items={items} onClose={close} /> : null
  return { onContextMenu, onKeyDown, menu }
}

function FieldContextMenu({
  at,
  items,
  onClose
}: {
  at: { x: number; y: number }
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState(0)
  const enabled = items.filter((i) => !i.disabled)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => (c + 1) % Math.max(1, enabled.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => (c - 1 + Math.max(1, enabled.length)) % Math.max(1, enabled.length))
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const it = enabled[cursor]
        if (it) {
          it.run()
          onClose()
        }
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    ref.current?.focus()
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, enabled, cursor])

  // Keep the panel on screen.
  const w = 240
  const h = items.length * 30 + 12
  const x = Math.min(at.x, window.innerWidth - w - 8)
  const y = Math.min(at.y, window.innerHeight - h - 8)
  return createPortal(
    <div
      ref={ref}
      role='menu'
      tabIndex={-1}
      data-field-context-menu
      style={{ position: 'fixed', left: x, top: y, width: w, zIndex: 110 }}
      className='rounded-lg border border-slate-200 bg-white p-1 shadow-xl outline-none dark:border-border dark:bg-card'
    >
      {items.map((it) => {
        const idx = enabled.indexOf(it)
        const active = idx === cursor && !it.disabled
        return (
          <button
            key={it.key}
            type='button'
            role='menuitem'
            disabled={it.disabled}
            onMouseEnter={() => idx >= 0 && setCursor(idx)}
            onClick={() => {
              it.run()
              onClose()
            }}
            className={cn(
              'flex h-[30px] w-full items-center gap-2 rounded-sm px-2 text-left text-[12.5px] font-medium text-slate-700 dark:text-slate-200',
              active && 'bg-accent text-accent-foreground',
              it.disabled && 'cursor-not-allowed opacity-40'
            )}
          >
            <span className='shrink-0 text-slate-500'>{it.icon}</span>
            <span className='min-w-0 flex-1 truncate'>{it.label}</span>
            {it.hint && (
              <span className='max-w-[90px] truncate font-mono text-[10.5px] text-slate-400'>
                {it.hint}
              </span>
            )}
          </button>
        )
      })}
    </div>,
    document.body
  )
}

// ─── Presence-aware soft lock (#16) ──────────────────────────────────────────

/**
 * Hosts mark a field wrapper someone else is focused on with
 * `data-remote-editor="<name>"` (admin use-record-presence, efp-new
 * record-presence). This hook watches the wrapper's own attribute and, while
 * it is set, asks once before letting the local user type into the same
 * field — a soft lock: editable, never blocking.
 */
export function usePresenceSoftLock(wrapperRef: RefObject<HTMLDivElement | null>) {
  const [editor, setEditor] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const confirmedRef = useRef(false)
  const pendingTargetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const read = () => setEditor(el.getAttribute('data-remote-editor'))
    read()
    const mo = new MutationObserver(read)
    mo.observe(el, { attributes: true, attributeFilter: ['data-remote-editor'] })
    return () => mo.disconnect()
  }, [wrapperRef])

  // A remote editor leaving clears any pending confirm; the local confirm
  // is remembered for the field until the remote editor leaves and returns.
  useEffect(() => {
    if (!editor) {
      setConfirming(false)
      confirmedRef.current = false
    }
  }, [editor])

  const onFocusCapture = useCallback(
    (e: React.FocusEvent) => {
      if (!editor || confirmedRef.current) return
      const t = e.target as HTMLElement
      if (!t.matches('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return
      pendingTargetRef.current = t
      // Blur on the next tick — inside the focus dispatch itself a blur() is
      // occasionally re-focused by the control's own handlers.
      setTimeout(() => {
        if (!confirmedRef.current) t.blur()
      }, 0)
      setConfirming(true)
    },
    [editor]
  )

  const confirm = useCallback(() => {
    confirmedRef.current = true
    setConfirming(false)
    const t = pendingTargetRef.current
    pendingTargetRef.current = null
    if (t) setTimeout(() => t.focus(), 0)
  }, [])
  const cancel = useCallback(() => {
    setConfirming(false)
    pendingTargetRef.current = null
  }, [])

  return { editor, confirming, onFocusCapture, confirm, cancel }
}

export function PresenceSoftLockStrip({
  editor,
  confirming,
  onConfirm,
  onCancel
}: {
  editor: string
  confirming: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const initials = editor
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <div
      data-presence-soft-lock
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-[11.5px]',
        confirming
          ? 'border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100'
          : 'text-amber-700 dark:text-amber-300'
      )}
    >
      <span className='inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[9px] font-semibold text-amber-900 dark:bg-amber-500/40 dark:text-amber-50'>
        {initials || '?'}
      </span>
      <span className='min-w-0 flex-1'>
        {confirming ? `${editor} is typing here — edit anyway?` : `${editor} is editing this field`}
      </span>
      {confirming && (
        <>
          <button
            type='button'
            onClick={onConfirm}
            className='rounded-md bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-700'
          >
            Edit anyway
          </button>
          <button
            type='button'
            onClick={onCancel}
            className='rounded-md border border-amber-300 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15'
          >
            Leave it
          </button>
        </>
      )}
    </div>
  )
}
