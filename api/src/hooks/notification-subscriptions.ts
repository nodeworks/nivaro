import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { getRelations } from '../services/collections.js'
import { sendMail } from '../services/mail.js'
import { notificationRowMeta } from '../services/notification-channels.js'
import {
  renderChangesToken,
  renderNotificationTemplate
} from '../services/notification-templates.js'
import { computeDelta } from '../services/revisions.js'
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

/** Friendly label for a record: the entity-room registry's match_field
 *  (CM26-79811 for workflows) first, then the collection's display template,
 *  then '#<id>'. Both resolvers are imported lazily — workflow-transitions.ts
 *  and queues.ts import THIS module, so a static import would be circular. */
async function friendlyRecordLabel(collection: string, item: string): Promise<string> {
  try {
    const { resolveFriendlyId } = await import('../services/workflow-transitions.js')
    const f = await resolveFriendlyId(collection, item)
    if (f && f !== String(item)) return f
  } catch {
    /* fall through */
  }
  try {
    const { getLabels } = await import('../services/queues.js')
    const labels = await getLabels(new Map([[collection, new Set([String(item)])]]))
    const l = labels[`${collection}:${item}`]
    if (l && l !== String(item)) return l
  } catch {
    /* fall through */
  }
  return `#${item}`
}

/** The record's friendly label, or — for a row that belongs to a parent
 *  record (a line, a forecast year) — "<child> <row label> on <parent>". */
