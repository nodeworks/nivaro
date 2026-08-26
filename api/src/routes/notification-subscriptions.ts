import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { resolveStateOwners } from '../services/pipeline-engine.js'
import type { QueueRow } from '../services/queues.js'
import { canReadQueue } from './queues.js'

const VALID_EVENT_TYPES = ['create', 'update', 'delete', 'all', 'workflow_transition'] as const
type EventType = (typeof VALID_EVENT_TYPES)[number]

const VALID_DIGEST_FREQUENCIES = ['instant', 'daily', 'weekly'] as const
type DigestFrequency = (typeof VALID_DIGEST_FREQUENCIES)[number]

function serialize(row: Record<string, unknown>) {
  return {
    id: row.id,
    user: row.user,
    collection: row.collection ?? null,
    queue_id: row.queue_id ?? null,
    queue_view_id: row.queue_view_id ?? null,
    event_type: row.event_type,
    filter_field: row.filter_field ?? null,
    filter_value: row.filter_value ?? null,
    filters: (() => {
      try {
        return row.filters ? JSON.parse(row.filters as string) : null
      } catch {
        return null
      }
    })(),
    label: row.label ?? null,
    is_active: !!row.is_active,
    digest_frequency: (row.digest_frequency as string | undefined) ?? 'instant',
    notify_inapp: row.notify_inapp !== false && row.notify_inapp !== 0,
    notify_email: row.notify_email !== false && row.notify_email !== 0,
    created_at: row.created_at
  }
}

