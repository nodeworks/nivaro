import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

function formatSubRow(row: Record<string, unknown>) {
  return {
    ...row,
    data: parseJsonSafe(row.data)
  }
}

export async function subRowsRoutes(app: FastifyInstance) {
  // ─── Sub-row templates (must be before /:collection/:itemId/:field to avoid route conflict) ──

  // GET /sub-rows/templates/:collection/:field — list templates for a field
  app.get('/templates/:collection/:field', { preHandler: authenticate }, async (req, reply) => {
    const { collection, field } = req.params as { collection: string; field: string }

    if (!(await can(req.user!, 'read', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const rows = (await db('nivaro_sub_row_templates')
      .where({ collection, field })
      .orderBy('created_at', 'desc')) as Record<string, unknown>[]

    return reply.send({
      data: rows.map((r) => ({
        ...r,
        items: parseJsonSafe(r.items)
      }))
    })
  })

  // POST /sub-rows/templates — create a template
  app.post('/templates', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      collection: string
      field: string
      name: string
      items: unknown[]
    }

    if (!body.collection || !body.field || !body.name) {
      return reply.code(400).send({ error: 'collection, field, and name are required' })
    }
    if (body.collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', body.collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const now = new Date()
    const [row] = await db('nivaro_sub_row_templates')
      .insert({
        collection: body.collection,
        field: body.field,
        name: body.name,
        items: JSON.stringify(body.items ?? []),
        created_by: req.user!.id,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = (await db('nivaro_sub_row_templates')
      .where({ id: insertedId })
      .first()) as Record<string, unknown>

    return reply.code(201).send({
      data: { ...created, items: parseJsonSafe(created.items) }
    })
  })

  // DELETE /sub-rows/templates/:id — delete a template
  app.delete('/templates/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_sub_row_templates').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_sub_row_templates').where({ id }).delete()
    return reply.code(204).send()
  })

  // POST /sub-rows/templates/:id/apply — return template items
  app.post('/templates/:id/apply', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const template = (await db('nivaro_sub_row_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!template) return reply.code(404).send({ error: 'Not found' })

    if (!(await can(req.user!, 'read', template.collection as string)))
      return reply.code(403).send({ error: 'Forbidden' })

    return reply.send({ items: parseJsonSafe(template.items) })
  })

  // ─── Reorder — also must be before /:collection/:itemId/:field ────────────────

  // POST /sub-rows/reorder — batch update sort values
  app.post('/reorder', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      collection: string
      item_id: string
      field: string
      order: Array<{ id: number | string; sort: number }>
    }

    if (!body.collection || !body.item_id || !body.field || !Array.isArray(body.order)) {
      return reply
        .code(400)
        .send({ error: 'collection, item_id, field, and order array are required' })
    }
    if (body.collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', body.collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    for (const item of body.order) {
      await db('nivaro_sub_rows')
        .where({
          id: item.id,
          collection: body.collection,
          item_id: body.item_id,
          field: body.field
        })
        .update({ sort: item.sort, updated_at: new Date() })
    }

    const rows = (await db('nivaro_sub_rows')
      .where({ collection: body.collection, item_id: body.item_id, field: body.field })
      .orderBy('sort', 'asc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map(formatSubRow) })
  })

  // ─── Core sub-row CRUD ────────────────────────────────────────────────────────

  // GET /sub-rows/:collection/:itemId/:field
  app.get('/:collection/:itemId/:field', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId, field } = req.params as {
      collection: string
      itemId: string
      field: string
    }

    if (!(await can(req.user!, 'read', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const rows = (await db('nivaro_sub_rows')
      .where({ collection, item_id: itemId, field })
      .select('id', 'sort', 'data')
      .orderBy('sort', 'asc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map(formatSubRow) })
  })

  // POST /sub-rows/:collection/:itemId/:field — add a sub-row
  app.post('/:collection/:itemId/:field', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId, field } = req.params as {
      collection: string
      itemId: string
      field: string
    }

    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const body = req.body as { data: Record<string, unknown> }
    if (!body.data || typeof body.data !== 'object') {
      return reply.code(400).send({ error: 'data object is required' })
    }

    const maxRow = await db('nivaro_sub_rows')
      .where({ collection, item_id: itemId, field })
      .max('sort as max_sort')
      .first()

    const maxSort = (maxRow?.max_sort as number | null) ?? 0
    const newSort = maxSort + 1
    const now = new Date()

    const [row] = await db('nivaro_sub_rows')
      .insert({
        collection,
        item_id: itemId,
        field,
        sort: newSort,
        data: JSON.stringify(body.data),
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = (await db('nivaro_sub_rows')
      .where({ id: insertedId })
      .select('id', 'sort', 'data')
      .first()) as Record<string, unknown>

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_sub_rows',
      item: String(insertedId),
      req
    })

    return reply.code(201).send({ data: formatSubRow(created) })
  })

  // PATCH /sub-rows/:collection/:itemId/:field — bulk replace all sub-rows
  app.patch('/:collection/:itemId/:field', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId, field } = req.params as {
      collection: string
      itemId: string
      field: string
    }

    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const body = req.body as {
      items: Array<{ id?: number | string; sort: number; data: Record<string, unknown> }>
    }

    if (!Array.isArray(body.items)) {
      return reply.code(400).send({ error: 'items array is required' })
    }

    const now = new Date()

    await db('nivaro_sub_rows').where({ collection, item_id: itemId, field }).delete()

    const inserted: Record<string, unknown>[] = []
    for (const item of body.items) {
      const [row] = await db('nivaro_sub_rows')
        .insert({
          collection,
          item_id: itemId,
          field,
          sort: item.sort,
          data: JSON.stringify(item.data ?? {}),
          created_at: now,
          updated_at: now
        })
        .returning('id')

      const insertedId = typeof row === 'object' ? row.id : row
      const created = (await db('nivaro_sub_rows')
        .where({ id: insertedId })
        .select('id', 'sort', 'data')
        .first()) as Record<string, unknown>
      inserted.push(formatSubRow(created))
    }

    return reply.send({ data: inserted })
  })

  // DELETE /sub-rows/:collection/:itemId/:field/:subRowId — delete a single sub-row
  app.delete(
    '/:collection/:itemId/:field/:subRowId',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, itemId, field, subRowId } = req.params as {
        collection: string
        itemId: string
        field: string
        subRowId: string
      }

      if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
      if (!(await can(req.user!, 'update', collection)))
        return reply.code(403).send({ error: 'Forbidden' })

      const existing = await db('nivaro_sub_rows')
        .where({ id: subRowId, collection, item_id: itemId, field })
        .first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_sub_rows').where({ id: subRowId }).delete()

      return reply.code(204).send()
    }
  )
}
