import { useCallback, useEffect, useRef, useState } from 'react'
import type { LayoutOp } from '../../lib/layout-ops'
import type { StagedServerDraft, StagedWriter } from './staged-api'
import type { LayoutDraft, UnsavedStep } from './useLayoutDraft'

/**
 * A layout's unsaved changes are staged (#2589, #2653): while a layout has
 * unsaved changes they are kept in this browser (localStorage, per layout and
 * person) and, about a second after each change, on the server (one row per
 * person and layout — only its author can read it). Saving or discarding
 * clears both. Opening the layout with nothing unsaved in memory finds the
 * newer of the two copies and offers to bring it back: on the same rev as
 * it was made, exactly; on a newer rev (someone saved since, or staging
 * took the night's layouts) folded onto the layout as it is now, with any
 * change that no longer fits listed instead of applied. Storage can be
 * missing or refuse (private window) and the server copy can be off: then
 * whichever copy exists is used, and with neither nothing is offered.
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

/** How long after the last change the server copy is written. */
export const STAGED_SYNC_MS = 1200

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

/** The server's copy in the browser copy's shape. */
export function fromServerDraft(
  d: StagedServerDraft | null | undefined,
  layoutId: number,
  userId: string
): StoredDraft | null {
  if (!d || d.steps.length === 0) return null
  const at = Date.parse(d.saved_at)
  return {
    v: 1,
    layoutId,
    userId,
    baseRev: d.base_rev,
    steps: d.steps,
    at: Number.isFinite(at) ? at : 0
  }
}

/** The copy to offer: the newer of the two (ties go to the server, which outlives this browser). */
export function pickDraft(
  local: StoredDraft | null,
  server: StoredDraft | null
): StoredDraft | null {
  if (!local) return server
  if (!server) return local
  return local.at > server.at ? local : server
}

export type RecoveryState = {
  kind: 'offer'
  draft: StoredDraft
  /** The layout was saved since: Recover folds the changes onto it and lists what no longer fits. */
  stale: boolean
  source: 'server' | 'browser'
} | null

/** Where the server copy stands: what the status chip's tip says. */
export type StagedSync = 'off' | 'idle' | 'pending' | 'kept' | 'failed'

export interface StagedServer {
  /** The server has answered (or failed): the decision can be made. */
  settled: boolean
  draft: StagedServerDraft | null
  /** false = the server keeps no drafts; only the browser copy is used. */
  available: boolean
  writer: StagedWriter
}

/**
 * Keep `draft`'s unsaved steps for layout `layoutId` in storage (and on the
 * server, when given one), and decide once per opened layout whether there
 * is a draft to offer.
 */
