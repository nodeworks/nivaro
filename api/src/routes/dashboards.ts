import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  computeWidgetData,
  normalizeWidgetFilters,
  registeredFieldSet
} from '../services/dashboard-widgets.js'
import { readItems } from '../services/items.js'
import { getLabels } from '../services/queues.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface DashboardRow {
  id: string
  name: string
  user: string | null
  is_shared: boolean | number
  role_id?: string | null
  global_filters?: string | null
  created_at: Date
  updated_at: Date
}

interface WidgetRow {
  id: string
  dashboard: string
  type: string
  title: string
  collection: string | null
  field: string | null
  filters: string | null
  col: number
  row: number
  width: number
  height: number
  created_at: Date
}

interface CreateWidgetBody {
  type: string
  title: string
  collection?: string | null
  field?: string | null
  filters?: unknown
  col?: number
  row?: number
  width?: number
  height?: number
}

interface CreateDashboardBody {
  name: string
  is_shared?: boolean
  role_id?: string | null
}

interface UpdateDashboardBody {
  role_id?: string | null
  name?: string
  is_shared?: boolean
  /** #635 — saved global filter bar (WidgetFilter[] shape, validated client-side + per-widget at resolve). */
  global_filters?: Array<{ field: string; value: unknown; op?: string }> | null
}

