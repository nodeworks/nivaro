import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'
import {
  type DateRange,
  type EntityFilter,
  isRegisteredBusinessCollection,
  parseJson,
  physicalColumns,
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

    const VALID_TYPES = new Set(['kpi', 'kpi_group', 'bar', 'line', 'donut', 'table', 'divider'])
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
      const data = await resolveWidgetData(
        req.user!,
        { type: widget.type, collection: widget.collection, config: parseJson(widget.config) },
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
      const fieldList = (req.body?.fields ?? []).filter((f) => /^[a-zA-Z0-9_]+$/.test(f))

      const system = `Turn the user's prose into report filters. Respond ONLY with JSON:
{"date_range": {"preset": one of this_month|last_30_days|last_3_months|last_6_months|last_12_months|ytd|custom, "start"?: "YYYY-MM-DD", "end"?: "YYYY-MM-DD"} | null, "entity_filters": [{"field": string, "values": [string]}]}
Entity filter fields MUST be among: ${fieldList.join(', ') || '(none available — return empty entity_filters)'}. Today is ${new Date().toISOString().slice(0, 10)}.`

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
}
