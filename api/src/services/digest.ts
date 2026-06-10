import { config } from '../config.js'
import { db } from '../db/index.js'
import type { CronManager } from '../plugins/cron.js'
import { sendRawMail } from './mail.js'

/**
 * Digest emails — batch nivaro_notifications into one daily/weekly email per
 * user instead of per-event delivery. A user receives a digest when they have
 * at least one active notification subscription with that digest_frequency
 * AND at least one notification newer than their last_digest_at watermark.
 */

const MAX_NOTIFICATIONS = 50
const DAY_MS = 24 * 60 * 60 * 1000

interface DigestUser {
  id: string
  email: string | null
  first_name: string | null
  last_digest_at: Date | string | null
}

interface NotificationRow {
  id: number
  subject: string | null
  message: string | null
  collection: string | null
  item: string | null
  timestamp: Date | string
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function formatRelative(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toISOString().slice(0, 10)
}

function buildDigestHtml(
  firstName: string | null,
  frequency: 'daily' | 'weekly',
  grouped: Map<string, NotificationRow[]>,
  total: number,
  now: Date
): string {
  const sections: string[] = []

  for (const [collection, rows] of grouped) {
    const items = rows
      .map((n) => {
        const when = formatRelative(new Date(n.timestamp), now)
        const subject = escapeHtml(n.subject ?? 'Notification')
        const message = n.message ? escapeHtml(n.message) : ''
        const link =
          n.collection && n.item
            ? `${config.ADMIN_URL}/collections/${encodeURIComponent(n.collection)}/${encodeURIComponent(n.item)}`
            : null
        const title = link
          ? `<a href="${link}" style="color:#0e7490;text-decoration:none;font-weight:600;">${subject}</a>`
          : `<span style="font-weight:600;color:#0f172a;">${subject}</span>`
        return `<li style="margin:0 0 10px 0;line-height:1.4;">
          ${title}
          <span style="color:#94a3b8;font-size:12px;"> · ${when}</span>
          ${message ? `<br/><span style="color:#475569;font-size:13px;">${message}</span>` : ''}
        </li>`
      })
      .join('\n')

    sections.push(`<h3 style="margin:20px 0 8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #e2e8f0;padding-bottom:4px;">${escapeHtml(collection)}</h3>
<ul style="margin:0;padding-left:18px;">${items}</ul>`)
  }

  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:24px auto;background:#ffffff;border-radius:8px;padding:28px;">
    <h2 style="margin:0 0 4px 0;font-size:18px;color:#0f172a;">Your ${frequency} Nivaro digest</h2>
    <p style="margin:0 0 16px 0;color:#475569;font-size:13px;">${greeting} here ${total === 1 ? 'is the update' : `are the ${total} updates`} since your last digest.</p>
    ${sections.join('\n')}
    <p style="margin:24px 0 0 0;font-size:12px;color:#94a3b8;">You receive this because one of your notification subscriptions is set to ${frequency} digest delivery.</p>
  </div>
</body>
</html>`
}

/**
 * Run digest delivery for one frequency. For each user with at least one
 * active subscription set to that frequency, collect their notifications
 * since last_digest_at (default 24h / 7d window), cap at 50, group by
 * collection, send a single email, then advance last_digest_at.
 */
export async function runDigests(frequency: 'daily' | 'weekly'): Promise<void> {
  const now = new Date()
  const defaultWindowMs = frequency === 'weekly' ? 7 * DAY_MS : DAY_MS

  let users: DigestUser[]
  try {
    users = (await db('nivaro_notification_subscriptions as ns')
      .join('nivaro_users as u', 'ns.user', 'u.id')
      .where({ 'ns.is_active': true, 'ns.digest_frequency': frequency })
      .distinct('u.id', 'u.email', 'u.first_name', 'u.last_digest_at')) as DigestUser[]
  } catch (err) {
    console.warn('[digest] failed to load digest users:', err)
    return
  }

  for (const user of users) {
    try {
      const since = user.last_digest_at
        ? new Date(user.last_digest_at)
        : new Date(now.getTime() - defaultWindowMs)

      const notifications = (await db('nivaro_notifications')
        .where({ recipient: user.id })
        .where('timestamp', '>', since)
        .orderBy('timestamp', 'desc')
        .limit(MAX_NOTIFICATIONS)
        .select('id', 'subject', 'message', 'collection', 'item', 'timestamp')) as NotificationRow[]

      // Nothing new — skip (and leave the watermark so old items roll into the next digest)
      if (notifications.length === 0) continue

      // Group by collection (uncategorized notifications go last)
      const grouped = new Map<string, NotificationRow[]>()
      for (const n of notifications) {
        const key = n.collection ?? 'Other'
        const list = grouped.get(key) ?? []
        list.push(n)
        grouped.set(key, list)
      }

      if (user.email) {
        const subject = `Your ${frequency} Nivaro digest — ${notifications.length} update${notifications.length === 1 ? '' : 's'}`
        await sendRawMail({
          to: user.email,
          subject,
          html: buildDigestHtml(user.first_name, frequency, grouped, notifications.length, now)
        })
      }

      await db('nivaro_users').where({ id: user.id }).update({ last_digest_at: now })
    } catch (err) {
      // One user failing must not block the rest
      console.warn(`[digest] failed for user ${user.id}:`, err)
    }
  }
}

/**
 * Register the digest cron jobs. Call after buildServer():
 *   registerDigestCrons(app.cron)
 */
export function registerDigestCrons(cron: CronManager): void {
  cron.schedule('digest-daily', '0 8 * * *', () => runDigests('daily'))
  cron.schedule('digest-weekly', '0 8 * * 1', () => runDigests('weekly'))
}