export async function notificationSubscriptionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET /implicit/:collection/:item — why this user ALREADY gets notified for a
  // record without any subscription: they created it, or they're a current
  // pipeline owner (owner-notification flows + the daily digest cover both).
  // Feeds the record subscribe-bell dialog's info strip.
  app.get('/implicit/:collection/:item', async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }
    if (/^nivaro_/i.test(collection) || !/^[a-zA-Z0-9_]+$/.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const userId = String(req.user!.id).toUpperCase()
    const reasons: string[] = []
    try {
      const row = (await db(collection).where({ id: item }).first()) as
        | Record<string, unknown>
        | undefined
      if (row) {
        for (const col of ['user_created', 'creator', 'created_by']) {
          if (col in row && row[col] != null && String(row[col]).toUpperCase() === userId) {
            reasons.push('creator')
            break
          }
        }
      }
      const instance = (await db('nivaro_workflow_instances')
        .where({ collection, item })
        .first()) as { id: string; current_state: string } | undefined
      if (instance?.current_state) {
        const owners = await resolveStateOwners(instance.current_state, instance.id, collection, item)
        if (owners.some((o) => String(o.id).toUpperCase() === userId)) reasons.push('owner')
      }
    } catch {
      // best-effort — an unreadable record just means no implicit reasons
    }
    return reply.send({ data: { reasons } })
  })

  // GET / — list current user's subscriptions (or ?user= for admin)
  app.get('/', async (req, reply) => {
    const userId = req.user!.id
    const q = req.query as { user?: string }

    let targetUser = userId
    if (q.user && q.user !== userId) {
      if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      targetUser = q.user
    }

    const rows = await db('nivaro_notification_subscriptions')
      .where({ user: targetUser })
      .orderBy('created_at', 'desc')
      .select('*')

    return reply.send({ data: rows.map(serialize) })
  })

  // POST / — create subscription
  app.post('/', async (req, reply) => {
    const userId = req.user!.id
    const body = req.body as {
      collection?: string
      queue_id?: string
      queue_view_id?: number | null
      event_type?: string
      filter_field?: string
      filter_value?: string
      label?: string
      is_active?: boolean
      digest_frequency?: string
      notify_inapp?: boolean
      notify_email?: boolean
      filters?: Array<{ field: string; op: string; value?: unknown }>
    }

    const hasCollection = !!body.collection?.trim()
    const hasQueue = !!body.queue_id?.trim()
    if (hasCollection === hasQueue) {
      return reply.code(400).send({ error: 'exactly one of collection or queue_id is required' })
    }

    if (
      body.digest_frequency !== undefined &&
      !(VALID_DIGEST_FREQUENCIES as readonly string[]).includes(body.digest_frequency)
    ) {
      return reply
        .code(400)
        .send({ error: `digest_frequency must be one of: ${VALID_DIGEST_FREQUENCIES.join(', ')}` })
    }

    let queue: QueueRow | undefined
    if (hasQueue) {
      queue = await db('nivaro_queues').where({ id: body.queue_id }).first<QueueRow>()
      if (!queue) return reply.code(404).send({ error: 'Queue not found' })
      if (!canReadQueue(queue, req)) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      // Instant queue-entry notifications (#121): 'instant' is allowed now —
      // the queue-entry-notify cron (*/5) diffs the queue's id set per
      // subscription and notifies on NEW arrivals (view-subscriptions pattern).
      if (body.queue_view_id != null) {
        const view = await db('nivaro_queue_views')
          .where({ id: Number(body.queue_view_id), queue_id: body.queue_id })
          .first('id')
        if (!view) return reply.code(404).send({ error: 'Saved view not found on this queue' })
      }
      if (body.event_type && body.event_type !== 'all') {
        return reply.code(400).send({ error: 'queue subscriptions must use event_type "all"' })
      }
    } else {
      if (!body.event_type || !(VALID_EVENT_TYPES as readonly string[]).includes(body.event_type)) {
        return reply
          .code(400)
          .send({ error: `event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}` })
      }
    }

    const collection = hasCollection ? body.collection!.trim() : null
    const queueId = hasQueue ? body.queue_id!.trim() : null
    const event_type = (hasQueue ? 'all' : (body.event_type as EventType)) as EventType
    const filter_field = hasQueue ? null : body.filter_field?.trim() || null
    const filter_value = hasQueue ? null : body.filter_value?.trim() || null

    // Prevent exact duplicates
    const existing = hasQueue
      ? await db('nivaro_notification_subscriptions')
          .where({
            user: userId,
            queue_id: queueId,
            queue_view_id: hasQueue ? (body.queue_view_id ?? null) : null
          })
          .first('id')
      : await db('nivaro_notification_subscriptions')
          .where({
            user: userId,
            collection,
            event_type,
            filter_field: filter_field ?? null,
            filter_value: filter_value ?? null
          })
          .first('id')

    if (existing) {
      return reply.code(409).send({ error: 'A subscription with these settings already exists' })
    }

    const [row] = await db('nivaro_notification_subscriptions')
      .insert({
        user: userId,
        collection,
        queue_id: queueId,
        queue_view_id: hasQueue ? (body.queue_view_id ?? null) : null,
        event_type,
        filter_field,
        filter_value,
        label: body.label?.trim() || null,
        filters:
          !hasQueue && Array.isArray(body.filters) && body.filters.length
            ? JSON.stringify(body.filters)
            : null,
        is_active: body.is_active !== false,
        digest_frequency: (body.digest_frequency as DigestFrequency | undefined) ?? 'instant',
        notify_inapp: body.notify_inapp !== false,
        notify_email: body.notify_email !== false,
        created_at: new Date()
      })
      .returning('*')

    await logActivity({
      action: 'subscribe',
      user: userId,
      collection: 'nivaro_notification_subscriptions',
      item: String(row.id),
      comment: collection ?? `queue:${queueId}`,
      req
    })

    return reply.code(201).send({ data: serialize(row) })
  })

  // PATCH /:id — update subscription (own only, or admin)
  app.patch('/:id', async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const body = req.body as {
      label?: string | null
      filter_field?: string | null
      filter_value?: string | null
      is_active?: boolean
      digest_frequency?: string
      notify_inapp?: boolean
      notify_email?: boolean
      filters?: Array<{ field: string; op: string; value?: unknown }> | null
    }

    const existing = await db('nivaro_notification_subscriptions')
      .where({ id: Number(id) })
      .first('*')
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (existing.user !== userId && !req.isAdmin) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    if (
      body.digest_frequency !== undefined &&
      !(VALID_DIGEST_FREQUENCIES as readonly string[]).includes(body.digest_frequency)
    ) {
      return reply
        .code(400)
        .send({ error: `digest_frequency must be one of: ${VALID_DIGEST_FREQUENCIES.join(', ')}` })
    }
    if (existing.queue_id && body.digest_frequency === 'instant') {
      return reply
        .code(400)
        .send({ error: 'queue subscriptions only support daily or weekly digest_frequency' })
    }

    const updates: Record<string, unknown> = {}
    if ('label' in body) updates.label = body.label?.trim() || null
    if ('filter_field' in body) updates.filter_field = body.filter_field?.trim() || null
    if ('filter_value' in body) updates.filter_value = body.filter_value?.trim() || null
    if ('is_active' in body) updates.is_active = !!body.is_active
    if ('digest_frequency' in body) updates.digest_frequency = body.digest_frequency
    if ('notify_inapp' in body) updates.notify_inapp = body.notify_inapp !== false
    if ('notify_email' in body) updates.notify_email = body.notify_email !== false
    if ('filters' in body) {
      updates.filters =
        Array.isArray(body.filters) && body.filters.length ? JSON.stringify(body.filters) : null
    }

    if (Object.keys(updates).length === 0) {
      return reply.send({ data: serialize(existing) })
    }

    await db('nivaro_notification_subscriptions')
      .where({ id: Number(id) })
      .update(updates)

    const updated = await db('nivaro_notification_subscriptions')
      .where({ id: Number(id) })
      .first('*')
    await logActivity({
      action: 'update',
      user: userId,
      collection: 'nivaro_notification_subscriptions',
      item: String(id),
      req
    })
    return reply.send({ data: serialize(updated) })
  })

  // DELETE /:id — delete (own only, or admin)
  app.delete('/:id', async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_notification_subscriptions')
      .where({ id: Number(id) })
      .first('id', 'user')
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (existing.user !== userId && !req.isAdmin) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_notification_subscriptions')
      .where({ id: Number(id) })
      .del()
    await logActivity({
      action: 'unsubscribe',
      user: userId,
      collection: 'nivaro_notification_subscriptions',
      item: String(id),
      req
    })
    return reply.send({ data: { id: Number(id) } })
  })

  // GET /admin/all — all subscriptions with user info (admin only)
  app.get('/admin/all', { preHandler: [requireAdmin] }, async (_req, reply) => {
    const rows = await db('nivaro_notification_subscriptions as ns')
      .join('nivaro_users as u', 'ns.user', 'u.id')
      .orderBy('ns.created_at', 'desc')
      .select(
        'ns.id',
        'ns.user',
        'ns.collection',
        'ns.event_type',
        'ns.filter_field',
        'ns.filter_value',
        'ns.label',
        'ns.is_active',
        'ns.digest_frequency',
        'ns.created_at',
        'u.email as user_email',
        'u.first_name',
        'u.last_name'
      )

    return reply.send({
      data: rows.map((row) => ({
        ...serialize(row),
        user_email: row.user_email,
        user_name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.user_email
      }))
    })
  })

  // GET /admin/stats — per-collection subscription counts (admin only)
  app.get('/admin/stats', { preHandler: [requireAdmin] }, async (_req, reply) => {
    const rows = await db('nivaro_notification_subscriptions')
      .where({ is_active: true })
      .groupBy('collection', 'event_type')
      .select('collection', 'event_type')
      .count<{ collection: string; event_type: string; count: string | number }[]>({ count: '*' })

    // Group by collection
    const byCollection: Record<string, Record<string, number>> = {}
    for (const row of rows) {
      if (!byCollection[row.collection]) byCollection[row.collection] = {}
      byCollection[row.collection][row.event_type] = Number(row.count)
    }

    const stats = Object.entries(byCollection).map(([collection, events]) => ({
      collection,
      events,
      total: Object.values(events).reduce((s, n) => s + n, 0)
    }))

    return reply.send({ data: stats })
  })
}
