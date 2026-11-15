import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { classifyBounce } from './mail-suppressions.js'
import { mentionReceipts, receiptKey } from './mention-receipts.js'
import { type NotificationDelivery, parseDelivery } from './notification-channels.js'

/**
 * Mention delivery status for the person who wrote the comment (realtime round 7, item 16).
 * Per person a comment mentions: did it reach them, and how — "Seen in app", "In their inbox",
 * "Phone alert sent", "Emailed 10:42 AM", "Email bounced", "Muted — won't be told".
 *
 * Read from what the app already records, nothing new is tracked:
 * - the mention's inbox row (nivaro_notifications, category 'mentions', this record, written
 *   just after the comment) and its per-channel `delivery` record (push / Teams / email
 *   outcomes, the unread-escalation stamps);
 * - the mail log rows that record names (sent, failed, dropped) — a hard bounce reads "bounced";
 * - the mention read receipt (#2117: opened the record or read the notification since).
 * A person with no inbox row was never told: the delivery decision as it stands now says why
 * (muted / their rules turn mentions off / the account is suspended) — or, on a field comment,
 * they may not read the field.
 *
 * Only the comment's author and administrators get this (the route checks); a reason that
 * names someone else's settings goes to administrators only.
 */

/** A mention's inbox row is the one written within this window after the comment. */
const ROW_WINDOW_MS = 10 * 60_000
const ROW_SKEW_MS = 5_000

export type MentionHeadline = 'seen' | 'in_inbox' | 'muted' | 'not_told'

export interface MentionChannel {
  key: 'push' | 'email' | 'teams'
  status: 'sent' | 'deferred' | 'bounced' | 'failed' | 'not_sent'
  at: string | null
}

export interface MentionDelivery {
  id: string
  name: string
  headline: MentionHeadline
  seen_at: string | null
  /** When the inbox row landed. */
  delivered_at: string | null
  channels: MentionChannel[]
  /** Why nobody told them — administrators only. */
  reason: string | null
}

export interface MailLogRow {
  id: number
  status: string
  error: string | null
  created_at: Date | string
}

const iso = (v: Date | string | null | undefined): string | null => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** A mail log row → the email's outcome as the author reads it (pure). */
export function emailOutcome(row: MailLogRow | undefined): MentionChannel['status'] | null {
  if (!row) return null
  const status = String(row.status)
  if (status === 'sent') return 'sent'
  if (status === 'deferred') return 'deferred'
  const text = String(row.error ?? '').replace(/^skipped:\s*/i, '')
  if (status === 'failed' || status === 'dropped') {
    if (text && classifyBounce({ message: text }).kind === 'hard') return 'bounced'
    return status === 'failed' ? 'failed' : 'not_sent'
  }
  return null
}

/**
 * One person's delivery from their inbox row (pure). `row` null = no row landed: `muted`
 * (the decision now says they would not be told — administrators only) or `not_told`.
 */
export function describeMention(input: {
  id: string
  name: string
  row: { timestamp: Date | string; delivery: NotificationDelivery | null } | null
  mail: Map<number, MailLogRow>
  seenAt: string | null
  /** For a person without a row: whether their rules would still keep them from hearing. */
  silenced?: { muted: boolean; reason: string | null } | null
  isAdmin: boolean
}): MentionDelivery {
  const { row, mail, seenAt } = input
  const channels: MentionChannel[] = []
  const d = row?.delivery ?? null
  if (d?.push) {
    if (d.push.status === 'sent') channels.push({ key: 'push', status: 'sent', at: iso(d.push.at) })
    else if (d.push.status === 'failed') channels.push({ key: 'push', status: 'failed', at: null })
  }
  if (!d?.push?.at && d?.escalation?.push_at)
    channels.push({ key: 'push', status: 'sent', at: iso(d.escalation.push_at) })
  // Email: sent at delivery time, or later by the unread escalation.
  const emailLogId = d?.email?.mail_log_id ?? d?.escalation?.email_log_id ?? null
  const logged = emailLogId != null ? mail.get(Number(emailLogId)) : undefined
  const fromLog = emailOutcome(logged)
  if (fromLog) {
    channels.push({ key: 'email', status: fromLog, at: iso(logged?.created_at) })
  } else if (d?.email && (d.email.status === 'sent' || d.email.status === 'deferred')) {
    channels.push({ key: 'email', status: d.email.status, at: iso(d.email.at) })
  } else if (d?.email?.status === 'failed') {
    channels.push({ key: 'email', status: 'failed', at: null })
  } else if (d?.escalation?.email_at) {
    channels.push({ key: 'email', status: 'sent', at: iso(d.escalation.email_at) })
  }
  if (d?.teams?.status === 'sent')
    channels.push({ key: 'teams', status: 'sent', at: iso(d.teams.at) })

  let headline: MentionHeadline
  if (seenAt) headline = 'seen'
  else if (row) headline = 'in_inbox'
  // Only administrators learn that someone muted them; to a non-admin author a muted person
  // simply was not told (their notification rules are their own business).
  else if (input.silenced?.muted && input.isAdmin) headline = 'muted'
  else headline = 'not_told'
  return {
    id: input.id,
    name: input.name,
    headline,
    seen_at: seenAt,
    delivered_at: row ? iso(row.timestamp) : null,
    channels,
    reason: input.isAdmin && !row ? (input.silenced?.reason ?? null) : null
  }
}

