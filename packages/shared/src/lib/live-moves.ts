import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { LIVE_ASPECTS, type LiveBatch, useLiveRecord } from './live'

/**
 * Move buttons switch on live (realtime round 2). Which moves a record offers — a transition's
 * condition, its requirements, an extension check's advisory ("needs a PO number"), who owns
 * the step — can turn true or false because of a change somebody else made: a partner wrote
 * the PO number back, a colleague uploaded the file the move needs, a line was added. The
 * pipeline panel re-reads its own `/pipelines/instance` answer (as the viewer, so every role,
 * owner and check is judged for them) when the record's live events say something that could
 * matter moved, instead of keeping the buttons it drew on open.
 *
 * - Coalesced per record: one re-read per MOVES_GAP_MS at most, however many panels show the
 *   record's moves (the header buttons and the panel share one query) and however long the burst.
 * - Never under the person's hands: while a move's confirm or requirements dialog is open
 *   (`hold`), the re-read waits and runs once it closes.
 * - Notices that cannot change a move (a comment, a task, an edit lock, the SLA clock) are
 *   ignored. Moves that newly appear are inert for a beat already (FreshButtonGuard).
 */

export const MOVES_GAP_MS = 1500

/** Aspects that never change which moves are on offer. */
const IRRELEVANT: ReadonlySet<string> = new Set([
  LIVE_ASPECTS.comments,
  LIVE_ASPECTS.tasks,
  LIVE_ASPECTS.lock,
  LIVE_ASPECTS.sla
])

/** Could this batch change the moves a record offers? (Exported for tests.) */
export function movesMayChange(batch: Pick<LiveBatch, 'changedFields' | 'deleted'>): boolean {
  if (batch.deleted) return false
  if (batch.changedFields === null) return true
  return batch.changedFields.some((f) => !IRRELEVANT.has(f))
}

// record key → last re-read time / pending timer, shared by every panel on the page.
const lastAt = new Map<string, number>()
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** When the next re-read for this record may run (exported for tests). */
export function nextMovesRefresh(
  last: number | undefined,
  now: number,
  gap = MOVES_GAP_MS
): number {
  return last == null ? now : Math.max(now, last + gap)
}

export function useLiveMoves(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  opts: { hold?: boolean; enabled?: boolean } = {}
): void {
  const qc = useQueryClient()
  const holdRef = useRef(!!opts.hold)
  holdRef.current = !!opts.hold
  const owedRef = useRef(false)
  const id = item == null ? '' : String(item)
  const key = `${collection ?? ''}\u0001${id}`

  const refresh = () => {
    if (!collection || !id) return
    if (holdRef.current) {
      owedRef.current = true
      return
    }
    if (pending.has(key)) return
    const now = Date.now()
    const at = nextMovesRefresh(lastAt.get(key), now)
    const t = setTimeout(
      () => {
        pending.delete(key)
        lastAt.set(key, Date.now())
        if (lastAt.size > 200) lastAt.clear()
        // Every panel's key for this record (the plain one, previews by role / person).
        void qc.invalidateQueries({ queryKey: ['pipeline-instance', collection, id] })
        void qc.invalidateQueries({ queryKey: ['pipeline-instance', collection, Number(id)] })
      },
      Math.max(250, at - now)
    )
    pending.set(key, t)
  }

  useLiveRecord(
    collection,
    id || null,
    (batch) => {
      if (movesMayChange(batch)) refresh()
    },
    { enabled: opts.enabled !== false && !!collection && !!id }
  )

  // A re-read owed while a dialog was open runs when it closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh reads refs
  useEffect(() => {
    if (!opts.hold && owedRef.current) {
      owedRef.current = false
      refresh()
    }
  }, [opts.hold])
}
