import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

export async function fieldGroupsRoutes(app: FastifyInstance) {
  // GET /field-groups/:collection — list all groups for a collection
  app.get('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const rows = await db('nivaro_field_groups')
      .where({ collection })
      .select('id', 'collection', 'key', 'label', 'type', 'icon', 'sort', 'is_collapsed')
      .orderBy('sort', 'asc')

    return reply.send({ data: rows })
  })

  // POST /field-groups — create a field group
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      collection: string
      key: string
      label: string
      type: string
      icon?: string
      sort?: number
      is_collapsed?: boolean
    }

    if (!body.collection || !body.key || !body.label || !body.type) {
      return reply.code(400).send({ error: 'collection, key, label, and type are required' })
    }

    const now = new Date()
    const [row] = await db('nivaro_field_groups')
      .insert({
        collection: body.collection,
        key: body.key,
        label: body.label,
        type: body.type,
        icon: body.icon ?? null,
        sort: body.sort ?? 0,
        is_collapsed: body.is_collapsed ? 1 : 0,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = await db('nivaro_field_groups').where({ id: insertedId }).first()

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_field_groups',
      item: String(insertedId),
      req
    })

    return reply.code(201).send({ data: created })
  })

  // PATCH /field-groups/:id — update a field group
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_field_groups').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{
      key: string
      label: string
      type: string
      icon: string | null
      sort: number
      is_collapsed: boolean
    }>

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.key !== undefined) patch.key = body.key
    if (body.label !== undefined) patch.label = body.label
    if (body.type !== undefined) patch.type = body.type
    if ('icon' in body) patch.icon = body.icon ?? null
    if (body.sort !== undefined) patch.sort = body.sort
    if (body.is_collapsed !== undefined) patch.is_collapsed = body.is_collapsed ? 1 : 0

    await db('nivaro_field_groups').where({ id }).update(patch)
    const updated = await db('nivaro_field_groups').where({ id }).first()

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_field_groups',
      item: id,
      req
    })

    return reply.send({ data: updated })
  })

  // DELETE /field-groups/:id — delete a field group and clear group_key on fields
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_field_groups').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    // Clear group_key on fields that belong to this group
    await db('nivaro_fields')
      .where({ collection: existing.collection, group_key: existing.key })
      .update({ group_key: null })

    await db('nivaro_field_groups').where({ id }).delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_field_groups',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // POST /field-groups/reorder — batch update sort values
  app.post('/reorder', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { collection: string; order: Array<{ id: number; sort: number }> }

    if (!body.collection || !Array.isArray(body.order) || body.order.length === 0) {
      return reply.code(400).send({ error: 'collection and order array are required' })
    }

    for (const item of body.order) {
      await db('nivaro_field_groups')
        .where({ id: item.id, collection: body.collection })
        .update({ sort: item.sort, updated_at: new Date() })
    }

    const rows = await db('nivaro_field_groups')
      .where({ collection: body.collection })
      .select('id', 'key', 'label', 'sort')
      .orderBy('sort', 'asc')

    return reply.send({ data: rows })
  })
}
