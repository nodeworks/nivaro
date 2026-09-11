import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import {
  renderChangesToken,
  renderNotificationTemplate
} from '../services/notification-templates.js'
import { emitNotification } from '../plugins/socketio.js'
import { getRelations } from '../services/collections.js'
import { sendMail } from '../services/mail.js'
import { hooks } from './registry.js'

/** A subscription that names ONE record (the per-record bell): filter_field
 *  'id', or a single `id eq` entry in `filters`. Such a watch is an explicit
 *  "tell me about this record", so it fires on the watcher's own edits too
 *  and on writes to the record's child rows — collection-wide subscriptions
 *  keep skipping the actor and only see their own collection. */
function isRecordScoped(sub: { filter_field?: string | null; filters?: unknown }): boolean {
  if (sub.filter_field === 'id') return true
  if (!sub.filters) return false
  try {
    const list = typeof sub.filters === 'string' ? JSON.parse(sub.filters) : sub.filters
    return (
      Array.isArray(list) &&
      list.length === 1 &&
      list[0]?.field === 'id' &&
      (list[0].op === 'eq' || list[0].op === undefined)
    )
  } catch {
    return false
  }
}

/** Child collection → parent M2O relations, so a write to a line rolls up to
 *  the parent record's watchers. 60s cache; relations change in Data Model. */
const parentRelCache = new Map<
  string,
  { at: number; rels: Array<{ parent: string; fk: string }> }
>()
async function parentRelationsOf(child: string): Promise<Array<{ parent: string; fk: string }>> {
  const hit = parentRelCache.get(child)
  if (hit && Date.now() - hit.at < 60_000) return hit.rels
  let rels: Array<{ parent: string; fk: string }> = []
  try {
    const rows = await getRelations(child)
    rels = rows
      .filter(
        (r) =>
          r.many_collection === child &&
          r.one_collection &&
          !r.junction_field &&
          !String(r.one_collection).startsWith('nivaro_')
      )
      .map((r) => ({ parent: r.one_collection as string, fk: r.many_field }))
  } catch {
    rels = []
  }
  parentRelCache.set(child, { at: Date.now(), rels })
  return rels
}

let _app: FastifyInstance | null = null
export function setApp(app: FastifyInstance) {
  _app = app
}

async function fireSubscriptionNotifications(
  collection: string,
  eventType: 'create' | 'update' | 'delete',
  item: string,
  data: Record<string, unknown> | null,
  actorUserId: string | undefined,
  /** Set when this fires on behalf of a CHILD-row write (a workflow line):
   *  only record-scoped watches of the parent are told, and the wording
   *  names the child. */
  viaChild?: { collection: string; item: string; event: 'create' | 'update' | 'delete' }
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
        'ns.filters',
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
      const recordScoped = isRecordScoped(sub)
      // Skip the actor for collection-wide subscriptions — nobody wants a
      // "you changed X" for every save. A record-scoped watch is explicit and
      // fires on the watcher's own edits too (Rob, 2026-09-11).
      if (actorUserId && sub.user === actorUserId && !recordScoped) continue
      // Child-row roll-ups reach record watchers only.
      if (viaChild && !recordScoped) continue

      // Apply optional field filter
      if (sub.filter_field && data) {
        const actualVal = String(data[sub.filter_field as string] ?? '')
        if (actualVal !== sub.filter_value) continue
      }

      const label = sub.label || `${collection} ${eventType}`
      const childLabel = viaChild ? viaChild.collection.replace(/_/g, ' ') : null
      let subject = viaChild
        ? `${label}: ${childLabel} ${viaChild.event}d${by}`
        : `${label}: ${eventType} in ${collection}${by}`
      let message = viaChild
        ? `${actorName ?? 'Someone'} ${viaChild.event}d ${childLabel} ${viaChild.item} on item ${item} in ${collection}`
        : actorName
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

      // Immediate email only for instant subscriptions — daily/weekly ride
      // the daily action summary (services/daily-digest.ts). In-app
      // notification above is always inserted regardless of cadence. The
      // subscription's own cadence beats the category's daily default.
      const frequency = (sub.digest_frequency as string | null) ?? 'instant'
      if (frequency === 'instant' && wantEmail && sub.email) {
        await sendMail({
          collection,
          item,
          to: sub.email,
          subject,
          category: 'watch',
          cadence: 'sender',
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
        valueCache.set(path, await resolveRecordValue(opts.collection, record, path, opts.item, db))
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
      if (opts.actorUserId && sub.user === opts.actorUserId && !isRecordScoped(sub)) continue

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
          category: 'workflow',
          cadence: 'sender',
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

/** A write to a child row (workflow line, allocation…) is a change to the
 *  parent record as far as someone WATCHING that record is concerned: fire the
 *  parent's record-scoped subscriptions for every M2O parent the row names. */
async function rollUpToParents(
  child: string,
  event: 'create' | 'update' | 'delete',
  childItem: string,
  row: Record<string, unknown> | null,
  actorUserId: string | undefined
) {
  if (!row) return
  const rels = await parentRelationsOf(child)
  for (const rel of rels) {
    const parentId = row[rel.fk]
    if (parentId == null || parentId === '') continue
    await fireSubscriptionNotifications(
      rel.parent,
      'update',
      String(parentId),
      { id: parentId },
      actorUserId,
      { collection: child, item: childItem, event }
    ).catch(() => undefined)
  }
}

export function registerNotificationSubscriptionHooks() {
  hooks.after('*', 'create', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const item = ctx.keys?.[0] != null ? String(ctx.keys[0]) : ''
    const row = ctx.result as Record<string, unknown> | null
    await fireSubscriptionNotifications(ctx.collection, 'create', item, row, ctx.user?.id)
    await rollUpToParents(ctx.collection, 'create', item, row, ctx.user?.id)
  })

  hooks.after('*', 'update', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const item = ctx.keys?.[0] != null ? String(ctx.keys[0]) : ''
    const row = ctx.result as Record<string, unknown> | null
    await fireSubscriptionNotifications(ctx.collection, 'update', item, row, ctx.user?.id)
    await rollUpToParents(ctx.collection, 'update', item, row, ctx.user?.id)
  })

  hooks.after('*', 'delete', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const item = ctx.keys?.[0] != null ? String(ctx.keys[0]) : ''
    const prev = ctx.previousData as Record<string, unknown> | null
    await rollUpToParents(ctx.collection, 'delete', item, prev, ctx.user?.id)
    await fireSubscriptionNotifications(ctx.collection, 'delete', item, prev, ctx.user?.id)
  })
}
