import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { emitNotification } from '../plugins/socketio.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const

interface Issue {
  id: number
  collection: string | null
  item: string | null
  title: string
  severity: string
  status: string
  assigned_to: string | null
  raised_by: string
  resolution_notes: string | null
  created_at: Date
  updated_at: Date
}

async function notifyAssignment(
  app: FastifyInstance,
  issue: Issue,
  assigneeId: string,
  senderId: string | null
): Promise<void> {
  const notification = {
    recipient: assigneeId,
    sender: senderId,
    subject: `Issue assigned: ${issue.title}`.slice(0, 255),
    message: `You have been assigned issue #${issue.id} (${issue.severity}): ${issue.title}`,
    status: 'inbox',
    timestamp: new Date(),
    collection: issue.collection,
    item: issue.item ?? String(issue.id)
  }
  try {
    await db('nivaro_notifications').insert(notification)
    if (app.io) emitNotification(app.io, assigneeId, notification)
  } catch (err) {
    app.log.warn({ err }, 'Failed to send issue assignment notification')
  }
}

export async function issuesRoutes(app: FastifyInstance) {
  // GET /issues?collection=&item=&status=&severity=&assigned_to=me
  app.get('/', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item, status, severity, assigned_to } = req.query as {
      collection?: string
      item?: string
      status?: string
      severity?: string
      assigned_to?: string
    }

    let query = db<Issue>('nivaro_issues as i')
      .leftJoin('nivaro_users as a', 'i.assigned_to', 'a.id')
      .leftJoin('nivaro_users as r', 'i.raised_by', 'r.id')
      .select(
        'i.*',
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, '')))) as assigned_to_name"
        ),
        'a.email as assigned_to_email',
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(r.first_name, ''), ' ', COALESCE(r.last_name, '')))) as raised_by_name"
        ),
        'r.email as raised_by_email'
      )
      .orderBy('i.created_at', 'desc')
      .limit(200)

    if (collection) query = query.where('i.collection', collection)
    if (item) query = query.where('i.item', item)
    if (status) query = query.where('i.status', status)
    if (severity) query = query.where('i.severity', severity)
    if (assigned_to) {
      query = query.where('i.assigned_to', assigned_to === 'me' ? req.user!.id : assigned_to)
    }

    const rows = await query
    return reply.send({ data: rows })
  })

  // GET /issues/summary — counts by status + severity
  app.get('/summary', { preHandler: requireAuth }, async (_req, reply) => {
    const [byStatus, bySeverity] = await Promise.all([
      db('nivaro_issues').select('status').count('* as count').groupBy('status'),
      db('nivaro_issues')
        .select('severity')
        .count('* as count')
        .whereNot('status', 'closed')
        .groupBy('severity')
    ])

    const statusCounts: Record<string, number> = {}
    for (const row of byStatus) statusCounts[row.status as string] = Number(row.count)
    const severityCounts: Record<string, number> = {}
    for (const row of bySeverity) severityCounts[row.severity as string] = Number(row.count)

    return reply.send({ data: { by_status: statusCounts, by_severity: severityCounts } })
  })

  // GET /issues/:id
  app.get('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db<Issue>('nivaro_issues')
      .where({ id: Number(id) })
      .first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: row })
  })

  // POST /issues
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as {
      title: string
      severity?: string
      collection?: string | null
      item?: string | null
      assigned_to?: string | null
    }

    if (!body.title?.trim()) {
      return reply.code(400).send({ error: 'title is required' })
    }
    if (body.severity && !SEVERITIES.includes(body.severity as never)) {
      return reply.code(400).send({ error: `severity must be one of ${SEVERITIES.join(', ')}` })
    }

    // If the issue references a collection, the raiser must be able to read it
    if (body.collection && !req.isAdmin) {
      const allowed = await can(req.user!, 'read', body.collection)
      if (!allowed) {
        return reply.code(403).send({ error: 'No read access to this collection' })
      }
    }

    const now = new Date()
    const [row] = await db('nivaro_issues')
      .insert({
        title: body.title.trim().slice(0, 500),
        severity: body.severity ?? 'medium',
        status: 'open',
        collection: body.collection ?? null,
        item: body.item ?? null,
        assigned_to: body.assigned_to ?? null,
        raised_by: req.user!.id,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = await db<Issue>('nivaro_issues').where({ id: insertedId }).first()

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_issues',
      item: String(insertedId),
      req
    })

    if (created?.assigned_to) {
      await notifyAssignment(app, created, created.assigned_to, req.user!.id)
    }

    return reply.code(201).send({ data: created })
  })

  // PATCH /issues/:id — assignee, raiser, or admin only
  app.patch('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<Issue>('nivaro_issues')
      .where({ id: Number(id) })
      .first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const userId = req.user!.id
    const allowed = req.isAdmin || existing.assigned_to === userId || existing.raised_by === userId
    if (!allowed) {
      return reply
        .code(403)
        .send({ error: 'Only the assignee, raiser, or an admin can update this issue' })
    }

    const body = req.body as Partial<{
      title: string
      severity: string
      status: string
      assigned_to: string | null
      resolution_notes: string | null
      collection: string | null
      item: string | null
    }>

    if (body.severity !== undefined && !SEVERITIES.includes(body.severity as never)) {
      return reply.code(400).send({ error: `severity must be one of ${SEVERITIES.join(', ')}` })
    }
    if (body.status !== undefined && !STATUSES.includes(body.status as never)) {
      return reply.code(400).send({ error: `status must be one of ${STATUSES.join(', ')}` })
    }

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.title !== undefined) patch.title = body.title.trim().slice(0, 500)
    if (body.severity !== undefined) patch.severity = body.severity
    if (body.status !== undefined) patch.status = body.status
    if ('assigned_to' in body) patch.assigned_to = body.assigned_to ?? null
    if ('resolution_notes' in body) patch.resolution_notes = body.resolution_notes ?? null
    if ('collection' in body) patch.collection = body.collection ?? null
    if ('item' in body) patch.item = body.item ?? null

    await db('nivaro_issues')
      .where({ id: Number(id) })
      .update(patch)
    const updated = await db<Issue>('nivaro_issues')
      .where({ id: Number(id) })
      .first()

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_issues',
      item: id,
      req
    })

    // Notify newly assigned user
    if (
      updated?.assigned_to &&
      updated.assigned_to !== existing.assigned_to &&
      updated.assigned_to !== userId
    ) {
      await notifyAssignment(app, updated, updated.assigned_to, userId)
    }

    return reply.send({ data: updated })
  })

  // DELETE /issues/:id — admin only
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<Issue>('nivaro_issues')
      .where({ id: Number(id) })
      .first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_issues')
      .where({ id: Number(id) })
      .delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_issues',
      item: id,
      req
    })

    return reply.code(204).send()
  })
}
