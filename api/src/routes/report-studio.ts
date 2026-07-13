import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  type DateRange,
  parseJson,
  resolveWidgetData,
  type WidgetQueryConfig,
  type WidgetRow
} from '../services/report-studio.js'

/**
 * Report Studio — user-composed widget reports over any collection.
 * Visibility mirrors queues: owner, or shared (optionally role-scoped).
 * Mutations are owner/admin only. Widget data resolves AS THE VIEWER, so
 * collection read permissions apply per widget.
 */

interface ReportRow {
  id: string
  name: string
  icon: string | null
  description: string | null
  owner: string
  is_shared: boolean
  role_id: string | null
  global_filters: string | null
  created_at: Date
  updated_at: Date
}

function canReadReport(report: ReportRow, req: FastifyRequest): boolean {
  if (req.isAdmin) return true
  if (report.owner === req.user!.id) return true
  if (!report.is_shared) return false
  return !report.role_id || report.role_id === (req.user!.role ?? null)
}

function canEditReport(report: ReportRow, req: FastifyRequest): boolean {
  return !!req.isAdmin || report.owner === req.user!.id
}

function formatReport(r: ReportRow, widgets?: WidgetRow[]) {
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    description: r.description,
    owner: r.owner,
    is_shared: !!r.is_shared,
    role_id: r.role_id,
    global_filters: parseJson(r.global_filters),
    created_at: r.created_at,
    updated_at: r.updated_at,
    ...(widgets
      ? {
          widgets: widgets.map((w) => ({
            id: w.id,
            type: w.type,
            title: w.title,
            collection: w.collection,
            config: parseJson<WidgetQueryConfig>(w.config),
            x: w.x,
            y: w.y,
            w: w.w,
            h: w.h,
            sort: w.sort
          }))
        }
      : {})
  }
}

async function loadReport(id: string): Promise<ReportRow | undefined> {
  return (await db('nivaro_report_defs').where({ id }).first()) as ReportRow | undefined
}

