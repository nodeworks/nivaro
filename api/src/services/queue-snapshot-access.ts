import { db } from '../db/index.js'
import { accessSignature } from './queue-trend-guard.js'
import type { QueueRow, QueueSourceRow } from './queues.js'
import { restrictScopesFor } from './user-scopes.js'

// Who may read a worklist's stored daily snapshots as THEIR numbers (army 11 Q2-7):
// the snapshots are resolved as the queue's owner, so they answer a viewer only when
// the two carry the same restrict-mode User Scopes. Used by /queues/:id/trends,
// /queues/badges and report-studio queue widgets.

/** A person's restrict-mode scopes as one comparable string ('[]' = nothing narrows them). */
export async function accessSigFor(
  user: { id: string; api_key_scope_restrictions?: unknown } | null | undefined
): Promise<string> {
  if (!user?.id) return '[]'
  return accessSignature(await restrictScopesFor(user as never).catch(() => []))
}

/**
 * Do the queue's stored snapshots (resolved as its OWNER) count what THIS viewer sees?
 * Only when the two carry the same restrict-mode User Scopes — otherwise a delta is the
 * slice one of them may not see, not movement (army 11 Q2-7), and it would leak counts.
 */
export async function snapshotsFitViewer(
  queue: Pick<QueueRow, 'owner'>,
  viewer: { id: string; api_key_scope_restrictions?: unknown } | null | undefined,
  ownerSigs: Map<string, Promise<string>> = new Map()
): Promise<boolean> {
  const mine = await accessSigFor(viewer)
  const ownerId = queue.owner ? String(queue.owner) : ''
  if (!ownerId) return mine === '[]'
  let theirs = ownerSigs.get(ownerId)
  if (!theirs) {
    theirs = (async () => {
      const row = (await db('nivaro_users').where({ id: ownerId }).first('id')) as
        | { id: string }
        | undefined
      return row ? accessSigFor(row) : '[]'
    })()
    ownerSigs.set(ownerId, theirs)
  }
  return mine === (await theirs)
}

export type DefSourceRow = Pick<
  QueueSourceRow,
  'type' | 'collection' | 'filters' | 'state_values' | 'state_mode' | 'sla_filter'
>
export async function queueDefSources(queueId: string): Promise<DefSourceRow[]> {
  return (await db('nivaro_queue_sources')
    .where({ queue_id: queueId })
    .select(
      'type',
      'collection',
      'filters',
      'state_values',
      'state_mode',
      'sla_filter'
    )) as DefSourceRow[]
}
