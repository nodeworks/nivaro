import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
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

function formatChange(row: Record<string, unknown>) {
  return {
    ...row,
    changes: parseJsonSafe(row.changes)
  }
}

export async function scheduledChangesRoutes(app: FastifyInstance) {
  // GET /scheduled-changes — list all (admin) with optional filters
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection, status } = req.query as { collection?: string; status?: string }

    let query = db('nivaro_scheduled_changes').orderBy('scheduled_at', 'asc')

    if (collection) query = query.where({ collection })
    if (status) query = query.where({ status })

    const rows = (await query) as Record<string, unknown>[]
    return reply.send({ data: rows.map(formatChange) })
  })

  // GET /scheduled-changes/:collection/:itemId — list for an item
  app.get('/:collection/:itemId', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }

    const rows = (await db('nivaro_scheduled_changes')
      .where({ collection, item_id: itemId })
      .orderBy('scheduled_at', 'asc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map(formatChange) })
  })

  // POST /scheduled-changes — create
  app.post('/', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      collection: string
      item_id: string
      change_type: 'field_update' | 'workflow_transition'
      changes: Record<string, unknown>
      scheduled_at: string
    }

    if (!body.collection || !body.item_id || !body.change_type || !body.scheduled_at) {
      return reply
        .code(400)
        .send({ error: 'collection, item_id, change_type, and scheduled_at are required' })
    }

    if (!['field_update', 'workflow_transition'].includes(body.change_type)) {
      return reply
        .code(400)
        .send({ error: 'change_type must be field_update or workflow_transition' })
    }

    if (body.collection.startsWith('nivaro_') && !(req.isAdmin ?? false)) {
      return reply.code(403).send({ error: 'Cannot schedule changes to system collections' })
    }
    if (!(await can(req.user!, 'update', body.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const PROTECTED_FIELDS = [
      'id',
      'role',
      'admin_access',
      'static_token',
      'password_hash',
      'external_id'
    ]
    if (Object.keys(body.changes ?? {}).some((k) => PROTECTED_FIELDS.includes(k))) {
      return reply.code(400).send({ error: 'changes contains protected fields' })
    }

    const now = new Date()
    const scheduledAt = new Date(body.scheduled_at)
    if (Number.isNaN(scheduledAt.getTime())) {
      return reply.code(400).send({ error: 'scheduled_at is not a valid date' })
    }

    const [row] = await db('nivaro_scheduled_changes')
      .insert({
        collection: body.collection,
        item_id: body.item_id,
        change_type: body.change_type,
        changes: JSON.stringify(body.changes ?? {}),
        scheduled_at: scheduledAt,
        status: 'pending',
        created_by: req.user!.id,
        created_at: now,
        updated_at: now
        // NOTE: Inngest integration for auto-execution is a future enhancement.
        // For now, scheduled changes must be executed manually via POST /:id/execute.
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = (await db('nivaro_scheduled_changes')
      .where({ id: insertedId })
      .first()) as Record<string, unknown>

    return reply.code(201).send({ data: formatChange(created) })
  })

  // DELETE /scheduled-changes/:id — cancel
  app.delete('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_scheduled_changes').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    // Own or admin
    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    if (existing.status === 'executed') {
      return reply.code(409).send({ error: 'Cannot cancel an already executed change' })
    }

    await db('nivaro_scheduled_changes')
      .where({ id })
      .update({ status: 'cancelled', updated_at: new Date() })

    return reply.code(204).send()
  })

  // POST /scheduled-changes/:id/execute — manually execute now (admin)
  app.post('/:id/execute', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const change = await db('nivaro_scheduled_changes').where({ id }).first()
    if (!change) return reply.code(404).send({ error: 'Not found' })

    if (change.status !== 'pending') {
      return reply.code(409).send({ error: `Change is already ${change.status}` })
    }

    const changesData = parseJsonSafe(change.changes) as Record<string, unknown>
    const now = new Date()

    try {
      await db(change.collection).where({ id: change.item_id }).update(changesData)
    } catch (err) {
      console.error('Failed to execute scheduled change:', err)
      await db('nivaro_scheduled_changes')
        .where({ id })
        .update({ status: 'failed', updated_at: now })
      return reply.code(500).send({ error: 'Failed to apply changes to item' })
    }

    await db('nivaro_scheduled_changes')
      .where({ id })
      .update({ status: 'executed', executed_at: now, updated_at: now })

    await logActivity({
      action: 'execute_scheduled_change',
      user: req.user?.id,
      collection: change.collection,
      item: change.item_id,
      req
    })

    return reply.send({ data: { id, status: 'executed', executed_at: now } })
  })
}
