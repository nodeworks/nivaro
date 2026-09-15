import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { appForUser } from '../services/app-links.js'
import {
  decideDelivery,
  getNotifyPrefs,
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_LABELS,
  type NotifyCategory,
  notifyUser
} from '../services/notification-channels.js'
import {
  actionsFor,
  deriveTarget,
  type NotificationTargetSpec,
  normalizeTarget,
  resolveTargetUrl
} from '../services/notification-target.js'

/**
 * Notification test bench (admin): "send me a sample of every category" and a
 * per-user simulator that answers "which channels would fire for THIS person
 * for THIS event, and why" — the same decideDelivery() notifyUser executes,
 * rendered instead of acted on. Nothing in /simulate sends.
 */

const SAMPLES: Array<{
  category: NotifyCategory
  subject: string
  message: string
  target?: NotificationTargetSpec
}> = [
  {
    category: 'workflow',
    subject: 'Sample: Approve — request REQ-00001 is now Waiting on Level 2 Approval',
    message: 'Jane Doe moved REQ-00001 to "Waiting on Level 2 Approval" (Approve).',
    target: { kind: 'my_work', action: 'open' }
  },
  {
    category: 'workflow',
    subject: 'Sample: Task assigned: Attach the vendor quote',
    message: 'A sample task assigned to you — it opens your task list.',
    target: { kind: 'task', action: 'open' }
  },
  {
    category: 'sla',
    subject: 'Sample: SLA escalation (tier 1): Level 2 approval within 2 days',
    message: 'REQ-00001 has been in "Waiting on Level 2 Approval" 2h past its SLA.',
    target: { kind: 'my_work', action: 'open' }
  },
  {
    category: 'mentions',
    subject: 'Sample: Jane Doe mentioned you in chat',
    message: '@you can you look at the allocation on REQ-00001?',
    target: { kind: 'chat', room: 'global', action: 'reply' }
  },
  {
    category: 'watch',
    subject: 'Sample: Watching REQ-00001: updated by Jane Doe',
    message: 'Total Amount $39,900.00 → $41,200.00',
    target: { kind: 'my_work', action: 'open' }
  },
  {
    category: 'alerts',
    subject: 'Sample: Alert: Open PO total above threshold',
    message: 'Open PO total is $1.2M (threshold $1.0M).',
    target: { kind: 'alerts', action: 'open' }
  },
  {
    category: 'anomaly',
    subject: 'Sample: Anomaly Detected: amount outlier on REQ-00001',
    message: 'A line amount is 4.2σ above the vendor mean.',
    target: { kind: 'alerts', action: 'open' }
  },
  {
    category: 'reports',
    subject: 'Sample: Report "Budget Health" is ready',
    message: 'Your weekly report digest is ready to view.',
    target: { kind: 'my_work', action: 'open' }
  },
  {
    category: 'system',
    subject: 'Sample: New sign-in to your account',
    message: 'A sign-in from a new location was recorded (this is only a sample).',
    target: { kind: 'home', action: 'open' }
  },
  {
    category: 'other',
    subject: 'Sample: Everything else',
    message: 'A notification with no recognisable keyword lands here.',
    target: { kind: 'home', action: 'open' }
  }
]

