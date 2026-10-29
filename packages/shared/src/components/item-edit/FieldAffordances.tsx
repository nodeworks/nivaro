import {
  Copy,
  ExternalLink,
  Eye,
  History,
  Lock,
  Sigma,
  UserRound,
  UserRoundPen,
  UserRoundX,
  X
} from 'lucide-react'
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import type { TextContext } from '../../lib/placement-behaviour'
import { htmlToText } from '../../lib/sanitize-html'
import { cn, formatRelative } from '../../lib/utils'
import { useOverflowTip } from '../TipLayer'
import { clearPersonalDefault, refusalText, usePersonalDefaultCss } from './PersonalDefaultControl'
import { PERSONAL_DEFAULT_GHOST_BUTTON } from './PersonalDefaultPill'
import type { CMSField, CMSRelation } from './types'
import { usePersonalDefaultsApi } from './usePersonalDefaults'

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
  /** #2596: pointing at a locked field asks the server for the exact rule (once). */
  onLockHover?: () => void
  applyToLines: Record<string, ApplyToLinesSpec>
  openRelated?: (collection: string, id: string) => void
  /** The form's layout id — a field's own AI fill button (#2692) names it. */
  layoutId?: number | null
  /** Pickers count searches that find nothing on this form (#2726); off in design mode. */
  pickerMisses?: boolean
  /** The form was filled from a document proposal: fields the layout marks
   *  `autofill_check` get a "check this" ring (#2691). */
  fromAutofill?: boolean
  /** Glossary terms in help text get a dotted underline (#2711); false = the form turned it off. */
  glossaryHelp?: boolean
  /** #2703: the record's pipeline state and the viewer's role, for label rules. */
  placementText?: TextContext | null
}

export const FieldAffordancesContext = createContext<FieldAffordances | null>(null)
export const useFieldAffordances = () => useContext(FieldAffordancesContext)

