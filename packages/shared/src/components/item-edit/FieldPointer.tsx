import { Crosshair, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import {
  type CoViewer,
  type FieldPointer,
  pointMayScroll,
  pointRefusalText,
  useCoViewers,
  useFieldPointer
} from '../../lib/co-edit'
import { useLivePreference } from '../../lib/live-preference'
import { CoViewerAvatar } from './SectionPresence'

/** A nudge chip stays this long unless the person acts on it. */
const CHIP_MS = 60_000
/** …and this long when the page already scrolled to the field. */
const SCROLLED_CHIP_MS = 6_000

/** Room the floating chip needs under the page's content (its height + the bottom inset). */
const CHIP_CLEARANCE_PX = 72

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return null
}

let lastInputAt = 0
let inputHooked = false
function hookInput(): void {
  if (inputHooked || typeof document === 'undefined') return
  inputHooked = true
  const note = () => {
    lastInputAt = Date.now()
  }
  for (const e of ['pointerdown', 'wheel', 'keydown', 'touchstart'])
    document.addEventListener(e, note, { capture: true, passive: true })
}

function editingSomething(): boolean {
  const a = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
  if (!a || a === document.body) return false
  return (
    a.matches?.('input, textarea, select, [contenteditable="true"], [role="combobox"]') ?? false
  )
}

function popoverOpen(): boolean {
  return (
    typeof document !== 'undefined' &&
    !!document.querySelector('[data-radix-popper-content-wrapper], [role="menu"]')
  )
}

/**
 * Realtime round 7 #4 — the receiving side of "Point Beth to this field", mounted once by the
 * record form. A nudge scrolls the field into view only when the person is idle there
 * (Normal mode, nothing being typed, no open menu, no input for a few seconds); otherwise a
 * quiet chip offers "Rob pointed you to Amount · Go". Calm/Off never scroll. Also says how a
 * nudge THIS tab sent went (the sender's own action, so one short toast).
 */
export function FieldPointerHost({
  collection,
  itemId,
  fieldLabel,
  onGo
}: {
  collection: string
  itemId: string
  fieldLabel: (field: string) => string
  /** Bring the field into view (open its tab / section, scroll, flash). */
  onGo: (field: string) => boolean
}) {
  const { pointer, result, dismiss } = useFieldPointer(collection, itemId)
  const viewers = useCoViewers(collection, itemId)
  const { quiet } = useLivePreference()
  const [chip, setChip] = useState<{ p: FieldPointer; scrolled: boolean } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const onGoRef = useRef(onGo)
  onGoRef.current = onGo
  const quietRef = useRef(quiet)
  quietRef.current = quiet

  useEffect(() => hookInput(), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: one decision per nudge (its time)
  useEffect(() => {
    if (!pointer) return
    const scroll = pointMayScroll({
      quiet: quietRef.current,
      visible: typeof document === 'undefined' || document.visibilityState === 'visible',
      editingSomething: editingSomething(),
      popoverOpen: popoverOpen(),
      lastInputAt,
      now: Date.now()
    })
    const scrolled = scroll ? onGoRef.current(pointer.field) : false
    setChip({ p: pointer, scrolled })
    dismiss()
  }, [pointer?.at])

  useEffect(() => {
    if (!chip) return
    const t = setTimeout(() => setChip(null), chip.scrolled ? SCROLLED_CHIP_MS : CHIP_MS)
    return () => clearTimeout(t)
  }, [chip])

  // biome-ignore lint/correctness/useExhaustiveDependencies: one toast per answer (its seq)
  useEffect(() => {
    if (!result) return
    const name = viewers.find((v) => v.id.toUpperCase() === result.to.toUpperCase())?.name
    const who = name ?? 'They'
    if (result.ok) toast(`${who} was pointed to ${fieldLabel(result.field)}`)
    else toast.info(pointRefusalText(result.reason, name ?? 'That person'))
  }, [result?.seq])

  // While the chip floats at the bottom, the page's scroller gets room below its content, so
  // the last fields can always scroll clear of it instead of sitting underneath.
  useEffect(() => {
    if (!chip) return
    const scroller = scrollParentOf(anchorRef.current)
    if (!scroller) return
    const before = scroller.style.paddingBottom
    const base = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0
    scroller.style.paddingBottom = `${base + CHIP_CLEARANCE_PX}px`
    return () => {
      scroller.style.paddingBottom = before
    }
  }, [chip])

  const container =
    (anchorRef.current?.closest('[role="dialog"]') as HTMLElement | null) ??
    (typeof document !== 'undefined' ? document.body : null)

  return (
    <>
      <span ref={anchorRef} hidden />
      {chip &&
        container &&
        createPortal(
          <PointerChip
            pointer={chip.p}
            label={fieldLabel(chip.p.field)}
            scrolled={chip.scrolled}
            onGo={() => {
              onGoRef.current(chip.p.field)
              setChip(null)
            }}
            onClose={() => setChip(null)}
          />,
          container
        )}
    </>
  )
}

function PointerChip({
  pointer,
  label,
  scrolled,
  onGo,
  onClose
}: {
  pointer: FieldPointer
  label: string
  scrolled: boolean
  onGo: () => void
  onClose: () => void
}) {
  const who: CoViewer = pointer.user
  return (
    <div
      role='status'
      aria-live='polite'
      data-field-pointer={pointer.field}
      className='nvr-slide-up-centered fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 z-[60] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1.5 pr-1 text-[12.5px] text-slate-700 shadow-lg shadow-slate-900/5 dark:border-border dark:bg-card dark:text-slate-200 dark:shadow-black/30'
    >
      <CoViewerAvatar person={who} size={22} />
      <span className='min-w-0 truncate'>
        <span className='font-medium text-slate-900 dark:text-slate-50'>{who.name}</span>{' '}
        {scrolled ? 'pointed you here:' : 'pointed you to'}{' '}
        <span className='font-medium text-slate-900 dark:text-slate-50'>{label}</span>
      </span>
      {!scrolled && (
        <button
          type='button'
          onClick={onGo}
          data-field-pointer-go=''
          // One treatment for Go everywhere: a small bordered pill, cyan-tinted.
          className='inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-cyan-600/30 bg-cyan-50 px-2.5 text-[12px] font-semibold text-[#0e7490] transition-colors hover:bg-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-nvr-cyan/40 dark:bg-nvr-cyan/10 dark:text-nvr-cyan dark:hover:bg-nvr-cyan/20'
        >
          <Crosshair className='h-3 w-3' aria-hidden />
          Go
        </button>
      )}
      <button
        type='button'
        onClick={onClose}
        aria-label='Dismiss'
        className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted dark:hover:text-slate-300'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