interface UpdateWidgetBody {
  type?: string
  title?: string
  collection?: string | null
  field?: string | null
  filters?: unknown
  col?: number
  row?: number
  width?: number
  height?: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toJsonStr(val: unknown): string | null {
  if (val === null || val === undefined) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

function parseJson(val: string | null | undefined): unknown {
  if (!val) return null
  try {
    return JSON.parse(val)
  } catch {
    return null
  }
}

function formatWidget(w: WidgetRow) {
  return {
    ...w,
    filters: parseJson(w.filters),
    is_shared: undefined
  }
}

function formatDashboard(d: DashboardRow, widgets: WidgetRow[] = []) {
  return {
    ...d,
    is_shared: Boolean(d.is_shared),
    role_id: d.role_id ?? null,
    global_filters: (() => {
      try {
        const parsed = d.global_filters ? JSON.parse(d.global_filters) : null
        return Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    })(),
    widgets: widgets.map(formatWidget)
  }
}

/** Verify a collection name is registered in nivaro_collections (prevents SQL injection). */
async function resolveCollection(name: string): Promise<boolean> {
  const row = await db('nivaro_collections').where('collection', name).first()
  return !!row
}

/** Verify a field is registered in nivaro_fields for a collection (prevents SQL injection via column name). */
async function resolveField(collection: string, field: string): Promise<boolean> {
  const row = await db('nivaro_fields').where({ collection, field }).first()
  return !!row
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function dashboardsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ── GET / — list own + shared dashboards ──────────────────────────────────
  app.get('/', async (req) => {
    const userId = req.user!.id

    const userRole = req.user!.role ?? null
    const rows = (await db('nivaro_dashboards')
      .where('user', userId)
      .orWhere((shared) => {
        shared.where('is_shared', true).andWhere((roleQb) => {
          roleQb.whereNull('role_id')
          if (userRole) roleQb.orWhere('role_id', userRole)
        })
      })
      .orderBy('created_at', 'asc')) as DashboardRow[]

    const ids = rows.map((r) => r.id)

    const widgets: WidgetRow[] = ids.length
      ? ((await db('nivaro_dashboard_widgets').whereIn('dashboard', ids)) as WidgetRow[])
      : []

    const widgetsByDashboard = new Map<string, WidgetRow[]>()
    for (const w of widgets) {
      const list = widgetsByDashboard.get(w.dashboard) ?? []
      list.push(w)
      widgetsByDashboard.set(w.dashboard, list)
    }

    return {
      data: rows.map((d) => formatDashboard(d, widgetsByDashboard.get(d.id) ?? []))
    }
  })

  // ── POST / — create dashboard ─────────────────────────────────────────────
  app.post<{ Body: CreateDashboardBody }>('/', async (req, reply) => {
    const { name, is_shared = false, role_id = null } = req.body
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const id = randomUUID()
    const now = new Date()

    await db('nivaro_dashboards').insert({
      id,
      name: name.trim(),
      user: req.user!.id,
      is_shared: role_id ? true : is_shared,
      role_id: role_id || null,
      created_at: now,
      updated_at: now
    })

    const row = (await db('nivaro_dashboards').where('id', id).first()) as DashboardRow
    await logActivity({
      action: 'create',
      collection: 'nivaro_dashboards',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: formatDashboard(row) })
  })

  // ── GET /:id — get one dashboard ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const userId = req.user!.id
    const row = (await db('nivaro_dashboards').where('id', req.params.id).first()) as
      | DashboardRow
      | undefined

    if (!row) return reply.code(404).send({ error: 'Not found' })
    const roleOk = !row.role_id || row.role_id === (req.user!.role ?? '')
    if (!req.isAdmin && row.user !== userId && !(row.is_shared && roleOk)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const widgets = (await db('nivaro_dashboard_widgets')
      .where('dashboard', row.id)
      .orderBy('row', 'asc')
      .orderBy('col', 'asc')) as WidgetRow[]

    return { data: formatDashboard(row, widgets) }
  })

  // ── PATCH /:id ────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: UpdateDashboardBody }>('/:id', async (req, reply) => {
    const userId = req.user!.id
    const row = (await db('nivaro_dashboards').where('id', req.params.id).first()) as
      | DashboardRow
      | undefined

    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && row.user !== userId) return reply.code(403).send({ error: 'Forbidden' })

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (req.body.name !== undefined) updates.name = req.body.name.trim()
    if (req.body.is_shared !== undefined) updates.is_shared = req.body.is_shared
    if (req.body.role_id !== undefined) {
      // Role scoping forces shared (a role-scoped private dashboard is a contradiction).
      updates.role_id = req.body.role_id || null
      if (req.body.role_id) updates.is_shared = true
    }
    if (req.body.global_filters !== undefined) {
      updates.global_filters =
        Array.isArray(req.body.global_filters) && req.body.global_filters.length
          ? JSON.stringify(req.body.global_filters.slice(0, 20))
          : null
    }

    await db('nivaro_dashboards').where('id', row.id).update(updates)
    const updated = (await db('nivaro_dashboards').where('id', row.id).first()) as DashboardRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_dashboards',
      item: row.id,
      user: req.user?.id,
      req
    })
    return { data: formatDashboard(updated) }
  })

  // ── DELETE /:id ───────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const userId = req.user!.id
    const row = (await db('nivaro_dashboards').where('id', req.params.id).first()) as
      | DashboardRow
      | undefined

    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && row.user !== userId) return reply.code(403).send({ error: 'Forbidden' })

    // Cascade-delete widgets in app code (FK is NO ACTION)
    await db('nivaro_dashboard_widgets').where('dashboard', row.id).delete()
    await db('nivaro_dashboards').where('id', row.id).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_dashboards',
      item: row.id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // ── POST /:id/widgets — add widget ────────────────────────────────────────
  // AI dashboard builder (#251): "build me a dashboard" — reports-AI-build
  // parity for the simpler dashboard widget model. Creates the dashboard AND
  // its widgets; a failed AI call deletes the shell.
  app.post<{ Body: { prompt?: string; name?: string } }>('/ai-build', async (req, reply) => {
    const prompt = String(req.body?.prompt ?? '').trim()
    if (!prompt) return reply.code(400).send({ error: 'prompt is required' })
    const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
    const aiClient = await getAiClient()
    if (!aiClient) return reply.code(503).send({ error: 'AI is not configured' })
    const { model } = await getAiModelSettings()

    const collections = (await db('nivaro_collections')
      .whereNot('collection', 'like', 'nivaro_%')
      .select('collection')
      .limit(80)) as Array<{ collection: string }>
    const fields = (await db('nivaro_fields')
      .whereIn(
        'collection',
        collections.map((c) => c.collection)
      )
      .whereIn('type', ['integer', 'decimal', 'float', 'number', 'string', 'date', 'datetime'])
      .select('collection', 'field', 'type')) as Array<{
      collection: string
      field: string
      type: string
    }>
    const catalog = collections
      .map((c) => {
        const fs = fields.filter((f) => f.collection === c.collection).slice(0, 20)
        return `${c.collection}: ${fs.map((f) => `${f.field}(${f.type})`).join(', ')}`
      })
      .join('\n')
    const system = `You compose dashboard widgets. Types: count (record count), sum (sum of field), avg (avg of field), latest (newest records list), bar_chart (grouped by field), line_chart (over a date field). Grid: 4 columns; KPIs (count/sum/avg) width=1 height=1, charts width=2 height=2, latest width=2 height=2.
Collections and fields:
${catalog}
Respond ONLY with JSON: {"name":"...","widgets":[{"type":"count","title":"...","collection":"...","field":"<field or null>","col":0,"row":0,"width":1,"height":1}]}. Use ONLY listed collections/fields. 4-8 widgets, no overlaps.`

    let parsed: { name?: string; widgets?: Array<Record<string, unknown>> } | null = null
    try {
      const msg = await aiClient.messages.create({
        model,
        max_tokens: 1800,
        system,
        messages: [{ role: 'user', content: prompt }]
      })
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      const jm = text.match(/\{[\s\S]*\}/)
      parsed = jm ? JSON.parse(jm[0]) : null
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message.slice(0, 200) : 'AI call failed' })
    }
    if (!parsed?.widgets?.length) return reply.code(422).send({ error: 'AI returned no widgets' })

    const dashId = randomUUID()
    await db('nivaro_dashboards').insert({
      id: dashId,
      name: String(req.body?.name ?? parsed.name ?? 'AI dashboard').slice(0, 200),
      user: req.user!.id,
      is_shared: false,
      created_at: new Date()
    })
    const VALID = new Set(['count', 'sum', 'avg', 'latest', 'bar_chart', 'line_chart'])
    const known = new Set(collections.map((c) => c.collection))
    let created = 0
    for (const w of parsed.widgets.slice(0, 10)) {
      const type = String(w.type ?? '')
      const collection = String(w.collection ?? '')
      if (!VALID.has(type) || !known.has(collection)) continue
      await db('nivaro_dashboard_widgets').insert({
        id: randomUUID(),
        dashboard: dashId,
        type,
        title: String(w.title ?? type).slice(0, 200),
        collection,
        field: w.field ? String(w.field).slice(0, 200) : null,
        filters: null,
        col: Math.max(0, Math.min(3, Number(w.col) || 0)),
        row: Math.max(0, Number(w.row) || 0),
        width: Math.max(1, Math.min(4, Number(w.width) || 1)),
        height: Math.max(1, Math.min(4, Number(w.height) || 1)),
        created_at: new Date()
      })
      created++
    }
    if (created === 0) {
      await db('nivaro_dashboards').where({ id: dashId }).del()
      return reply.code(422).send({ error: 'AI produced no valid widgets' })
    }
    await logActivity({
      action: 'dashboard-ai-build',
      collection: 'nivaro_dashboards',
      item: dashId,
      user: req.user!.id,
      req,
      comment: prompt.slice(0, 200)
    })
    return reply.send({ data: { id: dashId, widgets_created: created } })
  })

  app.post<{ Params: { id: string }; Body: CreateWidgetBody }>(
    '/:id/widgets',
    async (req, reply) => {
      const userId = req.user!.id
      const dashboard = (await db('nivaro_dashboards').where('id', req.params.id).first()) as
        | DashboardRow
        | undefined

      if (!dashboard) return reply.code(404).send({ error: 'Dashboard not found' })
      if (!req.isAdmin && dashboard.user !== userId) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const {
        type,
        title,
        collection,
        field,
        filters,
        col = 0,
        row = 0,
        width = 1,
        height = 1
      } = req.body

      if (!type || !title?.trim()) {
        return reply.code(400).send({ error: 'type and title are required' })
      }

      // 'report_preset' = a Report Studio catalog widget rendered client-side
      // (field holds the preset id; the /data endpoint is never used for it)
      const VALID_TYPES = [
        'count',
        'sum',
        'avg',
        'latest',
        'bar_chart',
        'line_chart',
        'report_preset'
      ]
      if (!VALID_TYPES.includes(type)) {
        return reply.code(400).send({ error: `type must be one of: ${VALID_TYPES.join(', ')}` })
      }

      // Validate collection exists if provided
      if (collection) {
        const valid = await resolveCollection(collection)
        if (!valid) return reply.code(400).send({ error: 'Unknown collection' })
      }

      // Validate field is registered (prevents SQL injection via column name in sum/avg queries)
      if (field && collection) {
        const validField = await resolveField(collection, field)
        if (!validField) return reply.code(400).send({ error: 'Unknown field' })
      }

      const id = randomUUID()
      await db('nivaro_dashboard_widgets').insert({
        id,
        dashboard: dashboard.id,
        type,
        title: title.trim(),
        collection: collection ?? null,
        field: field ?? null,
        filters: toJsonStr(filters),
        col,
        row,
        width,
        height,
        created_at: new Date()
      })

      const widget = (await db('nivaro_dashboard_widgets').where('id', id).first()) as WidgetRow
      await logActivity({
        action: 'create',
        collection: 'nivaro_dashboard_widgets',
        item: id,
        user: req.user?.id,
        req,
        comment: `dashboard:${dashboard.id}`
      })
      return reply.code(201).send({ data: formatWidget(widget) })
    }
  )

  // ── PATCH /widgets/:widgetId ──────────────────────────────────────────────
  app.patch<{ Params: { widgetId: string }; Body: UpdateWidgetBody }>(
    '/widgets/:widgetId',
    async (req, reply) => {
      const userId = req.user!.id
      const widget = (await db('nivaro_dashboard_widgets')
        .where('id', req.params.widgetId)
        .first()) as WidgetRow | undefined

      if (!widget) return reply.code(404).send({ error: 'Widget not found' })

      const dashboard = (await db('nivaro_dashboards').where('id', widget.dashboard).first()) as
        | DashboardRow
        | undefined

      if (!dashboard) return reply.code(404).send({ error: 'Dashboard not found' })
      if (!req.isAdmin && dashboard.user !== userId) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = {}
      const { type, title, collection, field, filters, col, row, width, height } = req.body

      if (type !== undefined) {
        const VALID_TYPES = [
          'count',
          'sum',
          'avg',
          'latest',
          'bar_chart',
          'line_chart',
          'report_preset'
        ]
        if (!VALID_TYPES.includes(type))
          return reply.code(400).send({ error: 'Invalid widget type' })
        updates.type = type
      }
      if (title !== undefined) updates.title = title.trim()
      if (collection !== undefined) {
        if (collection) {
          const valid = await resolveCollection(collection)
          if (!valid) return reply.code(400).send({ error: 'Unknown collection' })
        }
        updates.collection = collection ?? null
      }
      if (field !== undefined) {
        const collForField = (updates.collection as string | null | undefined) ?? widget.collection
        if (field && collForField) {
          const validField = await resolveField(collForField, field)
          if (!validField) return reply.code(400).send({ error: 'Unknown field' })
        }
        updates.field = field ?? null
      }
      if (filters !== undefined) updates.filters = toJsonStr(filters)
      if (col !== undefined) updates.col = col
      if (row !== undefined) updates.row = row
      if (width !== undefined) updates.width = width
      if (height !== undefined) updates.height = height

      await db('nivaro_dashboard_widgets').where('id', widget.id).update(updates)
      const updated = (await db('nivaro_dashboard_widgets')
        .where('id', widget.id)
        .first()) as WidgetRow
      await logActivity({
        action: 'update',
        collection: 'nivaro_dashboard_widgets',
        item: widget.id,
        user: req.user?.id,
        req
      })
      return { data: formatWidget(updated) }
    }
  )

  // ── DELETE /widgets/:widgetId ─────────────────────────────────────────────
  app.delete<{ Params: { widgetId: string } }>('/widgets/:widgetId', async (req, reply) => {
    const userId = req.user!.id
    const widget = (await db('nivaro_dashboard_widgets')
      .where('id', req.params.widgetId)
      .first()) as WidgetRow | undefined

    if (!widget) return reply.code(404).send({ error: 'Widget not found' })

    const dashboard = (await db('nivaro_dashboards').where('id', widget.dashboard).first()) as
      | DashboardRow
      | undefined
    if (!dashboard) return reply.code(404).send({ error: 'Dashboard not found' })
    if (!req.isAdmin && dashboard.user !== userId) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_dashboard_widgets').where('id', widget.id).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_dashboard_widgets',
      item: widget.id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // ── GET /widgets/:widgetId/data ───────────────────────────────────────────
  // ?extra_filters=<JSON> — dashboard-level global filters (#635), merged into
  // the widget's own filters; a filter only binds widgets whose collection has
  // the field (report-studio entity-filter semantics, enforced in the service).
  app.get<{ Params: { widgetId: string }; Querystring: { extra_filters?: string } }>(
    '/widgets/:widgetId/data',
    async (req, reply) => {
      const userId = req.user!.id
      const widget = (await db('nivaro_dashboard_widgets')
        .where('id', req.params.widgetId)
        .first()) as WidgetRow | undefined

      if (!widget) return reply.code(404).send({ error: 'Widget not found' })

      const dashboard = (await db('nivaro_dashboards').where('id', widget.dashboard).first()) as
        | DashboardRow
        | undefined
      if (!dashboard) return reply.code(404).send({ error: 'Dashboard not found' })
      if (!req.isAdmin && dashboard.user !== userId && !dashboard.is_shared) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const extraFilters = normalizeWidgetFilters(req.query.extra_filters)
      const result = await computeWidgetData(widget, extraFilters)
      if ('error' in result) return reply.code(result.status).send({ error: result.error })
      return { data: result.data }
    }
  )

  // ── POST /widgets/:widgetId/drill — records behind a widget number (#636) ──
  // Reads via readItems AS THE VIEWER, so RBAC/RLS/User Scopes bind exactly
  // like any other list read — the aggregate a viewer saw may count rows the
  // drill won't show them, and that asymmetry is deliberate.
  app.post<{
    Params: { widgetId: string }
    Body: { segment?: { field?: string; value?: unknown } | null; extra_filters?: unknown }
  }>('/widgets/:widgetId/drill', async (req, reply) => {
    const userId = req.user!.id
    const widget = (await db('nivaro_dashboard_widgets')
      .where('id', req.params.widgetId)
      .first()) as WidgetRow | undefined

    if (!widget) return reply.code(404).send({ error: 'Widget not found' })

    const dashboard = (await db('nivaro_dashboards').where('id', widget.dashboard).first()) as
      | DashboardRow
      | undefined
    if (!dashboard) return reply.code(404).send({ error: 'Dashboard not found' })
    if (!req.isAdmin && dashboard.user !== userId && !dashboard.is_shared) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (!widget.collection) return reply.code(400).send({ error: 'Widget has no collection' })

    const fieldSet = await registeredFieldSet(widget.collection)
    const conds = [
      ...normalizeWidgetFilters(widget.filters),
      ...normalizeWidgetFilters(req.body?.extra_filters)
    ].filter((f) => fieldSet.has(f.field))

    const OP_MAP: Record<string, string> = {
      eq: '_eq',
      neq: '_neq',
      gt: '_gt',
      gte: '_gte',
      lt: '_lt',
      lte: '_lte',
      contains: '_contains',
      in: '_in'
    }
    const and: Array<Record<string, unknown>> = conds.map((f) => ({
      [f.field]: { [OP_MAP[f.op ?? 'eq'] ?? '_eq']: f.value }
    }))

    const seg = req.body?.segment
    if (seg && typeof seg.field === 'string' && seg.value !== undefined && seg.value !== null) {
      if (seg.field === 'date') {
        // Built-in charts bucket by CAST(created_at AS DATE) — a clicked bar's
        // "date" segment means that calendar day, not a physical column.
        const day = String(seg.value).slice(0, 10)
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          const next = new Date(`${day}T00:00:00Z`)
          next.setUTCDate(next.getUTCDate() + 1)
          and.push({ created_at: { _gte: day } })
          and.push({ created_at: { _lt: next.toISOString().slice(0, 10) } })
        }
      } else if (fieldSet.has(seg.field)) {
        and.push({ [seg.field]: { _eq: seg.value } })
      } else {
        return reply.code(400).send({ error: 'Unknown segment field' })
      }
    }

    try {
      const res = await readItems(req.user!, widget.collection, {
        fields: ['id'],
        filter: and.length ? { _and: and } : undefined,
        limit: 100
      })
      const ids = (res.data ?? []).map((r: Record<string, unknown>) => String(r.id))
      const labels = ids.length
        ? await getLabels(new Map([[widget.collection, new Set(ids)]]))
        : ({} as Record<string, string>)
      return {
        data: {
          collection: widget.collection,
          total: res.total ?? ids.length,
          capped: ids.length >= 100,
          records: ids.map((id) => ({
            id,
            label: labels[`${widget.collection}:${id}`] ?? `#${id}`
          }))
        }
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500
      return reply
        .code(status)
        .send({ error: status === 403 ? 'Forbidden' : 'Failed to resolve records' })
    }
  })
}
