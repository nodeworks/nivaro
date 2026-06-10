import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { sendMail } from '../services/mail.js'
import { hooks } from './registry.js'

let _app: FastifyInstance | null = null
export function setApp(app: FastifyInstance) {
  _app = app
}

async function fireSubscriptionNotifications(
  collection: string,
  eventType: 'create' | 'update' | 'delete',
  item: string,
  data: Record<string, unknown> | null,
  actorUserId: string | undefined
) {
  try {
    // Find all active subscriptions matching this collection+event
    const subs = await db('nivaro_notification_subscriptions as ns')
      .join('nivaro_users as u', 'ns.user', 'u.id')
      .where({ 'ns.collection': collection, 'ns.is_active': true })
      .where((qb) => {
        qb.where('ns.event_type', eventType).orWhere('ns.event_type', 'all')
      })
      .select(
        'ns.id',
        'ns.user',
        'ns.filter_field',
        'ns.filter_value',
        'ns.label',
        'ns.digest_frequency',
        'u.email',
        'u.first_name'
      )

    const now = new Date()
    for (const sub of subs) {
      // Skip the actor — don't notify the user who triggered the event
      if (actorUserId && sub.user === actorUserId) continue

      // Apply optional field filter
      if (sub.filter_field && data) {
        const actualVal = String(data[sub.filter_field as string] ?? '')
        if (actualVal !== sub.filter_value) continue
      }

      const label = sub.label || `${collection} ${eventType}`
      const subject = `${label}: ${eventType} in ${collection}`
      const message = `A ${eventType} event occurred on item ${item} in ${collection}`

      const [notif] = await db('nivaro_notifications')
        .insert({
          recipient: sub.user,
          subject: subject.slice(0, 255),
          status: 'inbox',
          timestamp: now,
          sender: actorUserId ?? null,
          message: message.slice(0, 500),
          collection,
          item
        })
        .returning('*')

      if (_app?.io) {
        emitNotification(_app.io, sub.user, {
          id: notif?.id ?? null,
          subject: subject.slice(0, 255),
          message: message.slice(0, 200),
          collection,
          item,
          sender: actorUserId ?? null,
          timestamp: now
        })
      }

      // Immediate email only for instant subscriptions — daily/weekly are
      // batched by the digest cron (services/digest.ts). In-app notification
      // above is always inserted regardless of digest frequency.
      const frequency = (sub.digest_frequency as string | null) ?? 'instant'
      if (frequency === 'instant' && sub.email) {
        await sendMail({
          to: sub.email,
          subject,
          template: 'notification',
          data: {
            first_name: sub.first_name,
            message,
            ...(item
              ? {
                  action_url: `${config.ADMIN_URL}/collections/${collection}/${item}`,
                  action_label: 'View item'
                }
              : {})
          }
        }).catch((err) => {
          console.warn('[notification-subscriptions] email send failed:', err)
        })
      }
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.warn('[notification-subscriptions] error:', err)
  }
}

export function registerNotificationSubscriptionHooks() {
  hooks.after('*', 'create', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    await fireSubscriptionNotifications(
      ctx.collection,
      'create',
      ctx.keys?.[0] != null ? String(ctx.keys[0]) : '',
      ctx.result as Record<string, unknown> | null,
      ctx.user?.id
    )
  })

  hooks.after('*', 'update', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    await fireSubscriptionNotifications(
      ctx.collection,
      'update',
      ctx.keys?.[0] != null ? String(ctx.keys[0]) : '',
      ctx.result as Record<string, unknown> | null,
      ctx.user?.id
    )
  })

  hooks.after('*', 'delete', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    await fireSubscriptionNotifications(
      ctx.collection,
      'delete',
      ctx.keys?.[0] != null ? String(ctx.keys[0]) : '',
      ctx.previousData as Record<string, unknown> | null,
      ctx.user?.id
    )
  })
}
