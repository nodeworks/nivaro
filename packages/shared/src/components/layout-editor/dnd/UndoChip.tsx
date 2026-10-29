import { Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

// After a drop on the trash (#3204): a small chip where the drop happened —
// "Removed Region · Undo". Undo is the draft's own undo, so it is offered only
// while the removal is still the step Undo would reverse (`stillUndoable`):
// any other change, or ⌘Z, takes the chip away. It leaves by itself after a
// few seconds, but not while the pointer or focus is on it.

export const UNDO_CHIP_MS = 6000

const CSS = `
@keyframes nvr-undo-chip-in{from{opacity:0;transform:translate(-50%,calc(-100% + 6px))}to{opacity:1;transform:translate(-50%,-100%)}}
[data-trash-undo-chip]{animation:nvr-undo-chip-in 140ms cubic-bezier(0.25,1,0.5,1) both}
@media (prefers-reduced-motion: reduce){[data-trash-undo-chip]{animation:none}}
`

/** Keep the chip inside the window (16px gutter), above the drop point. */
export function chipPosition(
  point: { x: number; y: number },
  view: { width: number; height: number },
  half = 120
): { left: number; top: number } {
  const left = Math.min(Math.max(point.x, 16 + half), Math.max(16 + half, view.width - 16 - half))
  const top = Math.min(Math.max(point.y - 16, 56), view.height - 16)
  return { left, top }
}

export function UndoChip({
  label,
  point,
  origin,
  stillUndoable,
  onUndo,
  onClose
}: {
  /** What was removed, as the form names it. */
  label: string
  /** Where the drop happened (viewport px). */
  point: { x: number; y: number }
  /** Where `position: fixed` is measured from inside the host (fixedOrigin). */
  origin: { x: number; y: number }
  stillUndoable: boolean
  onUndo: () => void
  onClose: () => void
}) {
  const [held, setHeld] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!stillUndoable) closeRef.current()
  }, [stillUndoable])
  useEffect(() => {
    if (held) return
    const t = setTimeout(() => closeRef.current(), UNDO_CHIP_MS)
    return () => clearTimeout(t)
  }, [held])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const view =
    typeof window === 'undefined'
      ? { width: 1024, height: 768 }
      : { width: window.innerWidth, height: window.innerHeight }
  const { left, top } = chipPosition(point, view)
  return (
    <div
      role='status'
      data-trash-undo-chip=''
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      style={{ left: left - origin.x, top: top - origin.y, transform: 'translate(-50%, -100%)' }}
      className='pointer-events-auto fixed z-[1001] flex max-w-[240px] items-center gap-1 rounded-lg bg-white py-1 pl-2.5 pr-1 text-[12.5px] text-slate-700 shadow-lg ring-1 ring-slate-900/10 dark:bg-card dark:text-slate-200 dark:ring-white/10'
    >
      <style>{CSS}</style>
      <span className='min-w-0 truncate'>
        Removed <span className='font-medium text-slate-900 dark:text-foreground'>{label}</span>
      </span>
      <span aria-hidden className='text-slate-300 dark:text-slate-600'>
        ·
      </span>
      <button
        type='button'
        data-trash-undo=''
        onClick={() => {
          onUndo()
          closeRef.current()
        }}
        className='inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-nvr-cyan hover:bg-nvr-cyan/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:px-3'
      >
        <Undo2 aria-hidden className='h-3.5 w-3.5' />
        Undo
      </button>
    </div>
  )
}
