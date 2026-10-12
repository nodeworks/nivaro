import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { getIo } from './io-holder.js'
import { tenantScopedRoom } from './tenant-rooms.js'

/**
 * Read receipts on mentions (#2117). A person mentioned in a record's notes is
 * "seen" once they opened the record or read the mention's notification after
 * it was written — both are watermarks the app already keeps
 * (nivaro_record_views.last_viewed_at, nivaro_notifications.read_at), so no new
 * table and no new tracking. The answer is one timestamp per mention, shown
 * only to people reading that record's thread.
 */

/** A notification row counts for a comment written within this window before it. */
const NOTIFICATION_SKEW_MS = 120_000

export interface MentionRef {
  comment: string
  user: string
  /** When the comment was written. */
  at: Date | string
}

const key = (comment: string, user: string) => `${comment}|${String(user).toUpperCase()}`

/** The earliest moment this mention counts as seen, or null. Pure — exported for tests. */
export function seenAt(
  commentAt: Date,
  lastViewedAt: Date | null,
  mentionReadAts: Date[]
): Date | null {
  const candidates: Date[] = []
  if (lastViewedAt && lastViewedAt.getTime() >= commentAt.getTime()) candidates.push(lastViewedAt)
  for (const r of mentionReadAts)
    if (r.getTime() >= commentAt.getTime() - NOTIFICATION_SKEW_MS) candidates.push(r)
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b))
}

/** `${comment}|${USER}` → ISO time seen, for each mention that has been seen. */
export async function mentionReceipts(
  collection: string,
  item: string,
  mentions: MentionRef[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (mentions.length === 0) return out
  const users = [...new Set(mentions.map((m) => String(m.user)))]
  try {
    const views = (await selectInChunks(users, 500, (chunk) =>
      db('nivaro_record_views')
        .where({ collection, item_id: String(item) })
        .whereIn('user', chunk)
        .select('user', 'last_viewed_at')
    )) as Array<{ user: string; last_viewed_at: Date | null }>
    const viewedBy = new Map(
      views.map((v) => [
        String(v.user).toUpperCase(),
        v.last_viewed_at ? new Date(v.last_viewed_at) : null
      ])
    )
    const reads = (await selectInChunks(users, 500, (chunk) =>
      db('nivaro_notifications')
        .where({ collection, item: String(item), category: 'mentions' })
        .whereIn('recipient', chunk)
        .whereNotNull('read_at')
        .select('recipient', 'read_at')
    )) as Array<{ recipient: string; read_at: Date }>
    const readsBy = new Map<string, Date[]>()
    for (const r of reads) {
      const k = String(r.recipient).toUpperCase()
      const list = readsBy.get(k) ?? []
      list.push(new Date(r.read_at))
      readsBy.set(k, list)
    }
    for (const m of mentions) {
      const u = String(m.user).toUpperCase()
      const at = seenAt(new Date(m.at), viewedBy.get(u) ?? null, readsBy.get(u) ?? [])
      if (at) out.set(key(m.comment, m.user), at.toISOString())
    }
  } catch {
    /* a receipt is decoration — the thread still loads without it */
  }
  return out
}

export function receiptKey(comment: string, user: string): string {
  return key(comment, user)
}

/**
 * `userId` just opened the record. When that makes a mention of them newly seen, poke the
 * record's room with the same `record:comment` notice a new note sends, so open threads
 * refetch and show the mark. Payload: ids only.
 */
export async function announceMentionSeen(
  collection: string,
  item: string,
  userId: string,
  previouslyViewedAt: Date | string | null
): Promise<void> {
  try {
    const q = db('nivaro_comment_mentions as m')
      .join('nivaro_comments as c', 'm.comment', 'c.id')
      .where({ 'c.collection': collection, 'c.item': String(item), 'm.user': userId })
    if (previouslyViewedAt) q.where('c.created_at', '>', new Date(previouslyViewedAt))
    const hit = await q.first('m.id')
    if (!hit) return
    getIo()
      ?.to(tenantScopedRoom(`record:${collection}:${item}`))
      .emit('record:comment', { collection, item, user: userId })
  } catch {
    /* best-effort */
  }
}
