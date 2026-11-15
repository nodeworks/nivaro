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
      className='nvr-slide-up-centered fixed bottom-5 left-1/2 z-[60] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1.5 pr-1 text-[12.5px] text-slate-700 shadow-lg shadow-slate-900/5 dark:border-border dark:bg-card dark:text-slate-200 dark:shadow-black/30'
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
          className='inline-flex shrink-0 items-center gap-1 rounded-full bg-nvr-cyan px-2.5 py-1 text-[11.5px] font-semibold text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-card'
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
