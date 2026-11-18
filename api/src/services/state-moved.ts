import { announceRawWrites } from './raw-write-announcer.js'
import { announceAddendumChange, announceRecordAspect } from './record-events.js'

/**
 * A record's pipeline state moved OUTSIDE `applyTransition` (S4/S5/S6, realtime gaps
 * 2026-11-17): GraphQL start/transition mutations, the REST start route, a parallel split or
 * join. `applyTransition` (workflow-transitions.ts) keeps materialized queue rows current and
 * announces `$state`; these paths did neither, so the pipeline panel, list state column,
 * queues and owner badges kept the old step until a reload (owner-change-live ignores moves on
 * purpose because the move announces `$state` itself).
 *
 * Never throws; ids + the aspect name only.
 */
export async function announceStateMoved(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  opts: { syncQueues?: boolean } = {}
): Promise<void> {
  if (!collection || item == null || item === '') return
  if (opts.syncQueues !== false) {
    try {
      const { syncMaterializedQueueItem } = await import('./queue-materialization.js')
      await syncMaterializedQueueItem(collection, String(item))
    } catch {
      /* queue sync is best-effort here, as in applyTransition's callers */
    }
  }
  announceRecordAspect(collection, item, '$state')
  if (collection === 'nivaro_addendums') void announceAddendumChange(String(item))
}

/**
 * Many records moved at once (admin bulk start, instance migration): one coalesced `$state`
 * notice per collection through the raw-write announcer (more than 100 ids fold into one
 * "records in this collection changed" notice). Never throws.
 */
export function announceStatesMoved(
  moves: ReadonlyArray<{ collection: string; item: string | number }>,
  source: string
): void {
  const by = new Map<string, Array<string | number>>()
  for (const m of moves) {
    if (!m?.collection || m.item == null || m.item === '') continue
    const list = by.get(m.collection) ?? []
    list.push(m.item)
    by.set(m.collection, list)
  }
  for (const [collection, ids] of by)
    void announceRawWrites(collection, ids, { changed_fields: ['$state'], source })
}