export async function reportStudioRoutes(app: FastifyInstance) {
  // ── Report CRUD ─────────────────────────────────────────────────────────────

  app.get('/', { preHandler: requireAuth }, async (req, reply) => {
    const rows = (await db('nivaro_report_defs').orderBy('updated_at', 'desc')) as ReportRow[]
    const visible = rows.filter((r) => canReadReport(r, req))
    const counts = (await db('nivaro_report_widgets')
      .whereIn(
        'report',
        visible.map((r) => r.id)
      )
      .groupBy('report')
      .select('report')
      .count({ n: '*' })) as Array<{ report: string; n: number | string }>
    const countBy = new Map(counts.map((c) => [c.report, Number(c.n)]))
    return reply.send({
      data: visible.map((r) => ({ ...formatReport(r), widget_count: countBy.get(r.id) ?? 0 }))
    })
  })

  app.post<{ Body: { name?: string; icon?: string; description?: string } }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      const name = String(req.body?.name ?? '').trim()
      if (!name) return reply.code(400).send({ error: 'name is required' })
      const id = randomUUID()
      await db('nivaro_report_defs').insert({
        id,
        name: name.slice(0, 255),
        icon: req.body?.icon?.slice(0, 50) ?? null,
        description: req.body?.description?.slice(0, 500) ?? null,
        owner: req.user!.id,
        is_shared: false,
        created_at: new Date(),
        updated_at: new Date()
      })
      await logActivity({
        action: 'report-create',
        collection: 'nivaro_report_defs',
        item: id,
        user: req.user!.id
      })
      const row = await loadReport(id)
      return reply.send({ data: formatReport(row as ReportRow, []) })
    }
  )

  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const widgets = (await db('nivaro_report_widgets')
      .where({ report: report.id })
      .orderBy('sort')) as WidgetRow[]
    return reply.send({ data: { ...formatReport(report, widgets), editable: canEditReport(report, req) } })
  })

  app.patch<{
    Params: { id: string }
    Body: {
      name?: string
      icon?: string | null
      description?: string | null
      is_shared?: boolean
      role_id?: string | null
      global_filters?: unknown
    }
  }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canEditReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const b = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 255)
    if (b.icon !== undefined) patch.icon = b.icon ? String(b.icon).slice(0, 50) : null
    if (b.description !== undefined)
      patch.description = b.description ? String(b.description).slice(0, 500) : null
    if (b.is_shared !== undefined) patch.is_shared = !!b.is_shared
    if (b.role_id !== undefined) patch.role_id = b.role_id || null
    if (b.global_filters !== undefined)
      patch.global_filters = b.global_filters ? JSON.stringify(b.global_filters) : null
    await db('nivaro_report_defs').where({ id: report.id }).update(patch)
    const row = await loadReport(report.id)
    return reply.send({ data: formatReport(row as ReportRow) })
  })

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canEditReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      await db('nivaro_report_defs').where({ id: report.id }).del()
      await logActivity({
        action: 'report-delete',
        collection: 'nivaro_report_defs',
        item: report.id,
        user: req.user!.id,
        comment: report.name
      })
      return reply.send({ data: { deleted: true } })
    }
  )

  // ── Widgets — bulk replace (builder saves the whole set) ────────────────────

  app.put<{
    Params: { id: string }
    Body: {
      widgets?: Array<{
        id?: string
        type?: string
        title?: string
        collection?: string | null
        config?: unknown
        x?: number
        y?: number
        w?: number
        h?: number
      }>
    }
  }>('/:id/widgets', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canEditReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const incoming = Array.isArray(req.body?.widgets) ? req.body.widgets : []
    if (incoming.length > 40) return reply.code(400).send({ error: 'Max 40 widgets per report' })

    const VALID_TYPES = new Set(['kpi', 'bar', 'line', 'donut', 'table', 'divider'])
    const rows = incoming.map((w, i) => ({
      id: w.id && /^[0-9a-f-]{36}$/i.test(w.id) ? w.id : randomUUID(),
      report: report.id,
      type: VALID_TYPES.has(String(w.type)) ? String(w.type) : 'kpi',
      title: String(w.title ?? 'Untitled').slice(0, 255),
      collection: w.collection ? String(w.collection).slice(0, 255) : null,
      config: w.config ? JSON.stringify(w.config) : null,
      x: Math.max(0, Math.min(11, Number(w.x) || 0)),
      y: Math.max(0, Number(w.y) || 0),
      w: Math.max(1, Math.min(12, Number(w.w) || 3)),
      h: Math.max(1, Math.min(12, Number(w.h) || 2)),
      sort: i
    }))

    await db.transaction(async (trx) => {
      await trx('nivaro_report_widgets').where({ report: report.id }).del()
      if (rows.length > 0) await trx('nivaro_report_widgets').insert(rows)
      await trx('nivaro_report_defs').where({ id: report.id }).update({ updated_at: new Date() })
    })
    return reply.send({ data: { saved: rows.length, ids: rows.map((r) => r.id) } })
  })

  // ── Widget data — resolves as the viewer ────────────────────────────────────

  app.post<{
    Params: { id: string; widgetId: string }
    Body: { date_range?: DateRange | null }
  }>('/:id/widgets/:widgetId/data', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const widget = (await db('nivaro_report_widgets')
      .where({ id: req.params.widgetId, report: report.id })
      .first()) as WidgetRow | undefined
    if (!widget) return reply.code(404).send({ error: 'Widget not found' })
    try {
      const data = await resolveWidgetData(
        req.user!,
        { type: widget.type, collection: widget.collection, config: parseJson(widget.config) },
        req.body?.date_range ?? (parseJson<{ date_range?: DateRange }>(report.global_filters)?.date_range ?? null)
      )
      return reply.send({ data })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500
      return reply
        .code(status)
        .send({ error: err instanceof Error ? err.message : 'Widget failed' })
    }
  })

  // Preview an unsaved widget config (builder live preview)
  app.post<{
    Body: {
      type?: string
      collection?: string | null
      config?: WidgetQueryConfig | null
      date_range?: DateRange | null
    }
  }>('/preview', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const data = await resolveWidgetData(
        req.user!,
        {
          type: String(req.body?.type ?? 'kpi'),
          collection: req.body?.collection ?? null,
          config: req.body?.config ?? null
        },
        req.body?.date_range ?? null
      )
      return reply.send({ data })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500
      return reply
        .code(status)
        .send({ error: err instanceof Error ? err.message : 'Preview failed' })
    }
  })

  // ── Clone / export / import ─────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/:id/clone',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const widgets = (await db('nivaro_report_widgets')
        .where({ report: report.id })
        .orderBy('sort')) as WidgetRow[]
      const newId = randomUUID()
      await db('nivaro_report_defs').insert({
        id: newId,
        name: `${report.name} (copy)`.slice(0, 255),
        icon: report.icon,
        description: report.description,
        owner: req.user!.id,
        is_shared: false,
        global_filters: report.global_filters,
        created_at: new Date(),
        updated_at: new Date()
      })
      if (widgets.length > 0) {
        await db('nivaro_report_widgets').insert(
          widgets.map((w) => ({
            id: randomUUID(),
            report: newId,
            type: w.type,
            title: w.title,
            collection: w.collection,
            config: w.config,
            x: w.x,
            y: w.y,
            w: w.w,
            h: w.h,
            sort: w.sort
          }))
        )
      }
      return reply.send({ data: { id: newId } })
    }
  )

  // ── Subscriptions (own) ─────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/:id/subscription',
    { preHandler: requireAuth },
    async (req, reply) => {
      const sub = await db('nivaro_report_subscriptions')
        .where({ report: req.params.id, user: req.user!.id })
        .first()
      return reply.send({ data: sub ?? null })
    }
  )

  app.put<{
    Params: { id: string }
    Body: { cadence?: string; delivery_email?: boolean; delivery_inapp?: boolean } | null
  }>('/:id/subscription', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    if (req.body == null) {
      await db('nivaro_report_subscriptions')
        .where({ report: report.id, user: req.user!.id })
        .del()
      return reply.send({ data: null })
    }
    const cadence = req.body.cadence === 'weekly' ? 'weekly' : 'daily'
    const existing = await db('nivaro_report_subscriptions')
      .where({ report: report.id, user: req.user!.id })
      .first()
    const values = {
      cadence,
      delivery_email: req.body.delivery_email !== false,
      delivery_inapp: req.body.delivery_inapp !== false
    }
    if (existing) {
      await db('nivaro_report_subscriptions').where({ id: existing.id }).update(values)
    } else {
      await db('nivaro_report_subscriptions').insert({
        report: report.id,
        user: req.user!.id,
        ...values,
        created_at: new Date()
      })
    }
    const sub = await db('nivaro_report_subscriptions')
      .where({ report: report.id, user: req.user!.id })
      .first()
    return reply.send({ data: sub })
  })

  // ── Alerts ──────────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/:id/alerts',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const alerts = await db('nivaro_report_alerts')
        .where({ report: report.id })
        .orderBy('created_at', 'desc')
      const firing = (await db('nivaro_report_alert_log')
        .whereIn(
          'alert',
          alerts.map((a) => a.id)
        )
        .where({ status: 'firing' })
        .select('alert')) as Array<{ alert: string }>
      const firingSet = new Set(firing.map((f) => f.alert))
      return reply.send({
        data: alerts.map((a) => ({
          ...a,
          conditions: parseJson(a.conditions),
          firing: firingSet.has(a.id)
        }))
      })
    }
  )

  app.post<{
    Params: { id: string }
    Body: {
      widget?: string
      name?: string
      conditions?: Array<{ field: string; op: string; value: number }>
      delivery_email?: boolean
      delivery_inapp?: boolean
    }
  }>('/:id/alerts', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const b = req.body ?? {}
    const conditions = (Array.isArray(b.conditions) ? b.conditions : [])
      .filter(
        (c) =>
          ['value', 'row_count'].includes(String(c.field)) &&
          ['gt', 'gte', 'lt', 'lte', 'eq'].includes(String(c.op)) &&
          Number.isFinite(Number(c.value))
      )
      .map((c) => ({ field: c.field, op: c.op, value: Number(c.value) }))
    if (!b.widget || conditions.length === 0) {
      return reply.code(400).send({ error: 'widget and at least one valid condition required' })
    }
    const widget = await db('nivaro_report_widgets')
      .where({ id: b.widget, report: report.id })
      .first()
    if (!widget) return reply.code(404).send({ error: 'Widget not found' })
    const id = randomUUID()
    await db('nivaro_report_alerts').insert({
      id,
      report: report.id,
      widget: b.widget,
      name: String(b.name ?? `Alert on ${widget.title}`).slice(0, 255),
      conditions: JSON.stringify(conditions),
      delivery_email: b.delivery_email !== false,
      delivery_inapp: b.delivery_inapp !== false,
      is_active: true,
      created_by: req.user!.id,
      created_at: new Date()
    })
    return reply.send({ data: { id } })
  })

  app.patch<{ Params: { id: string; alertId: string }; Body: { is_active?: boolean } }>(
    '/:id/alerts/:alertId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const alert = await db('nivaro_report_alerts')
        .where({ id: req.params.alertId, report: req.params.id })
        .first()
      if (!alert) return reply.code(404).send({ error: 'Alert not found' })
      if (!req.isAdmin && alert.created_by !== req.user!.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      if (req.body?.is_active !== undefined) {
        await db('nivaro_report_alerts')
          .where({ id: alert.id })
          .update({ is_active: !!req.body.is_active })
      }
      return reply.send({ data: { updated: true } })
    }
  )

  app.delete<{ Params: { id: string; alertId: string } }>(
    '/:id/alerts/:alertId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const alert = await db('nivaro_report_alerts')
        .where({ id: req.params.alertId, report: req.params.id })
        .first()
      if (!alert) return reply.code(404).send({ error: 'Alert not found' })
      if (!req.isAdmin && alert.created_by !== req.user!.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      await db('nivaro_report_alerts').where({ id: alert.id }).del()
      return reply.send({ data: { deleted: true } })
    }
  )
}
