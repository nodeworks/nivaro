import { db } from '../db/index.js'
import type { User } from '../types.js'
import { parseListViewTopic } from './list-viewer-topics.js'
import { can } from './permissions.js'
import { canUserReadQueue } from './queue-access.js'

/**
 * May `user` announce themselves on a list-viewer topic (list-viewer-topics.ts)? Only for a
 * list they could open: read access to the collection, or the queue's own visibility rule.
 * One cached permission check or one queue row per page open — never per event.
 */
export async function mayReadListTopic(
  user: User,
  topic: string,
  isAdmin: boolean
): Promise<boolean> {
  const t = parseListViewTopic(topic)
  if (!t) return false
  if (isAdmin) return true
  try {
    if (t.kind === 'list') return await can(user, 'read', t.id)
    const queue = (await db('nivaro_queues')
      .where({ id: t.id })
      .first('id', 'owner', 'is_shared', 'role_id')) as
      | { owner?: string | null; is_shared?: boolean | number | null; role_id?: string | null }
      | undefined
    return queue ? canUserReadQueue(queue, user, false) : false
  } catch {
    return false
  }
}
