import { db } from '../db/index.js'
import { announceNotificationsRead, emitToUserRoom } from './user-sync.js'

/**
 * A notification that asked someone to do something turns "done" by itself
 * once the thing is handled — by them or by anyone else. The row keeps its
 * place in the inbox, reads as read (the badge drops), and carries one calm
 * line: "Approved by Beth", "Moved to PUB'd by Beth", "Done by you".
 *
 * At send time notifyUser stores a resolution key in the row's `detail` JSON
 * (no migration): what would settle it.
 *
 *   step:<collection>:<item>   a workflow / SLA ask about a record — settled when the
 *                              record moves to another step
 *   task:<id>                  a task (assigned, team, reminder) — settled when done
 *   approval:<instance id>     an approval request — settled when its step is decided
 *   ticket:<id>                a support request — settled when it is closed
 *
 * When one of those happens, the writer calls `resolveNotifications(event)`:
 * open rows written BEFORE the event whose key matches are stamped
 * `detail.resolved = {by, by_name, at, text, on}`, set read, and the
 * recipient's tabs are told through their own user room (ids only — the tab
 * re-reads its inbox through the permission-checked route).
 *
 * Rows asking for an explicit acknowledgement are never settled for the
 * person: an acknowledgement is theirs to give.
 */

export type ResolveOn = 'step' | 'task' | 'approval' | 'ticket'

export type ResolveEvent =
  | {
      on: 'step'
      collection: string
      item: string
      at: Date
      actorId: string | null
      /** The step the record is in now. */
      stateLabel: string | null
      /** People whose ask carries on into the new step and who are not told
       *  again by the move (the actor, when they still own it): left open. */
      keepOpenFor?: string[]
    }
  | {
      on: 'task'
      id: string | number
      at: Date
      actorId: string | null
      collection?: string | null
      item?: string | null
    }
  | {
      on: 'approval'
      id: string | number
      at: Date
      actorId: string | null
      decision: 'approved' | 'rejected'
      collection?: string | null
      item?: string | null
    }
  | {
      on: 'ticket'
      id: string | number
      at: Date
      actorId: string | null
      status: 'done' | 'cancelled'
    }

export interface ResolvedStamp {
  on: ResolveOn
  by: string | null
  by_name: string | null
  at: string
  text: string
}

