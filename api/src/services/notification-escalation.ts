import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { sendMail } from './mail.js'
import {
  ACK_DONE_LIKE,
  ACK_PENDING_LIKE,
  getNotifyPrefs,
  NOTIFY_CATEGORY_LABELS,
  type NotificationDelivery,
  type NotifyCategory,
  type NotifyPrefs,
  notifyUser,
  parseDelivery
} from './notification-channels.js'
import { parseStoredTarget, resolveTargetUrl } from './notification-target.js'
import { sendWebPush } from './web-push.js'

/**
 * Channel fallback chain: a notification that stays UNREAD climbs channels
 * on the recipient's own schedule — "in-app → still unread after 1h: push →
 * still unread after 4h: email" — and stops the moment it is read (or
 * snoozed, or deleted). Per category, per user:
 *
 *   preferences.notification_prefs.escalation[category] =
 *     { push_after_min?: number, email_after_min?: number }
 *
 * Each step fires ONCE per row (stamped in delivery.escalation) and is
 * skipped when the original delivery already used that channel — an email
 * sent at delivery time is not re-sent as an "escalation". Runs every 5
 * minutes; only rows younger than 7 days are considered, so a pref set today
 * does not flood the person with last month's inbox.
 */

const WINDOW_DAYS = 7
export const ESCALATION_STEPS = ['push_after_min', 'email_after_min'] as const
export type EscalationRule = { push_after_min?: number; email_after_min?: number }
export type EscalationPrefs = Partial<Record<NotifyCategory, EscalationRule>>

function escalationOf(prefs: NotifyPrefs | null): EscalationPrefs | null {
  const raw = (prefs as { escalation?: unknown } | null)?.escalation
  return raw && typeof raw === 'object' ? (raw as EscalationPrefs) : null
}

/** Users whose preferences mention an escalation rule — a LIKE on the JSON
 *  text is the cheap pre-filter; the parsed prefs are the truth. */
async function usersWithEscalation(): Promise<string[]> {
  const rows = (await db('nivaro_users')
    .where('preferences', 'like', '%"escalation"%')
    .where((qb) => qb.whereNull('status').orWhereNot('status', 'suspended'))
    .where('is_redacted', 0)
    .select('id')) as Array<{ id: string }>
  return rows.map((r) => String(r.id))
}

async function runChannelEscalation(
  app: FastifyInstance,
  now = new Date()
): Promise<{ pushed: number; emailed: number; checked: number }> {
  const out = { pushed: 0, emailed: 0, checked: 0 }
  const userIds = await usersWithEscalation()
  if (userIds.length === 0) return out
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000)

  for (const userId of userIds) {
    const prefs = await getNotifyPrefs(userId)
    const esc = escalationOf(prefs)
    if (!esc) continue
    const categories = (Object.keys(esc) as NotifyCategory[]).filter(
      (c) => esc[c] && (esc[c]?.push_after_min || esc[c]?.email_after_min)
    )
    if (categories.length === 0) continue

    const rows = (await db('nivaro_notifications')
      .where({ recipient: userId, status: 'inbox' })
      .where('timestamp', '>=', since)
      .whereIn('category', categories)
      .where((qb) => qb.whereNull('snoozed_until').orWhere('snoozed_until', '<=', now))
      .select('id', 'subject', 'message', 'category', 'timestamp', 'delivery', 'target')) as Array<{
      id: number
      subject: string
      message: string | null
      category: NotifyCategory
      timestamp: Date
      delivery: string | null
      target: string | null
    }>
    if (rows.length === 0) continue
    let user: { email: string | null; first_name: string | null } | undefined
    for (const row of rows) {
      out.checked++
      const rule = esc[row.category]
      if (!rule) continue
      const ageMin = (now.getTime() - new Date(row.timestamp).getTime()) / 60_000
      const delivery: NotificationDelivery = parseDelivery(row.delivery) ?? {}
      const stamps = { ...(delivery.escalation ?? {}) }
      let changed = false
      const target = parseStoredTarget(row.target)

      // Step 1: push — unless push already went out with the original delivery.
      if (
        rule.push_after_min &&
        ageMin >= rule.push_after_min &&
        !stamps.push_at &&
        delivery.push?.status !== 'sent'
      ) {
        const url =
          (await resolveTargetUrl(target, { recipientUserId: userId }).catch(() => null)) ??
          '/notifications'
        const sent = await sendWebPush(userId, {
          title: `Still unread: ${row.subject}`.slice(0, 120),
          body: (row.message ?? '').slice(0, 300),
          url
        }).catch(() => 0)
        stamps.push_at = now.toISOString()
        changed = true
        if (sent > 0) out.pushed++
      }
      // Step 2: email — unless the original delivery already emailed.
      if (
        rule.email_after_min &&
        ageMin >= rule.email_after_min &&
        !stamps.email_at &&
        delivery.email?.status !== 'sent'
      ) {
        user ??= (await db('nivaro_users').where({ id: userId }).first('email', 'first_name')) as
          | { email: string | null; first_name: string | null }
          | undefined
        if (user?.email) {
          const hours = Math.round(rule.email_after_min / 60)
          const when =
            rule.email_after_min < 60
              ? `${rule.email_after_min} minutes`
              : `${hours} hour${hours === 1 ? '' : 's'}`
          const label = NOTIFY_CATEGORY_LABELS[row.category] ?? row.category
          const actionUrl = await resolveTargetUrl(target, { recipientUserId: userId }).catch(
            () => null
          )
          try {
            const mail = await sendMail({
              to: user.email,
              subject: row.subject,
              template: 'notification',
              category: row.category,
              cadence: 'sender',
              skipDigest: true,
              why: `you asked to be emailed when a "${label}" notification stays unread for ${when}`,
              data: {
                first_name: user.first_name,
                subject: row.subject,
                message: `${row.message ?? ''}\n\n(This has been unread in your inbox for ${when}.)`,
                category: row.category,
                ...(actionUrl ? { action_url: actionUrl, action_label: 'Open' } : {})
              }
            })
            stamps.email_at = now.toISOString()
            stamps.email_log_id = mail.log_id
            changed = true
            if (mail.status === 'sent') out.emailed++
          } catch {
            // SMTP failure — try again next tick (no stamp)
          }
        } else {
          stamps.email_at = now.toISOString()
          changed = true
        }
      }
      if (changed) {
        await db('nivaro_notifications')
          .where({ id: row.id })
          .update({ delivery: JSON.stringify({ ...delivery, escalation: stamps }) })
          .catch(() => {})
      }
    }
  }
  if (out.pushed > 0 || out.emailed > 0) {
    await logActivity({
      action: 'notification-escalation',
      user: null,
      collection: 'nivaro_notifications',
      comment: `${out.pushed} pushed, ${out.emailed} emailed (${out.checked} unread rows checked)`
    }).catch(() => undefined)
  }
  void app
  return out
}