export function useDraftRecovery(
  draft: Pick<LayoutDraft, 'bundle' | 'baseRev' | 'unsavedSteps' | 'status' | 'restore'>,
  layoutId: number,
  userId: string | null,
  server?: StagedServer
) {
  const [state, setState] = useState<RecoveryState>(null)
  const [sync, setSync] = useState<StagedSync>('idle')
  // The layout (and person) the stored draft was looked up for; until then nothing is written.
  const checked = useRef<string | null>(null)
  const pending = useRef(false)
  // The server holds a row for this layout (found, or written here): an empty draft clears it.
  const onServer = useRef(false)
  // A server write waiting for the pause, with what it will send (flushed on a switch or unmount).
  const queued = useRef<{
    timer: ReturnType<typeof setTimeout>
    layoutId: number
    steps: UnsavedStep[]
    baseRev: string
  } | null>(null)
  const scope = userId ? `${userId}:${layoutId}` : null
  const rev = draft.bundle?.rev ?? null
  const serverSettled = !server || server.settled
  const serverDraft = server?.draft ?? null
  const serverOn = !!server && server.available
  const writer = server?.writer
  const writerRef = useRef(writer)
  writerRef.current = writer

  // Send a waiting write now (the editor moves on: another layout, or closes).
  const flush = useCallback(() => {
    const w = queued.current
    if (!w) return
    clearTimeout(w.timer)
    queued.current = null
    writerRef.current
      ?.write(w.layoutId, { steps: w.steps, baseRev: w.baseRev })
      .catch(() => undefined)
  }, [])
  useEffect(() => flush, [flush])

  useEffect(() => {
    if (!scope || !userId || !rev || !serverSettled || checked.current === scope) return
    flush()
    checked.current = scope
    pending.current = false
    onServer.current = !!serverDraft
    setState(null)
    setSync(serverOn ? 'idle' : 'off')
    // Unsaved changes still in memory (the layout was reopened in this tab) are the newer copy.
    if (draft.unsavedSteps.length > 0) return
    const local = readStoredDraft(layoutId, userId)
    const remote = fromServerDraft(serverDraft, layoutId, userId)
    const chosen = pickDraft(local, remote)
    if (!chosen) return
    pending.current = true
    setState({
      kind: 'offer',
      draft: chosen,
      stale: chosen.baseRev !== draft.baseRev,
      source: chosen === remote ? 'server' : 'browser'
    })
  }, [
    scope,
    userId,
    rev,
    layoutId,
    draft.unsavedSteps.length,
    draft.baseRev,
    serverSettled,
    serverDraft,
    serverOn,
    flush
  ])

  const steps = draft.unsavedSteps
  const saving = draft.status === 'saving'
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` re-runs it once an offer is settled
  useEffect(() => {
    if (!scope || !userId || checked.current !== scope || pending.current || saving) return
    if (queued.current) {
      clearTimeout(queued.current.timer)
      queued.current = null
    }
    if (steps.length > 0 && draft.baseRev) {
      const stored: StoredDraft = {
        v: 1,
        layoutId,
        userId,
        baseRev: draft.baseRev,
        steps: steps.map((s) => ({ label: s.label, ops: s.ops as LayoutOp[] })),
        at: Date.now()
      }
      writeStoredDraft(stored)
      if (!writer || !serverOn) return
      setSync('pending')
      const timer = setTimeout(() => {
        queued.current = null
        writer
          .write(layoutId, { steps: stored.steps, baseRev: stored.baseRev })
          .then(() => {
            onServer.current = true
            setSync('kept')
          })
          .catch(() => setSync('failed'))
      }, STAGED_SYNC_MS)
      queued.current = { timer, layoutId, steps: stored.steps, baseRev: stored.baseRev }
    } else if (steps.length === 0) {
      clearStoredDraft(layoutId, userId)
      if (writer && serverOn && onServer.current) {
        onServer.current = false
        writer.clear(layoutId).catch(() => undefined)
      }
      if (serverOn) setSync('idle')
    }
  }, [scope, userId, layoutId, steps, saving, draft.baseRev, state, writer, serverOn])

  const restore = draft.restore
  const recover = useCallback(() => {
    if (state?.kind !== 'offer') return
    pending.current = false
    setState(null)
    restore(state.draft.steps)
  }, [state, restore])

  const dismiss = useCallback(() => {
    if (state?.kind === 'offer' && userId) {
      clearStoredDraft(layoutId, userId)
      if (writer && serverOn && onServer.current) {
        onServer.current = false
        writer.clear(layoutId).catch(() => undefined)
      }
    }
    pending.current = false
    setState(null)
  }, [state, userId, layoutId, writer, serverOn])

  return { state, recover, dismiss, sync }
}

/** The status chip's tip while changes wait: where they are kept. */
export function stagedTip(sync: StagedSync): string {
  const base = 'Only you see these changes until you save (⌘S).'
  switch (sync) {
    case 'kept':
      return `${base} Kept for you on the server: carry on from any browser.`
    case 'pending':
      return `${base} Keeping them for you on the server…`
    case 'failed':
      return `${base} They are kept in this browser; the server copy could not be written.`
    case 'off':
      return `${base} They are kept in this browser.`
    default:
      return base
  }
}
