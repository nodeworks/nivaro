import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { runAnomalyChecks, SENSITIVITY_DESCRIPTIONS } from '../services/anomaly-detect.js'
import { logActivity } from '../services/activity.js'
import {
  parseJsonSafe,
  runMetricAlertChecks,
  runMetricAlertDigest
} from '../services/metric-alerts.js'

/**
 * Metric alert engine routes (EFP Alert Manager parity).
 *
 * Visibility model mirrors EFP: definitions/anomaly-definitions are a shared
 * catalog (admin-curated); rules are readable when shared or your own; log
 * entries follow rule visibility; subscriptions are strictly your own.
 */

const RULE_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'change_pct'])
const CHECK_FREQUENCIES = new Set(['hourly', 'daily', 'weekly'])
const DIGEST_FREQUENCIES = new Set(['immediate', 'daily', 'weekly'])
const RULE_STATUSES = new Set(['active', 'paused', 'archived'])
const SENSITIVITIES = new Set(['low', 'medium', 'high'])

function toJsonStr(v: unknown): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

interface ReportRowLite {
  id: string
  name: string
  owner: string | null
  is_shared: boolean
  role_id: string | null
}

function canReadReport(report: ReportRowLite, req: FastifyRequest): boolean {
  if (req.isAdmin) return true
  const uid = String(req.user?.id ?? '').toLowerCase()
  if (report.owner && String(report.owner).toLowerCase() === uid) return true
  if (!report.is_shared) return false
  if (!report.role_id) return true
  return String(report.role_id).toLowerCase() === String(req.user?.role ?? '').toLowerCase()
}

