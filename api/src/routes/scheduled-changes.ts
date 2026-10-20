import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { canUpdateItem, readOne } from '../services/items.js'
import { can, getAllowedFields } from '../services/permissions.js'
import { recordToolRefusal } from '../services/record-tool-gate.js'

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

function formatChange(row: Record<string, unknown>, readable: Set<string> | null = null) {
  const changes = parseJsonSafe(row.changes)
  if (!readable) return { ...row, changes }
  // A stored value that is not a field map can't be filtered, so it never
  // reaches a viewer limited to some fields.
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { ...row, changes: {} }
  }
  // Values of fields the viewer may not read never leave the server.
  return {
    ...row,
    changes: Object.fromEntries(
      Object.entries(changes as Record<string, unknown>).filter(([k]) => readable.has(k))
    )
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
    return reply.send({ data: rows.map((r) => formatChange(r)) })
  })

  // GET /scheduled-changes/:collection/:itemId — list for an item. Non-admins
  // see the list only for a record they can see, and only the values of
  // fields they may read.
  app.get('/:collection/:itemId', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }

    let readable: Set<string> | null = null
    if (!(req.isAdmin ?? false)) {
      const visible = await readOne(
        req.user!,
        collection,
        itemId,
        req.workspaceId ?? undefined
      ).catch(() => null)
      if (!visible) return reply.code(404).send({ error: 'Not found' })
      const fields = await getAllowedFields(req.user!, 'read', collection)
      readable = fields === null || fields.includes('*') ? null : new Set(fields)
    }

    const rows = (await db('nivaro_scheduled_changes')
      .where({ collection, item_id: itemId })
      .orderBy('scheduled_at', 'asc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map((r) => formatChange(r, readable)) })
  })

  // POST /scheduled-changes — create
  app.post('/', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      collection: string
      item_id: string
      change_type: 'field_update' | 'workflow_transition'
      changes: Record<string, unknown>
      scheduled_at: string
      layout?: string | null
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

    if (body.changes != null && (typeof body.changes !== 'object' || Array.isArray(body.changes))) {
      return reply.code(400).send({ error: 'changes must be an object of field values' })
    }

    const isAdmin = req.isAdmin ?? false
    if (body.collection.startsWith('nivaro_') && !isAdmin) {
      return reply.code(403).send({ error: 'Cannot schedule changes to system collections' })
    }
    // Non-admins: the record must be visible (404), its form must grant
    // "Schedule a change" (allow_schedule) and they must be able to update
    // THIS record — the same gate as "Disable in pickers".
    const refusal = await recordToolRefusal(
      req,
      body.collection,
      String(body.item_id),
      'allow_schedule',
      {
        layout: typeof body.layout === 'string' ? body.layout : null,
        denied: 'Only administrators can schedule changes here'
      }
    )
    if (refusal) return reply.code(refusal.status).send({ error: refusal.error })
    if (!(await can(req.user!, 'update', body.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (!isAdmin) {
      // Execution writes every key as a column, whatever the change type, so
      // each one must be a field the caller may update.
      const allowed = await getAllowedFields(req.user!, 'update', body.collection)
      if (allowed !== null && !allowed.includes('*')) {
        const allowedSet = new Set(allowed)
        const blocked = Object.keys(body.changes ?? {}).find((k) => !allowedSet.has(k))
        if (blocked) {
          return reply.code(403).send({ error: `You may not change the field "${blocked}"` })
        }
      }
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
        // For now, scheduled changes must be executed manually via POST /:id/execute.
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    await logActivity({
      action: 'schedule-change-create',
      user: req.user?.id,
      collection: body.collection,
      item: body.item_id,
      comment: `${body.change_type} scheduled for ${scheduledAt.toISOString()}`,
      req
    })
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

    // Own or admin — and a non-admin only while they can still see and
    // update the record the change is for.
    const isAdmin = req.isAdmin ?? false
    if (!isAdmin) {
      if (existing.created_by !== req.user!.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const workspaceId = req.workspaceId ?? undefined
      const itemId = String(existing.item_id)
      const visible = await readOne(req.user!, existing.collection, itemId, workspaceId).catch(
        () => null
      )
      if (!visible) return reply.code(404).send({ error: 'Not found' })
      if (!(await canUpdateItem(req.user!, existing.collection, itemId, workspaceId))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
    }

    if (existing.status === 'executed') {
      return reply.code(409).send({ error: 'Cannot cancel an already executed change' })
    }

    await db('nivaro_scheduled_changes')
      .where({ id })
      .update({ status: 'cancelled', updated_at: new Date() })

    await logActivity({
      action: 'schedule-change-cancel',
      user: req.user?.id,
      collection: existing.collection,
      item: existing.item_id,
      comment: existing.change_type,
      req
    })

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
