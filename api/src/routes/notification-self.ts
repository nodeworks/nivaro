import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { getFields, getRelations } from '../services/collections.js'
import { ForbiddenError, ItemNotFoundError, readOne } from '../services/items.js'
import { buildChanges, type FieldMeta, loadRevisionPair } from '../services/notification-changes.js'
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
import { deriveTarget, parseStoredTarget } from '../services/notification-target.js'
import { recordLabelsAsViewer } from '../services/record-labels-as-viewer.js'

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
 *   GET  /:id/changes      — #3079: the changed fields old → new, read on open AS THE READER
 *        from the revision the notification points at; readOne is the permission boundary
 *        (a field missing from the reader's read is never shown; an unreadable record = 404).
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

  app.get('/:id/changes', async (req, reply) => {
    const nid = Number((req.params as { id: string }).id)
    if (!Number.isInteger(nid) || nid <= 0)
      return reply.code(400).send({ error: 'Bad notification id' })
    const row = (await db('nivaro_notifications')
      .where({ id: nid, recipient: req.user!.id })
      .first()) as Record<string, unknown> | undefined
    if (!row) return reply.code(404).send({ error: 'Notification not found' })
    const target =
      parseStoredTarget(row.target) ??
      deriveTarget({
        collection: row.collection as string | null,
        item: row.item as string | null,
        subject: row.subject as string | null
      })
    const collection = target?.collection ?? (row.collection as string | null)
    const item = target?.id != null ? String(target.id) : (row.item as string | null)
    if (!collection || !item || /^(nivaro|directus)_/i.test(collection))
      return reply.code(400).send({ error: 'This notification is not about a record' })
    let current: Record<string, unknown> | null
    try {
      current = (await readOne(
        req.user!,
        collection,
        item,
        req.workspaceId ?? undefined
      )) as Record<string, unknown> | null
    } catch (err) {
      if (err instanceof ForbiddenError) return reply.code(404).send({ error: 'Record not found' })
      if (err instanceof ItemNotFoundError)
        return reply.code(404).send({ error: 'Record not found' })
      throw err
    }
    // readOne answers null for a row the reader cannot see (or one that is gone).
    if (!current) return reply.code(404).send({ error: 'Record not found' })

    // What the reader may see: scalar + M2O fields present on THEIR read (field permissions
    // already narrowed it), never hidden / alias / system columns.
    const [fields, relations] = await Promise.all([
      getFields(collection).catch(() => []),
      getRelations(collection).catch(() => [])
    ])
    const aliasNames = new Set(
      relations
        .filter((r) => r.one_collection === collection && r.one_field)
        .map((r) => String(r.one_field))
    )
    const m2oTarget = new Map<string, string>()
    for (const r of relations)
      if (r.many_collection === collection && r.one_collection && !r.junction_field)
        m2oTarget.set(r.many_field, r.one_collection)
    const visible = new Map<string, FieldMeta>()
    for (const f of fields) {
      const alias =
        f.type === 'alias' ||
        aliasNames.has(f.field) ||
        /m2m|o2m|m2a|list-/.test(String(f.interface ?? '')) ||
        (f.special ?? []).some((x) => /^(m2m|o2m|m2a|alias)$/.test(x))
      if (f.field === 'id' || f.hidden || alias || !(f.field in current)) continue
      visible.set(f.field, {
        field: f.field,
        label: (f as unknown as { label?: string | null }).label ?? null,
        type: f.type ?? null,
        m2o: m2oTarget.get(f.field) ?? null
      })
    }

    const revIdRaw = row.revision_id
    const pair = await loadRevisionPair({
      collection,
      item,
      revisionId: revIdRaw != null && revIdRaw !== '' ? Number(revIdRaw) : null,
      before: (row.timestamp as Date | string | null) ?? null
    })
    if (!pair)
      return reply.send({
        data: {
          collection,
          item,
          revision_id: null,
          at: null,
          notified_at: row.timestamp ?? null,
          changes: [],
          note: 'No revision from that time — the changes were not kept.'
        }
      })
    // M2O labels for both sides, read as the reader (an unreadable related record gets the
    // collection's name, never its id or a hint that it exists).
    const refs: Array<{ collection: string; id: string }> = []
    for (const key of [...Object.keys(pair.rev.delta ?? {}), ...Object.keys(pair.rev.data ?? {})]) {
      const m2o = visible.get(key)?.m2o
      if (!m2o) continue
      for (const v of [pair.prev?.data?.[key], pair.rev.delta?.[key] ?? pair.rev.data?.[key]])
        if (v != null && v !== '' && typeof v !== 'object')
          refs.push({ collection: m2o, id: String(v) })
    }
    const labels = refs.length
      ? await recordLabelsAsViewer(req.user!, refs).catch(() => ({}) as Record<string, string>)
      : {}
    const changes = buildChanges({ rev: pair.rev, prev: pair.prev, visible, labels })
    return reply.send({
      data: {
        collection,
        item,
        revision_id: pair.rev.id,
        at: pair.rev.at ?? null,
        notified_at: row.timestamp ?? null,
        changes,
        first_revision: pair.prev == null
      }
    })
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
