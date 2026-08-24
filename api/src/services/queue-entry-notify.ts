import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { fetchQueueItems } from './queues.js'

/**
 * Instant queue-entry notifications (#121) + saved-view arrivals (#379).
 * Every 5 minutes, for each ACTIVE instant queue subscription: resolve the
 * queue's current id set AS THE SUBSCRIBER (RBAC/scopes apply), diff against
 * the stored watermark, notify on new arrivals. The view-subscriptions
 * pattern: first run is baseline-only; sets over the cap degrade honestly to
 * count-only deltas.
 */

const ID_CAP = 5000

interface SubRow {
  id: number
  user: string
  queue_id: string
  queue_view_id: number | null
  queue_last_ids: string | null
  label: string | null
}

export async function runQueueEntryNotifyPass(app: FastifyInstance): Promise<void> {
  const subs = (await db('nivaro_notification_subscriptions')
    .whereNotNull('queue_id')
    .where({ is_active: true, digest_frequency: 'instant' })
    .select('id', 'user', 'queue_id', 'queue_view_id', 'queue_last_ids', 'label')) as SubRow[]
  if (subs.length === 0) return

  for (const sub of subs) {
    try {
      const user = await db('nivaro_users').where({ id: sub.user }).first()
      if (!user || String(user.status ?? '').toLowerCase() === 'suspended') continue
      const queue = (await db('nivaro_queues').where({ id: sub.queue_id }).first('name')) as
        | { name?: string }
        | undefined
      if (!queue) continue

      // Saved-view scope (#379): apply the view's scope + column filters so
      // "new arrivals" means new IN THE VIEW, not merely in the queue.
      let scope: 'mine' | 'unowned' | 'all' | 'claimed' = 'all'
      let filters: Record<string, unknown> | undefined
      if (sub.queue_view_id != null) {
        const view = (await db('nivaro_queue_views')
          .where({ id: sub.queue_view_id, queue_id: sub.queue_id })
          .first('state', 'name')) as { state?: string; name?: string } | undefined
        if (!view) continue // stale view — skip silently, like view subscriptions
        try {
          const st = JSON.parse(view.state ?? '{}') as {
            scope?: string
            filters?: Record<string, unknown>
          }
          if (st.scope === 'mine' || st.scope === 'unowned' || st.scope === 'claimed')
            scope = st.scope
          if (st.filters && typeof st.filters === 'object') filters = st.filters
        } catch {
          /* unreadable state = whole queue */
        }
      }

      const { items, total } = await fetchQueueItems(sub.queue_id, user as never, scope, {
        filters,
        limit: ID_CAP,
        page: 1
      })
      const currentIds = items.map((i) => `${i.collection}:${i.item_id}`)
      const overCap = total > ID_CAP

      let prev: string[] | { count: number } | null = null
      try {
        prev = JSON.parse(sub.queue_last_ids ?? 'null')
      } catch {
        prev = null
      }

      const snapshot = overCap ? { count: total } : currentIds
      await db('nivaro_notification_subscriptions')
        .where({ id: sub.id })
        .update({ queue_last_ids: JSON.stringify(snapshot) })

      if (prev == null) continue // baseline pass — never notify on first run

      let newOnes: string[] = []
      if (Array.isArray(prev) && !overCap) {
        const prevSet = new Set(prev)
        newOnes = currentIds.filter((k) => !prevSet.has(k))
      } else {
        // Count-only mode: notify when the total grew.
        const prevCount = Array.isArray(prev) ? prev.length : Number(prev?.count ?? 0)
        if (total > prevCount) newOnes = Array(total - prevCount).fill('?')
      }
      if (newOnes.length === 0) continue

      const first = items.find((i) => newOnes.includes(`${i.collection}:${i.item_id}`))
      const { notifyUser } = await import('./notification-channels.js')
      await notifyUser(app, sub.user, {
        subject: `${queue.name ?? 'Queue'}: ${newOnes.length} new item${newOnes.length === 1 ? '' : 's'}`,
        message:
          first && newOnes.length === 1
            ? `"${first.label}" just entered ${sub.label ?? queue.name ?? 'the queue'}.`
            : `${newOnes.length} items entered ${sub.label ?? queue.name ?? 'the queue'} in the last few minutes.`,
        ...(first && newOnes.length === 1
          ? { collection: first.collection, item: String(first.item_id) }
          : {})
      })
    } catch {
      // One broken subscription must not stop the rest.
    }
  }
}
