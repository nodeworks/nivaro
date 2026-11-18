import { syncMaterializedQueueItem } from './queue-materialization.js'

/** Records one call re-syncs at most; past it the rest wait for the queue's own backfill. */
export const QUEUE_SYNC_MAX = 500
/** Records synced at once (each one is a few small reads + one upsert per materialized queue). */
const CONCURRENCY = 4

export interface QueueSyncResult {
  synced: number
  failed: number
  /** Ids past QUEUE_SYNC_MAX that were not synced. */
  skipped: number
}

/**
 * Re-sync the materialized queue rows of these records (`ctx.queues.syncRecord`, B1 fix round
 * for efp-ops E1): an extension that moves a pipeline raw has no other way to keep queue caches
 * current, because only `applyTransition` and the items service call syncMaterializedQueueItem.
 * Runs in the caller's async context (its tenant), bounded (QUEUE_SYNC_MAX ids, CONCURRENCY at
 * once); a failure is logged and never thrown.
 */
export async function syncQueueRecords(
  collection: string,
  ids: string | number | ReadonlyArray<string | number>,
  log: (msg: string, err?: unknown) => void = (msg, err) =>
    console.warn(`[queues.syncRecord] ${msg}`, err instanceof Error ? err.message : (err ?? ''))
): Promise<QueueSyncResult> {
  const result: QueueSyncResult = { synced: 0, failed: 0, skipped: 0 }
  if (!collection || typeof collection !== 'string') return result
  const list = [
    ...new Set(
      (Array.isArray(ids) ? ids : [ids])
        .filter((i) => i != null && String(i).trim() !== '')
        .map((i) => String(i).trim())
    )
  ]
  const todo = list.slice(0, QUEUE_SYNC_MAX)
  result.skipped = list.length - todo.length
  if (result.skipped > 0)
    log(`${collection}: ${result.skipped} record(s) past the ${QUEUE_SYNC_MAX} cap were not synced`)
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++]
      try {
        await syncMaterializedQueueItem(collection, id)
        result.synced++
      } catch (err) {
        result.failed++
        log(`${collection}/${id} failed`, err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
  return result
}
