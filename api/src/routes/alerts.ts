import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { evaluateAlerts } from '../hooks/alerts.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

interface AlertDefinitionRow {
  id: number
  name: string
  category: string
  collection: string
  field: string
  operator: string
  threshold: number
  unit: string
  filters: string | null
  cooldown_minutes: number
  is_active: boolean | number
  detection_type: string
  sensitivity: number | null
  created_by: string | null
  created_at: Date
  updated_at: Date
}

function formatDef(row: AlertDefinitionRow) {
  return {
    ...row,
    is_active: row.is_active === true || row.is_active === 1,
    filters: parseJson(row.filters),
    detection_type: row.detection_type === 'anomaly' ? 'anomaly' : 'threshold',
    sensitivity: row.sensitivity != null ? Number(row.sensitivity) : null
  }
}

export async function alertsRoutes(app: FastifyInstance) {
  // ── Alert Definitions (admin only) ────────────────────────────────────────

  app.get('/definitions', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await db('nivaro_alert_definitions as d')
      .leftJoin('nivaro_alert_subscriptions as s', 's.alert_definition', 'd.id')
      .leftJoin('nivaro_alert_log as l', (join) => {
        join.on('l.alert_definition', '=', 'd.id')
      })
      .select(
        'd.*',
        db.raw('COUNT(DISTINCT s.id) as subscriber_count'),
        db.raw('MAX(l.triggered_at) as last_triggered')
      )
      .groupBy(
        'd.id',
        'd.name',
        'd.category',
        'd.collection',
        'd.field',
        'd.operator',
        'd.threshold',
        'd.unit',
        'd.filters',
        'd.cooldown_minutes',
        'd.is_active',
        'd.detection_type',
        'd.sensitivity',
        'd.created_by',
        'd.created_at',
        'd.updated_at'
      )
      .orderBy('d.id', 'desc')

    return reply.send({
      data: rows.map((r) => ({
        ...formatDef(r as AlertDefinitionRow),
        subscriber_count: Number(r.subscriber_count ?? 0),
        last_triggered: r.last_triggered ?? null
      }))
    })
  })

  app.get<{ Params: { id: string } }>(
    '/definitions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const row = await db('nivaro_alert_definitions').where({ id }).first<AlertDefinitionRow>()
      if (!row) return reply.code(404).send({ error: 'Not found' })

      const subscribers = await db('nivaro_alert_subscriptions as s')
        .join('nivaro_users as u', 's.user', 'u.id')
        .where({ 's.alert_definition': id })
        .select(
          's.id',
          's.user',
          's.notify_email',
          's.notify_inapp',
          'u.first_name',
          'u.last_name',
          'u.email'
        )

      return reply.send({ data: { ...formatDef(row), subscribers } })
    }
  )

  app.post('/definitions', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      name: string
      category?: string
      collection: string
      field: string
      operator: string
      threshold: number
      unit?: string
      filters?: Record<string, unknown> | null
      cooldown_minutes?: number
      is_active?: boolean
      detection_type?: string
      sensitivity?: number | null
    }

    const detectionType = body.detection_type === 'anomaly' ? 'anomaly' : 'threshold'

    if (!body.name || !body.collection || !body.field) {
      return reply.code(400).send({ error: 'name, collection, field are required' })
    }
    if (detectionType === 'threshold' && (!body.operator || body.threshold == null)) {
      return reply
        .code(400)
        .send({ error: 'operator and threshold are required for threshold alerts' })
    }

    const now = new Date()
    const [id] = await db('nivaro_alert_definitions').insert({
      name: body.name,
      category: body.category ?? 'general',
      collection: body.collection,
      field: body.field,
      operator: body.operator ?? 'gt',
      threshold: body.threshold ?? 0,
      unit: body.unit ?? 'count',
      filters: body.filters ? JSON.stringify(body.filters) : null,
      cooldown_minutes: body.cooldown_minutes ?? 60,
      is_active: body.is_active !== false ? 1 : 0,
      detection_type: detectionType,
      sensitivity:
        detectionType === 'anomaly'
          ? body.sensitivity != null
            ? Number(body.sensitivity)
            : 2.0
          : null,
      created_by: req.user?.id ?? null,
      created_at: now,
      updated_at: now
    })

    const created = await db('nivaro_alert_definitions').where({ id }).first<AlertDefinitionRow>()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_alert_definitions',
      item: String(id),
      req
    })
    return reply.code(201).send({ data: formatDef(created!) })
  })

  app.patch<{ Params: { id: string } }>(
    '/definitions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_alert_definitions')
        .where({ id })
        .first<AlertDefinitionRow>()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body as Partial<{
        name: string
        category: string
        collection: string
        field: string
        operator: string
        threshold: number
        unit: string
        filters: Record<string, unknown> | null
        cooldown_minutes: number
        is_active: boolean
        detection_type: string
        sensitivity: number | null
      }>

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (body.name != null) patch.name = body.name
      if (body.category != null) patch.category = body.category
      if (body.collection != null) patch.collection = body.collection
      if (body.field != null) patch.field = body.field
      if (body.operator != null) patch.operator = body.operator
      if (body.threshold != null) patch.threshold = body.threshold
      if (body.unit != null) patch.unit = body.unit
      if ('filters' in body) patch.filters = body.filters ? JSON.stringify(body.filters) : null
      if (body.cooldown_minutes != null) patch.cooldown_minutes = body.cooldown_minutes
      if (body.is_active != null) patch.is_active = body.is_active ? 1 : 0
      if (body.detection_type != null) {
        patch.detection_type = body.detection_type === 'anomaly' ? 'anomaly' : 'threshold'
      }
      if ('sensitivity' in body) {
        patch.sensitivity = body.sensitivity != null ? Number(body.sensitivity) : null
      }

      await db('nivaro_alert_definitions').where({ id }).update(patch)
      const updated = await db('nivaro_alert_definitions').where({ id }).first<AlertDefinitionRow>()
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_alert_definitions',
        item: String(id),
        req
      })
      return reply.send({ data: formatDef(updated!) })
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/definitions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_alert_definitions').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_alert_log').where({ alert_definition: id }).delete()
      await db('nivaro_alert_subscriptions').where({ alert_definition: id }).delete()
      await db('nivaro_alert_definitions').where({ id }).delete()

      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_alert_definitions',
        item: String(id),
        req
      })
      return reply.code(204).send()
    }
  )

  // ── Alert Subscriptions (any authenticated user) ───────────────────────────

  app.get('/subscriptions', { preHandler: authenticate }, async (req, reply) => {
    const userId = req.user!.id
    const rows = await db('nivaro_alert_subscriptions as s')
      .join('nivaro_alert_definitions as d', 's.alert_definition', 'd.id')
      .where({ 's.user': userId })
      .select(
        's.id',
        's.alert_definition',
        's.notify_email',
        's.notify_inapp',
        'd.name',
        'd.category',
        'd.collection',
        'd.field',
        'd.operator',
        'd.threshold',
        'd.unit',
        'd.is_active'
      )

    return reply.send({ data: rows })
  })

  app.post('/subscriptions', { preHandler: authenticate }, async (req, reply) => {
    const userId = req.user!.id
    const body = req.body as {
      alert_definition: number
      notify_email?: boolean
      notify_inapp?: boolean
    }

    if (!body.alert_definition) {
      return reply.code(400).send({ error: 'alert_definition is required' })
    }

    const def = await db('nivaro_alert_definitions').where({ id: body.alert_definition }).first()
    if (!def) return reply.code(404).send({ error: 'Alert definition not found' })

    if (!req.isAdmin && !(await can(req.user!, 'read', def.collection as string))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    // Upsert: delete existing then insert
    await db('nivaro_alert_subscriptions')
      .where({ alert_definition: body.alert_definition, user: userId })
      .delete()

    const [id] = await db('nivaro_alert_subscriptions').insert({
      alert_definition: body.alert_definition,
      user: userId,
      notify_email: body.notify_email !== false ? 1 : 0,
      notify_inapp: body.notify_inapp !== false ? 1 : 0
    })

    const created = await db('nivaro_alert_subscriptions').where({ id }).first()
    await logActivity({
      action: 'subscribe',
      user: userId,
      collection: 'nivaro_alert_subscriptions',
      item: String(id),
      req
    })
    return reply.code(201).send({ data: created })
  })

  app.delete<{ Params: { id: string } }>(
    '/subscriptions/:id',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = Number(req.params.id)
      const sub = await db('nivaro_alert_subscriptions').where({ id }).first()
      if (!sub) return reply.code(404).send({ error: 'Not found' })

      // Only own subscription or admin
      if (sub.user !== req.user!.id && !req.isAdmin) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      await db('nivaro_alert_subscriptions').where({ id }).delete()
      await logActivity({
        action: 'unsubscribe',
        user: req.user?.id,
        collection: 'nivaro_alert_subscriptions',
        item: String(id),
        req
      })
      return reply.code(204).send()
    }
  )

  // ── Alert Log (admin) ──────────────────────────────────────────────────────

  app.get<{ Querystring: { definition?: string } }>(
    '/log',
    { preHandler: requireAdmin },
    async (req, reply) => {
      let query = db('nivaro_alert_log as l')
        .join('nivaro_alert_definitions as d', 'l.alert_definition', 'd.id')
        .select(
          'l.*',
          'd.name as definition_name',
          'd.category',
          'd.field',
          'd.operator',
          'd.threshold',
          'd.unit'
        )
        .orderBy('l.triggered_at', 'desc')
        .limit(100)

      if (req.query.definition) {
        query = query.where({ 'l.alert_definition': Number(req.query.definition) })
      }

      const rows = await query
      return reply.send({ data: rows })
    }
  )

  // ── Manual Evaluation (admin) ──────────────────────────────────────────────

  app.post('/evaluate', { preHandler: requireAdmin }, async (_req, reply) => {
    const triggered = await evaluateAlerts()
    return reply.send({ data: { triggered } })
  })
}
