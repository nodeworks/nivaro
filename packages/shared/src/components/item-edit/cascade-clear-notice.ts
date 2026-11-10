import { createContext, useCallback, useContext, useEffect, useRef } from 'react'
import { toast } from 'sonner'

/**
 * Cascade auto-clear notices (army11, Rob 2026-11-08): changing Zone clears a
 * Region / Project that is not available for the new Zone (and so on down the
 * chain — Region → Project → Sub Type …; a child that still fits stays). The
 * clear itself is the cascade rule's `clear_on_unavailable`
 * (CascadeEffectController); this says what happened, once per chain:
 * "Region and Project cleared — not available for the Zone you picked".
 */
export interface CascadeClearNote {
  /** The field that was emptied. */
  field: string
  /** Its label as the form shows it. */
  label: string
  /** The fields whose values narrow it (its cascade parents). */
  parents: string[]
}

export type CascadeClearNotifier = (note: CascadeClearNote) => void

export const CascadeClearNoticeContext = createContext<CascadeClearNotifier | null>(null)
export const useCascadeClearNotifier = () => useContext(CascadeClearNoticeContext)

/** "Region", "Region and Project", "Region, Project and Sub Type". */
export function joinLabels(labels: string[]): string {
  const xs = [...new Set(labels.filter(Boolean))]
  if (xs.length <= 1) return xs[0] ?? ''
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

/**
 * The notice for one chain of clears. `because` = the field the person changed
 * (its label), when known.
 */
export function cascadeClearText(cleared: string[], because: string | null): string {
  const what = joinLabels(cleared)
  return because
    ? `${what} cleared — not available for the ${because} you picked`
    : `${what} cleared — no longer available for what you picked`
}

/**
 * Which field the person changed to cause these clears: the most recently
 * edited parent that was not itself cleared in this chain (Zone, not the
 * Region that was cleared and then cleared Project).
 */
export function cascadeRootParent(
  notes: CascadeClearNote[],
  editSeq: (field: string) => number
): string | null {
  const cleared = new Set(notes.map((n) => n.field))
  const candidates = [...new Set(notes.flatMap((n) => n.parents))].filter((p) => !cleared.has(p))
  if (candidates.length === 0) return null
  return candidates.reduce((best, p) => (editSeq(p) > editSeq(best) ? p : best), candidates[0])
}

/** How long a chain may keep adding clears to the same notice (each clear
 *  waits on its own availability read). */
const CHAIN_MS = 4000
const SETTLE_MS = 500
const TOAST_ID = 'nvr-cascade-clear'

/** The form's notifier: collects a chain of clears and shows ONE toast for it. */
export function useCascadeClearNotices(opts: {
  labelOf: (field: string) => string
  editSeq: (field: string) => number
}): CascadeClearNotifier {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const notesRef = useRef<CascadeClearNote[]>([])
  const lastAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )
  return useCallback((note: CascadeClearNote) => {
    const now = Date.now()
    if (now - lastAtRef.current > CHAIN_MS) notesRef.current = []
    lastAtRef.current = now
    if (!notesRef.current.some((n) => n.field === note.field)) notesRef.current.push(note)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const notes = notesRef.current
      if (notes.length === 0) return
      const root = cascadeRootParent(notes, optsRef.current.editSeq)
      toast.info(
        cascadeClearText(
          notes.map((n) => n.label),
          root ? optsRef.current.labelOf(root) : null
        ),
        {
          id: TOAST_ID,
          description: 'Pick them again from the narrowed lists.'
        }
      )
    }, SETTLE_MS)
  }, [])
}

/**
 * A linked (M2M) field the PERSON changed (not a cross-record fill, not a
 * staging the form did itself) is recorded like a typed field: in the set the
 * cascades read as "fields the person changed" (dirtyFields) and with the
 * newest edit number (the notice names it). Returns whether it was recorded.
 * army11 browser check: Zone — an M2M on workflows — never counted, so a
 * Region outside the new Zone stayed (flagged, not cleared) and the notice
 * named Project Type.
 */
export function notePersonLinkEdit(
  state: { touched: Set<string>; seq: Map<string, number>; next: () => number },
  field: string,
  by: { crossFill: number; notPerson: number }
): boolean {
  if (by.crossFill > 0 || by.notPerson > 0) return false
  state.touched.add(field)
  state.seq.set(field, state.next())
  return true
}

/**
 * After a save: what the person touched is now the record's saved state, so
 * the "changed this session" set starts over (CR27-55150, 2026-11-10). The
 * save resets the staged links and the linked parents (Zone) reload a moment
 * later; with the old set still saying "Zone touched", that reload read as the
 * person changing Zone and the cascade emptied Funding Year, Project and Sub
 * Type — which the next save then deleted. A save that left work staged (a
 * refused line, a reason still owed) keeps the set: those edits are unsaved.
 */
export function settleTouchedAfterSave(
  touched: Set<string>,
  opts: { leftWorkStaged: boolean }
): void {
  if (opts.leftWorkStaged) return
  touched.clear()
}
