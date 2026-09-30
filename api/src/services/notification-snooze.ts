/**
 * Snooze until it changes (#647): a notification about a record can sleep
 * until that record moves — a field write or a pipeline state change by
 * someone other than the person who snoozed it — instead of until a time.
 *
 * The row keeps a far-future snoozed_until (so every existing "snoozed" filter
 * hides it) plus snooze_until_change = 1. A write wakes it: snoozed_until and
 * the flag cleared, status back to inbox, a live notification:new so the bell
 * shows it again. The per-write cost is one Set lookup unless the collection
 * has a pending until-change snooze (refreshed every 60s and on every snooze).
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { getIo } from './io-holder.js'

/** Far enough that no preset reaches it; within every dialect's datetime. */
export const UNTIL_CHANGE = new Date('9999-01-01T00:00:00Z')

let pending: { at: number; collections: Set<string> } | null = null

export function bustSnoozeCache(): void {
  pending = null
}

async function pendingCollections(): Promise<Set<string>> {
  if (pending && Date.now() - pending.at < 60_000) return pending.collections
  let collections = new Set<string>()
  if (await hasColumn('nivaro_notifications', 'snooze_until_change')) {
    const rows = (await db('nivaro_notifications')
      .where('snooze_until_change', true)
      .whereNotNull('collection')
      .distinct('collection')
      .catch(() => [])) as Array<{ collection: string }>
    collections = new Set(rows.map((r) => String(r.collection)))
  }
  pending = { at: Date.now(), collections }
  return collections
}

/** Snooze one of the caller's own notifications until its record changes. */
export async function snoozeUntilChange(
  id: string | number,
  userId: string
): Promise<'ok' | 'not-found' | 'no-record' | 'unsupported'> {
  if (!(await hasColumn('nivaro_notifications', 'snooze_until_change'))) return 'unsupported'
  const row = (await db('nivaro_notifications')
    .where({ id, recipient: userId })
    .first('id', 'collection', 'item')) as { collection?: string | null; item?: string | null } | undefined
  if (!row) return 'not-found'
  if (!row.collection || row.item == null || row.item === '') return 'no-record'
  await db('nivaro_notifications')
    .where({ id, recipient: userId })
    .update({ snoozed_until: UNTIL_CHANGE, snooze_until_change: true, status: 'inbox' })
  bustSnoozeCache()
  return 'ok'
}

/** Clearing any snooze also clears the until-change flag. */
export async function clearUntilChange(id: string | number, userId: string): Promise<void> {
  if (!(await hasColumn('nivaro_notifications', 'snooze_until_change'))) return
  await db('nivaro_notifications')
    .where({ id, recipient: userId })
    .update({ snooze_until_change: false })
    .catch(() => {})
}

/**
 * A record moved: wake every until-change snooze on it, except the ones held
 * by the person who moved it (their own edit is not news to them). Never
 * throws — a write must not fail because a notification could not wake.
 */
export async function wakeOnChange(
  collection: string,
  item: string | number,
  actorId: string | null,
  reason: string
): Promise<number> {
  try {
    if (!(await pendingCollections()).has(collection)) return 0
    const q = db('nivaro_notifications').where({
      snooze_until_change: true,
      collection,
      item: String(item)
    })
    if (actorId) q.whereNot('recipient', actorId)
    const rows = (await q.clone().select('id', 'recipient', 'subject', 'message')) as Array<{
      id: number
      recipient: string
      subject: string
      message: string | null
    }>
    if (rows.length === 0) return 0
    await db('nivaro_notifications')
      .whereIn(
        'id',
        rows.map((r) => r.id)
      )
      .update({ snoozed_until: null, snooze_until_change: false, status: 'inbox' })
    bustSnoozeCache()
    const io = getIo()
    for (const r of rows)
      io?.to(`user:${r.recipient}`).emit('notification:new', {
        id: r.id,
        subject: r.subject,
        message: r.message,
        collection,
        item: String(item),
        woke: reason
      })
    return rows.length
  } catch {
    return 0
  }
}