export const ghostText = (v: unknown): string => {
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
  // Rich text: markup out and entities decoded (`&lt;b&gt;` showed literally).
  const raw = String(v)
  const s = /[<&]/.test(raw) ? htmlToText(raw).trim() : raw
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

/** "was X · Jane, just now" under a field another person changed while this
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
          <span className='font-medium'>{ghostText(change.theirs)}</span> while you were editing
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
        <span className='font-medium line-through decoration-sky-400/70'>
          {ghostText(change.was)}
        </span>
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
export function LockReasonBadge({ reason, onHover }: { reason: string; onHover?: () => void }) {
  return (
    <span
      onPointerEnter={onHover}
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
  /** Keep the menu open after the click (the item continues in the panel itself). */
  stay?: boolean
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
  openRelated,
  editable = false
}: {
  wrapperRef: RefObject<HTMLDivElement | null>
  field: CMSField
  value: unknown
  relations: CMSRelation[]
  collection: string
  itemId: string
  openRelated?: (collection: string, id: string) => void
  /** The person can edit this field on this form (not read-only, computed or hidden):
   *  only then may the menu offer "Save as my default". */
  editable?: boolean
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  // Personal defaults: "Save as my default" asks inline (in the menu panel) before it saves.
  const personalDefaults = usePersonalDefaultsApi()
  // 'save' = Make default / Save as my default; 'update' = Update default (same slot, new value).
  const [confirming, setConfirming] = useState<'save' | 'update' | false>(false)
  const [parts, setParts] = useState<string[] | null>(null)
  const [updateText, setUpdateText] = useState<{ value: string; context: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const openAt = useCallback((x: number, y: number) => setAt({ x, y }), [])
  /** What opened the panel: the ⋯ button / right-click ('menu'), or the visible Make default /
   *  Update default control. */
  const [openedBy, setOpenedBy] = useState<'menu' | 'make' | 'update' | null>(null)
  // Opened from the ⋯ button or Make default: focus goes back there when the panel closes
  // (unless the person clicked into something else that took focus). When that button is gone
  // (a save turned Make default into "Your default"), `refocusRef` says where to go instead.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const refocusRef = useRef<(() => HTMLElement | null | undefined) | null>(null)
  const close = useCallback(() => {
    setAt(null)
    setOpenedBy(null)
    setConfirming(false)
    setParts(null)
    setUpdateText(null)
    setSaving(false)
    const back = returnFocusRef.current
    const instead = refocusRef.current
    returnFocusRef.current = null
    refocusRef.current = null
    if (back || instead)
      window.setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) return
        if (back?.isConnected) back.focus()
        else instead?.()?.focus()
      }, 0)
  }, [])
  const isOpen = at !== null
  /** The ⋯ button in the label row (touch has no right-click): toggles the same menu under it. */
  const openFrom = useCallback(
    (el: HTMLElement) => {
      if (isOpen) {
        close()
        return
      }
      const r = el.getBoundingClientRect()
      targetRef.current = null
      returnFocusRef.current = el
      setOpenedBy('menu')
      openAt(r.left, r.bottom + 4)
    },
    [isOpen, close, openAt]
  )
  const startConfirm = useCallback(() => {
    if (!personalDefaults) return
    setParts(null)
    setConfirming('save')
    personalDefaults.describeSave(field.field).then(
      (p) => setParts(p),
      () => setParts([])
    )
  }, [personalDefaults, field.field])
  const startUpdate = useCallback(() => {
    if (!personalDefaults) return
    setUpdateText(null)
    setConfirming('update')
    personalDefaults.describeUpdate(field.field).then(
      (t) => setUpdateText(t),
      () => setUpdateText({ value: '', context: [] })
    )
  }, [personalDefaults, field.field])
  /** The visible Make default / Update default control: the same inline confirm as the menu's
   *  "Save as my default", right-aligned under the control; a second click closes it. */
  const confirmSaveFrom = useCallback(
    (
      el: HTMLElement,
      refocus?: () => HTMLElement | null | undefined,
      mode: 'make' | 'update' = 'make'
    ) => {
      // A second click closes it; with the ⋯ menu open, it switches to the confirm instead.
      if (isOpen && openedBy === mode) {
        close()
        return
      }
      const r = el.getBoundingClientRect()
      targetRef.current = null
      returnFocusRef.current = el
      refocusRef.current = refocus ?? null
      setOpenedBy(mode)
      if (mode === 'update') startUpdate()
      else startConfirm()
      openAt(r.right - MENU_WIDTH, r.bottom + 4)
    },
    [isOpen, openedBy, close, openAt, startConfirm, startUpdate]
  )
  // The element under the cursor when the menu opened. "Copy value" reads
  // THIS, not the field's draft value: an inline grid is one FieldRow whose
  // alias value is never in the draft (rows live in their own query), so the
  // draft-only copy pasted blank on every line cell (reported 2026-09-14).
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
      setOpenedBy('menu')
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
        setOpenedBy('menu')
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
  const pdAllowed = !!personalDefaults?.allowed(field.field)
  const pdHasValue = pdAllowed && editable && !!personalDefaults?.hasValue(field.field)
  const pdSaved = pdAllowed ? (personalDefaults?.defaultFor(field.field) ?? null) : null
  const pdOffer = pdHasValue && !pdSaved
  const pdUpdate = pdHasValue && !!pdSaved && !personalDefaults?.isDefault(field.field)
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
      : []),
    // Same states as the visible control: no default here → Save; a default holding another
    // value → Update (that default, in place); the value IS the default → only Clear.
    ...(pdOffer
      ? [
          {
            key: 'save-default',
            label: 'Save as my default',
            icon: <UserRound className='h-3.5 w-3.5' />,
            stay: true,
            run: startConfirm
          } satisfies MenuItem
        ]
      : []),
    ...(pdUpdate
      ? [
          {
            key: 'update-default',
            label: 'Update my default',
            icon: <UserRoundPen className='h-3.5 w-3.5' />,
            stay: true,
            run: startUpdate
          } satisfies MenuItem
        ]
      : []),
    ...(pdSaved && personalDefaults
      ? [
          {
            key: 'clear-default',
            label: 'Clear my default',
            icon: <UserRoundX className='h-3.5 w-3.5' />,
            // Runs at once (a menu pick is deliberate); the toast's Undo saves it back.
            run: () => {
              void clearPersonalDefault(personalDefaults, field.field)
            }
          } satisfies MenuItem
        ]
      : [])
  ]

  const updateLine = (t: { value: string; context: string[] }, done: boolean) => {
    const to = t.value ? ` to ${t.value}` : ''
    const where = t.context.length ? ` for ${t.context.join(' · ')}` : ''
    return done ? `Updated your default${where}${to}` : `Update your default${where}${to}?`
  }
  const confirm: MenuConfirm | null =
    confirming === 'update' && personalDefaults
      ? {
          label: 'Update my default',
          action: 'Update',
          text: updateText ? updateLine(updateText, false) : 'Update your default?',
          ready: updateText !== null && !saving,
          saving,
          onCancel: close,
          onSave: () => {
            setSaving(true)
            personalDefaults.update(field.field).then(
              () => {
                toast.success(updateText ? updateLine(updateText, true) : 'Updated your default')
                close()
              },
              (e) => {
                toast.error(refusalText(e, 'Could not update your default'))
                close()
              }
            )
          }
        }
      : confirming && personalDefaults
        ? {
            label: 'Save as my default',
            action: 'Save',
            text: parts?.length
              ? `Save ${parts.join(' · ')} as your ${parts.length > 1 ? 'defaults' : 'default'}?`
              : 'Save as your default?',
            ready: parts !== null && !saving,
            saving,
            onCancel: close,
            onSave: () => {
              setSaving(true)
              personalDefaults.save(field.field).then(
                () => {
                  toast.success(
                    parts?.length
                      ? `Saved ${parts.join(' · ')} as your default${parts.length > 1 ? 's' : ''}`
                      : 'Your default was saved'
                  )
                  close()
                },
                (e) => {
                  toast.error(refusalText(e, 'Could not save your default'))
                  close()
                }
              )
            }
          }
        : null
  const menu = at ? (
    <FieldContextMenu
      at={at}
      items={items}
      onClose={close}
      confirm={confirm}
      anchor={wrapperRef.current}
    />
  ) : null
  // The ⋯ button shows only where the menu offers something about this field beyond the copy
  // items every field has: today, Save / Clear my default.
  const hasFieldItems = items.some(
    (i) => i.key === 'save-default' || i.key === 'update-default' || i.key === 'clear-default'
  )
  return {
    onContextMenu,
    onKeyDown,
    menu,
    openFrom,
    isOpen,
    hasFieldItems,
    confirmSaveFrom,
    openedBy
  }
}

