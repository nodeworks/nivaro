import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Extension event outbox admin surface (#504) — inspect, retry, discard.
 * Rendered by the Extensions page's Events tab.
 *
 * WIRING (routes/index.ts):
 *   await app.register(extensionEventRoutes, { prefix: '/extension-events' })
 */
export async function extensionEventRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  // GET /extension-events?status=&extension=&page=&limit=
  app.get('/', async (req, reply) => {
    const q = req.query as { status?: string; extension?: string; page?: string; limit?: string }
    const page = Math.max(1, Number(q.page ?? 1) || 1)
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50))
    const base = db('nivaro_extension_events')
    if (q.status && ['pending', 'delivered', 'failed', 'dead'].includes(q.status)) {
      void base.where('status', q.status)
    }
    if (q.extension) void base.where('extension', q.extension)
    const [rows, countRow] = await Promise.all([
      base
        .clone()
        .orderBy('id', 'desc')
        .offset((page - 1) * limit)
        .limit(limit),
      base.clone().count('* as c').first() as Promise<{ c: number } | undefined>
    ])
    return reply.send({ data: rows, total: Number(countRow?.c ?? 0), page, limit })
  })

  // POST /extension-events/:id/retry — back to pending, due immediately.
  app.post<{ Params: { id: string } }>('/:id/retry', async (req, reply) => {
    const row = await db('nivaro_extension_events').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Event not found' })
    if (row.status === 'delivered') {
      return reply.code(400).send({ error: 'Event was already delivered' })
    }
    await db('nivaro_extension_events').where('id', row.id).update({
      status: 'pending',
      attempts: 0,
      next_attempt_at: new Date()
    })
    await logActivity({
      action: 'extension-event-retry',
      user: req.user?.id,
      collection: 'nivaro_extension_events',
      item: String(row.id),
      comment: `${row.extension}:${row.event_type}`,
      req
    })
    return reply.send({ data: { id: row.id, status: 'pending' } })
  })

  // POST /extension-events/:id/discard — dead + admin note, never re-swept.
  app.post<{ Params: { id: string } }>('/:id/discard', async (req, reply) => {
    const row = await db('nivaro_extension_events').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Event not found' })
    if (row.status === 'delivered') {
      return reply.code(400).send({ error: 'Event was already delivered' })
    }
    const note = 'discarded by admin'
    await db('nivaro_extension_events')
      .where('id', row.id)
      .update({
        status: 'dead',
        next_attempt_at: null,
        last_error: row.last_error ? `${String(row.last_error).slice(0, 3900)} (${note})` : note
      })
    await logActivity({
      action: 'extension-event-discard',
      user: req.user?.id,
      collection: 'nivaro_extension_events',
      item: String(row.id),
      comment: `${row.extension}:${row.event_type}`,
      req
    })
    return reply.send({ data: { id: row.id, status: 'dead' } })
  })
}
