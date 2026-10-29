import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import {
  classifyNotification,
  getNotifyPrefsLayered,
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_LABELS,
  type NotifyCategory,
  parseDelivery,
  parseDetail
} from '../services/notification-channels.js'
import { RULE_LAYER_LABELS } from '../services/notification-layers.js'
import { parseDeliveryReason } from '../services/notification-reason.js'
import { simulateDelivery } from '../services/notification-simulate.js'

/**
 * The signed-in person's own notification extras, mounted beside notificationsRoutes under
 * /api/notifications. Every route here answers for req.user only — no route takes a user id,
 * and a notification id that is not the caller's answers 404.
 *
 *   GET  /my-rule-defaults — #3077: the person's role and that role's default rules, so
 *        Profile → Notification rules can say which values come from the role.
 *   GET  /:id/why          — #3078: the stored reason (path + the rules that picked each
 *        channel + escalation steps) written when the row was decided; `recorded: false` for
 *        rows written before reasons were recorded.
 *   POST /test-my-rules    — #3078: the Notification Bench simulate, for the caller only.
 */
export async function notificationSelfRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/my-rule-defaults', async (req) => {
    const layered = await getNotifyPrefsLayered(req.user!.id)
    return {
      data: {
        role: layered.role ? { id: layered.role.id, name: layered.role.name } : null,
        rules: layered.role?.rules ?? {}
      }
    }
  })

  app.get('/:id/why', async (req, reply) => {
    const nid = Number((req.params as { id: string }).id)
    if (!Number.isInteger(nid) || nid <= 0)
      return reply.code(400).send({ error: 'Bad notification id' })
    const row = (await db('nivaro_notifications')
      .where({ id: nid, recipient: req.user!.id })
      .first()) as Record<string, unknown> | undefined
    if (!row) return reply.code(404).send({ error: 'Notification not found' })
    const reason = parseDeliveryReason(row.delivery_reason)
    const category =
      (row.category as NotifyCategory | null) ?? classifyNotification(String(row.subject ?? ''))
    return {
      data: {
        id: nid,
        recorded: reason != null,
        reason,
        // The older "why me" (#77) the row carried, shown beside "Sent before reasons were
        // recorded" so an old row still says what it can.
        why: parseDetail(row.detail)?.why ?? null,
        delivery: parseDelivery(row.delivery),
        category,
        category_label: NOTIFY_CATEGORY_LABELS[category] ?? category,
        layer_labels: RULE_LAYER_LABELS,
        notified_at: row.timestamp ?? null
      }
    }
  })

  app.post<{
    Body: {
      category?: string
      subject?: string
      email?: boolean
      at?: string
    }
  }>('/test-my-rules', async (req, reply) => {
    const b = req.body ?? {}
    const category = (NOTIFY_CATEGORIES as string[]).includes(String(b.category))
      ? (b.category as NotifyCategory)
      : 'workflow'
    // Only the caller, never a body id; no record (presence and mutes are about records).
    const data = await simulateDelivery(req.user!.id, {
      subject: String(b.subject ?? `Test: a "${NOTIFY_CATEGORY_LABELS[category]}" notification`),
      category,
      channels: { inapp: true, email: b.email !== false, sms: false },
      at: typeof b.at === 'string' ? b.at : undefined
    })
    if (!data) return reply.code(404).send({ error: 'User not found' })
    return {
      data: {
        evaluated_at: data.evaluated_at,
        category,
        category_label: NOTIFY_CATEGORY_LABELS[category],
        decision: data.decision,
        layers: data.layers,
        layer_labels: data.layer_labels,
        role: data.user.role_defaults,
        quiet_hours: data.user.quiet_hours,
        push_subscriptions: data.user.push_subscriptions
      }
    }
  })
}
