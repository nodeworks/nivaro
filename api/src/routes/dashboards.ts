import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface DashboardRow {
  id: string
  name: string
  user: string | null
  is_shared: boolean | number
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
}

interface UpdateDashboardBody {
  name?: string
  is_shared?: boolean
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

    const rows = (await db('nivaro_dashboards')
      .where('user', userId)
      .orWhere('is_shared', true)
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
    const { name, is_shared = false } = req.body
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const id = randomUUID()
    const now = new Date()

    await db('nivaro_dashboards').insert({
      id,
      name: name.trim(),
      user: req.user!.id,
      is_shared,
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
    if (!req.isAdmin && row.user !== userId && !row.is_shared) {
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

      const VALID_TYPES = ['count', 'sum', 'avg', 'latest', 'bar_chart', 'line_chart']
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
        const VALID_TYPES = ['count', 'sum', 'avg', 'latest', 'bar_chart', 'line_chart']
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
  app.get<{ Params: { widgetId: string } }>('/widgets/:widgetId/data', async (req, reply) => {
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

    if (!widget.collection) {
      return { data: null }
    }

    // Safety: always validate collection against registry
    const validCollection = await resolveCollection(widget.collection)
    if (!validCollection) {
      return reply.code(400).send({ error: 'Unknown collection' })
    }

    const col = widget.collection

    try {
      if (widget.type === 'count') {
        const result = await db(col).count('* as count').first()
        return { data: { value: Number(result?.count ?? 0) } }
      }

      if (widget.type === 'sum') {
        if (!widget.field) return { data: { value: null } }
        const result = await db(col).sum(`${widget.field} as total`).first()
        return { data: { value: result?.total !== null ? Number(result?.total) : null } }
      }

      if (widget.type === 'avg') {
        if (!widget.field) return { data: { value: null } }
        const result = await db(col).avg(`${widget.field} as average`).first()
        return { data: { value: result?.average !== null ? Number(result?.average) : null } }
      }

      if (widget.type === 'latest') {
        const rows = await db(col).orderBy('created_at', 'desc').limit(10)
        return { data: { rows } }
      }

      if (widget.type === 'bar_chart' || widget.type === 'line_chart') {
        // Group by day for last 30 days (MSSQL syntax)
        const rows = await db(col)
          .select(db.raw('CAST(created_at AS DATE) as date'))
          .count('* as count')
          .whereRaw('created_at >= DATEADD(day, -30, GETDATE())')
          .groupByRaw('CAST(created_at AS DATE)')
          .orderBy('date', 'asc')

        const chartData = rows.map((r) => ({
          date: String(r.date),
          count: Number(r.count)
        }))
        return { data: { rows: chartData } }
      }

      return reply.code(400).send({ error: 'Unsupported widget type' })
    } catch (err) {
      app.log.error(err, 'dashboard widget data error')
      return reply.code(500).send({ error: 'Failed to compute widget data' })
    }
  })
}
