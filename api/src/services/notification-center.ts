import { db } from '../db/index.js'
import {
  type DeliveryDecision,
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_LABELS,
  type NotifyCategory,
  type NotifyPrefs
} from './notification-channels.js'

/** #2406 — archive read notifications older than `days` for one person. */
export async function archiveReadOlderThan(userId: string, days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  return db('nivaro_notifications')
    .where({ recipient: userId, status: 'read' })
    .where('timestamp', '<', cutoff)
    .update({ status: 'archived' })
}

export const CLEANUP_DAYS_MIN = 7
export const CLEANUP_DAYS_MAX = 365

const cleanedAt = new Map<string, number>()

/** Per-person automatic clean-up (preferences.notification_cleanup_days),
 *  run lazily from the list at most once an hour — no cron needed. */
export async function autoCleanup(userId: string): Promise<void> {
  const last = cleanedAt.get(userId) ?? 0
  if (Date.now() - last < 3_600_000) return
  cleanedAt.set(userId, Date.now())
  try {
    const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
      | { preferences?: unknown }
      | undefined
    const p =
      typeof row?.preferences === 'string'
        ? JSON.parse(row.preferences)
        : ((row?.preferences as Record<string, unknown> | null) ?? {})
    const days = Number((p as { notification_cleanup_days?: unknown }).notification_cleanup_days)
    if (Number.isInteger(days) && days >= CLEANUP_DAYS_MIN && days <= CLEANUP_DAYS_MAX)
      await archiveReadOlderThan(userId, days)
  } catch {
    // clean-up is best-effort
  }
}

export const SUGGEST_WINDOW_DAYS = 14
const SUGGEST_MIN = 20

/** #2367 — categories that mostly pile up unopened in the caller's own inbox.
 *  Pure so it is unit-tested. `rows` = one count row per category. */
export function noiseSuggestions(
  rows: Array<{ category: string; total: number; unopened: number }>,
  prefs: NotifyPrefs | null
) {
  const out: Array<{
    category: NotifyCategory
    label: string
    total: number
    unopened: number
    message: string
  }> = []
  for (const r of rows) {
    const cat = r.category as NotifyCategory
    if (!NOTIFY_CATEGORIES.includes(cat)) continue
    // Never suggest muting what is already off, or what asks for action.
    if (prefs?.matrix?.[cat]?.inapp === false) continue
    if (cat === 'mentions' || cat === 'sla' || cat === 'system') continue
    if (r.total < SUGGEST_MIN || r.unopened / r.total < 0.7) continue
    const label = NOTIFY_CATEGORY_LABELS[cat] ?? cat
    out.push({
      category: cat,
      label,
      total: r.total,
      unopened: r.unopened,
      message: `You got ${r.total} "${label}" notifications in the last ${SUGGEST_WINDOW_DAYS} days; ${r.unopened} were never opened.`
    })
  }
  return out.sort((a, b) => b.unopened - a.unopened).slice(0, 3)
}

/** Keep only the shapes the delivery decision reads — mirrors the validator
 *  in routes/users.ts so a preview can never judge something a save would
 *  have dropped. */
export function sanitizePrefs(raw: unknown): NotifyPrefs {
  const np = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
  const out: NotifyPrefs = {}
  if (typeof np.quiet_start === 'string' && TIME.test(np.quiet_start))
    out.quiet_start = np.quiet_start
  if (typeof np.quiet_end === 'string' && TIME.test(np.quiet_end)) out.quiet_end = np.quiet_end
  if (np.matrix && typeof np.matrix === 'object') {
    const m: NonNullable<NotifyPrefs['matrix']> = {}
    for (const cat of NOTIFY_CATEGORIES) {
      const row = (np.matrix as Record<string, unknown>)[cat] as Record<string, unknown> | undefined
      if (!row || typeof row !== 'object') continue
      const email = row.email
      m[cat] = {
        inapp: row.inapp !== false,
        push: row.push !== false,
        ...(email === 'instant' || email === 'daily' || email === 'off' ? { email } : {}),
        ...(row.quiet_override === true ? { quiet_override: true } : {})
      }
    }
    out.matrix = m
  }
  return out
}

export interface PreviewTotals {
  notifications: number
  inapp: number
  push: number
  email_sent: number
  email_deferred: number
}

export const emptyTotals = (): PreviewTotals => ({
  notifications: 0,
  inapp: 0,
  push: 0,
  email_sent: 0,
  email_deferred: 0
})

export function tallyDecision(t: PreviewTotals, d: DeliveryDecision) {
  t.notifications++
  if (d.inapp) t.inapp++
  if (d.push) t.push++
  if (d.email === 'send') t.email_sent++
  if (d.email === 'deferred') t.email_deferred++
}
