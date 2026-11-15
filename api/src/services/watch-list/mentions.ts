import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { commentTextForPreview } from '../comment-images.js'
import { whereInList } from '../db-batch.js'

/**
 * The dock's "Mentions & replies" tab (rt5 round 6):
 *
 * - Mentions are the person's own `mentions` notifications, so their read state IS the
 *   notification's: reading one here marks it read in the bell (POST /notifications/:id/read,
 *   which tells every tab), and reading it in the bell shows here.
 * - Replies are comments other people left after the person's own newest comment on the same
 *   record thread (a field's thread counts on its own) in the last 30 days. They have no
 *   notification row; their read mark is the watch list's `replies_seen_at`.
 *
 * Read AS THE PERSON: a reply on a record they can no longer open, or on a field they may not
 * read, is left out; record names come from the viewer-scoped label read.
 */

export const MENTIONS_DAYS = 30
const LIMIT = 40

export interface MentionItem {
  key: string
  kind: 'mention' | 'reply'
  /** Notification id (mentions only) — what "mark read" acts on. */
  notification_id: number | null
  collection: string | null
  item: string | null
  title: string | null
  by: { id: string; name: string } | null
  text: string
  at: string
  unread: boolean
  field: string | null
}

/** Strip a comment to one readable line. Exported for tests. */
export function previewLine(text: string, max = 160): string {
  const plain = commentTextForPreview(String(text ?? ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

/** Replies to the person: others' comments newer than their own on the same thread. Pure. */
export function repliesFrom(
  mine: Array<{ collection: string; item: string; field: string | null; at: Date | string }>,
  others: Array<{
    id: string
    collection: string
    item: string
    field: string | null
    user: string | null
    created_at: Date | string
    text: string
  }>,
  selfId: string
): typeof others {
  const myLast = new Map<string, number>()
  for (const m of mine) {
    const k = `${m.collection}|${m.item}|${m.field ?? ''}`
    const t = new Date(m.at).getTime()
    if (!myLast.has(k) || (myLast.get(k) ?? 0) < t) myLast.set(k, t)
  }
  const me = selfId.toLowerCase()
  return others.filter((c) => {
    if (!c.user || c.user.toLowerCase() === me) return false
    const t = myLast.get(`${c.collection}|${c.item}|${c.field ?? ''}`)
    return t != null && new Date(c.created_at).getTime() > t
  })
}

export async function readMentions(
  user: User,
  isAdmin: boolean,
  repliesSeenAt: string | null,
  now: Date = new Date()
): Promise<{ items: MentionItem[]; unread: number }> {
  const selfId = String(user.id)
  const since = new Date(now.getTime() - MENTIONS_DAYS * 86_400_000)

  const [notes, mine] = await Promise.all([
    db('nivaro_notifications')
      .where({ recipient: selfId, category: 'mentions' })
      .whereIn('status', ['inbox', 'read'])
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(LIMIT)
      .select('id', 'timestamp', 'status', 'sender', 'message', 'collection', 'item')
      .catch(() => []) as Promise<
      Array<{
        id: number
        timestamp: Date
        status: string
        sender: string | null
        message: string | null
        collection: string | null
        item: string | null
      }>
    >,
    db('nivaro_comments')
      .where({ user: selfId })
      .whereNull('deleted_at')
      .where('created_at', '>=', since)
      .whereNot('collection', 'nivaro_revisions')
      .groupBy('collection', 'item', 'field')
      .select('collection', 'item', 'field')
      .max({ at: 'created_at' })
      .limit(200)
      .catch(() => []) as Promise<
      Array<{ collection: string; item: string; field: string | null; at: Date }>
    >
  ])

  // Others' comments on the threads the person wrote on, newest first.
  const byCol = new Map<string, Set<string>>()
  for (const m of mine) {
    if (/^(nivaro_|directus_)/i.test(m.collection)) continue
    const s = byCol.get(m.collection) ?? new Set<string>()
    s.add(String(m.item))
    byCol.set(m.collection, s)
  }
  type C = {
    id: string
    collection: string
    item: string
    field: string | null
    user: string | null
    created_at: Date
    text: string
  }
  const others: C[] = []
  const { compileAccessGates, visibleIds } = await import('../record-access.js')
  const { getAllowedFields } = await import('../permissions.js')
  for (const [collection, idSet] of byCol) {
    const ids = [...idSet]
    const gates = await compileAccessGates(user, collection, { actingAdmin: isAdmin }).catch(
      () => null
    )
    if (!gates) continue
    const visible = await visibleIds(gates, ids).catch(() => new Set<string>())
    if (visible.size === 0) continue
    const allowed = isAdmin
      ? null
      : await getAllowedFields(user, 'read', collection).catch(() => [] as string[])
    const rows = (await whereInList(
      db('nivaro_comments').where({ collection }).whereNull('deleted_at'),
      'item',
      [...visible]
    )
      .where('created_at', '>=', since)
      .whereNot('user', selfId)
      .orderBy('created_at', 'desc')
      .limit(LIMIT)
      .select('id', 'collection', 'item', 'field', 'user', 'created_at', 'text')
      .catch(() => [])) as C[]
    for (const r of rows) {
      if (r.field && allowed && !allowed.includes('*') && !allowed.includes(r.field)) continue
      others.push(r)
    }
  }
  // A reply that also @mentioned the person is already a mention row: show it once.
  const mentionAt = notes.map((n) => ({
    k: `${n.collection}|${n.item}|${String(n.sender ?? '').toLowerCase()}`,
    t: new Date(n.timestamp).getTime()
  }))
  const replies = repliesFrom(mine, others, selfId).filter((r) => {
    const k = `${r.collection}|${r.item}|${String(r.user ?? '').toLowerCase()}`
    const t = new Date(r.created_at).getTime()
    return !mentionAt.some((m) => m.k === k && Math.abs(m.t - t) < 60_000)
  })

  const people = new Set<string>()
  for (const n of notes) if (n.sender) people.add(String(n.sender))
  for (const r of replies) if (r.user) people.add(String(r.user))
  const names: Record<string, string> = {}
  if (people.size > 0) {
    const rows = (await db('nivaro_users')
      .whereIn('id', [...people])
      .select('id', 'first_name', 'last_name', 'is_redacted')
      .catch(() => [])) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      is_redacted: unknown
    }>
    for (const r of rows)
      names[String(r.id).toLowerCase()] = r.is_redacted
        ? 'Former user'
        : `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Someone'
  }
  const refs = [
    ...notes
      .filter((n) => n.collection && n.item && !/^(nivaro_|directus_)/i.test(n.collection))
      .map((n) => ({ collection: String(n.collection), id: String(n.item) })),
    ...replies.map((r) => ({ collection: r.collection, id: String(r.item) }))
  ]
  let titles: Record<string, string> = {}
  if (refs.length > 0) {
    try {
      const { recordLabelsAsViewer } = await import('../record-labels-as-viewer.js')
      titles = await recordLabelsAsViewer(user, refs)
    } catch {
      /* titles stay empty */
    }
  }
  const person = (id: string | null) =>
    id ? { id, name: names[id.toLowerCase()] ?? 'Someone' } : null
  const seenT = repliesSeenAt ? new Date(repliesSeenAt).getTime() : 0
  const items: MentionItem[] = [
    ...notes.map(
      (n): MentionItem => ({
        key: `m:${n.id}`,
        kind: 'mention',
        notification_id: Number(n.id),
        collection: n.collection,
        item: n.item != null ? String(n.item) : null,
        title: n.collection && n.item ? (titles[`${n.collection}:${n.item}`] ?? null) : null,
        by: person(n.sender),
        text: previewLine(n.message ?? ''),
        at: new Date(n.timestamp).toISOString(),
        unread: n.status === 'inbox',
        field: null
      })
    ),
    ...replies.map(
      (r): MentionItem => ({
        key: `r:${r.id}`,
        kind: 'reply',
        notification_id: null,
        collection: r.collection,
        item: String(r.item),
        title: titles[`${r.collection}:${r.item}`] ?? null,
        by: person(r.user),
        text: previewLine(r.text),
        at: new Date(r.created_at).toISOString(),
        unread: new Date(r.created_at).getTime() > seenT,
        field: r.field ?? null
      })
    )
  ]
    .sort((a, z) => new Date(z.at).getTime() - new Date(a.at).getTime())
    .slice(0, LIMIT)
  return { items, unread: items.filter((i) => i.unread).length }
}
