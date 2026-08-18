import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity, logActivityThrottled } from '../services/activity.js'
import { restoreReportVersion, snapshotReportVersion } from '../services/report-versions.js'
import { deriveAlertMetric } from '../services/report-studio-jobs.js'
import { can } from '../services/permissions.js'
import {
  type DateRange,
  type EntityFilter,
  isRegisteredBusinessCollection,
  parseJson,
  physicalColumns,
  resolveWidgetData,
  resolveWidgetDataFull,
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
    folder: (r as { folder?: string | null }).folder ?? null,
    snapshot_schedule: (r as { snapshot_schedule?: string | null }).snapshot_schedule ?? null,
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

function sanitizeAlertFilters(
  raw: unknown
): string | null {
  if (!Array.isArray(raw)) return null
  const out = raw
    .filter(
      (f) =>
        f &&
        typeof (f as { field?: unknown }).field === 'string' &&
        Array.isArray((f as { values?: unknown }).values)
    )
    .slice(0, 10)
    .map((f) => {
      const e = f as { field: string; values: Array<string | number>; labels?: string[] }
      return {
        field: e.field.slice(0, 80),
        values: e.values.slice(0, 50).map((v) => (typeof v === 'number' ? v : String(v).slice(0, 200))),
        labels: Array.isArray(e.labels)
          ? e.labels.slice(0, 50).map((l) => String(l).slice(0, 200))
          : undefined
      }
    })
    .filter((f) => f.values.length > 0)
  return out.length > 0 ? JSON.stringify(out) : null
}

export async function reportStudioRoutes(app: FastifyInstance) {
  // ─── Prebuilt widget catalog ────────────────────────────────────────────────
  // Named, categorized widget configs users drop into a report instead of
  // building a metric by hand. Data-driven — admins manage rows, deployments
  // (EFP) seed their own library.
  app.get('/widget-presets', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = await db('nivaro_report_widget_presets')
      .where('is_active', true)
      .orderBy(['category', 'sort', 'name'])
    return reply.send({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        description: r.description,
        widget_type: r.widget_type,
        config: (() => {
          try {
            return r.config ? JSON.parse(r.config) : null
          } catch {
            return null
          }
        })(),
        w: r.w,
        h: r.h
      }))
    })
  })

  app.post('/widget-presets', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const b = (req.body ?? {}) as Record<string, unknown>
    if (!b.name || !b.widget_type) return reply.code(400).send({ error: 'name and widget_type required' })
    const now = new Date()
    await db('nivaro_report_widget_presets').insert({
      name: String(b.name).slice(0, 255),
      category: String(b.category ?? 'general').slice(0, 50),
      description: b.description ? String(b.description).slice(0, 1000) : null,
      widget_type: String(b.widget_type).slice(0, 50),
      config: b.config ? JSON.stringify(b.config) : null,
      w: Number(b.w) || 6,
      h: Number(b.h) || 4,
      sort: Number(b.sort) || 0,
      is_active: b.is_active !== false,
      created_at: now,
      updated_at: now
    })
    void logActivity({
      action: 'report-widget-preset-create',
      user: req.user?.id ?? null,
      comment: `preset "${String(b.name).slice(0, 80)}" (${String(b.widget_type)})`
    })
    return reply.send({ data: { ok: true } })
  })

  app.patch('/widget-presets/:presetId', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const id = Number((req.params as { presetId: string }).presetId)
    const b = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = { updated_at: new Date() }
    for (const k of ['name', 'category', 'description', 'widget_type'] as const) {
      if (k in b) patch[k] = b[k] == null ? null : String(b[k])
    }
    if ('config' in b) patch.config = b.config ? JSON.stringify(b.config) : null
    for (const k of ['w', 'h', 'sort'] as const) if (k in b) patch[k] = Number(b[k]) || 0
    if ('is_active' in b) patch.is_active = b.is_active !== false
    await db('nivaro_report_widget_presets').where('id', id).update(patch)
    void logActivity({
      action: 'report-widget-preset-update',
      user: req.user?.id ?? null,
      comment: `preset ${id}: ${Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')}`
    })
    return reply.send({ data: { ok: true } })
  })

  app.delete('/widget-presets/:presetId', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const id = Number((req.params as { presetId: string }).presetId)
    await db('nivaro_report_widget_presets').where('id', id).del()
    void logActivity({
      action: 'report-widget-preset-delete',
      user: req.user?.id ?? null,
      comment: `preset ${id}`
    })
    return reply.send({ data: { ok: true } })
  })

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
    // Usage tracking: one row per viewer per report per hour — feeds
    // GET /report-studio/usage ("nobody has opened this in 90 days").
    void logActivityThrottled(app.redis, `report-view:${report.id}:${req.user!.id}`, 3600, {
      action: 'report-view',
      collection: 'nivaro_report_defs',
      item: report.id,
      user: req.user!.id
    })
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
    await snapshotReportVersion(report.id, 'before settings change', req.user!.id)
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
    const bx = b as { folder?: string | null; snapshot_schedule?: string | null }
    if (bx.folder !== undefined) patch.folder = bx.folder ? String(bx.folder).slice(0, 100) : null
    if (bx.snapshot_schedule !== undefined)
      patch.snapshot_schedule = ['weekly', 'monthly'].includes(String(bx.snapshot_schedule))
        ? bx.snapshot_schedule
        : null
    await db('nivaro_report_defs').where({ id: report.id }).update(patch)
    await logActivity({
      action: 'report-update',
      collection: 'nivaro_report_defs',
      item: report.id,
      user: req.user!.id,
      req,
      comment: Object.keys(patch)
        .filter((k) => k !== 'updated_at')
        .join(', ')
    })
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
    await snapshotReportVersion(report.id, 'before widgets save', req.user!.id)
    const incoming = Array.isArray(req.body?.widgets) ? req.body.widgets : []
    if (incoming.length > 40) return reply.code(400).send({ error: 'Max 40 widgets per report' })

    const VALID_TYPES = new Set(['kpi', 'kpi_group', 'bar', 'line', 'donut', 'table', 'divider', 'query', 'calc', 'movers'])
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
    await logActivity({
      action: 'report-widgets-save',
      collection: 'nivaro_report_defs',
      item: report.id,
      user: req.user!.id,
      req,
      comment: `${rows.length} widget(s)`
    })
    return reply.send({ data: { saved: rows.length, ids: rows.map((r) => r.id) } })
  })

  // ── Widget data — resolves as the viewer ────────────────────────────────────

  app.post<{
    Params: { id: string; widgetId: string }
    Body: { date_range?: DateRange | null; entity_filters?: EntityFilter[] }
  }>('/:id/widgets/:widgetId/data', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const widget = (await db('nivaro_report_widgets')
      .where({ id: req.params.widgetId, report: report.id })
      .first()) as WidgetRow | undefined
    if (!widget) return reply.code(404).send({ error: 'Widget not found' })
    try {
      const data = await resolveWidgetDataFull(
        req.user!,
        report.id,
        { id: widget.id, type: widget.type, collection: widget.collection, config: parseJson(widget.config) },
        req.body?.date_range ??
          (parseJson<{ date_range?: DateRange }>(report.global_filters)?.date_range ?? null),
        Array.isArray(req.body?.entity_filters) ? req.body.entity_filters : []
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
      entity_filters?: EntityFilter[]
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
        req.body?.date_range ?? null,
        Array.isArray(req.body?.entity_filters) ? req.body.entity_filters : []
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
      await logActivity({
        action: 'report-clone',
        collection: 'nivaro_report_defs',
        item: newId,
        user: req.user!.id,
        req,
        comment: `cloned from ${report.name} (${report.id})`
      })
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
    Body: {
      cadence?: string
      delivery_email?: boolean
      delivery_inapp?: boolean
      deliver_room?: string | null
    } | null
  }>('/:id/subscription', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    if (req.body == null) {
      await db('nivaro_report_subscriptions')
        .where({ report: report.id, user: req.user!.id })
        .del()
      await logActivity({
        action: 'report-unsubscribe',
        collection: 'nivaro_report_defs',
        item: report.id,
        user: req.user!.id,
        req
      })
      return reply.send({ data: null })
    }
    const cadence = req.body.cadence === 'weekly' ? 'weekly' : 'daily'
    const existing = await db('nivaro_report_subscriptions')
      .where({ report: report.id, user: req.user!.id })
      .first()
    const bodyRoom = (req.body as { deliver_room?: string | null }).deliver_room
    const bodyPdf = (req.body as { attach_pdf?: boolean }).attach_pdf
    const values = {
      cadence,
      delivery_email: req.body.delivery_email !== false,
      delivery_inapp: req.body.delivery_inapp !== false,
      ...(bodyRoom !== undefined
        ? { deliver_room: bodyRoom ? String(bodyRoom).slice(0, 200) : null }
        : {}),
      ...(bodyPdf !== undefined ? { attach_pdf: !!bodyPdf } : {})
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
    await logActivity({
      action: 'report-subscribe',
      collection: 'nivaro_report_defs',
      item: report.id,
      user: req.user!.id,
      req,
      comment: `${cadence}${values.delivery_email ? ' email' : ''}${values.delivery_inapp ? ' in-app' : ''}`
    })
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
      const lastFired = (await db('nivaro_report_alert_log')
        .whereIn(
          'alert',
          alerts.map((a) => a.id)
        )
        .groupBy('alert')
        .select('alert')
        .max({ fired_at: 'fired_at' })) as Array<{ alert: string; fired_at: Date | null }>
      const lastMap = new Map(lastFired.map((f) => [f.alert, f.fired_at]))
      return reply.send({
        data: alerts.map((a) => ({
          ...a,
          conditions: parseJson(a.conditions),
          filters: parseJson((a as { filters?: string | null }).filters ?? null),
          firing: firingSet.has(a.id),
          last_fired: lastMap.get(a.id) ?? null
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
      filters?: Array<{ field: string; values: Array<string | number>; labels?: string[] }>
    }
  }>('/:id/alerts', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const b = req.body ?? {}
    const conditions = (Array.isArray(b.conditions) ? b.conditions : [])
      .filter(
        (c) =>
          typeof c.field === 'string' &&
          c.field.length > 0 &&
          c.field.length <= 120 &&
          ['gt', 'gte', 'lt', 'lte', 'eq'].includes(String(c.op)) &&
          Number.isFinite(Number(c.value))
      )
      .map((c) => ({ field: String(c.field), op: c.op, value: Number(c.value) }))
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
      filters: sanitizeAlertFilters(b.filters),
      delivery_email: b.delivery_email !== false,
      delivery_inapp: b.delivery_inapp !== false,
      is_active: true,
      created_by: req.user!.id,
      created_at: new Date()
    })
    await logActivity({
      action: 'report-alert-create',
      collection: 'nivaro_report_alerts',
      item: id,
      user: req.user!.id,
      req,
      comment: `${widget.title}: ${conditions.map((c) => `${c.field} ${c.op} ${c.value}`).join(', ')}`
    })
    return reply.send({ data: { id } })
  })

  app.patch<{
    Params: { id: string; alertId: string }
    Body: {
      is_active?: boolean
      name?: string
      conditions?: Array<{ field: string; op: string; value: number }>
      delivery_email?: boolean
      delivery_inapp?: boolean
      filters?: Array<{ field: string; values: Array<string | number>; labels?: string[] }> | null
    }
  }>('/:id/alerts/:alertId', { preHandler: requireAuth }, async (req, reply) => {
    const alert = await db('nivaro_report_alerts')
      .where({ id: req.params.alertId, report: req.params.id })
      .first()
    if (!alert) return reply.code(404).send({ error: 'Alert not found' })
    if (!req.isAdmin && alert.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const b = req.body ?? {}
    const patch: Record<string, unknown> = {}
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 255)
    if (b.delivery_email !== undefined) patch.delivery_email = !!b.delivery_email
    if (b.delivery_inapp !== undefined) patch.delivery_inapp = !!b.delivery_inapp
    if (b.filters !== undefined) patch.filters = sanitizeAlertFilters(b.filters)
    if (b.conditions !== undefined) {
      const conditions = (Array.isArray(b.conditions) ? b.conditions : [])
        .filter(
          (c) =>
            ['value', 'row_count'].includes(String(c.field)) &&
            ['gt', 'gte', 'lt', 'lte', 'eq'].includes(String(c.op)) &&
            Number.isFinite(Number(c.value))
        )
        .map((c) => ({ field: c.field, op: c.op, value: Number(c.value) }))
      if (conditions.length === 0)
        return reply.code(400).send({ error: 'At least one valid condition required' })
      patch.conditions = JSON.stringify(conditions)
    }
    if (Object.keys(patch).length === 0)
      return reply.code(400).send({ error: 'No fields to update' })
    await db('nivaro_report_alerts').where({ id: alert.id }).update(patch)
    await logActivity({
      action: 'report-alert-update',
      collection: 'nivaro_report_alerts',
      item: alert.id,
      user: req.user!.id,
      req,
      comment: Object.keys(patch).join(', ')
    })
    return reply.send({ data: { updated: true } })
  })

  // Alert history — the firing/resolved log rows for one alert (or the whole
  // report when alertId is omitted via /alerts-log).
  app.get<{ Params: { id: string; alertId: string } }>(
    '/:id/alerts/:alertId/log',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      // Scope check — the alert must belong to THIS report, or any readable
      // report id could be used to read another report's alert history.
      const owned = await db('nivaro_report_alerts')
        .where({ id: req.params.alertId, report: report.id })
        .first()
      if (!owned) return reply.code(404).send({ error: 'Alert not found' })
      const rows = await db('nivaro_report_alert_log')
        .where({ alert: req.params.alertId })
        .orderBy('fired_at', 'desc')
        .limit(50)
      return reply.send({
        data: rows.map((r) => ({ ...r, metric_snapshot: parseJson(r.metric_snapshot) }))
      })
    }
  )
  // Reset every cached custom-query result this report's query widgets use
  // (staging 'Reset Cache' parity). Safe: caches repopulate on next view.
  app.post<{ Params: { id: string } }>(
    '/:id/reset-cache',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const widgets = (await db('nivaro_report_widgets')
        .where({ report: report.id })
        .select('config', 'type')) as Array<{ config: string | null; type: string }>
      const slugs = new Set<string>()
      for (const w of widgets) {
        if (w.type !== 'query') continue
        const slug = parseJson<{ query?: { slug?: string } }>(w.config)?.query?.slug
        if (slug) slugs.add(slug)
      }
      const { bustCustomQueryCache } = await import('./custom-queries.js')
      let cleared = 0
      for (const slug of slugs) {
        cleared += await bustCustomQueryCache(app.redis, slug).catch(() => 0)
      }
      await logActivity({
        action: 'report-reset-cache',
        collection: 'nivaro_report_defs',
        item: report.id,
        user: req.user!.id,
        req,
        comment: `${slugs.size} quer(y|ies), ${cleared} cache key(s) cleared`
      })
      return reply.send({ data: { queries: slugs.size, cleared } })
    }
  )

  // ── Per-user filter presets ─────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/:id/filter-presets',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const rows = await db('nivaro_report_filter_presets')
        .where({ report: report.id, user: req.user!.id })
        .orderBy('name')
      return reply.send({
        data: rows.map((r) => ({
          id: r.id,
          name: r.name,
          date_range: parseJson(r.date_range),
          entity_filters: parseJson(r.entity_filters) ?? []
        }))
      })
    }
  )

  // Upsert by name (same-name save overwrites the caller's own preset)
  app.post<{
    Params: { id: string }
    Body: { name?: string; date_range?: unknown; entity_filters?: unknown }
  }>('/:id/filter-presets', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const name = String(req.body?.name ?? '').trim().slice(0, 120)
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const row = {
      date_range: req.body?.date_range ? JSON.stringify(req.body.date_range) : null,
      entity_filters: sanitizeAlertFilters(req.body?.entity_filters) ?? '[]'
    }
    const existing = await db('nivaro_report_filter_presets')
      .where({ report: report.id, user: req.user!.id, name })
      .first()
    if (existing) {
      await db('nivaro_report_filter_presets').where({ id: existing.id }).update(row)
      await logActivity({
        action: 'report-filter-preset-update',
        collection: 'nivaro_report_filter_presets',
        item: String(existing.id),
        user: req.user!.id,
        req,
        comment: name
      })
      return reply.send({ data: { id: existing.id, updated: true } })
    }
    await db('nivaro_report_filter_presets').insert({
      ...row,
      report: report.id,
      user: req.user!.id,
      name,
      created_at: new Date()
    })
    const created = await db('nivaro_report_filter_presets')
      .where({ report: report.id, user: req.user!.id, name })
      .first()
    await logActivity({
      action: 'report-filter-preset-create',
      collection: 'nivaro_report_filter_presets',
      item: created?.id != null ? String(created.id) : undefined,
      user: req.user!.id,
      req,
      comment: name
    })
    return reply.send({ data: { id: created?.id, updated: false } })
  })

  app.delete<{ Params: { id: string; presetId: string } }>(
    '/:id/filter-presets/:presetId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const preset = await db('nivaro_report_filter_presets')
        .where({ id: Number(req.params.presetId), report: req.params.id })
        .first()
      if (!preset) return reply.code(404).send({ error: 'Preset not found' })
      if (!req.isAdmin && preset.user !== req.user!.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      await db('nivaro_report_filter_presets').where({ id: preset.id }).del()
      await logActivity({
        action: 'report-filter-preset-delete',
        collection: 'nivaro_report_filter_presets',
        item: String(preset.id),
        user: req.user!.id,
        req,
        comment: preset.name
      })
      return reply.send({ data: { deleted: true } })
    }
  )

  // Mark an open firing log entry resolved (owner or admin)
  app.post<{ Params: { id: string; alertId: string } }>(
    '/:id/alerts/:alertId/resolve',
    { preHandler: requireAuth },
    async (req, reply) => {
      const alert = await db('nivaro_report_alerts')
        .where({ id: req.params.alertId, report: req.params.id })
        .first()
      if (!alert) return reply.code(404).send({ error: 'Alert not found' })
      if (!req.isAdmin && alert.created_by !== req.user!.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const n = await db('nivaro_report_alert_log')
        .where({ alert: alert.id, status: 'firing' })
        .update({ status: 'resolved', resolved_at: new Date() })
      await logActivity({
        action: 'report-alert-resolve',
        collection: 'nivaro_report_alerts',
        item: alert.id,
        user: req.user!.id,
        req,
        comment: `${n} firing entr(y|ies) resolved`
      })
      return reply.send({ data: { resolved: n } })
    }
  )

  app.get<{ Params: { id: string } }>(
    '/:id/alerts-log',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const alertIds = (
        await db('nivaro_report_alerts').where({ report: report.id }).select('id')
      ).map((a) => a.id as string)
      if (alertIds.length === 0) return reply.send({ data: [] })
      const rows = await db('nivaro_report_alert_log')
        .whereIn('alert', alertIds)
        .orderBy('fired_at', 'desc')
        .limit(100)
      return reply.send({
        data: rows.map((r) => ({ ...r, metric_snapshot: parseJson(r.metric_snapshot) }))
      })
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
      await logActivity({
        action: 'report-alert-delete',
        collection: 'nivaro_report_alerts',
        item: alert.id,
        user: req.user!.id,
        req,
        comment: alert.name
      })
      return reply.send({ data: { deleted: true } })
    }
  )

  // ── Filter bar support — distinct values for a field across the report ─────

  app.get<{ Params: { id: string }; Querystring: { field?: string } }>(
    '/:id/filter-options',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const field = String(req.query.field ?? '')
      if (!/^[a-zA-Z0-9_]+$/.test(field)) return reply.code(400).send({ error: 'Invalid field' })
      // Never enumerate credential-like columns, even on business tables
      if (/token|secret|password|hash|totp|key/i.test(field)) {
        return reply.code(400).send({ error: 'Field not filterable' })
      }
      // Only fields the report owner actually pinned to the filter bar
      const filterBar =
        parseJson<{ filter_bar?: Array<{ field: string }> }>(report.global_filters)?.filter_bar ??
        []
      if (!filterBar.some((f) => f.field === field)) {
        return reply.code(400).send({ error: 'Field is not on this report’s filter bar' })
      }

      const widgets = (await db('nivaro_report_widgets')
        .where({ report: report.id })
        .whereNotNull('collection')) as WidgetRow[]
      const collections = [...new Set(widgets.map((w) => w.collection as string))]
      const seen = new Map<string, string>()
      for (const col of collections) {
        try {
          // registered business collections the VIEWER can read — nothing else
          if (!(await isRegisteredBusinessCollection(col))) continue
          if (!(await can(req.user!, 'read', col))) continue
          const valid = await physicalColumns(col)
          if (!valid.has(field)) continue
          const rows = (await db(col)
            .distinct(field)
            .whereNotNull(field)
            .limit(100)) as Array<Record<string, unknown>>
          // FK? resolve labels
          const rel = (await db('nivaro_relations')
            .where({ many_collection: col, many_field: field })
            .whereNull('junction_field')
            .first()) as { one_collection: string | null } | undefined
          if (rel?.one_collection && !rel.one_collection.startsWith('nivaro_')) {
            const ids = rows.map((r) => r[field]).filter((v) => v != null)
            const related = (await db(rel.one_collection).whereIn(
              'id',
              ids as Array<string | number>
            )) as Array<Record<string, unknown>>
            for (const r of related) {
              seen.set(
                String(r.id),
                String(r.title ?? r.name ?? r.label ?? r.subject ?? r.id).slice(0, 60)
              )
            }
          } else {
            for (const r of rows) {
              const v = r[field]
              if (v != null) seen.set(String(v), String(v).slice(0, 60))
            }
          }
        } catch {
          /* skip mismatched collections */
        }
        if (seen.size >= 100) break
      }
      return reply.send({
        data: [...seen.entries()]
          .map(([value, label]) => ({ value, label }))
          .sort((a, b) => a.label.localeCompare(b.label))
      })
    }
  )

  // ── AI: compose a report from a prompt / set filters from prose ────────────

  app.post<{ Params: { id: string }; Body: { prompt?: string } }>(
    '/:id/ai-build',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canEditReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const prompt = String(req.body?.prompt ?? '').trim()
      if (!prompt) return reply.code(400).send({ error: 'prompt is required' })

      const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
      const client = await getAiClient()
      if (!client) return reply.code(503).send({ error: 'AI is not configured' })
      const { model } = await getAiModelSettings()

      // Catalog: registered collections + their numeric/date fields
      const collections = (await db('nivaro_collections')
        .whereNot('collection', 'like', 'nivaro\_%')
        .select('collection', 'display_name')
        .limit(80)) as Array<{ collection: string; display_name: string | null }>
      const fields = (await db('nivaro_fields')
        .whereIn(
          'collection',
          collections.map((c) => c.collection)
        )
        .whereIn('type', ['integer', 'bigInteger', 'decimal', 'float', 'number', 'date', 'datetime', 'string'])
        .select('collection', 'field', 'type')) as Array<{
        collection: string
        field: string
        type: string
      }>
      const catalog = collections
        .map((c) => {
          const fs = fields.filter((f) => f.collection === c.collection).slice(0, 25)
          return `${c.collection}: ${fs.map((f) => `${f.field}(${f.type})`).join(', ')}`
        })
        .join('\n')

      const system = `You compose report widgets for a reporting tool. Available widget types: kpi (one aggregate), kpi_group (metrics array of up to 4 tiles), bar, line (needs dimension; use bucket day|week|month for date fields), donut, table (columns array), divider (section heading). Aggregates: count, sum, avg, min, max (non-count needs a numeric field). Grid is 12 columns; kpi w=3 h=2, kpi_group w=12 h=2, charts w=6 h=3, tables w=12 h=3, divider w=12 h=1.
Collections and fields available:
${catalog}
Config schema (follow EXACTLY):
- kpi:       {"metric":{"aggregate":"count|sum|avg|min|max","field":"<numeric>"},"date_field":"<date col or omit>","format":{"prefix":"$"}}
- kpi_group: {"metrics":[{"label":"...","collection":"<collection>","aggregate":"count","field":"<numeric for non-count>"}]}
- bar/line/donut: {"metric":{"aggregate":"count"},"dimension":{"field":"<column>","bucket":"month"},"date_field":"<same date col for bucketed>"} — bucket ONLY for date columns (day|week|month); omit bucket to group by a value column
- table:     {"columns":["a","b"],"sort":"-created_at","limit":10}
Respond ONLY with JSON: {"widgets":[{"type":"...","title":"...","collection":"...","config":{...},"x":0,"y":0,"w":6,"h":3}]}. Use ONLY listed collections/fields. 4-8 widgets. Lay them out top-to-bottom without overlaps.`

      try {
        const msg = await client.messages.create({
          model,
          max_tokens: 2500,
          system,
          messages: [{ role: 'user', content: prompt }]
        })
        const text = msg.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .filter(Boolean)
          .join('')
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        if (!jsonMatch) return reply.code(422).send({ error: 'AI returned no usable layout' })
        const parsed = JSON.parse(jsonMatch[0]) as { widgets?: unknown[] }
        if (!Array.isArray(parsed.widgets) || parsed.widgets.length === 0) {
          return reply.code(422).send({ error: 'AI returned no widgets' })
        }
        await logActivity({
          action: 'report-ai-build',
          collection: 'nivaro_report_defs',
          item: report.id,
          user: req.user!.id,
          comment: prompt.slice(0, 200)
        })
        return reply.send({ data: { widgets: parsed.widgets.slice(0, 12) } })
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message.slice(0, 200) : 'AI call failed' })
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { prompt?: string; fields?: string[] } }>(
    '/:id/ai-filters',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const prompt = String(req.body?.prompt ?? '').trim()
      if (!prompt) return reply.code(400).send({ error: 'prompt is required' })

      const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
      const client = await getAiClient()
      if (!client) return reply.code(503).send({ error: 'AI is not configured' })
      const { model } = await getAiModelSettings()
      // fields may be plain names or {field, label} pairs — labels give the
      // model the human meaning ('division' is labeled 'Zone').
      const rawFields = Array.isArray(req.body?.fields) ? req.body.fields : []
      const fieldDefs = rawFields
        .map((f: unknown) =>
          typeof f === 'string'
            ? { field: f, label: f }
            : { field: String((f as { field?: unknown })?.field ?? ''), label: String((f as { label?: unknown })?.label ?? '') }
        )
        .filter((f: { field: string }) => /^[a-zA-Z0-9_]+$/.test(f.field))
      const fieldList = fieldDefs.map(
        (f: { field: string; label: string }) =>
          `${f.field}${f.label && f.label !== f.field ? ` (shown to users as "${f.label}")` : ''}`
      )

      const system = `Turn the user's prose into report filters. Respond ONLY with JSON:
{"date_range": {"preset": one of this_month|last_30_days|last_3_months|last_6_months|last_12_months|ytd|custom, "start"?: "YYYY-MM-DD", "end"?: "YYYY-MM-DD"} | null, "entity_filters": [{"field": string, "values": [string]}]}
Entity filter fields MUST be among: ${fieldList.join(', ') || '(none available — return empty entity_filters)'}. Match the user's words against the user-facing labels (e.g. "Zone 1" belongs to the field labeled "Zone"). Only set date_range when the prose mentions a TIME period — a funding year is a filter field, not a date range. Today is ${new Date().toISOString().slice(0, 10)}.`

      try {
        const msg = await client.messages.create({
          model,
          max_tokens: 500,
          system,
          messages: [{ role: 'user', content: prompt }]
        })
        const text = msg.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .filter(Boolean)
          .join('')
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        if (!jsonMatch) return reply.code(422).send({ error: 'Could not parse the request' })
        return reply.send({ data: JSON.parse(jsonMatch[0]) })
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message.slice(0, 200) : 'AI call failed' })
      }
    }
  )

  // ── Config versions (restore after a bad edit / AI build) ──────────────────

  app.get<{ Params: { id: string } }>(
    '/:id/versions',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const rows = await db('nivaro_report_versions as v')
        .leftJoin('nivaro_users as u', 'v.created_by', 'u.id')
        .where({ 'v.report': report.id })
        .orderBy('v.version', 'desc')
        .limit(30)
        .select('v.id', 'v.version', 'v.note', 'v.created_at', 'u.first_name', 'u.last_name')
      return reply.send({
        data: rows.map((r) => ({
          id: r.id,
          version: r.version,
          note: r.note,
          created_at: r.created_at,
          created_by_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null
        }))
      })
    }
  )

  app.post<{ Params: { id: string; versionId: string } }>(
    '/:id/versions/:versionId/restore',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canEditReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const result = await restoreReportVersion(report.id, Number(req.params.versionId), req.user!.id)
      if ('error' in result) return reply.code(400).send({ error: result.error })
      await logActivity({
        action: 'report-version-restore',
        collection: 'nivaro_report_defs',
        item: report.id,
        user: req.user!.id,
        req,
        comment: `version ${req.params.versionId}`
      })
      return reply.send({ data: result })
    }
  )

  // ── Point-in-time snapshots ("vs Aug 1") ───────────────────────────────────
  // Stores one derived metric per widget (deriveAlertMetric — total by
  // construction), resolved AS THE CALLER with the report's own date range.

  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    '/:id/snapshots',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const widgets = (await db('nivaro_report_widgets')
        .where({ report: report.id })
        .orderBy('sort')) as WidgetRow[]
      const dateRange =
        parseJson<{ date_range?: DateRange }>(report.global_filters)?.date_range ?? null
      const data: Record<string, { value: number | null }> = {}
      for (const w of widgets) {
        if (w.type === 'divider') continue
        try {
          const resolved = await resolveWidgetDataFull(
            req.user!,
            report.id,
            { id: w.id, type: w.type, collection: w.collection, config: parseJson(w.config) },
            dateRange
          )
          data[w.id] = { value: deriveAlertMetric('value', resolved) }
        } catch {
          data[w.id] = { value: null }
        }
      }
      const name =
        String(req.body?.name ?? '').trim().slice(0, 120) ||
        new Date().toISOString().slice(0, 10)
      const [inserted] = await db('nivaro_report_snapshots')
        .insert({
          report: report.id,
          name,
          data: JSON.stringify(data),
          taken_at: new Date(),
          created_by: req.user!.id
        })
        .returning('id')
      await logActivity({
        action: 'report-snapshot',
        collection: 'nivaro_report_defs',
        item: report.id,
        user: req.user!.id,
        req,
        comment: name
      })
      const id =
        typeof inserted === 'object' && inserted !== null
          ? (inserted as { id: number }).id
          : (inserted as number)
      return reply.code(201).send({ data: { id, name } })
    }
  )

  app.get<{ Params: { id: string } }>(
    '/:id/snapshots',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const rows = await db('nivaro_report_snapshots')
        .where({ report: report.id })
        .orderBy('id', 'desc')
        .limit(30)
        .select('id', 'name', 'taken_at')
      return reply.send({ data: rows })
    }
  )

  app.get<{ Params: { id: string; snapId: string } }>(
    '/:id/snapshots/:snapId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const row = await db('nivaro_report_snapshots')
        .where({ report: report.id, id: Number(req.params.snapId) })
        .first()
      if (!row) return reply.code(404).send({ error: 'Snapshot not found' })
      return reply.send({
        data: {
          id: row.id,
          name: row.name,
          taken_at: row.taken_at,
          data: parseJson(row.data) ?? {}
        }
      })
    }
  )

  app.delete<{ Params: { id: string; snapId: string } }>(
    '/:id/snapshots/:snapId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canEditReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      await db('nivaro_report_snapshots')
        .where({ report: report.id, id: Number(req.params.snapId) })
        .del()
      return reply.send({ data: { deleted: true } })
    }
  )

  // ── Usage — which reports are actually read (admin cleanup view) ───────────

  app.get('/usage', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const since30 = new Date(Date.now() - 30 * 86_400_000)
    const rows = (await db('nivaro_activity')
      .where({ action: 'report-view', collection: 'nivaro_report_defs' })
      .groupBy('item')
      .select('item')
      .max({ last_viewed: 'timestamp' })) as Array<{ item: string; last_viewed: Date }>
    const recent = (await db('nivaro_activity')
      .where({ action: 'report-view', collection: 'nivaro_report_defs' })
      .where('timestamp', '>', since30)
      .groupBy('item')
      .select('item')
      .count({ views_30d: '*' })
      .countDistinct({ viewers_30d: 'user' })) as Array<{
      item: string
      views_30d: number | string
      viewers_30d: number | string
    }>
    const recentMap = new Map(recent.map((r) => [String(r.item), r]))
    const usage: Record<string, { last_viewed: string; views_30d: number; viewers_30d: number }> =
      {}
    for (const r of rows) {
      const rec = recentMap.get(String(r.item))
      usage[String(r.item)] = {
        last_viewed: new Date(r.last_viewed).toISOString(),
        views_30d: Number(rec?.views_30d ?? 0),
        viewers_30d: Number(rec?.viewers_30d ?? 0)
      }
    }
    return reply.send({ data: usage })
  })

  // ── Widget annotations ("price increase landed here") ──────────────────────

  app.get<{ Params: { id: string } }>(
    '/:id/annotations',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
      const rows = await db('nivaro_report_annotations as a')
        .leftJoin('nivaro_users as u', 'a.created_by', 'u.id')
        .where({ 'a.report': report.id })
        .orderBy('a.id', 'desc')
        .limit(200)
        .select('a.id', 'a.widget', 'a.note', 'a.anchor_date', 'a.created_at', 'a.created_by', 'u.first_name', 'u.last_name')
      return reply.send({
        data: rows.map((r) => ({
          id: r.id,
          widget: r.widget,
          note: r.note,
          anchor_date: r.anchor_date,
          created_at: r.created_at,
          created_by: r.created_by,
          created_by_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null
        }))
      })
    }
  )

  app.post<{
    Params: { id: string }
    Body: { widget?: string; note?: string; anchor_date?: string | null }
  }>('/:id/annotations', { preHandler: requireAuth }, async (req, reply) => {
    const report = await loadReport(req.params.id)
    if (!report) return reply.code(404).send({ error: 'Report not found' })
    if (!canReadReport(report, req)) return reply.code(403).send({ error: 'Forbidden' })
    const widget = String(req.body?.widget ?? '')
    const note = String(req.body?.note ?? '').trim().slice(0, 500)
    if (!/^[0-9a-f-]{36}$/i.test(widget) || !note) {
      return reply.code(400).send({ error: 'widget and note are required' })
    }
    const anchor = String(req.body?.anchor_date ?? '').trim()
    const [inserted] = await db('nivaro_report_annotations')
      .insert({
        report: report.id,
        widget,
        note,
        anchor_date: /^\d{4}-\d{2}(-\d{2})?$/.test(anchor) ? anchor : null,
        created_by: req.user!.id,
        created_at: new Date()
      })
      .returning('id')
    const id =
      typeof inserted === 'object' && inserted !== null
        ? (inserted as { id: number }).id
        : (inserted as number)
    return reply.code(201).send({ data: { id } })
  })

  app.delete<{ Params: { id: string; annId: string } }>(
    '/:id/annotations/:annId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const report = await loadReport(req.params.id)
      if (!report) return reply.code(404).send({ error: 'Report not found' })
      const row = await db('nivaro_report_annotations')
        .where({ report: report.id, id: Number(req.params.annId) })
        .first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      // Own note, or anyone who can edit the report.
      if (row.created_by !== req.user!.id && !canEditReport(report, req)) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      await db('nivaro_report_annotations').where({ id: row.id }).del()
      return reply.send({ data: { deleted: true } })
    }
  )
}
