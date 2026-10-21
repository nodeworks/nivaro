import { useCallback, useEffect, useRef, useState } from 'react'
import type { LayoutOp } from '../../lib/layout-ops'
import type { LayoutDraft, UnsavedStep } from './useLayoutDraft'

/**
 * Recover a draft after a crash (#2653). While a layout has unsaved changes
 * they are kept in this browser (localStorage, per layout and person) with
 * the rev they sit on; saving or discarding clears them. Opening the layout
 * with nothing unsaved in memory finds them: on the same rev it offers to
 * recover them, on a newer rev (someone saved since) they are dropped with a
 * note. Storage can be missing or refuse (private window): then nothing is
 * kept and nothing is offered.
 */

export interface StoredDraft {
  v: 1
  layoutId: number
  userId: string
  baseRev: string
  steps: UnsavedStep[]
  /** When it was last written (ms). */
  at: number
}

const PREFIX = 'nvr:layout-draft:'
export const storedDraftKey = (layoutId: number, userId: string) =>
  `${PREFIX}${userId.toLowerCase()}:${layoutId}`

function isStep(s: unknown): s is UnsavedStep {
  const x = s as { label?: unknown; ops?: unknown } | null
  return !!x && typeof x.label === 'string' && Array.isArray(x.ops)
}

export function readStoredDraft(layoutId: number, userId: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(storedDraftKey(layoutId, userId))
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<StoredDraft>
    if (
      d?.v !== 1 ||
      d.layoutId !== layoutId ||
      typeof d.baseRev !== 'string' ||
      !Array.isArray(d.steps) ||
      d.steps.length === 0 ||
      !d.steps.every(isStep)
    )
      return null
    return d as StoredDraft
  } catch {
    return null
  }
}

export function writeStoredDraft(d: StoredDraft): void {
  try {
    window.localStorage.setItem(storedDraftKey(d.layoutId, d.userId), JSON.stringify(d))
  } catch {
    /* full or blocked storage: nothing to recover later, the editor works on */
  }
}

export function clearStoredDraft(layoutId: number, userId: string): void {
  try {
    window.localStorage.removeItem(storedDraftKey(layoutId, userId))
  } catch {
    /* blocked storage */
  }
}

export type RecoveryState =
  | { kind: 'offer'; draft: StoredDraft }
  | { kind: 'dropped'; draft: StoredDraft }
  | null

/**
 * Keep `draft`'s unsaved steps for layout `layoutId` in storage, and decide
 * once per opened layout whether there is a stored draft to offer.
 */
export function useDraftRecovery(
  draft: Pick<LayoutDraft, 'bundle' | 'baseRev' | 'unsavedSteps' | 'status' | 'restore'>,
  layoutId: number,
  userId: string | null
) {
  const [state, setState] = useState<RecoveryState>(null)
  // The layout (and person) the stored draft was looked up for; until then nothing is written.
  const checked = useRef<string | null>(null)
  const pending = useRef(false)
  const scope = userId ? `${userId}:${layoutId}` : null
  const rev = draft.bundle?.rev ?? null

  useEffect(() => {
    if (!scope || !userId || !rev || checked.current === scope) return
    checked.current = scope
    pending.current = false
    setState(null)
    // Unsaved changes still in memory (the layout was reopened in this tab) are the newer copy.
    if (draft.unsavedSteps.length > 0) return
    const stored = readStoredDraft(layoutId, userId)
    if (!stored) return
    if (stored.baseRev === draft.baseRev) {
      pending.current = true
      setState({ kind: 'offer', draft: stored })
    } else {
      clearStoredDraft(layoutId, userId)
      setState({ kind: 'dropped', draft: stored })
    }
  }, [scope, userId, rev, layoutId, draft.unsavedSteps.length, draft.baseRev])

  const steps = draft.unsavedSteps
  const saving = draft.status === 'saving'
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` re-runs it once an offer is settled
  useEffect(() => {
    if (!scope || !userId || checked.current !== scope || pending.current || saving) return
    if (steps.length > 0 && draft.baseRev)
      writeStoredDraft({
        v: 1,
        layoutId,
        userId,
        baseRev: draft.baseRev,
        steps: steps.map((s) => ({ label: s.label, ops: s.ops as LayoutOp[] })),
        at: Date.now()
      })
    else if (steps.length === 0) clearStoredDraft(layoutId, userId)
  }, [scope, userId, layoutId, steps, saving, draft.baseRev, state])

  const restore = draft.restore
  const recover = useCallback(() => {
    if (state?.kind !== 'offer') return
    pending.current = false
    setState(null)
    restore(state.draft.steps)
  }, [state, restore])

  const dismiss = useCallback(() => {
    if (state?.kind === 'offer' && userId) clearStoredDraft(layoutId, userId)
    pending.current = false
    setState(null)
  }, [state, userId, layoutId])

  return { state, recover, dismiss }
}
