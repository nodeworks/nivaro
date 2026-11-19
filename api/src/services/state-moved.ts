import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { announceRawWrites } from './raw-write-announcer.js'
import { announceAddendumChange, announceRecordAspect } from './record-events.js'
import { currentTenantKey } from './tenant-rooms.js'

const mirrorCache = new Map<string, { at: number; field: string | null }>()
const MIRROR_TTL_MS = 15_000

/** Tests: forget the cached bindings. */
export function clearMirrorCache(): void {
  mirrorCache.clear()
}

/**
 * The column a collection's pipeline binding mirrors the state into (`state_field`), or null.
 * A move that mirrors it names it in the same `$state` notice so list columns re-read (B1
 * concern, controller ruling). Cached briefly: a bulk move asks once per collection.
 */
export async function mirroredStateField(collection: string): Promise<string | null> {
  // Module state is shared by every cloud tenant: key by tenant too.
  const key = `${currentTenantKey()}|${collection}`
  const hit = mirrorCache.get(key)
  if (hit && Date.now() - hit.at < MIRROR_TTL_MS) return hit.field
  let field: string | null = null
  try {
    const b = (await db('nivaro_workflow_bindings').where({ collection }).first('state_field')) as
      | { state_field?: string | null }
      | undefined
    field = b?.state_field ? String(b.state_field) : null
  } catch {
    /* no binding table / read failed: no field */
  }
  mirrorCache.set(key, { at: Date.now(), field })
  return field
}

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
  announceRecordAspect(collection, item, '$state', await mirroredStateField(collection))
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
  for (const [collection, ids] of by) {
    void mirroredStateField(collection).then((field) =>
      announceRawWrites(collection, ids, {
        changed_fields: field ? ['$state', field] : ['$state'],
        source,
        noticeOnly: true
      })
    )
  }
}

/** Materialized queue rows re-synced after a template delete; more than this waits for the
 *  queue's own rematerialize (the `$state` notice still reaches every open page). */
const TEMPLATE_DELETE_QUEUE_SYNC_CAP = 500

/**
 * rt-fix C (L3): a pipeline template was deleted with every instance — the records it ran on
 * have no step any more. One coalesced `$state` notice per collection (pipeline panel, list state
 * column, owner chips), then their materialized queue rows re-sync in the background pool.
 * Never throws.
 */
export function announceTemplateGone(
  moves: Array<{ collection: string; item: string }>,
  templateId: string
): void {
  if (moves.length === 0) return
  try {
    announceStatesMoved(moves, `template-delete:${templateId}`)
  } catch {
    /* live refresh only */
  }
  const sync = moves.slice(0, TEMPLATE_DELETE_QUEUE_SYNC_CAP)
  void runInBackgroundPool(async () => {
    try {
      const { syncMaterializedQueueItem } = await import('./queue-materialization.js')
      for (const m of sync)
        await syncMaterializedQueueItem(m.collection, String(m.item)).catch(() => {})
    } catch {
      /* a rematerialize repairs the cache */
    }
  })
}
