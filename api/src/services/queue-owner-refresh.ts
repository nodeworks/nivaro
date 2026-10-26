import { AsyncResource } from 'node:async_hooks'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { onOwnersChanged } from '../db/owner-signal.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * A materialized worklist caches each row's owners (nivaro_queue_item_owners)
 * and re-syncs a row when its RECORD is written or moves. An owner change that
 * touches no record — an owner group, its people or teams, a team's members, a
 * binding, a manual owner, a delegate or out-of-office — would leave "My
 * items" wrong until the next full rebuild, and nothing scheduled one. Such a
 * change ('rules', db/owner-signal.ts) re-syncs every cached row in place —
 * never the backfill, which empties a worklist while it runs: after 30 s of
 * quiet, at most 2 min after the first change, on the background pool.
 */
const QUIET_MS = 30_000
const MAX_WAIT_MS = 120_000

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; first: number }>()

export function scheduleMaterializedOwnerRefresh(): void {
  const tenant = currentTenantKey()
  const now = Date.now()
  const prev = pending.get(tenant)
  if (prev) clearTimeout(prev.timer)
  const first = prev?.first ?? now
  // Bound to the caller's async context: the timer fires inside the tenant
  // the change was made in (cloud mode keys its database off that context).
  const run = AsyncResource.bind(() => {
    pending.delete(tenant)
    void runInBackgroundPool(() => refreshMaterializedOwners()).catch(() => {})
  })
  const timer = setTimeout(run, Math.max(0, Math.min(QUIET_MS, first + MAX_WAIT_MS - now)))
  timer.unref?.()
  pending.set(tenant, { timer, first })
}

/**
 * Re-sync every record cached in a materialized worklist (its row, owners
 * included), each record once however many worklists hold it, a few at a
 * time. Rows are updated where they stand, so the worklist never reads empty.
 * Returns how many records were re-synced.
 */
export async function refreshMaterializedOwners(concurrency = 4): Promise<number> {
  const rows = (await db('nivaro_queue_items as qi')
    .join('nivaro_queues as q', 'q.id', 'qi.queue_id')
    .where('q.materialized', true)
    .select('qi.collection', 'qi.item_id')) as Array<{ collection: string; item_id: string }>
  const seen = new Set<string>()
  const records = rows.filter((r) => {
    const k = `${r.collection}\u0001${String(r.item_id).toUpperCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (records.length === 0) return 0
  const { syncMaterializedQueueItem } = await import('./queue-materialization.js')
  let next = 0
  const worker = async () => {
    while (next < records.length) {
      const r = records[next++]
      await syncMaterializedQueueItem(r.collection, String(r.item_id)).catch(() => {})
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker))
  return records.length
}

/**
 * Materialized worklists with no cache rows at all — a database copied or
 * restored without its regenerated tables (the nightly config promote copies
 * nivaro_queues but never nivaro_queue_items) reads as an empty worklist.
 * Each gets a rebuild. A worklist that really matches nothing is rebuilt
 * cheaply each pass. Returns the ids enqueued.
 */
export async function healEmptyMaterializedQueues(): Promise<string[]> {
  const empty = (await db('nivaro_queues as q')
    .where('q.materialized', true)
    .whereNotExists(
      db('nivaro_queue_items as qi').whereRaw('qi.queue_id = q.id').select(db.raw('1'))
    )
    .select('q.id')) as Array<{ id: string }>
  if (empty.length === 0) return []
  const { enqueueQueueMaterializationBackfill } = await import(
    '../functions/queue-materialization-jobs.js'
  )
  for (const { id } of empty) await enqueueQueueMaterializationBackfill(String(id))
  return empty.map((r) => String(r.id))
}

onOwnersChanged((change) => {
  if (change?.kind === 'rules') scheduleMaterializedOwnerRefresh()
})