const MENU_WIDTH = 240
/** The buttons in a field's label row that open (and toggle shut) this field's panel. */
const PANEL_TRIGGERS =
  '[data-field-menu-trigger], [data-personal-default-make], [data-personal-default-update]'

type MenuConfirm = {
  /** The panel's accessible name while it asks. */
  label: string
  /** The confirming button ("Save" / "Update"). */
  action: string
  text: string
  ready: boolean
  saving?: boolean
  onSave: () => void
  onCancel: () => void
}

function FieldContextMenu({
  at,
  items,
  onClose,
  confirm,
  anchor
}: {
  at: { x: number; y: number }
  items: MenuItem[]
  onClose: () => void
  confirm?: MenuConfirm | null
  /** The field wrapper: inside a modal sheet the panel portals into that [role=dialog]
   *  (a body portal inherits the modal lock's pointer-events:none and the focus trap). */
  anchor?: HTMLElement | null
}) {
  // The confirm's touch sizes live in the control's owned CSS (a form whose only way in is the
  // ⋯ menu must get them too).
  usePersonalDefaultCss()
  const ref = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState(0)
  const enabled = items.filter((i) => !i.disabled)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (ref.current?.contains(t)) return
      // This field's own ⋯ / Make default button toggles the panel itself (closing here would
      // reopen it).
      if (t?.closest?.(PANEL_TRIGGERS) && anchor?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (confirm) {
        // Enter / Space act on the focused button; Tab stays between Cancel and Save.
        if (e.key === 'Tab') {
          e.preventDefault()
          const btns = [cancelRef.current, saveRef.current].filter(
            (b): b is HTMLButtonElement => !!b && !b.disabled
          )
          if (btns.length === 0) return
          const i = btns.indexOf(document.activeElement as HTMLButtonElement)
          const next = e.shiftKey ? i - 1 : i + 1
          btns[((next % btns.length) + btns.length) % btns.length]?.focus()
        }
        return
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
          if (!it.stay) onClose()
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
  }, [onClose, enabled, cursor, confirm, anchor])
  const saveRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmOpen = !!confirm
  const confirmReady = !!confirm?.ready
  // Cancel is never disabled: focus lands there at once, then moves to Save when it enables.
  useEffect(() => {
    if (confirmOpen) cancelRef.current?.focus()
  }, [confirmOpen])
  useEffect(() => {
    if (!confirmReady) return
    const a = document.activeElement
    if (a === cancelRef.current || a === ref.current || a === document.body)
      saveRef.current?.focus()
  }, [confirmReady])

  // Keep the panel on screen: its real height once drawn (the confirm line wraps to 1–4 rows),
  // and never wider than the viewport less an 8px margin each side (a 320px phone gets 304px).
  const w = Math.min(MENU_WIDTH, window.innerWidth - 16)
  // A very long value label is clamped to 4 lines; the whole line is then on its tip.
  const confirmTextRef = useOverflowTip<HTMLParagraphElement>(confirm?.text)
  const [h, setH] = useState(() => (confirm ? 96 : items.length * 30 + 12))
  useLayoutEffect(() => {
    const drawn = ref.current?.offsetHeight
    if (drawn && drawn !== h) setH(drawn)
  })
  const x = Math.max(8, Math.min(at.x, window.innerWidth - w - 8))
  const y = Math.max(8, Math.min(at.y, window.innerHeight - h - 8))
  const host = (anchor?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
  const place: React.CSSProperties =
    host === document.body
      ? { position: 'fixed', left: x, top: y }
      : (() => {
          const c = host.getBoundingClientRect()
          return {
            position: 'absolute',
            left: x - c.left + host.scrollLeft - host.clientLeft,
            top: y - c.top + host.scrollTop - host.clientTop
          }
        })()
  return createPortal(
    <div
      ref={ref}
      // While it asks "Save … as your default?" the panel is a small non-modal dialog, not a menu.
      {...(confirm
        ? { role: 'dialog', 'aria-modal': false, 'aria-label': confirm.label }
        : { role: 'menu', 'aria-label': 'Field options' })}
      tabIndex={-1}
      data-field-context-menu
      style={{ ...place, width: w, maxWidth: 'calc(100vw - 16px)', zIndex: 110 }}
      className='rounded-lg border border-slate-200 bg-white p-1 shadow-xl outline-none dark:border-border dark:bg-card'
    >
      {confirm ? (
        <div data-personal-default-confirm className='space-y-2 px-2 py-1.5'>
          <p
            ref={confirmTextRef}
            aria-live='polite'
            className='line-clamp-4 text-[12.5px] leading-snug text-slate-700 [overflow-wrap:anywhere] dark:text-slate-200'
          >
            {confirm.text}
          </p>
          <div className='flex justify-end gap-1.5'>
            <button
              ref={cancelRef}
              type='button'
              onClick={confirm.onCancel}
              className={PERSONAL_DEFAULT_GHOST_BUTTON}
            >
              <X className='h-3 w-3' aria-hidden /> Cancel
            </button>
            <button
              ref={saveRef}
              type='button'
              disabled={!confirm.ready}
              onClick={confirm.onSave}
              // 44px on touch screens: PERSONAL_DEFAULT_CSS (a host's `.h-7` would win a class).
              className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white hover:bg-nvr-cyan/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50'
            >
              {confirm.saving ? 'Saving…' : confirm.action}
            </button>
          </div>
        </div>
      ) : null}
      {confirm
        ? null
        : items.map((it) => {
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
                  if (!it.stay) onClose()
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
    host
  )
}

// ─── Presence-aware soft lock (#16) ──────────────────────────────────────────

/**
 * Hosts mark a field wrapper someone else is focused on with
 * `data-remote-editor="<name>"` (admin use-record-presence, or a host's own
 * record-presence hook). This hook watches the wrapper's own attribute and, while
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
