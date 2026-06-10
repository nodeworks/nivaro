import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// Actual schema (migration 003 + renamed in 012):
// id INT, timestamp datetime, status varchar ('inbox'|'read'),
// recipient uuid FK→nivaro_users, sender uuid|null,
// subject varchar(255), message text|null, collection|null, item|null

function serialize(row: Record<string, unknown>) {
  return {
    id: row.id,
    user: row.recipient,
    title: row.subject,
    message: row.message,
    type: 'notification',
    read: row.status !== 'inbox',
    collection: row.collection,
    item: row.item,
    data: null,
    created_at: row.timestamp
  }
}

export async function notificationsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET /?page=&limit=&status=all|inbox|read (legacy ?unread=true still honored)
  app.get('/', async (req, reply) => {
    const userId = req.user!.id
    const q = req.query as { unread?: string; page?: string; limit?: string; status?: string }

    const page = Math.max(1, Number(q.page) || 1)
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))

    const filtered = () => {
      let query = db('nivaro_notifications').where({ recipient: userId })
      if (q.status === 'inbox' || q.unread === 'true') query = query.andWhere({ status: 'inbox' })
      else if (q.status === 'read') query = query.andWhere({ status: 'read' })
      return query
    }

    const countRow = await filtered().count<{ count: string | number }>({ count: '*' }).first()
    const total = Number(countRow?.count ?? 0)

    const rows = await filtered()
      .orderBy('timestamp', 'desc')
      .offset((page - 1) * limit)
      .limit(limit)
      .select('*')

    return reply.send({ data: rows.map(serialize), total, page, limit })
  })

  app.get('/count', async (req, reply) => {
    const userId = req.user!.id
    const row = await db('nivaro_notifications')
      .where({ recipient: userId, status: 'inbox' })
      .count<{ count: string | number }>({ count: '*' })
      .first()
    return reply.send({ unread: Number(row?.count ?? 0) })
  })

  app.post('/:id/read', async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const updated = await db('nivaro_notifications')
      .where({ id: Number(id), recipient: userId })
      .update({ status: 'read' })
    if (!updated) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'notification-read',
      user: userId,
      collection: 'nivaro_notifications',
      item: String(id),
      req
    })
    return reply.send({ data: { id: Number(id), read: true } })
  })

  async function markAllRead(userId: string) {
    return db('nivaro_notifications')
      .where({ recipient: userId, status: 'inbox' })
      .update({ status: 'read' })
  }

  app.post('/read-all', async (req, reply) => {
    const updated = await markAllRead(req.user!.id)
    await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_notifications',
      comment: 'mark-all-read',
      req
    })
    return reply.send({ data: { updated } })
  })

  // Alias for the notifications center UI
  app.post('/mark-all-read', async (req, reply) => {
    const updated = await markAllRead(req.user!.id)
    await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_notifications',
      comment: 'mark-all-read',
      req
    })
    return reply.send({ data: { updated } })
  })

  // GET /unread-count — alias of /count for the notifications center UI
  app.get('/unread-count', async (req, reply) => {
    const row = await db('nivaro_notifications')
      .where({ recipient: req.user!.id, status: 'inbox' })
      .count<{ count: string | number }>({ count: '*' })
      .first()
    return reply.send({ unread: Number(row?.count ?? 0) })
  })

  app.delete('/:id', async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const deleted = await db('nivaro_notifications')
      .where({ id: Number(id), recipient: userId })
      .del()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      user: userId,
      collection: 'nivaro_notifications',
      item: String(id),
      req
    })
    return reply.send({ data: { id: Number(id) } })
  })
}
