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

type SubFilterOp = 'eq' | 'in' | 'intersects' | 'null' | 'nnull'
interface SubFilter {
  field: string
  op: SubFilterOp
  value?: unknown
}

function filterMatches(op: SubFilterOp, actual: unknown, expected: unknown): boolean {
  const actualList = Array.isArray(actual) ? actual.map(String) : null
  const expectedList = Array.isArray(expected) ? expected.map(String) : null
  switch (op) {
    case 'eq':
      return String(actual ?? '') === String(expected ?? '')
    case 'in':
      return !!expectedList && expectedList.includes(String(actual ?? ''))
    case 'intersects':
      if (!expectedList) return false
      if (actualList) return actualList.some((v) => expectedList.includes(v))
      return actual != null && expectedList.includes(String(actual))
    case 'null':
      return actual == null || actual === '' || (actualList !== null && actualList.length === 0)
    case 'nnull':
      return actualList !== null ? actualList.length > 0 : actual != null && actual !== ''
    default:
      return false
  }
}

/**
 * State-scoped workflow notifications (EFP notification-preferences parity).
 * Called from applyTransition after every workflow transition. Matches
 * subscriptions with event_type='workflow_transition' on the bound collection,
 * scoped by filter_field='to_state' + filter_value=<state key>, then evaluates
 * the multi-dimension `filters` JSON against the record (M2M aliases resolve
 * to junction id arrays via resolveRecordValue).
 */
export async function fireWorkflowStateSubscriptions(opts: {
  collection: string
  item: string
  /** Human-facing record id (workflow_id / inventory_request_id …) for
   *  subjects + messages; falls back to the internal id when absent. */
  friendlyId?: string
  stateKey: string
  stateLabel: string
  transitionLabel: string
  actorUserId?: string | null
}): Promise<void> {
  try {
    const subs = await db('nivaro_notification_subscriptions as ns')
      .join('nivaro_users as u', 'ns.user', 'u.id')
      .where({
        'ns.collection': opts.collection,
        'ns.is_active': true,
        'ns.event_type': 'workflow_transition'
      })
      .select(
        'ns.id',
        'ns.user',
        'ns.filter_field',
        'ns.filter_value',
        'ns.filters',
        'ns.label',
        'ns.digest_frequency',
        'u.email',
        'u.first_name'
      )
    if (subs.length === 0) return

    const relevant = subs.filter(
      (s) =>
        !s.filter_value ||
        (s.filter_field ?? 'to_state') !== 'to_state' ||
        s.filter_value === opts.stateKey
    )
    if (relevant.length === 0) return

    const { resolveRecordValue } = await import('../services/workflow-transitions.js')
    const record = ((await db(opts.collection).where({ id: opts.item }).first()) ?? {}) as Record<
      string,
      unknown
    >
    // Per-path cache — many subscribers share the same dimension fields
    const valueCache = new Map<string, unknown>()
    const getValue = async (path: string) => {
      if (!valueCache.has(path)) {
        valueCache.set(
          path,
          await resolveRecordValue(opts.collection, record, path, opts.item, db)
        )
      }
      return valueCache.get(path)
    }

    const now = new Date()
    for (const sub of relevant) {
      if (opts.actorUserId && sub.user === opts.actorUserId) continue

      let filters: SubFilter[] = []
      try {
        const parsed = sub.filters ? JSON.parse(sub.filters) : []
        filters = Array.isArray(parsed) ? parsed : []
      } catch {
        filters = []
      }

      let pass = true
      for (const f of filters) {
        if (!f?.field || !f.op) continue
        const actual = await getValue(f.field)
        if (!filterMatches(f.op, actual, f.value)) {
          pass = false
          break
        }
      }
      if (!pass) continue

      const label = sub.label || `${opts.collection} workflow`
      const friendly = opts.friendlyId ?? opts.item
      const subject = `${label} ${friendly}: ${opts.transitionLabel} → ${opts.stateLabel}`
      const message = `${friendly} moved to "${opts.stateLabel}" (${opts.transitionLabel})`

      const [notif] = await db('nivaro_notifications')
        .insert({
          recipient: sub.user,
          subject: subject.slice(0, 255),
          status: 'inbox',
          timestamp: now,
          sender: opts.actorUserId ?? null,
          message: message.slice(0, 500),
          collection: opts.collection,
          item: opts.item
        })
        .returning('*')

      if (_app?.io) {
        emitNotification(_app.io, sub.user, {
          id: notif?.id ?? null,
          subject: subject.slice(0, 255),
          message: message.slice(0, 200),
          collection: opts.collection,
          item: opts.item,
          sender: opts.actorUserId ?? null,
          timestamp: now
        })
      }

      const frequency = (sub.digest_frequency as string | null) ?? 'instant'
      if (frequency === 'instant' && sub.email) {
        await sendMail({
          to: sub.email,
          subject,
          template: 'notification',
          data: {
            first_name: sub.first_name,
            message,
            action_url: `${config.ADMIN_URL}/collections/${opts.collection}/${opts.item}`,
            action_label: 'View item'
          }
        }).catch((err) => {
          console.warn('[notification-subscriptions] workflow email send failed:', err)
        })
      }
    }
  } catch (err) {
    console.warn('[notification-subscriptions] workflow transition error:', err)
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