export async function metricAlertsRoutes(app: FastifyInstance) {
  // ─── Definitions (metric catalog) ───────────────────────────────────────────

  app.get('/definitions', { preHandler: requireAuth }, async (req, reply) => {
    const all = (req.query as { all?: string }).all === '1' && req.isAdmin
    const q = db('nivaro_metric_definitions').orderBy([
      { column: 'sort', order: 'asc' },
      { column: 'category', order: 'asc' },
      { column: 'name', order: 'asc' }
    ])
    if (!all) q.where({ status: 'active' })
    const rows = await q
    return reply.send({
      data: rows.map((r) => ({
        ...r,
        metric_source: req.isAdmin ? parseJsonSafe(r.metric_source) : undefined,
        supported_filters: parseJsonSafe(r.supported_filters)
      }))
    })
  })

  app.post('/definitions', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    if (!b.name || !b.metric_key || !b.metric_source) {
      return reply.code(400).send({ error: 'name, metric_key and metric_source are required' })
    }
    const [row] = (await db('nivaro_metric_definitions')
      .insert({
        name: String(b.name),
        description: (b.description as string) ?? null,
        metric_key: String(b.metric_key),
        category: (b.category as string) ?? 'general',
        unit: (b.unit as string) ?? 'count',
        default_operator: (b.default_operator as string) ?? 'gte',
        default_threshold: (b.default_threshold as number) ?? null,
        metric_source: toJsonStr(b.metric_source),
        supported_filters: toJsonStr(b.supported_filters),
        status: (b.status as string) ?? 'active',
        sort: (b.sort as number) ?? null
      })
      .returning('*')) as Array<Record<string, unknown>>
    await logActivity({
      action: 'create',
      user: req.user!.id,
      collection: 'nivaro_metric_definitions',
      item: String(row.id),
      req
    })
    return reply.send({ data: row })
  })

  app.patch('/definitions/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    for (const k of [
      'name',
      'description',
      'metric_key',
      'category',
      'unit',
      'default_operator',
      'default_threshold',
      'status',
      'sort'
    ]) {
      if (k in b) updates[k] = b[k]
    }
    if ('metric_source' in b) updates.metric_source = toJsonStr(b.metric_source)
    if ('supported_filters' in b) updates.supported_filters = toJsonStr(b.supported_filters)
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'No fields to update' })
    await db('nivaro_metric_definitions').where({ id }).update(updates)
    await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_metric_definitions',
      item: id,
      req
    })
    const row = await db('nivaro_metric_definitions').where({ id }).first()
    return reply.send({ data: row })
  })

  app.delete('/definitions/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await db('nivaro_metric_definitions').where({ id }).del()
    await logActivity({
      action: 'delete',
      user: req.user!.id,
      collection: 'nivaro_metric_definitions',
      item: id,
      req
    })
    return reply.send({ ok: true })
  })

  // ─── Rules ──────────────────────────────────────────────────────────────────

  const ruleSelect = () =>
    db('nivaro_metric_alert_rules as r')
      .join('nivaro_metric_definitions as d', 'd.id', 'r.definition_id')
      .select(
        'r.*',
        'd.name as definition_name',
        'd.description as definition_description',
        'd.category as definition_category',
        'd.unit as definition_unit'
      )

  const formatRule = (r: Record<string, unknown>) => ({
    ...r,
    filters: parseJsonSafe(r.filters),
    definition: {
      id: r.definition_id,
      name: r.definition_name,
      description: r.definition_description,
      category: r.definition_category,
      unit: r.definition_unit
    }
  })

  app.get('/rules', { preHandler: requireAuth }, async (req, reply) => {
    const rows = (await ruleSelect()
      .where((qb) => {
        qb.where('r.is_shared', true).orWhere('r.created_by', req.user!.id)
      })
      .orderBy('r.created_at', 'desc')
      .limit(500)) as Array<Record<string, unknown>>
    return reply.send({ data: rows.map(formatRule) })
  })

  app.post('/rules', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const definitionId = Number(b.definition_id)
    if (!b.name || !definitionId || b.threshold_value == null) {
      return reply.code(400).send({ error: 'name, definition_id and threshold_value are required' })
    }
    const operator = String(b.operator ?? 'gte')
    if (!RULE_OPERATORS.has(operator)) return reply.code(400).send({ error: 'Invalid operator' })
    const frequency = String(b.check_frequency ?? 'daily')
    if (!CHECK_FREQUENCIES.has(frequency)) {
      return reply.code(400).send({ error: 'Invalid check_frequency' })
    }
    const def = await db('nivaro_metric_definitions').where({ id: definitionId }).first('id')
    if (!def) return reply.code(404).send({ error: 'Definition not found' })

    const [row] = (await db('nivaro_metric_alert_rules')
      .insert({
        name: String(b.name),
        definition_id: definitionId,
        operator,
        threshold_value: Number(b.threshold_value),
        filters: toJsonStr(b.filters),
        check_frequency: frequency,
        is_shared: !!b.is_shared,
        status: RULE_STATUSES.has(String(b.status)) ? String(b.status) : 'active',
        created_by: req.user!.id,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('*')) as Array<Record<string, unknown>>

    // Auto-subscribe the creator (EFP behavior)
    await db('nivaro_metric_alert_subscriptions')
      .insert({
        rule_id: row.id,
        user: req.user!.id,
        delivery_in_app: true,
        delivery_email: false,
        digest_frequency: 'immediate',
        status: 'active'
      })
      .catch(() => undefined)

    await logActivity({
      action: 'create',
      user: req.user!.id,
      collection: 'nivaro_metric_alert_rules',
      item: String(row.id),
      req
    })
    return reply.send({ data: row })
  })

  app.patch('/rules/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rule = await db('nivaro_metric_alert_rules').where({ id }).first()
    if (!rule) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && String(rule.created_by).toLowerCase() !== String(req.user!.id).toLowerCase()) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const b = (req.body ?? {}) as Record<string, unknown>
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if ('name' in b) updates.name = String(b.name)
    if ('definition_id' in b) updates.definition_id = Number(b.definition_id)
    if ('operator' in b && RULE_OPERATORS.has(String(b.operator))) updates.operator = b.operator
    if ('threshold_value' in b) updates.threshold_value = Number(b.threshold_value)
    if ('filters' in b) updates.filters = toJsonStr(b.filters)
    if ('check_frequency' in b && CHECK_FREQUENCIES.has(String(b.check_frequency))) {
      updates.check_frequency = b.check_frequency
    }
    if ('is_shared' in b) updates.is_shared = !!b.is_shared
    if ('status' in b && RULE_STATUSES.has(String(b.status))) updates.status = b.status
    await db('nivaro_metric_alert_rules').where({ id }).update(updates)
    await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_metric_alert_rules',
      item: id,
      req
    })
    const row = await db('nivaro_metric_alert_rules').where({ id }).first()
    return reply.send({ data: row })
  })

  app.delete('/rules/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rule = await db('nivaro_metric_alert_rules').where({ id }).first()
    if (!rule) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && String(rule.created_by).toLowerCase() !== String(req.user!.id).toLowerCase()) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    await db('nivaro_metric_alert_rules').where({ id }).del()
    await logActivity({
      action: 'delete',
      user: req.user!.id,
      collection: 'nivaro_metric_alert_rules',
      item: id,
      req
    })
    return reply.send({ ok: true })
  })

  // ─── Subscriptions (own) ────────────────────────────────────────────────────

  app.get('/subscriptions', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await db('nivaro_metric_alert_subscriptions as s')
      .join('nivaro_metric_alert_rules as r', 'r.id', 's.rule_id')
      .join('nivaro_metric_definitions as d', 'd.id', 'r.definition_id')
      .where('s.user', req.user!.id)
      .select(
        's.*',
        'r.name as rule_name',
        'r.operator as rule_operator',
        'r.threshold_value as rule_threshold',
        'r.status as rule_status',
        'd.name as definition_name',
        'd.unit as definition_unit'
      )
    return reply.send({ data: rows })
  })

  app.post('/subscriptions', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const ruleId = Number(b.rule_id)
    if (!ruleId) return reply.code(400).send({ error: 'rule_id is required' })
    const rule = await db('nivaro_metric_alert_rules').where({ id: ruleId }).first()
    if (!rule) return reply.code(404).send({ error: 'Rule not found' })
    const isOwn = String(rule.created_by).toLowerCase() === String(req.user!.id).toLowerCase()
    if (!rule.is_shared && !isOwn && !req.isAdmin) {
      return reply.code(403).send({ error: 'Rule is not shared' })
    }
    const existing = await db('nivaro_metric_alert_subscriptions')
      .where({ rule_id: ruleId, user: req.user!.id })
      .first()
    if (existing) return reply.send({ data: existing })
    const digest = DIGEST_FREQUENCIES.has(String(b.digest_frequency))
      ? String(b.digest_frequency)
      : 'immediate'
    const [row] = (await db('nivaro_metric_alert_subscriptions')
      .insert({
        rule_id: ruleId,
        user: req.user!.id,
        delivery_in_app: b.delivery_in_app == null ? true : !!b.delivery_in_app,
        delivery_email: !!b.delivery_email,
        digest_frequency: digest,
        status: 'active'
      })
      .returning('*')) as Array<Record<string, unknown>>
    await logActivity({
      action: 'metric-alert-subscribe',
      collection: 'nivaro_metric_alert_subscriptions',
      item: row?.id != null ? String(row.id) : undefined,
      user: req.user!.id,
      req,
      comment: `rule ${ruleId} (${digest})`
    })
    return reply.send({ data: row })
  })

  app.patch('/subscriptions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const sub = await db('nivaro_metric_alert_subscriptions').where({ id }).first()
    if (!sub) return reply.code(404).send({ error: 'Not found' })
    if (String(sub.user).toLowerCase() !== String(req.user!.id).toLowerCase()) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const b = (req.body ?? {}) as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    if ('delivery_in_app' in b) updates.delivery_in_app = !!b.delivery_in_app
    if ('delivery_email' in b) updates.delivery_email = !!b.delivery_email
    if ('digest_frequency' in b && DIGEST_FREQUENCIES.has(String(b.digest_frequency))) {
      updates.digest_frequency = b.digest_frequency
    }
    if ('status' in b && ['active', 'paused'].includes(String(b.status))) updates.status = b.status
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'No fields to update' })
    await db('nivaro_metric_alert_subscriptions').where({ id }).update(updates)
    await logActivity({
      action: 'metric-alert-subscription-update',
      collection: 'nivaro_metric_alert_subscriptions',
      item: String(id),
      user: req.user!.id,
      req,
      comment: Object.keys(updates).join(', ')
    })
    const row = await db('nivaro_metric_alert_subscriptions').where({ id }).first()
    return reply.send({ data: row })
  })

  app.delete('/subscriptions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const sub = await db('nivaro_metric_alert_subscriptions').where({ id }).first()
    if (!sub) return reply.code(404).send({ error: 'Not found' })
    if (String(sub.user).toLowerCase() !== String(req.user!.id).toLowerCase()) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    await db('nivaro_metric_alert_subscriptions').where({ id }).del()
    await logActivity({
      action: 'metric-alert-unsubscribe',
      collection: 'nivaro_metric_alert_subscriptions',
      item: String(id),
      user: req.user!.id,
      req,
      comment: `rule ${sub.rule_id}`
    })
    return reply.send({ ok: true })
  })

  // ─── Log ────────────────────────────────────────────────────────────────────

  app.get('/log', { preHandler: requireAuth }, async (req, reply) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 100, 500)
    const rows = await db('nivaro_metric_alert_log as l')
      .join('nivaro_metric_alert_rules as r', 'r.id', 'l.rule_id')
      .join('nivaro_metric_definitions as d', 'd.id', 'r.definition_id')
      .where((qb) => {
        qb.where('r.is_shared', true).orWhere('r.created_by', req.user!.id)
      })
      .orderBy('l.fired_at', 'desc')
      .limit(limit)
      .select(
        'l.*',
        'r.name as rule_name',
        'r.operator as rule_operator',
        'd.name as definition_name',
        'd.unit as definition_unit'
      )
    return reply.send({ data: rows })
  })

  app.post('/run', { preHandler: requireAdmin }, async (req, reply) => {
    const freq = String((req.body as { frequency?: string } | null)?.frequency ?? 'all') as
      | 'hourly'
      | 'daily'
      | 'weekly'
      | 'all'
    const result = await runMetricAlertChecks(app, freq)
    await logActivity({
      action: 'metric-alert-run',
      user: req.user?.id,
      req,
      comment: `frequency=${freq}`
    })
    return reply.send({ data: result })
  })

  app.post('/run-digest', { preHandler: requireAdmin }, async (req, reply) => {
    const freq =
      String((req.body as { frequency?: string } | null)?.frequency ?? 'daily') === 'weekly'
        ? ('weekly' as const)
        : ('daily' as const)
    const result = await runMetricAlertDigest(app, freq)
    await logActivity({
      action: 'metric-alert-digest-run',
      user: req.user?.id,
      req,
      comment: `frequency=${freq}`
    })
    return reply.send({ data: result })
  })

  // ─── Anomaly definitions ────────────────────────────────────────────────────

  app.get('/anomaly-definitions', { preHandler: requireAuth }, async (req, reply) => {
    const all = (req.query as { all?: string }).all === '1' && req.isAdmin
    const q = db('nivaro_anomaly_definitions').orderBy('name', 'asc')
    if (!all) q.where({ status: 'active' })
    const rows = await q
    return reply.send({
      data: rows.map((r) => {
        const cfg = parseJsonSafe<Record<string, unknown>>(r.config)
        return {
          ...r,
          config: req.isAdmin ? cfg : undefined,
          // Public scope picker spec: [{key, label, collection?, value_field?, label_field?, sort?}]
          scope_options: (cfg?.scopes_spec as unknown) ?? null,
          sensitivity_hints: SENSITIVITY_DESCRIPTIONS[r.key as string] ?? null
        }
      })
    })
  })

  app.post('/anomaly-definitions', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    if (!b.key || !b.name || !b.config) {
      return reply.code(400).send({ error: 'key, name and config are required' })
    }
    const [row] = (await db('nivaro_anomaly_definitions')
      .insert({
        key: String(b.key),
        name: String(b.name),
        description: (b.description as string) ?? null,
        category: (b.category as string) ?? 'general',
        config: toJsonStr(b.config),
        status: (b.status as string) ?? 'active'
      })
      .returning('*')) as Array<Record<string, unknown>>
    await logActivity({
      action: 'create',
      user: req.user!.id,
      collection: 'nivaro_anomaly_definitions',
      item: String(row.id),
      req
    })
    return reply.send({ data: row })
  })

  app.patch('/anomaly-definitions/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    for (const k of ['key', 'name', 'description', 'category', 'status']) {
      if (k in b) updates[k] = b[k]
    }
    if ('config' in b) updates.config = toJsonStr(b.config)
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'No fields to update' })
    await db('nivaro_anomaly_definitions').where({ id }).update(updates)
    await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_anomaly_definitions',
      item: id,
      req
    })
    const row = await db('nivaro_anomaly_definitions').where({ id }).first()
    return reply.send({ data: row })
  })

  app.delete('/anomaly-definitions/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await db('nivaro_anomaly_definitions').where({ id }).del()
    await logActivity({
      action: 'delete',
      user: req.user!.id,
      collection: 'nivaro_anomaly_definitions',
      item: id,
      req
    })
    return reply.send({ ok: true })
  })

  // ─── Anomaly rules ──────────────────────────────────────────────────────────

  app.get('/anomaly-rules', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = (await db('nivaro_anomaly_rules as r')
      .join('nivaro_anomaly_definitions as d', 'd.id', 'r.definition_id')
      .orderBy('r.created_at', 'desc')
      .limit(200)
      .select(
        'r.*',
        'd.key as definition_key',
        'd.name as definition_name',
        'd.description as definition_description'
      )) as Array<Record<string, unknown>>
    return reply.send({
      data: rows.map((r) => ({
        ...r,
        scopes: parseJsonSafe(r.scopes),
        definition: {
          id: r.definition_id,
          key: r.definition_key,
          name: r.definition_name,
          description: r.definition_description
        }
      }))
    })
  })

  app.post('/anomaly-rules', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const definitionId = Number(b.definition_id)
    if (!b.name || !definitionId) {
      return reply.code(400).send({ error: 'name and definition_id are required' })
    }
    const def = await db('nivaro_anomaly_definitions').where({ id: definitionId }).first('id')
    if (!def) return reply.code(404).send({ error: 'Definition not found' })
    const [row] = (await db('nivaro_anomaly_rules')
      .insert({
        name: String(b.name),
        definition_id: definitionId,
        sensitivity: SENSITIVITIES.has(String(b.sensitivity)) ? String(b.sensitivity) : 'medium',
        scopes: toJsonStr(b.scopes),
        check_frequency: String(b.check_frequency) === 'weekly' ? 'weekly' : 'daily',
        delivery_in_app: b.delivery_in_app == null ? true : !!b.delivery_in_app,
        delivery_email: !!b.delivery_email,
        status: String(b.status) === 'paused' ? 'paused' : 'active',
        created_by: req.user!.id,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('*')) as Array<Record<string, unknown>>
    await logActivity({
      action: 'create',
      user: req.user!.id,
      collection: 'nivaro_anomaly_rules',
      item: String(row.id),
      req
    })
    return reply.send({ data: row })
  })

  app.patch('/anomaly-rules/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rule = await db('nivaro_anomaly_rules').where({ id }).first()
    if (!rule) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && String(rule.created_by).toLowerCase() !== String(req.user!.id).toLowerCase()) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const b = (req.body ?? {}) as Record<string, unknown>
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if ('name' in b) updates.name = String(b.name)
    if ('definition_id' in b) updates.definition_id = Number(b.definition_id)
    if ('sensitivity' in b && SENSITIVITIES.has(String(b.sensitivity))) {
      updates.sensitivity = b.sensitivity
    }
    if ('scopes' in b) updates.scopes = toJsonStr(b.scopes)
    if ('check_frequency' in b) {
      updates.check_frequency = String(b.check_frequency) === 'weekly' ? 'weekly' : 'daily'
    }
    if ('delivery_in_app' in b) updates.delivery_in_app = !!b.delivery_in_app
    if ('delivery_email' in b) updates.delivery_email = !!b.delivery_email
    if ('status' in b && ['active', 'paused'].includes(String(b.status))) updates.status = b.status
    await db('nivaro_anomaly_rules').where({ id }).update(updates)
    await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_anomaly_rules',
      item: id,
      req
    })
    const row = await db('nivaro_anomaly_rules').where({ id }).first()
    return reply.send({ data: row })
  })

  app.delete('/anomaly-rules/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rule = await db('nivaro_anomaly_rules').where({ id }).first()
    if (!rule) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && String(rule.created_by).toLowerCase() !== String(req.user!.id).toLowerCase()) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    await db('nivaro_anomaly_rules').where({ id }).del()
    await logActivity({
      action: 'delete',
      user: req.user!.id,
      collection: 'nivaro_anomaly_rules',
      item: id,
      req
    })
    return reply.send({ ok: true })
  })

  // ─── Anomaly log ────────────────────────────────────────────────────────────

  app.get('/anomaly-log', { preHandler: requireAuth }, async (req, reply) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 200, 500)
    const rows = (await db('nivaro_anomaly_log as l')
      .join('nivaro_anomaly_rules as r', 'r.id', 'l.rule_id')
      .orderBy('l.detected_at', 'desc')
      .limit(limit)
      .select('l.*', 'r.name as rule_name')) as Array<Record<string, unknown>>
    return reply.send({
      data: rows.map((r) => ({ ...r, stats_snapshot: parseJsonSafe(r.stats_snapshot) }))
    })
  })

  app.patch('/anomaly-log/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const status = String((req.body as { status?: string } | null)?.status ?? '')
    if (!['acknowledged', 'resolved'].includes(status)) {
      return reply.code(400).send({ error: 'status must be acknowledged or resolved' })
    }
    const entry = await db('nivaro_anomaly_log').where({ id }).first('id')
    if (!entry) return reply.code(404).send({ error: 'Not found' })
    const updates: Record<string, unknown> = { status }
    if (status === 'resolved') updates.resolved_at = new Date()
    await db('nivaro_anomaly_log').where({ id }).update(updates)
    await logActivity({
      action: `anomaly-${status}`,
      collection: 'nivaro_anomaly_log',
      item: String(id),
      user: req.user!.id,
      req
    })
    const row = await db('nivaro_anomaly_log').where({ id }).first()
    return reply.send({ data: { ...row, stats_snapshot: parseJsonSafe(row?.stats_snapshot) } })
  })

  app.post('/anomaly-run', { preHandler: requireAdmin }, async (req, reply) => {
    const freq = String((req.body as { frequency?: string } | null)?.frequency ?? 'all') as
      | 'daily'
      | 'weekly'
      | 'all'
    const result = await runAnomalyChecks(app, freq)
    await logActivity({
      action: 'anomaly-run',
      user: req.user?.id,
      req,
      comment: `frequency=${freq}`
    })
    return reply.send({ data: result })
  })

  // ─── Report (widget) alerts — aggregate across readable reports ─────────────

  app.get('/report-alerts', { preHandler: requireAuth }, async (req, reply) => {
    const reports = (await db('nivaro_report_defs').select(
      'id',
      'name',
      'owner',
      'is_shared',
      'role_id'
    )) as ReportRowLite[]
    const readable = reports.filter((r) => canReadReport(r, req))
    if (!readable.length) return reply.send({ data: [] })
    const nameById = new Map(readable.map((r) => [String(r.id), r.name]))

    const alerts = (await db('nivaro_report_alerts')
      .whereIn(
        'report',
        readable.map((r) => r.id)
      )
      .orderBy('created_at', 'desc')) as Array<Record<string, unknown>>
    if (!alerts.length) return reply.send({ data: [] })

    const ids = alerts.map((a) => a.id as string)
    const firing = (await db('nivaro_report_alert_log')
      .whereIn('alert', ids)
      .where('status', 'firing')
      .select('alert')) as Array<{ alert: string }>
    const firingSet = new Set(firing.map((f) => String(f.alert)))
    const lastFired = (await db('nivaro_report_alert_log')
      .whereIn('alert', ids)
      .groupBy('alert')
      .select('alert')
      .max({ fired_at: 'fired_at' })) as Array<{ alert: string; fired_at: Date | null }>
    const lastMap = new Map(lastFired.map((f) => [String(f.alert), f.fired_at]))

    return reply.send({
      data: alerts.map((a) => ({
        ...a,
        conditions: parseJsonSafe(a.conditions),
        filters: parseJsonSafe(a.filters),
        report_name: nameById.get(String(a.report)) ?? null,
        firing: firingSet.has(String(a.id)),
        last_fired: lastMap.get(String(a.id)) ?? null
      }))
    })
  })

  app.get('/report-alerts-log', { preHandler: requireAuth }, async (req, reply) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 200, 500)
    const reports = (await db('nivaro_report_defs').select(
      'id',
      'name',
      'owner',
      'is_shared',
      'role_id'
    )) as ReportRowLite[]
    const readable = reports.filter((r) => canReadReport(r, req))
    if (!readable.length) return reply.send({ data: [] })
    const nameById = new Map(readable.map((r) => [String(r.id), r.name]))

    const rows = (await db('nivaro_report_alert_log as l')
      .join('nivaro_report_alerts as a', 'a.id', 'l.alert')
      .whereIn(
        'a.report',
        readable.map((r) => r.id)
      )
      .orderBy('l.fired_at', 'desc')
      .limit(limit)
      .select('l.*', 'a.name as alert_name', 'a.report as report_id')) as Array<
      Record<string, unknown>
    >
    return reply.send({
      data: rows.map((r) => ({
        ...r,
        metric_snapshot: parseJsonSafe(r.metric_snapshot),
        report_name: nameById.get(String(r.report_id)) ?? null
      }))
    })
  })
}