async function friendlyRowLabel(
  collection: string,
  item: string,
  row: Record<string, unknown> | null
): Promise<string> {
  const own = await friendlyRecordLabel(collection, item)
  try {
    const rels = await parentRelationsOf(collection)
    if (rels.length === 0) return own
    // The coalescer's flush hands over `{id}` only — read the FKs off the row.
    let src: Record<string, unknown> | null = row
    if (!src || !rels.some((r) => src?.[r.fk] != null)) {
      src =
        ((await db(collection)
          .where('id', item)
          .first(...rels.map((r) => r.fk))
          .catch(() => null)) as Record<string, unknown> | null) ?? null
    }
    for (const rel of rels) {
      const parentId = src?.[rel.fk]
      if (parentId == null || parentId === '') continue
      const parent = await friendlyRecordLabel(rel.parent, String(parentId))
      const childLabel = collection.replace(/_/g, ' ')
      // A child whose own label already names the parent ("CM26-79811 ·
      // Line 4") needs no "on CM26-79811" after it.
      return own.includes(parent) ? `${childLabel} ${own}` : `${childLabel} ${own} on ${parent}`
    }
  } catch {
    /* the row's own label is still right */
  }
  return own
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

/** Everything one person changed on one record in one sitting: header field
 *  diffs plus child-row diffs / adds / removes, each labelled the way the
 *  email table shows them. */
export interface RecordChangeBundle {
  changes: Array<{ field: string; label: string; old: string; new: string }>
  /** Distinct child collections touched, for the subject line. */
  children: string[]
  /** Number of distinct writes folded in. */
  writes: number
}

// ── Per-record coalescing (2026-09-14: one edit to a child row + its parent
// used to send two emails). A form save is several writes: the parent
// PATCH, then each staged line. Record watches used to get one message per
// write. Now every record-scoped change is parked per (record, actor) and
// flushed once the writes go quiet for COALESCE_MS (hard cap COALESCE_MAX_MS
// so a slow trickle still lands), as ONE notification + ONE email listing
// all of it. Collection-wide subscriptions keep firing per write — they are
// feeds, not a watch on a record. Pending work is process-local; a restart
// mid-window loses the bundle (the writes themselves are safe).
const COALESCE_MS = Number(process.env.RECORD_WATCH_COALESCE_MS ?? 15_000)
const COALESCE_MAX_MS = Number(process.env.RECORD_WATCH_COALESCE_MAX_MS ?? 90_000)
type Pending = {
  collection: string
  item: string
  actorUserId: string | undefined
  bundle: RecordChangeBundle
  timer: NodeJS.Timeout | null
  startedAt: number
}
const pendingRecordChanges = new Map<string, Pending>()

async function flushRecordChanges(key: string) {
  const p = pendingRecordChanges.get(key)
  if (!p) return
  pendingRecordChanges.delete(key)
  if (p.timer) clearTimeout(p.timer)
  if (p.bundle.changes.length === 0) return
  await fireSubscriptionNotifications(
    p.collection,
    'update',
    p.item,
    { id: p.item },
    p.actorUserId,
    undefined,
    null,
    { scope: 'record', bundle: p.bundle }
  ).catch(() => undefined)
}

/** Test/ops hook: flush everything now (unit tests, graceful shutdown). */
export async function flushAllRecordChanges() {
  await Promise.all([...pendingRecordChanges.keys()].map((k) => flushRecordChanges(k)))
}

function enqueueRecordChange(
  collection: string,
  item: string,
  actorUserId: string | undefined,
  changes: RecordChangeBundle['changes'],
  child?: string
) {
  if (changes.length === 0) return
  const key = `${collection}:${item}:${actorUserId ?? ''}`
  let p = pendingRecordChanges.get(key)
  if (!p) {
    p = {
      collection,
      item,
      actorUserId,
      bundle: { changes: [], children: [], writes: 0 },
      timer: null,
      startedAt: Date.now()
    }
    pendingRecordChanges.set(key, p)
  }
  // A field edited twice in one sitting reads old(first) → new(last).
  for (const c of changes) {
    const prior = p.bundle.changes.find((x) => x.field === c.field && x.label === c.label)
    if (prior) prior.new = c.new
    else p.bundle.changes.push(c)
  }
  if (child && !p.bundle.children.includes(child)) p.bundle.children.push(child)
  p.bundle.writes += 1
  if (p.timer) clearTimeout(p.timer)
  const remaining = Math.max(
    500,
    Math.min(COALESCE_MS, COALESCE_MAX_MS - (Date.now() - p.startedAt))
  )
  p.timer = setTimeout(() => void flushRecordChanges(key), remaining)
  p.timer.unref?.()
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
  viaChild?: {
    collection: string
    item: string
    event: 'create' | 'update' | 'delete'
    /** The child row's own friendly label ("2026" for a forecast year). */
    label?: string | null
    /** The child row's labelled old → new list (its OWN fields). */
    changes?: Array<{ field: string; label: string; old: string; new: string }>
  },
  /** The row BEFORE an update — powers the old → new table in the email. */
  previous?: Record<string, unknown> | null,
  opts?: {
    /** Which subscriptions to serve: 'wide' = collection-wide only, 'record'
     *  = per-record watches only (the coalescer's flush), 'all' = both. */
    scope?: 'all' | 'wide' | 'record'
    /** A coalesced bundle of everything one person changed on this record in
     *  one sitting — header fields and child rows — sent as ONE message. */
    bundle?: RecordChangeBundle
  }
) {
  const scope = opts?.scope ?? 'all'
  const bundle = opts?.bundle
  try {
    // An update that changed nothing (a meta-only PATCH, an alias-only write,
    // a re-save) is not news — nobody wants "X was updated" with an empty
    // change list. Judged on the re-read row vs the row before; child-row
    // roll-ups are judged by the caller on the child's own delta.
    if (eventType === 'update' && !viaChild && !bundle && data && previous) {
      const delta = computeDelta(previous, data)
      for (const k of ['updated_at', 'date_updated', 'user_updated', 'changed', 'modified_at'])
        delete delta[k]
      if (Object.keys(delta).length === 0) return
    }
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
      if (scope === 'wide' && recordScoped) continue
      if (scope === 'record' && !recordScoped) continue
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

      // Record watches speak in the record's friendly label ("CM26-79811"),
      // never the internal id or the label captured at subscribe time. A
      // watch on a CHILD row (#11 — one forecast year, one PO line) names the
      // row AND the record it belongs to: "forecasts 2026 on CM26-79811".
      const friendly = recordScoped ? await friendlyRowLabel(collection, item, data) : null
      const collectionLabel = collection.replace(/_/g, ' ')
      const label = friendly ? `Watching ${friendly}` : sub.label || `${collection} ${eventType}`
      const childLabel = viaChild ? viaChild.collection.replace(/_/g, ' ') : null
      const childRef = viaChild
        ? viaChild.label
          ? `${childLabel} ${viaChild.label}`
          : `${childLabel} row`
        : null
      const childWhat = viaChild?.changes?.length
        ? ` — ${viaChild.changes
            .slice(0, 3)
            .map((c) => `${c.label}: ${c.old ? `${c.old} → ` : ''}${c.new}`)
            .join(', ')}${viaChild.changes.length > 3 ? ', …' : ''}`
        : ''
      const recordRef = friendly ? friendly : `item ${item} in ${collection}`
      const bundleWhat = bundle
        ? ` — ${bundle.changes
            .slice(0, 3)
            .map((c) => `${c.label}: ${c.old ? `${c.old} → ` : ''}${c.new}`)
            .join(', ')}${bundle.changes.length > 3 ? `, +${bundle.changes.length - 3} more` : ''}`
        : ''
      let subject = bundle
        ? `${label}: ${bundle.changes.length} ${bundle.changes.length === 1 ? 'change' : 'changes'}${by}`
        : viaChild
          ? `${label}: ${childRef} ${viaChild.event}d${by}`
          : friendly
            ? `${label}: ${eventType}d${by}`
            : `${label}: ${eventType} in ${collection}${by}`
      let message = bundle
        ? `${actorName ?? 'Someone'} changed ${recordRef}${bundleWhat}`
        : viaChild
          ? `${actorName ?? 'Someone'} ${viaChild.event}d ${childRef} on ${recordRef}${childWhat}`
          : actorName
            ? `${actorName} ${eventType}d ${recordRef}${friendly ? ` (${collectionLabel})` : ''}`
            : `${recordRef} was ${eventType}d${friendly ? ` (${collectionLabel})` : ''}`
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
      // A coalesced bundle already says exactly what moved — an admin
      // template for the bare event would hide it.
      if (templated && !bundle) {
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
            item,
            ...notificationRowMeta({ subject, category: 'watch', kind: 'record', action: 'open' })
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
        // Detailed body: the record's header-strip card + a labelled old →
        // new table (mail-types.ts builders, shared with the admin harness).
        let emailCtx: Record<string, unknown> = {}
        try {
          const { buildRecordCard } = await import('../services/mail-record-card.js')
          const { labelledChanges } = await import('../services/mail-types.js')
          const card = item
            ? await buildRecordCard(collection, item, { recipientUserId: sub.user }).catch(
                () => null
              )
            : null
          let delta: Record<string, unknown> | null = null
          if (eventType === 'update' && data && previous) {
            delta = {}
            for (const [k, v] of Object.entries(data)) {
              if (JSON.stringify(previous[k] ?? null) !== JSON.stringify(v ?? null)) delta[k] = v
            }
          }
          emailCtx = {
            collection,
            item,
            event: viaChild ? viaChild.event : eventType,
            actor_name: actorName,
            record_card: card,
            record_url: card?.url ?? `${config.ADMIN_URL}/collections/${collection}/${item}`,
            friendly_id: friendly ?? card?.title ?? String(item),
            changes: bundle
              ? bundle.changes
              : viaChild
                ? (viaChild.changes ?? [])
                : delta
                  ? await labelledChanges(collection, delta, previous)
                  : [],
            via_child: viaChild
              ? {
                  collection: viaChild.collection,
                  item: viaChild.item,
                  event: viaChild.event,
                  label: viaChild.label ?? null,
                  collection_label: viaChild.collection.replace(/_/g, ' ')
                }
              : null,
            subscription_label: sub.label || `${collectionLabel} subscription`
          }
        } catch {
          emailCtx = {}
        }
        await sendMail({
          collection,
          item,
          to: sub.email,
          subject,
          category: 'watch',
          cadence: 'sender',
          template: recordScoped ? 'record_watch' : 'subscription',
          why: recordScoped
            ? 'you watch this record'
            : `you subscribed to "${sub.label || `${collectionLabel} subscription`}"`,
          data: {
            first_name: sub.first_name,
            message,
            ...emailCtx,
            ...(item
              ? {
                  action_url:
                    (emailCtx.record_url as string | undefined) ??
                    `${config.ADMIN_URL}/collections/${collection}/${item}`,
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

      const recordScoped = isRecordScoped(sub)
      const friendly =
        opts.friendlyId ??
        (recordScoped ? await friendlyRecordLabel(opts.collection, opts.item) : opts.item)
      const label = recordScoped
        ? `Watching ${friendly}`
        : sub.label || `${opts.collection} workflow`
      let subject = `${recordScoped ? label : `${label} ${friendly}`}: ${opts.transitionLabel} → ${opts.stateLabel}${
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
            item: opts.item,
            ...notificationRowMeta({
              subject,
              category: 'workflow',
              kind: 'record',
              action: 'open'
            })
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
          why: recordScoped
            ? 'you watch this record'
            : `you subscribed to ${opts.collection.replace(/_/g, ' ')} state changes${
                sub.filter_value ? ` into ${opts.stateLabel}` : ''
              }`,
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
  actorUserId: string | undefined,
  previous?: Record<string, unknown> | null
) {
  if (!row) return
  const rels = await parentRelationsOf(child)
  if (rels.length === 0) return
  // What moved on the child row — the email shows THAT, not the parent's
  // header fields (Rob: "show the changes instead of a blanket set of
  // fields"). A child update that changed nothing rolls up to nobody.
  let changes: Array<{ field: string; label: string; old: string; new: string }> | undefined
  if (event === 'update') {
    if (!previous) return
    const delta = computeDelta(previous, row)
    for (const k of ['updated_at', 'date_updated', 'user_updated', 'changed', 'modified_at'])
      delete delta[k]
    if (Object.keys(delta).length === 0) return
    try {
      const { labelledChanges } = await import('../services/mail-types.js')
      changes = await labelledChanges(child, delta, previous)
    } catch {
      changes = undefined
    }
  }
  const label = await friendlyRecordLabel(child, childItem).catch(() => null)
  const rowLabel = label && label !== `#${childItem}` ? label : null
  // Each change names the row it belongs to — "Amount · Line 3: 2 → 1". A
  // field name alone does not say which child row moved.
  if (rowLabel && changes)
    changes = changes.map((c) => ({ ...c, label: `${c.label} · ${rowLabel}` }))
  const childLabel = child.replace(/_/g, ' ')
  const rowRef = rowLabel ? `${childLabel} ${rowLabel}` : `${childLabel} row`
  // Adds/removes become one change line each; updates carry their diff.
  const bundleChanges: RecordChangeBundle['changes'] =
    event === 'update'
      ? (changes ?? [])
      : [
          {
            field: `__${event}__:${child}:${childItem}`,
            label: rowRef,
            old: '',
            new: event === 'create' ? 'added' : 'removed'
          }
        ]
  for (const rel of rels) {
    const parentId = row[rel.fk]
    if (parentId == null || parentId === '') continue
    enqueueRecordChange(rel.parent, String(parentId), actorUserId, bundleChanges, child)
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
    const previous = (ctx.previousData as Record<string, unknown> | null) ?? null
    // Collection-wide feeds fire per write; the record's own watchers get
    // one coalesced message once the sitting's writes go quiet.
    await fireSubscriptionNotifications(
      ctx.collection,
      'update',
      item,
      row,
      ctx.user?.id,
      undefined,
      previous,
      {
        scope: 'wide'
      }
    )
    if (row && previous) {
      const delta = computeDelta(previous, row)
      for (const k of ['updated_at', 'date_updated', 'user_updated', 'changed', 'modified_at'])
        delete delta[k]
      if (Object.keys(delta).length > 0) {
        const { labelledChanges } = await import('../services/mail-types.js')
        const changes = await labelledChanges(ctx.collection, delta, previous).catch(() => [])
        enqueueRecordChange(ctx.collection, item, ctx.user?.id, changes)
      }
    }
    await rollUpToParents(
      ctx.collection,
      'update',
      item,
      row,
      ctx.user?.id,
      (ctx.previousData as Record<string, unknown> | null) ?? null
    )
  })

  hooks.after('*', 'delete', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const item = ctx.keys?.[0] != null ? String(ctx.keys[0]) : ''
    const prev = ctx.previousData as Record<string, unknown> | null
    await rollUpToParents(ctx.collection, 'delete', item, prev, ctx.user?.id)
    await fireSubscriptionNotifications(ctx.collection, 'delete', item, prev, ctx.user?.id)
  })
}
