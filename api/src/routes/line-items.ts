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

function formatLineItem(row: Record<string, unknown>) {
  return {
    ...row,
    data: parseJsonSafe(row.data)
  }
}

export async function lineItemsRoutes(app: FastifyInstance) {
  // ─── Line item templates (must be before /:collection/:itemId/:field to avoid route conflict) ──

  // GET /line-items/templates/:collection/:field — list templates for a field
  app.get('/templates/:collection/:field', { preHandler: authenticate }, async (req, reply) => {
    const { collection, field } = req.params as { collection: string; field: string }

    const rows = (await db('nivaro_line_item_templates')
      .where({ collection, field })
      .orderBy('created_at', 'desc')) as Record<string, unknown>[]

    return reply.send({
      data: rows.map((r) => ({
        ...r,
        items: parseJsonSafe(r.items)
      }))
    })
  })

  // POST /line-items/templates — create a template
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

    const now = new Date()
    const [row] = await db('nivaro_line_item_templates')
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
    const created = (await db('nivaro_line_item_templates')
      .where({ id: insertedId })
      .first()) as Record<string, unknown>

    return reply.code(201).send({
      data: { ...created, items: parseJsonSafe(created.items) }
    })
  })

  // DELETE /line-items/templates/:id — delete a template
  app.delete('/templates/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_line_item_templates').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_line_item_templates').where({ id }).delete()
    return reply.code(204).send()
  })

  // POST /line-items/templates/:id/apply — return template items
  app.post('/templates/:id/apply', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const template = (await db('nivaro_line_item_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!template) return reply.code(404).send({ error: 'Not found' })

    return reply.send({ items: parseJsonSafe(template.items) })
  })

  // ─── Reorder — also must be before /:collection/:itemId/:field ────────────────

  // POST /line-items/reorder — batch update sort values
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

    for (const item of body.order) {
      await db('nivaro_line_items')
        .where({
          id: item.id,
          collection: body.collection,
          item_id: body.item_id,
          field: body.field
        })
        .update({ sort: item.sort, updated_at: new Date() })
    }

    const rows = (await db('nivaro_line_items')
      .where({ collection: body.collection, item_id: body.item_id, field: body.field })
      .orderBy('sort', 'asc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map(formatLineItem) })
  })

  // ─── Core line item CRUD ──────────────────────────────────────────────────────

  // GET /line-items/:collection/:itemId/:field
  app.get('/:collection/:itemId/:field', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId, field } = req.params as {
      collection: string
      itemId: string
      field: string
    }

    const rows = (await db('nivaro_line_items')
      .where({ collection, item_id: itemId, field })
      .select('id', 'sort', 'data')
      .orderBy('sort', 'asc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map(formatLineItem) })
  })

  // POST /line-items/:collection/:itemId/:field — add a line item
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

    // Get max sort
    const maxRow = await db('nivaro_line_items')
      .where({ collection, item_id: itemId, field })
      .max('sort as max_sort')
      .first()

    const maxSort = (maxRow?.max_sort as number | null) ?? 0
    const newSort = maxSort + 1
    const now = new Date()

    const [row] = await db('nivaro_line_items')
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
    const created = (await db('nivaro_line_items')
      .where({ id: insertedId })
      .select('id', 'sort', 'data')
      .first()) as Record<string, unknown>

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_line_items',
      item: String(insertedId),
      req
    })

    return reply.code(201).send({ data: formatLineItem(created) })
  })

  // PATCH /line-items/:collection/:itemId/:field — bulk replace all line items
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

    // Delete all existing line items for this parent+field
    await db('nivaro_line_items').where({ collection, item_id: itemId, field }).delete()

    // Re-insert in order
    const inserted: Record<string, unknown>[] = []
    for (const item of body.items) {
      const [row] = await db('nivaro_line_items')
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
      const created = (await db('nivaro_line_items')
        .where({ id: insertedId })
        .select('id', 'sort', 'data')
        .first()) as Record<string, unknown>
      inserted.push(formatLineItem(created))
    }

    return reply.send({ data: inserted })
  })

  // DELETE /line-items/:collection/:itemId/:field/:lineItemId — delete a single line item
  app.delete(
    '/:collection/:itemId/:field/:lineItemId',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, itemId, field, lineItemId } = req.params as {
        collection: string
        itemId: string
        field: string
        lineItemId: string
      }

      const existing = await db('nivaro_line_items')
        .where({ id: lineItemId, collection, item_id: itemId, field })
        .first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_line_items').where({ id: lineItemId }).delete()

      return reply.code(204).send()
    }
  )
}