export async function notificationBenchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/catalog', async () => ({
    data: {
      categories: NOTIFY_CATEGORIES.map((c) => ({ value: c, label: NOTIFY_CATEGORY_LABELS[c] })),
      samples: SAMPLES.map((s) => ({ category: s.category, subject: s.subject }))
    }
  }))

  /** Send every sample to the caller — real sends, every rule applies (mail
   *  test mode included), so what lands is what a user would get. */
  app.post<{ Body: { email?: boolean; categories?: string[] } }>('/samples', async (req) => {
    const me = req.user!.id
    const want = new Set(
      (req.body?.categories ?? []).filter((c): c is NotifyCategory =>
        (NOTIFY_CATEGORIES as string[]).includes(c)
      )
    )
    const picked = want.size ? SAMPLES.filter((s) => want.has(s.category)) : SAMPLES
    const results: Array<{ subject: string; category: NotifyCategory; decision: unknown }> = []
    for (const s of picked) {
      const decision = await decideDelivery(me, {
        subject: s.subject,
        category: s.category,
        channels: { inapp: true, email: req.body?.email === true }
      })
      await notifyUser(app, me, {
        subject: s.subject,
        message: s.message,
        category: s.category,
        target: s.target,
        channels: { inapp: true, email: req.body?.email === true },
        why: `you asked the notification test bench for a "${NOTIFY_CATEGORY_LABELS[s.category]}" sample`
      })
      results.push({ subject: s.subject, category: s.category, decision })
    }
    await logActivity({
      action: 'notification-bench-samples',
      user: me,
      comment: `${picked.length} samples${req.body?.email ? ' + email' : ''}`,
      req
    })
    return { data: { sent: picked.length, results } }
  })

  /** Dry-run: what would happen for user X on event Y. */
  app.post<{
    Body: {
      user_id?: string
      subject?: string
      message?: string
      category?: string
      collection?: string | null
      item?: string | null
      channels?: { inapp?: boolean; email?: boolean; sms?: boolean }
      always_inbox?: boolean
      cadence?: 'sender'
      target?: unknown
      at?: string
    }
  }>('/simulate', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.user_id) return reply.code(400).send({ error: 'user_id is required' })
    const user = (await db('nivaro_users as u')
      .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
      .where('u.id', b.user_id)
      .first(
        'u.id',
        'u.email',
        'u.first_name',
        'u.last_name',
        'u.status',
        'u.is_redacted',
        'u.phone',
        'u.preferences',
        'r.name as role_name',
        'r.admin_access'
      )) as
      | {
          id: string
          email: string | null
          first_name: string | null
          last_name: string | null
          status: string | null
          is_redacted: boolean | number | null
          phone: string | null
          preferences: unknown
          role_name: string | null
          admin_access: boolean | number | null
        }
      | undefined
    if (!user) return reply.code(404).send({ error: 'User not found' })
    const subject = String(b.subject ?? 'Sample notification').slice(0, 255)
    const category = (NOTIFY_CATEGORIES as string[]).includes(String(b.category))
      ? (b.category as NotifyCategory)
      : undefined
    const at = b.at ? new Date(b.at) : new Date()
    const now = Number.isNaN(at.getTime()) ? new Date() : at
    const opts = {
      subject,
      category,
      collection: b.collection ?? undefined,
      item: b.item ?? undefined,
      channels: {
        inapp: b.channels?.inapp !== false,
        email: !!b.channels?.email,
        sms: !!b.channels?.sms
      },
      always_inbox: !!b.always_inbox,
      cadence: b.cadence === 'sender' ? ('sender' as const) : undefined
    }
    const decision = await decideDelivery(user.id, opts, now)
    const target =
      normalizeTarget(b.target) ??
      deriveTarget({ collection: b.collection ?? null, item: b.item ?? null, subject })
    const [portalUrl, adminUrl, preferredApp, prefs] = await Promise.all([
      resolveTargetUrl(target, { app: 'portal' }).catch(() => null),
      resolveTargetUrl(target, { app: 'admin' }).catch(() => null),
      appForUser(user.id),
      getNotifyPrefs(user.id)
    ])
    let digestHour: number | null = null
    let timezone: string | null = null
    try {
      const p =
        typeof user.preferences === 'string' ? JSON.parse(user.preferences) : user.preferences
      const h = Number((p as { digest_hour?: unknown })?.digest_hour)
      digestHour = Number.isInteger(h) ? h : 7
      const tz = (p as { timezone?: unknown })?.timezone
      timezone = typeof tz === 'string' ? tz : null
    } catch {
      digestHour = 7
    }
    // Push needs a registered browser subscription to reach anyone at all.
    const pushSubs = Number(
      (
        (await db('nivaro_push_subscriptions')
          .where({ user: user.id })
          .count({ c: '*' })
          .first()
          .catch(() => ({ c: 0 }))) as { c?: number | string }
      )?.c ?? 0
    )
    return {
      data: {
        user: {
          id: user.id,
          name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
          email: user.email,
          phone: user.phone ? 'on file' : null,
          role: user.role_name,
          admin: !!user.admin_access,
          status: user.status,
          preferred_app: preferredApp,
          push_subscriptions: pushSubs,
          quiet_hours:
            prefs?.quiet_start && prefs?.quiet_end
              ? `${prefs.quiet_start}–${prefs.quiet_end} ET`
              : null,
          matrix_row: prefs?.matrix?.[decision.category] ?? null,
          digest_hour: digestHour,
          timezone
        },
        evaluated_at: now.toISOString(),
        decision,
        target,
        actions: actionsFor(target),
        urls: { portal: portalUrl, admin: adminUrl, preferred: preferredApp }
      }
    }
  })
}
