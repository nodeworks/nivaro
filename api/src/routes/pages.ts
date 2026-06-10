import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'
import type { User } from '../types.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type PageWidgetType = 'table' | 'kpi' | 'markdown' | 'iframe' | 'recent-activity'

export interface PageWidget {
  id: string
  type: PageWidgetType
  x: number
  y: number
  w: number
  h: number
  config: Record<string, unknown>
}

export interface PageLayout {
  columns: number
  widgets: PageWidget[]
}

interface PageRow {
  id: number
  name: string
  slug: string
  icon: string | null
  layout: string
  is_shared: boolean
  role: string | null
  sort: number
  created_by: string
  created_at: Date
  updated_at: Date
}

type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'null' | 'nnull'

interface FilterRule {
  field: string
  op: FilterOp
  value?: unknown
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

const EMPTY_LAYOUT: PageLayout = { columns: 12, widgets: [] }

function serialize(row: PageRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    layout: parseJson<PageLayout>(row.layout) ?? EMPTY_LAYOUT,
    is_shared: !!row.is_shared,
    role: row.role,
    sort: row.sort,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

/** Access rule: admins see everything; otherwise own pages + shared pages (optionally role-restricted). */
function canAccessPage(user: User, isAdmin: boolean, page: PageRow): boolean {
  if (isAdmin) return true
  if (page.created_by === user.id) return true
  if (!page.is_shared) return false
  // Shared — optional role restriction
  if (page.role) return page.role === user.role
  return true
}

/** Load a page by slug, or by numeric id when the param is all digits. */
async function loadPage(slugOrId: string): Promise<PageRow | undefined> {
  if (/^\d+$/.test(slugOrId)) {
    const byId = (await db('nivaro_pages')
      .where({ id: Number(slugOrId) })
      .first()) as PageRow | undefined
    if (byId) return byId
  }
  return (await db('nivaro_pages').where({ slug: slugOrId }).first()) as PageRow | undefined
}

function isSystemCollection(collection: unknown): boolean {
  return typeof collection !== 'string' || collection.length === 0 || /^nivaro_/i.test(collection)
}

/**
 * Apply widget filters to a knex query. Supports:
 *   - object form: { field: value } (equality)
 *   - array form:  [{ field, op, value }]
 * Identifiers are passed through knex's identifier escaping.
 */
function applyWidgetFilters(q: ReturnType<typeof db>, filters: unknown): ReturnType<typeof db> {
  if (!filters) return q

  if (Array.isArray(filters)) {
    for (const f of filters as FilterRule[]) {
      if (!f || typeof f.field !== 'string' || !f.field) continue
      switch (f.op) {
        case 'eq':
          q.where(f.field, '=', f.value as never)
          break
        case 'neq':
          q.where(f.field, '!=', f.value as never)
          break
        case 'gt':
          q.where(f.field, '>', f.value as never)
          break
        case 'gte':
          q.where(f.field, '>=', f.value as never)
          break
        case 'lt':
          q.where(f.field, '<', f.value as never)
          break
        case 'lte':
          q.where(f.field, '<=', f.value as never)
          break
        case 'contains':
          q.where(f.field, 'like', `%${f.value}%`)
          break
        case 'null':
          q.whereNull(f.field)
          break
        case 'nnull':
          q.whereNotNull(f.field)
          break
      }
    }
    return q
  }

  if (typeof filters === 'object') {
    for (const [field, value] of Object.entries(filters as Record<string, unknown>)) {
      if (value === null) q.whereNull(field)
      else q.where(field, '=', value as never)
    }
  }
  return q
}

const VALID_WIDGET_TYPES = new Set<string>([
  'table',
  'kpi',
  'markdown',
  'iframe',
  'recent-activity'
])

/** Minimal layout shape validation — returns an error string or null. */
function validateLayout(layout: unknown): string | null {
  if (layout == null || typeof layout !== 'object') return 'layout must be an object'
  const l = layout as Partial<PageLayout>
  if (typeof l.columns !== 'number' || l.columns < 1 || l.columns > 24) {
    return 'layout.columns must be a number between 1 and 24'
  }
  if (!Array.isArray(l.widgets)) return 'layout.widgets must be an array'
  for (const w of l.widgets) {
    if (!w || typeof w !== 'object') return 'each widget must be an object'
    if (typeof w.id !== 'string' || !w.id) return 'each widget needs a string id'
    if (!VALID_WIDGET_TYPES.has(String(w.type))) return `invalid widget type "${w.type}"`
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      if (typeof w[k] !== 'number' || w[k] < 0) return `widget.${k} must be a non-negative number`
    }
    if (w.config != null && typeof w.config !== 'object') return 'widget.config must be an object'
  }
  return null
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function pagesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List — own + shared + role-matched (admins: all), ordered by sort.
  app.get('/', async (req) => {
    const rows = (await db('nivaro_pages').orderBy('sort', 'asc').select('*')) as PageRow[]
    const user = req.user as User
    const visible = rows.filter((p) => canAccessPage(user, !!req.isAdmin, p))
    return { data: visible.map(serialize) }
  })

  // Single — by slug (or numeric id), same access rule.
  app.get<{ Params: { slug: string } }>('/:slug', async (req, reply) => {
    const row = await loadPage(req.params.slug)
    if (!row) return reply.code(404).send({ error: 'Page not found' })
    if (!canAccessPage(req.user as User, !!req.isAdmin, row)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    return { data: serialize(row) }
  })

  // Create — admin only.
  app.post<{
    Body: {
      name: string
      slug?: string
      icon?: string | null
      layout?: unknown
      is_shared?: boolean
      role?: string | null
      sort?: number
    }
  }>('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body
    if (!body?.name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const slug = slugify(body.slug?.trim() || body.name)
    if (!slug) return reply.code(400).send({ error: 'slug is required' })

    const layout = body.layout ?? EMPTY_LAYOUT
    const layoutError = validateLayout(layout)
    if (layoutError) return reply.code(400).send({ error: layoutError })

    const existing = await db('nivaro_pages').where({ slug }).first()
    if (existing)
      return reply.code(409).send({ error: `A page with slug "${slug}" already exists` })

    const now = new Date()
    const [inserted] = await db('nivaro_pages')
      .insert({
        name: body.name.trim(),
        slug,
        icon: body.icon ?? null,
        layout: JSON.stringify(layout),
        is_shared: body.is_shared ?? true,
        role: body.role ?? null,
        sort: body.sort ?? 0,
        created_by: req.user?.id,
        created_at: now,
        updated_at: now
      })
      .returning('*')

    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as PageRow)
        : ((await db('nivaro_pages')
            .where({ id: inserted as number })
            .first()) as PageRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_pages',
      item: String(row.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: serialize(row) })
  })

  // Update — admin only.
  app.patch<{
    Params: { id: string }
    Body: Partial<{
      name: string
      slug: string
      icon: string | null
      layout: unknown
      is_shared: boolean
      role: string | null
      sort: number
    }>
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' })
    const existing = (await db('nivaro_pages').where({ id }).first()) as PageRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Page not found' })

    const body = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }

    if (body.name !== undefined) {
      if (!body.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' })
      patch.name = body.name.trim()
    }
    if (body.slug !== undefined) {
      const slug = slugify(body.slug)
      if (!slug) return reply.code(400).send({ error: 'slug cannot be empty' })
      const dupe = await db('nivaro_pages').where({ slug }).whereNot({ id }).first()
      if (dupe) return reply.code(409).send({ error: `A page with slug "${slug}" already exists` })
      patch.slug = slug
    }
    if (body.icon !== undefined) patch.icon = body.icon
    if (body.layout !== undefined) {
      const layoutError = validateLayout(body.layout)
      if (layoutError) return reply.code(400).send({ error: layoutError })
      patch.layout = JSON.stringify(body.layout)
    }
    if (body.is_shared !== undefined) patch.is_shared = body.is_shared
    if (body.role !== undefined) patch.role = body.role
    if (body.sort !== undefined) patch.sort = body.sort

    await db('nivaro_pages').where({ id }).update(patch)
    const row = (await db('nivaro_pages').where({ id }).first()) as PageRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_pages',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: serialize(row) }
  })

