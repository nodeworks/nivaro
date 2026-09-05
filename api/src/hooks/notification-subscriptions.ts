import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { renderChangesToken, renderNotificationTemplate } from '../services/notification-templates.js'
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
        'ns.notify_inapp',
        'ns.notify_email',
        'u.email',
        'u.first_name'
      )

    const now = new Date()

    // Who did it. "A change was made" leaves the reader having to open the
    // record and dig through history to learn the one thing they usually want
    // to know first; the actor is already in scope, it just was not said.
    let actorName: string | null = null
    if (actorUserId) {
      try {
        const a = (await db('nivaro_users')
          .where({ id: actorUserId })
          .first('first_name', 'last_name', 'email')) as
          | { first_name?: string | null; last_name?: string | null; email?: string | null }
          | undefined
        actorName =
          [a?.first_name, a?.last_name].filter(Boolean).join(' ').trim() || a?.email || null
      } catch {
        // Never let naming the actor stop the notification.
      }
    }
    const by = actorName ? ` by ${actorName}` : ''

    for (const sub of subs) {
      // Skip the actor — don't notify the user who triggered the event
      if (actorUserId && sub.user === actorUserId) continue

      // Apply optional field filter
      if (sub.filter_field && data) {
        const actualVal = String(data[sub.filter_field as string] ?? '')
        if (actualVal !== sub.filter_value) continue
      }

      const label = sub.label || `${collection} ${eventType}`
      let subject = `${label}: ${eventType} in ${collection}${by}`
      let message = actorName
        ? `${actorName} performed a ${eventType} on item ${item} in ${collection}`
        : `A ${eventType} event occurred on item ${item} in ${collection}`
      // Notification templates (#126): a `notification:subscription.<event>`
      // mail-template override rewrites the wording; {{changes}} carries the
      // field diff (#384). Hardcoded wording stays the default.
      const templated = await renderNotificationTemplate(`subscription.${eventType}`, {
        collection,
        record: item,
        actor: actorName ?? '',
        event: eventType,
        label,
        changes: renderChangesToken(data as Record<string, unknown>, null)
      }).catch(() => null)
      if (templated) {
        subject = templated.subject
        message = templated.message || message
      }

      // Per-subscription channels (#649): notify_inapp / notify_email are
      // migration-278 columns; NULL means "on" so every historic row keeps its
      // exact prior behavior.
      const wantInapp = channelOn(sub.notify_inapp)
      const wantEmail = channelOn(sub.notify_email)

      if (wantInapp) {
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
      }

      // Immediate email only for instant subscriptions — daily/weekly are
      // batched by the digest cron (services/digest.ts). In-app notification
      // above is always inserted regardless of digest frequency.
      const frequency = (sub.digest_frequency as string | null) ?? 'instant'
      if (frequency === 'instant' && wantEmail && sub.email) {
        await sendMail({
          collection,
          item,
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

/** Channel column truthiness (#649): NULL = on (historic rows), mssql bit 0/false = off. */
function channelOn(v: unknown): boolean {
  return v !== false && v !== 0
}

export type SubFilterOp = 'eq' | 'in' | 'intersects' | 'null' | 'nnull'
export interface SubFilter {
  field: string
  op: SubFilterOp
  value?: unknown
}

export function filterMatches(op: SubFilterOp, actual: unknown, expected: unknown): boolean {
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
    // An addendum's transition notifies the PARENT record's subscribers: the
    // subscription rows, the record the filters read, and the notification's
    // link all point at the parent (pipeline-subject.ts). The friendly id
    // already names the addendum.
    const { resolvePipelineSubject } = await import('../services/pipeline-subject.js')
    const subject = await resolvePipelineSubject(opts.collection, opts.item)
    opts = { ...opts, collection: subject.collection, item: subject.itemId }
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
        'ns.notify_inapp',
        'ns.notify_email',
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

    // Same reasoning as the record-change path: a state change is something a
    // PERSON did, and the reader's first question is who.
    let actorName: string | null = null
    if (opts.actorUserId) {
      try {
        const a = (await db('nivaro_users')
          .where({ id: opts.actorUserId })
          .first('first_name', 'last_name', 'email')) as
          | { first_name?: string | null; last_name?: string | null; email?: string | null }
          | undefined
        actorName =
          [a?.first_name, a?.last_name].filter(Boolean).join(' ').trim() || a?.email || null
      } catch {
        // Naming the actor must never stop the notification.
      }
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
      let subject = `${label} ${friendly}: ${opts.transitionLabel} → ${opts.stateLabel}${
        actorName ? ` by ${actorName}` : ''
      }`
      let message = actorName
        ? `${actorName} moved ${friendly} to "${opts.stateLabel}" (${opts.transitionLabel})`
        : `${friendly} moved to "${opts.stateLabel}" (${opts.transitionLabel})`
      const templated = await renderNotificationTemplate('workflow_transition', {
        collection: opts.collection,
        record: friendly,
        state: opts.stateLabel,
        transition: opts.transitionLabel,
        actor: actorName ?? '',
        label
      }).catch(() => null)
      if (templated) {
        subject = templated.subject
        message = templated.message || message
      }

      const wantInapp = channelOn(sub.notify_inapp)
      const wantEmail = channelOn(sub.notify_email)

      if (wantInapp) {
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
      }

      const frequency = (sub.digest_frequency as string | null) ?? 'instant'
      if (frequency === 'instant' && wantEmail && sub.email) {
        await sendMail({
          collection: opts.collection,
          item: opts.item,
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
