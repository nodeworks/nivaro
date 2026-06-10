import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

interface SavedViewRow {
  id: number
  collection: string
  name: string
  filters: string | null
  sort: string | null
  columns: string | null
  user: string
  is_shared: boolean | number
  role: string | null
  created_at: Date
}

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function toJsonStr(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

function formatView(row: SavedViewRow) {
  return {
    ...row,
    filters: parseJson(row.filters),
    sort: parseJson(row.sort),
    columns: parseJson(row.columns),
    is_shared: !!row.is_shared
  }
}

export async function savedViewsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET /?collection= — own views + shared views (optionally role-matched)
  app.get('/', async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    const userId = req.user!.id
    const userRole = req.user!.role ?? null

    const rows = (await db<SavedViewRow>('nivaro_saved_views')
      .where({ collection })
      .where((qb) => {
        qb.where({ user: userId }).orWhere((shared) => {
          shared.where('is_shared', true).andWhere((roleQb) => {
            roleQb.whereNull('role')
            if (userRole) roleQb.orWhere('role', userRole)
          })
        })
      })
      .orderBy('created_at', 'asc')) as SavedViewRow[]

    return reply.send({ data: rows.map(formatView) })
  })

  // POST / — create a view owned by the current user
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      collection?: string
      name?: string
      filters?: unknown
      sort?: unknown
      columns?: unknown
      is_shared?: boolean
      role?: string | null
    }

    const { collection, name } = body
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const [row] = (await db('nivaro_saved_views')
      .insert({
        collection,
        name: name.trim(),
        filters: toJsonStr(body.filters),
        sort: toJsonStr(body.sort),
        columns: toJsonStr(body.columns),
        user: req.user!.id,
        is_shared: !!body.is_shared,
        role: body.role ?? null,
        created_at: new Date()
      })
      .returning('*')) as unknown as [SavedViewRow]

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_saved_views',
      item: String(row.id),
      comment: collection,
      req
    })

    return reply.code(201).send({ data: formatView(row) })
  })

  // PATCH /:id — update (owner or admin)
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const view = (await db<SavedViewRow>('nivaro_saved_views')
      .where({ id: Number(id) })
      .first()) as SavedViewRow | undefined

    if (!view) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && view.user !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = (req.body ?? {}) as {
      name?: string
      filters?: unknown
      sort?: unknown
      columns?: unknown
      is_shared?: boolean
      role?: string | null
    }

    const update: Record<string, unknown> = {}
    if (body.name !== undefined) {
      if (!body.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' })
      update.name = body.name.trim()
    }
    if (body.filters !== undefined) update.filters = toJsonStr(body.filters)
    if (body.sort !== undefined) update.sort = toJsonStr(body.sort)
    if (body.columns !== undefined) update.columns = toJsonStr(body.columns)
    if (body.is_shared !== undefined) update.is_shared = !!body.is_shared
    if (body.role !== undefined) update.role = body.role ?? null

    if (Object.keys(update).length === 0) {
      return reply.send({ data: formatView(view) })
    }

    await db('nivaro_saved_views')
      .where({ id: Number(id) })
      .update(update)
    const updated = (await db<SavedViewRow>('nivaro_saved_views')
      .where({ id: Number(id) })
      .first()) as SavedViewRow

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_saved_views',
      item: String(id),
      req
    })

    return reply.send({ data: formatView(updated) })
  })

  // DELETE /:id — delete (owner or admin)
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const view = (await db<SavedViewRow>('nivaro_saved_views')
      .where({ id: Number(id) })
      .first()) as SavedViewRow | undefined

    if (!view) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && view.user !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_saved_views')
      .where({ id: Number(id) })
      .delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_saved_views',
      item: String(id),
      req
    })
    return reply.code(204).send()
  })
}
