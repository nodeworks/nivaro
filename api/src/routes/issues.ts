import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { emitNotification } from '../plugins/socketio.js'
import { logActivity } from '../services/activity.js'
import { trackError } from '../services/error-tracking.js'
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
  // POST /issues/client — React error boundary reports. Deduped by
  // fingerprint via trackError; severity fixed to 'high'.
  app.post('/client', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as {
      message?: string
      stack?: string
      url?: string
      recording_id?: string
      recording_offset_ms?: number
    }
    if (!body.message?.trim()) return reply.code(400).send({ error: 'message is required' })
    // The replay link is caller-supplied — accept only a uuid-shaped id, and
    // only one that exists AND belongs to the reporting user, or a client
    // could attach someone else's recording to an issue.
    let recordingId: string | null = null
    if (typeof body.recording_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.recording_id)) {
      const rec = await db('nivaro_session_recordings')
        .where({ id: body.recording_id, user: req.user?.id ?? '' })
        .first('id')
      if (rec) recordingId = body.recording_id
    }
    await trackError({
      source: 'client',
      route: String(body.url ?? 'unknown').slice(0, 300),
      message: body.message,
      stack: body.stack ?? null,
      userId: req.user?.id ?? null,
      recordingId,
      recordingOffsetMs:
        // Explicit null must STAY null (a clip has no offset — the whole clip
        // is the context); Number(null) is 0, which would claim precision the
        // link does not have.
        recordingId &&
        body.recording_offset_ms != null &&
        Number.isFinite(Number(body.recording_offset_ms))
          ? Math.max(0, Math.floor(Number(body.recording_offset_ms)))
          : null
    })
    return reply.code(204).send()
  })

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
        // everything except the (potentially large) screenshot blob
        'i.id',
        'i.collection',
        'i.item',
        'i.title',
        'i.severity',
        'i.status',
        'i.assigned_to',
        'i.raised_by',
        'i.resolution_notes',
        'i.source',
        'i.details',
        'i.fingerprint',
        'i.occurrence_count',
        'i.last_seen_at',
        'i.recording_id',
        'i.recording_offset_ms',
        'i.created_at',
        'i.updated_at',
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
      details?: string | null
      screenshot?: string | null
    }

    if (body.screenshot && !/^data:image\/(png|jpeg|webp);base64,/.test(body.screenshot)) {
      return reply.code(400).send({ error: 'screenshot must be a data:image URI' })
    }
    if (body.screenshot && body.screenshot.length > 2_500_000) {
      return reply.code(400).send({ error: 'screenshot too large (2MB cap)' })
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
        details: body.details ? String(body.details).slice(0, 8000) : null,
        screenshot: body.screenshot ?? null,
        source: 'manual',
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