  // Delete — admin only.
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' })
      const deleted = await db('nivaro_pages').where({ id }).delete()
      if (!deleted) return reply.code(404).send({ error: 'Page not found' })
      await logActivity({
        action: 'delete',
        collection: 'nivaro_pages',
        item: String(id),
        user: req.user?.id,
        req
      })
      return reply.code(204).send()
    }
  )

  // ── Widget data ─────────────────────────────────────────────────────────────
  // Executes a widget's stored config server-side with permission checks so the
  // client never needs raw item access logic.
  app.post<{ Params: { slug: string }; Body: { widget_id?: string } }>(
    '/:slug/widget-data',
    async (req, reply) => {
      const row = await loadPage(req.params.slug)
      if (!row) return reply.code(404).send({ error: 'Page not found' })

      const user = req.user as User
      if (!canAccessPage(user, !!req.isAdmin, row)) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const widgetId = req.body?.widget_id
      if (!widgetId) return reply.code(400).send({ error: 'widget_id is required' })

      const layout = parseJson<PageLayout>(row.layout) ?? EMPTY_LAYOUT
      const widget = layout.widgets.find((w) => w.id === widgetId)
      if (!widget) return reply.code(404).send({ error: 'Widget not found on this page' })

      const cfg = widget.config ?? {}

      try {
        switch (widget.type) {
          case 'table': {
            const collection = cfg.collection
            if (isSystemCollection(collection)) {
              return reply.code(400).send({ error: 'Invalid or system collection' })
            }
            if (!(await can(user, 'read', collection as string))) {
              return reply.code(403).send({ error: 'No read access to collection' })
            }
            const limit = Math.min(Math.max(Number(cfg.limit) || 25, 1), 100)
            const columns = Array.isArray(cfg.columns)
              ? (cfg.columns as unknown[]).filter(
                  (c): c is string => typeof c === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)
                )
              : null

            const q = db(collection as string)
              .select(columns?.length ? columns : '*')
              .limit(limit)
            applyWidgetFilters(q as never, cfg.filters)
            const rows = await q
            return { data: { rows } }
          }

          case 'kpi': {
            const collection = cfg.collection
            if (isSystemCollection(collection)) {
              return reply.code(400).send({ error: 'Invalid or system collection' })
            }
            if (!(await can(user, 'read', collection as string))) {
              return reply.code(403).send({ error: 'No read access to collection' })
            }
            const aggregate = String(cfg.aggregate ?? 'count')
            if (!['count', 'sum', 'avg'].includes(aggregate)) {
              return reply.code(400).send({ error: 'aggregate must be count, sum or avg' })
            }
            const field = typeof cfg.field === 'string' ? cfg.field : ''
            if (aggregate !== 'count' && !field) {
              return reply.code(400).send({ error: 'field is required for sum/avg' })
            }

            const q = db(collection as string)
            applyWidgetFilters(q as never, cfg.filters)

            let result: { v: number | string | null } | undefined
            if (aggregate === 'count') {
              result = (await q.count('* as v').first()) as { v: number } | undefined
            } else if (aggregate === 'sum') {
              result = (await q.sum(`${field} as v`).first()) as { v: number | null } | undefined
            } else {
              result = (await q.avg(`${field} as v`).first()) as { v: number | null } | undefined
            }
            const value = result?.v != null ? Number(result.v) : aggregate === 'count' ? 0 : null
            return { data: { value, label: typeof cfg.label === 'string' ? cfg.label : null } }
          }

          case 'recent-activity': {
            const collection = typeof cfg.collection === 'string' ? cfg.collection : null
            if (collection) {
              if (isSystemCollection(collection)) {
                return reply.code(400).send({ error: 'Invalid or system collection' })
              }
              if (!(await can(user, 'read', collection))) {
                return reply.code(403).send({ error: 'No read access to collection' })
              }
            } else if (!req.isAdmin) {
              // Unscoped activity is admin-only — non-admins must scope to a collection.
              return reply.code(403).send({ error: 'Unscoped activity requires admin access' })
            }
            const limit = Math.min(Math.max(Number(cfg.limit) || 10, 1), 50)
            let q = db('nivaro_activity')
              .select('id', 'action', 'collection', 'item', 'user', 'timestamp')
              .orderBy('timestamp', 'desc')
              .limit(limit)
            if (collection) q = q.where({ collection })
            const rows = await q
            return { data: { rows } }
          }

          default:
            return reply
              .code(400)
              .send({ error: `Widget type "${widget.type}" has no server-side data` })
        }
      } catch (err) {
        req.log.error({ err, widgetId, page: row.slug }, 'widget-data execution failed')
        return reply.code(500).send({ error: 'Failed to load widget data' })
      }
    }
  )
}