/** The stored detail JSON, parsed (local: notification-channels imports this file). */
export function parseDetail(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

const clean = (v: unknown) => (v == null ? '' : String(v).trim())

/**
 * Pure: the resolution key a notification is written with, or null when
 * nothing settles it (an FYI, a mention, a broadcast, an acknowledgement).
 */
export function resolveKeyFor(input: {
  category?: string | null
  lane?: string | null
  target?: {
    kind?: string | null
    collection?: string | null
    id?: string | number | null
    task_id?: string | number | null
    instance_id?: string | number | null
    action?: string | null
  } | null
  source?: { kind?: string | null; id?: string | number | null } | null
  subject?: string | null
  ackRequired?: boolean
  /** The recipient owns the record's current step (the reason it is needs-you). */
  owns?: boolean
}): string | null {
  if (input.ackRequired) return null
  const t = input.target ?? null
  const src = input.source ?? null
  // "Task done: …" tells the asker it is done — nothing left to settle.
  if (/^task done\b/i.test(clean(input.subject))) return null
  const taskId = clean(t?.task_id) || (src?.kind === 'task' ? clean(src.id) : '')
  if (taskId) return `task:${taskId}`
  if (t?.kind === 'task' && clean(t.id)) return `task:${clean(t.id)}`
  const ticketId =
    (t?.kind === 'support' ? clean(t.id) : '') || (src?.kind === 'support' ? clean(src.id) : '')
  if (ticketId) return `ticket:${ticketId}`
  if (t?.kind === 'approval') {
    const inst = clean(t.instance_id)
    return inst ? `approval:${inst}` : null
  }
  // A step ask: a workflow / SLA row about a record that the person is asked to act on.
  const lane = clean(input.lane)
  const category = clean(input.category)
  if (
    (t?.kind === 'record' || t?.kind === 'sla') &&
    clean(t.collection) &&
    clean(t.id) &&
    !/^(nivaro_|directus_|__)/i.test(clean(t.collection)) &&
    category !== 'mentions' &&
    t.action !== 'reply' &&
    (category === 'workflow' || category === 'sla' || input.owns === true) &&
    (lane === 'needs_you' || lane === 'critical')
  )
    return `step:${clean(t.collection)}:${clean(t.id)}`
  return null
}

/** Pure: the key an event settles. */
export function eventKey(ev: ResolveEvent): string {
  if (ev.on === 'step') return `step:${ev.collection}:${ev.item}`
  return `${ev.on}:${clean(ev.id)}`
}

/** Pure: the line the settled row shows, worded for its recipient. */
export function resolvedText(
  ev: ResolveEvent,
  who: { self: boolean; name: string | null }
): string {
  const by = !ev.actorId ? '' : who.self ? ' by you' : ` by ${who.name || 'someone'}`
  switch (ev.on) {
    case 'step':
      return ev.stateLabel ? `Moved to ${ev.stateLabel}${by}` : `Moved on${by}`
    case 'approval':
      return `${ev.decision === 'rejected' ? 'Rejected' : 'Approved'}${by}`
    case 'task':
      return `Done${by}`
    case 'ticket':
      return `${ev.status === 'cancelled' ? 'Cancelled' : 'Closed'}${by}`
  }
}

export interface ResolveCandidate {
  id: number | string
  recipient: string
  status: string | null
  timestamp: Date | string | null
  detail: unknown
}

/**
 * Pure: the rows an event settles — open (inbox or read, never archived),
 * written before the event, carrying the event's key, not already settled,
 * not waiting on an acknowledgement, and not someone the move keeps asking.
 */
export function planResolve(rows: ResolveCandidate[], ev: ResolveEvent): ResolveCandidate[] {
  const key = eventKey(ev)
  const cut = ev.at.getTime()
  const keep = ev.on === 'step' ? (ev.keepOpenFor ?? []) : []
  return rows.filter((r) => {
    if (r.status !== 'inbox' && r.status !== 'read') return false
    const t = r.timestamp ? new Date(r.timestamp).getTime() : Number.NaN
    if (!(Number.isFinite(t) && t < cut)) return false
    const d = parseDetail(r.detail)
    if (!d || d.resolve_key !== key) return false
    if (d.resolved) return false
    if (d.ack_required === true && typeof d.ack_at !== 'string') return false
    if (keep.some((k) => same(k, r.recipient))) return false
    return true
  })
}

/** LIKE pattern for the key inside the stored JSON (`[x]` escapes MSSQL wildcards). */
export function keyLike(key: string): string {
  return `%"resolve_key":${JSON.stringify(key).replace(/[%_[]/g, (c) => `[${c}]`)}%`
}

const LOOKBACK_MS = 90 * 24 * 3_600_000

async function candidates(ev: ResolveEvent): Promise<ResolveCandidate[]> {
  const key = eventKey(ev)
  let q = db('nivaro_notifications')
    .whereIn('status', ['inbox', 'read'])
    .where('timestamp', '<', ev.at)
    .where('detail', 'like', keyLike(key))
  // The record the row is about is indexed (collection, item); a ticket names none.
  const record =
    ev.on === 'step'
      ? { collection: ev.collection, item: ev.item }
      : ev.on === 'task' || ev.on === 'approval'
        ? ev.collection && ev.item
          ? { collection: ev.collection, item: String(ev.item) }
          : null
        : null
  if (record) q = q.where({ collection: record.collection, item: record.item })
  else q = q.where('timestamp', '>', new Date(ev.at.getTime() - LOOKBACK_MS))
  return (await q
    .select('id', 'recipient', 'status', 'timestamp', 'detail')
    .limit(500)) as ResolveCandidate[]
}

async function nameOf(id: string | null): Promise<string | null> {
  if (!id) return null
  const u = (await db('nivaro_users')
    .where({ id })
    .first('first_name', 'last_name', 'email')
    .catch(() => undefined)) as
    | { first_name: string | null; last_name: string | null; email: string | null }
    | undefined
  if (!u) return null
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null
}

/**
 * Settle every open notification the event handled. Best-effort: a failure
 * here never fails the write that caused it. Returns the settled row ids.
 */
export async function resolveNotifications(ev: ResolveEvent): Promise<number[]> {
  try {
    const rows = planResolve(await candidates(ev), ev)
    if (rows.length === 0) return []
    const name = await nameOf(ev.actorId)
    const at = ev.at.toISOString()
    const byRecipient = new Map<string, number[]>()
    for (const r of rows) {
      const d = parseDetail(r.detail) ?? {}
      const stamp: ResolvedStamp = {
        on: ev.on,
        by: ev.actorId,
        by_name: name,
        at,
        text: resolvedText(ev, { self: same(ev.actorId, r.recipient), name })
      }
      const patch: Record<string, unknown> = {
        detail: JSON.stringify({ ...d, resolved: stamp })
      }
      if (r.status === 'inbox') patch.status = 'read'
      await db('nivaro_notifications').where({ id: r.id }).update(patch)
      await db('nivaro_notifications')
        .where({ id: r.id })
        .whereNull('read_at')
        .update({ read_at: ev.at })
        .catch(() => undefined)
      const k = [...byRecipient.keys()].find((x) => same(x, r.recipient)) ?? String(r.recipient)
      byRecipient.set(k, [...(byRecipient.get(k) ?? []), Number(r.id)])
    }
    // The recipient's own tabs refetch their inbox (ids only, never text).
    const record =
      ev.on === 'step'
        ? { collection: ev.collection, item: ev.item }
        : ev.on === 'ticket'
          ? {}
          : { collection: ev.collection ?? undefined, item: ev.item ?? undefined }
    for (const [recipient, ids] of byRecipient) {
      emitToUserRoom(recipient, 'notification:retired', { ids, resolved: true, ...record })
      announceNotificationsRead(recipient)
    }
    return [...byRecipient.values()].flat()
  } catch {
    return []
  }
}

/** Pure: a row the digest should leave out — settled, retired or archived. */
export function isHandledRow(row: { status?: string | null; detail?: unknown }): boolean {
  if (row.status === 'archived') return true
  const d = parseDetail(row.detail)
  return !!d?.resolved
}
