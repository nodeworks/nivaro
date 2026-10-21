import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { deriveTarget, parseStoredTarget } from './notification-target.js'

/**
 * #1079 — did the notification lead to action? A notification whose target is
 * a record counts as "acted" when its RECIPIENT transitioned that record,
 * commented on it or completed a task on it within N hours of the send. The
 * notification analytics route rolls the verdict up per category / sender, so
 * a noisy category shows up as read-but-ignored.
 *
 * Notifications younger than N hours are left out of the denominator — their
 * window is still open, and counting them as "not acted" would punish whatever
 * was sent most recently.
 */

export const ACTED_DEFAULT_HOURS = 24
export const ACTED_MAX_HOURS = 168

export interface ActedNotification {
  id: number | string
  timestamp: Date | string
  recipient: string | null
  collection: string | null
  item: string | number | null
  subject: string | null
  target?: unknown
}

export interface ActedVerdict {
  /** The notification points at a record and its window has closed. */
  eligible: boolean
  acted: boolean
}

export function clampActedHours(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return ACTED_DEFAULT_HOURS
  return Math.min(ACTED_MAX_HOURS, Math.max(1, Math.round(n)))
}

const RECORD_KINDS = new Set(['record', 'sla', 'approval', 'access_request'])

/** The record a notification is about, or null when it points elsewhere. */
export function recordOf(n: ActedNotification): { collection: string; item: string } | null {
  const spec =
    parseStoredTarget(n.target) ??
    deriveTarget({ ...n, item: n.item == null ? null : String(n.item) })
  if (!spec || !RECORD_KINDS.has(spec.kind)) return null
  const collection = spec.collection?.trim()
  const item = spec.id != null && String(spec.id).trim() !== '' ? String(spec.id) : null
  if (!collection || !item) return null
  if (/^nivaro_/i.test(collection) || /^directus_/i.test(collection)) return null
  return { collection, item }
}

export const actionKey = (collection: string, item: string, user: string) =>
  `${collection}|${item}|${user.toUpperCase()}`

/** Pure verdict: eligible + acted for one notification against action times
 *  (epoch ms, any order) the recipient took on the record. */
export function verdictFor(
  n: ActedNotification,
  actions: Map<string, number[]>,
  hours: number,
  now: number
): ActedVerdict {
  const rec = recordOf(n)
  if (!rec || !n.recipient) return { eligible: false, acted: false }
  const sent = new Date(n.timestamp).getTime()
  if (!Number.isFinite(sent)) return { eligible: false, acted: false }
  const end = sent + hours * 3_600_000
  if (end > now) return { eligible: false, acted: false }
  const times = actions.get(actionKey(rec.collection, rec.item, String(n.recipient))) ?? []
  return { eligible: true, acted: times.some((t) => t >= sent && t <= end) }
}

/**
 * Every transition, comment and task completion the recipients made on the
 * records the notifications point at, since the earliest send. A table that is
 * missing or fails to read just contributes nothing (acted is decoration).
 */
export async function loadRecipientActions(
  notifications: ActedNotification[],
  since: Date
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  const add = (collection: string, item: unknown, user: unknown, at: unknown) => {
    if (user == null || item == null || !at) return
    const t = new Date(at as string).getTime()
    if (!Number.isFinite(t)) return
    const k = actionKey(collection, String(item), String(user))
    const list = out.get(k)
    if (list) list.push(t)
    else out.set(k, [t])
  }

  const byCollection = new Map<string, Set<string>>()
  for (const n of notifications) {
    const rec = recordOf(n)
    if (!rec || !n.recipient) continue
    const set = byCollection.get(rec.collection) ?? new Set<string>()
    set.add(rec.item)
    byCollection.set(rec.collection, set)
  }

  for (const [collection, items] of byCollection) {
    const ids = [...items]
    const safe = async (fn: () => Promise<void>) => {
      try {
        await fn()
      } catch {
        /* decoration — the other sources still count */
      }
    }
    await safe(async () => {
      const rows = await selectInChunks(ids, 1500, (chunk) =>
        db('nivaro_workflow_history as h')
          .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
          .where('i.collection', collection)
          .whereIn('i.item', chunk)
          .where('h.timestamp', '>=', since)
          .whereNotNull('h.user')
          // a start row (no from_state, no transition) is not an action
          .whereRaw('NOT (h.from_state IS NULL AND h.[transition] IS NULL)')
          .select('i.item as item', 'h.user as user', 'h.timestamp as at')
      )
      for (const r of rows as Array<{ item: unknown; user: unknown; at: unknown }>)
        add(collection, r.item, r.user, r.at)
    })
    await safe(async () => {
      const rows = await selectInChunks(ids, 1500, (chunk) =>
        db('nivaro_comments')
          .where({ collection })
          .whereIn('item', chunk)
          .where('created_at', '>=', since)
          .whereNull('deleted_at')
          .select('item', 'user', 'created_at as at')
      )
      for (const r of rows as Array<{ item: unknown; user: unknown; at: unknown }>)
        add(collection, r.item, r.user, r.at)
    })
    await safe(async () => {
      const rows = await selectInChunks(ids, 1500, (chunk) =>
        db('nivaro_tasks')
          .where({ collection })
          .whereIn('item', chunk)
          .whereNotNull('completed_by')
          .where('completed_at', '>=', since)
          .select('item', 'completed_by as user', 'completed_at as at')
      )
      for (const r of rows as Array<{ item: unknown; user: unknown; at: unknown }>)
        add(collection, r.item, r.user, r.at)
    })
  }
  return out
}

export interface ActedTally {
  eligible: number
  acted: number
  /** Read by the recipient yet never acted on within the window. */
  read_ignored: number
}

export const emptyTally = (): ActedTally => ({ eligible: 0, acted: 0, read_ignored: 0 })

export function tallyInto(
  m: Map<string, ActedTally>,
  key: string,
  v: ActedVerdict,
  read: boolean
): void {
  if (!v.eligible) return
  const cur = m.get(key) ?? emptyTally()
  cur.eligible++
  if (v.acted) cur.acted++
  else if (read) cur.read_ignored++
  m.set(key, cur)
}

/** Fields merged into a rollup row. */
export function actedFields(t: ActedTally | undefined) {
  const eligible = t?.eligible ?? 0
  return {
    acted_eligible: eligible,
    acted: t?.acted ?? 0,
    acted_rate: eligible ? (t?.acted ?? 0) / eligible : null,
    read_ignored: t?.read_ignored ?? 0,
    read_ignored_rate: eligible ? (t?.read_ignored ?? 0) / eligible : null
  }
}
