import { config } from '../config.js'
import type { QueueStats } from './queues.js'

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

export function buildQueueSummaryHtml(
  queueName: string,
  stats: QueueStats,
  queueUrl: string
): string {
  const stateLine = Object.entries(stats.by_state)
    .map(([state, count]) => `${escapeHtml(state)}: ${count}`)
    .join(' · ')
  return `<h3 style="margin:20px 0 8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #e2e8f0;padding-bottom:4px;">
    <a href="${queueUrl}" style="color:#0e7490;text-decoration:none;">${escapeHtml(queueName)}</a>
  </h3>
  <p style="margin:0 0 4px 0;font-size:13px;color:#0f172a;"><strong>${stats.total}</strong> item${stats.total === 1 ? '' : 's'} total, <strong>${stats.unowned}</strong> unowned</p>
  ${stateLine ? `<p style="margin:0 0 12px 0;font-size:12px;color:#64748b;">${stateLine}</p>` : ''}`
}

function buildDigestHtml(
  firstName: string | null,
  frequency: 'daily' | 'weekly',
  grouped: Map<string, NotificationRow[]>,
  total: number,
  now: Date,
  queueSections: string[] = []
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
    ${queueSections.join('\n')}
    <p style="margin:24px 0 0 0;font-size:12px;color:#94a3b8;">You receive this because one of your notification subscriptions is set to ${frequency} digest delivery.</p>
  </div>
</body>
</html>`
}

// runDigests / registerDigestCrons were folded into services/daily-digest.ts
// (2026-09-10): the notification digest now rides the daily action summary at
// the user's hour, so there is one morning email, not two. This module keeps
// the HTML helpers (unit-tested).