const ACK_REMIND_HOURS = 4
const ACK_MANAGER_HOURS = 24

/**
 * #2365 — notifications that asked for an acknowledgement. Unacknowledged
 * after 4 hours: one push reminder to the recipient. After 24 hours: one
 * notification to the recipient's manager (the chain), naming who has not
 * acknowledged. Each step fires once (stamped in delivery.escalation); reading
 * the notification does NOT stop it — only acknowledging does.
 */
export async function runAckEscalation(
  app: FastifyInstance,
  now = new Date()
): Promise<{ reminded: number; escalated: number }> {
  const out = { reminded: 0, escalated: 0 }
  const since = new Date(now.getTime() - 14 * 86_400_000)
  const rows = (await db('nivaro_notifications')
    .where('timestamp', '>=', since)
    .whereNot('status', 'archived')
    .where('detail', 'like', ACK_PENDING_LIKE)
    .whereNot('detail', 'like', ACK_DONE_LIKE)
    .limit(500)
    .select('id', 'recipient', 'subject', 'message', 'timestamp', 'delivery', 'target')) as Array<{
    id: number
    recipient: string
    subject: string
    message: string | null
    timestamp: Date
    delivery: string | null
    target: string | null
  }>
  for (const row of rows) {
    const ageH = (now.getTime() - new Date(row.timestamp).getTime()) / 3_600_000
    const delivery: NotificationDelivery = parseDelivery(row.delivery) ?? {}
    const stamps = { ...(delivery.escalation ?? {}) }
    let changed = false
    if (ageH >= ACK_REMIND_HOURS && !stamps.ack_remind_at) {
      const url =
        (await resolveTargetUrl(parseStoredTarget(row.target), {
          recipientUserId: row.recipient
        }).catch(() => null)) ?? '/notifications'
      await sendWebPush(row.recipient, {
        title: `Needs your acknowledgement: ${row.subject}`.slice(0, 120),
        body: (row.message ?? '').slice(0, 300),
        url
      }).catch(() => 0)
      stamps.ack_remind_at = now.toISOString()
      changed = true
      out.reminded++
    }
    if (ageH >= ACK_MANAGER_HOURS && !stamps.ack_manager_at) {
      const who = (await db('nivaro_users')
        .where({ id: row.recipient })
        .first('first_name', 'last_name', 'email', 'manager_id')) as
        | {
            first_name: string | null
            last_name: string | null
            email: string | null
            manager_id: string | null
          }
        | undefined
      if (who?.manager_id) {
        const name =
          `${who.first_name ?? ''} ${who.last_name ?? ''}`.trim() || who.email || 'Someone'
        await notifyUser(app, who.manager_id, {
          subject: `${name} has not acknowledged: ${row.subject}`.slice(0, 255),
          message:
            'This notification asked for an acknowledgement and has been waiting over a day.',
          category: 'workflow',
          always_inbox: true,
          why: 'you are this person\u2019s manager and an acknowledgement they owe is overdue'
        }).catch(() => undefined)
        out.escalated++
      }
      stamps.ack_manager_at = now.toISOString()
      changed = true
    }
    if (changed) {
      await db('nivaro_notifications')
        .where({ id: row.id })
        .update({ delivery: JSON.stringify({ ...delivery, escalation: stamps }) })
        .catch(() => {})
    }
  }
  return out
}

/** The 5-minute escalation tick: unread channel climbing + acknowledgements. */
export async function runNotificationEscalation(
  app: FastifyInstance,
  now = new Date()
): Promise<{ pushed: number; emailed: number; checked: number }> {
  const res = await runChannelEscalation(app, now)
  await runAckEscalation(app, now).catch((err) =>
    console.warn('[notification-escalation] ack escalation failed:', err)
  )
  return res
}
