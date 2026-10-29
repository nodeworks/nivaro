import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  decideDelivery,
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_LABELS,
  type NotifyCategory,
  notifyUser
} from '../services/notification-channels.js'
import { simulateDelivery } from '../services/notification-simulate.js'
import type { NotificationTargetSpec } from '../services/notification-target.js'

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

  // #526/#525 — start from a write: who would be told, how, and why everyone
  // else was not. Owners of a transition's new state come back SHOWN vs TOLD.
  app.post<{
    Body: {
      collection?: string
      item?: string
      event?: string
      changed_fields?: string[]
      to_state?: string | null
      actor_id?: string | null
    }
  }>('/who', async (req, reply) => {
    const b = req.body ?? {}
    const collection = String(b.collection ?? '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || /^(nivaro|directus)_/i.test(collection))
      return reply.code(400).send({ error: 'Invalid collection' })
    if (!b.item) return reply.code(400).send({ error: 'item is required' })
    const event = ['create', 'update', 'delete', 'transition'].includes(String(b.event))
      ? (b.event as 'create' | 'update' | 'delete' | 'transition')
      : 'update'
    const { whoWouldHear } = await import('../services/notification-audience.js')
    return {
      data: await whoWouldHear({
        collection,
        item: String(b.item),
        event,
        changed_fields: Array.isArray(b.changed_fields)
          ? b.changed_fields.filter((f) => /^[A-Za-z0-9_]+$/.test(String(f))).slice(0, 50)
          : [],
        to_state: b.to_state ?? null,
        actor_id: b.actor_id ?? req.user!.id
      })
    }
  })

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
    const data = await simulateDelivery(b.user_id, b)
    if (!data) return reply.code(404).send({ error: 'User not found' })
    return { data }
  })
}
