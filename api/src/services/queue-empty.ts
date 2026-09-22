/**
 * Why is this queue view empty? (#502)
 *
 * `scope=mine` legitimately returns nothing for someone who owns nothing,
 * which looked identical to a broken filter or a source the viewer may not
 * read — it even made a before/after comparison pass vacuously. When a queue
 * read comes back with zero rows the route attaches one of these, most
 * specific cause first. Cheap by design: permission checks per source, and
 * the whole-queue count only where the materialized cache answers it in SQL.
 */
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can } from './permissions.js'
import type { QueueScope } from './queues.js'

export interface QueueEmptyReason {
  reason:
    | 'not_permitted'
    | 'filters'
    | 'scope_mine'
    | 'scope_unowned'
    | 'scope_claimed'
    | 'no_match'
  message: string
  /** Source collections this viewer cannot read (their rows never reach any scope). */
  unreadable: string[]
  /** Records in the whole queue ('all' scope) — only when cheaply known. */
  queue_total: number | null
}

export async function explainEmptyQueue(
  queueId: string,
  user: User,
  isAdmin: boolean,
  scope: QueueScope,
  filters: Record<string, unknown> | undefined
): Promise<QueueEmptyReason> {
  const sources = (await db('nivaro_queue_sources')
    .where({ queue_id: queueId })
    .select('type', 'collection')) as Array<{ type: string; collection: string | null }>
  const collections = [
    ...new Set(
      sources
        .filter((s) => s.type === 'collection' && s.collection)
        .map((s) => s.collection as string)
    )
  ]
  const unreadable: string[] = []
  if (!isAdmin)
    for (const c of collections)
      if (!(await can(user, 'read', c).catch(() => false))) unreadable.push(c)

  let queueTotal: number | null = null
  const q = (await db('nivaro_queues').where({ id: queueId }).first('materialized')) as
    | { materialized?: boolean | number }
    | undefined
  if (q?.materialized && scope !== 'all') {
    try {
      const { fetchMaterializedStats } = await import('./queue-materialization-read.js')
      queueTotal = (await fetchMaterializedStats(queueId, user, 'all')).stats.total
    } catch {
      queueTotal = null
    }
  }
  const nice = (c: string) => c.replace(/_/g, ' ')
  const inQueue =
    queueTotal != null
      ? ` — ${queueTotal.toLocaleString()} record${queueTotal === 1 ? ' is' : 's are'} in the queue`
      : ''
  const activeFilters = Object.entries(filters ?? {}).filter(
    ([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
  )

  if (collections.length > 0 && unreadable.length === collections.length)
    return {
      reason: 'not_permitted',
      message: `Your role cannot read ${unreadable.map(nice).join(', ')}, so none of this queue's records can appear for you. Ask an administrator for read access.`,
      unreadable,
      queue_total: null
    }
  const partly =
    unreadable.length > 0
      ? ` (Records from ${unreadable.map(nice).join(', ')} never appear for you — your role cannot read them.)`
      : ''
  if (activeFilters.length > 0)
    return {
      reason: 'filters',
      message: `No record matches the ${activeFilters.length === 1 ? 'filter' : `${activeFilters.length} filters`} you set${inQueue}. Clear a filter to widen the list.${partly}`,
      unreadable,
      queue_total: queueTotal
    }
  if (scope === 'mine')
    return {
      reason: 'scope_mine',
      message: `Nothing in this queue is waiting on you${inQueue}. Records appear here when you are an owner of their current step or have claimed them.${partly}`,
      unreadable,
      queue_total: queueTotal
    }
  if (scope === 'unowned')
    return {
      reason: 'scope_unowned',
      message: `Every record in this queue has an owner${inQueue}.${partly}`,
      unreadable,
      queue_total: queueTotal
    }
  if (scope === 'claimed')
    return {
      reason: 'scope_claimed',
      message: `You have not claimed anything in this queue${inQueue}.${partly}`,
      unreadable,
      queue_total: queueTotal
    }
  return {
    reason: 'no_match',
    message: `No record matches this queue's sources right now — records land here when they reach the states and conditions the sources name.${partly}`,
    unreadable,
    queue_total: queueTotal
  }
}