/** Pick the mention's own row: the first one at or after the comment, inside the window. */
export function pickMentionRow<T extends { timestamp: Date | string }>(
  rows: T[],
  commentAt: Date
): T | null {
  const from = commentAt.getTime() - ROW_SKEW_MS
  const to = commentAt.getTime() + ROW_WINDOW_MS
  let best: T | null = null
  for (const r of rows) {
    const t = new Date(r.timestamp).getTime()
    if (t < from || t > to) continue
    if (!best || t < new Date(best.timestamp).getTime()) best = r
  }
  return best
}

/** Every mentioned person's delivery for one comment. */
export async function mentionDeliveryFor(
  comment: {
    id: string
    collection: string
    item: string
    user: string
    created_at: Date | string
  },
  people: Array<{ id: string; name: string }>,
  isAdmin: boolean
): Promise<MentionDelivery[]> {
  const others = people.filter((p) => String(p.id).toUpperCase() !== comment.user.toUpperCase())
  if (others.length === 0) return []
  const at = new Date(comment.created_at)
  const ids = others.map((p) => p.id)
  const rows = (await selectInChunks(ids, 500, (chunk) =>
    db('nivaro_notifications')
      .where({ collection: comment.collection, item: String(comment.item), category: 'mentions' })
      .whereIn('recipient', chunk)
      .where('timestamp', '>=', new Date(at.getTime() - ROW_SKEW_MS))
      .where('timestamp', '<=', new Date(at.getTime() + ROW_WINDOW_MS))
      .select('id', 'recipient', 'timestamp', 'delivery')
  ).catch(() => [])) as Array<{
    id: number
    recipient: string
    timestamp: Date
    delivery: string | null
  }>
  const byPerson = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = String(r.recipient).toUpperCase()
    byPerson.set(k, [...(byPerson.get(k) ?? []), r])
  }
  const picked = new Map<string, { timestamp: Date; delivery: NotificationDelivery | null }>()
  for (const p of others) {
    const row = pickMentionRow(byPerson.get(p.id.toUpperCase()) ?? [], at)
    if (row) picked.set(p.id.toUpperCase(), { ...row, delivery: parseDelivery(row.delivery) })
  }
  const logIds = [...picked.values()]
    .flatMap((r) => [r.delivery?.email?.mail_log_id, r.delivery?.escalation?.email_log_id])
    .filter((v): v is number => v != null && Number.isFinite(Number(v)))
    .map(Number)
  const mail = new Map<number, MailLogRow>()
  if (logIds.length) {
    const logs = (await db('nivaro_mail_log')
      .whereIn('id', [...new Set(logIds)])
      .select('id', 'status', 'error', 'created_at')
      .catch(() => [])) as MailLogRow[]
    for (const l of logs) mail.set(Number(l.id), l)
  }
  const receipts = await mentionReceipts(
    comment.collection,
    String(comment.item),
    others.map((p) => ({ comment: comment.id, user: p.id, at }))
  )
  const out: MentionDelivery[] = []
  for (const p of others) {
    const row = picked.get(p.id.toUpperCase()) ?? null
    let silenced: { muted: boolean; reason: string | null } | null = null
    if (!row) silenced = await wouldBeSilenced(p.id, comment.collection, comment.item)
    out.push(
      describeMention({
        id: p.id,
        name: p.name,
        row,
        mail,
        seenAt: receipts.get(receiptKey(comment.id, p.id)) ?? null,
        silenced,
        isAdmin
      })
    )
  }
  return out
}

/** Would a mention reach this person's inbox now? (the same decision notifyUser makes) */
async function wouldBeSilenced(
  userId: string,
  collection: string,
  item: string
): Promise<{ muted: boolean; reason: string | null }> {
  try {
    const { decideDelivery } = await import('./notification-channels.js')
    const d = await decideDelivery(
      userId,
      {
        subject: 'You were mentioned',
        collection,
        item,
        category: 'mentions',
        always_inbox: true
      },
      new Date()
    )
    if (d.dropped || !d.inapp) {
      const why = d.reasons.find((r) => r.channel === 'all' || r.channel === 'inapp')
      return { muted: true, reason: why?.text ?? null }
    }
    return { muted: false, reason: 'No notification was sent: they cannot open this.' }
  } catch {
    return { muted: false, reason: null }
  }
}
