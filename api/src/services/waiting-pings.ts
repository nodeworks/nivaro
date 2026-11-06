import { db } from '../db/index.js'

/**
 * "Waiting on you" pings retire when the work moves on (army 5, 2026-11-06:
 * Lee's bell kept "Waiting on you: CR26-81409 … Waiting on Level 1 Approval"
 * long after the record left L1; Kristina kept "Sent back: CR26-81409" after
 * she resubmitted). The ping's lane is decided once, at write time — nothing
 * re-judged it when the recipient stopped owning the step.
 *
 * On every applied transition (workflow-transitions.ts, after the move is
 * written) the record's open owner pings — "Waiting on you: <id>" and
 * "Sent back: <id>…" — written BEFORE the move, to anyone who does not own
 * the state the record is in now, are archived (read stamped). An owner of
 * the new state keeps theirs; pings the move itself sends come after the
 * cut-off and are never touched. No migration: status / read_at exist.
 *
 * Matched on the record the ping links (the flows link the SUBJECT record —
 * an addendum's parent) AND on its friendly id in the subject, so a parent's
 * move never retires a ping about one of its addendums. Best-effort.
 */

export interface PingRow {
  id: number
  recipient: string
  subject: string | null
  status: string | null
  timestamp: Date | string | null
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()

/** Pure: is this row an owner ping about `friendlyId`? */
export function isOwnerPing(subject: string | null | undefined, friendlyId: string): boolean {
  const s = String(subject ?? '')
  if (!friendlyId) return false
  if (s === `Waiting on you: ${friendlyId}`) return true
  // "Sent back: CR26-81409" or "Sent back: CR26-81409 — …"
  return s === `Sent back: ${friendlyId}` || s.startsWith(`Sent back: ${friendlyId} `)
}

/** Pure: the rows to retire — owner pings older than the move, to people who
 *  do not own the record's state now, not already archived. */
export function pingsToRetire(
  rows: PingRow[],
  friendlyId: string,
  stillOwnerIds: Iterable<string>,
  movedAt: Date
): PingRow[] {
  const keep = new Set([...stillOwnerIds].map((id) => String(id).toUpperCase()))
  const cut = movedAt.getTime()
  return rows.filter((r) => {
    if (r.status === 'archived') return false
    if (!isOwnerPing(r.subject, friendlyId)) return false
    if (keep.has(String(r.recipient).toUpperCase())) return false
    const t = r.timestamp ? new Date(r.timestamp).getTime() : Number.NaN
    // A ping with no readable time is left alone; one written at or after the
    // move belongs to the move.
    return Number.isFinite(t) && t < cut
  })
}

export async function retireWaitingPings(opts: {
  collection: string
  item: string
  friendlyId: string
  /** Owners of the state the record is in now (anyone listed keeps theirs). */
  stillOwnerIds: Iterable<string>
  /** When the move was written: later pings belong to it. */
  movedAt: Date
}): Promise<number> {
  try {
    const rows = (await db('nivaro_notifications')
      .where({ collection: opts.collection, item: String(opts.item) })
      .whereNot('status', 'archived')
      .where('timestamp', '<', opts.movedAt)
      .select('id', 'recipient', 'subject', 'status', 'timestamp')
      .limit(500)) as PingRow[]
    const retire = pingsToRetire(rows, opts.friendlyId, opts.stillOwnerIds, opts.movedAt)
    if (retire.length === 0) return 0
    const now = new Date()
    const ids = retire.map((r) => Number(r.id))
    await db('nivaro_notifications').whereIn('id', ids).update({ status: 'archived' })
    await db('nivaro_notifications')
      .whereIn('id', ids)
      .whereNull('read_at')
      .update({ read_at: now })
      .catch(() => {})
    // Open bells drop the rows on their next count read; tabs that listen for
    // it refresh now. Ids + record only (no text). The emit runs inside the
    // transition's tenant context (cloud user rooms are tenant-bound there).
    try {
      const { getIo } = await import('./io-holder.js')
      const io = getIo()
      const byRecipient = new Map<string, number[]>()
      for (const r of retire) {
        const key = [...byRecipient.keys()].find((k) => sameId(k, r.recipient)) ?? r.recipient
        byRecipient.set(key, [...(byRecipient.get(key) ?? []), Number(r.id)])
      }
      for (const [recipient, rowIds] of byRecipient)
        io?.to(`user:${recipient}`).emit('notification:retired', {
          ids: rowIds,
          collection: opts.collection,
          item: String(opts.item)
        })
    } catch {
      /* live refresh is a courtesy */
    }
    return retire.length
  } catch {
    return 0
  }
}
