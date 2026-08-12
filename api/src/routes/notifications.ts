import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { sendRawMail } from '../services/mail.js'
import { notifyUser } from '../services/notification-channels.js'
import { parseJsonSafe } from '../services/metric-alerts.js'

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

  // POST / — user-to-user notification (chat @mentions etc.). Sender is always
  // the authenticated user; rides notifyUser so socket + web push fire too.
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      recipient?: string
      subject?: string
      message?: string
      collection?: string
      item?: string
    }
    if (!body.recipient || !body.subject?.trim()) {
      return reply.code(400).send({ error: 'recipient and subject are required' })
    }
    const target = await db('nivaro_users')
      .where({ id: body.recipient, status: 'active' })
      .first('id')
    if (!target) return reply.code(404).send({ error: 'Recipient not found' })

    await notifyUser(app, String(target.id), {
      subject: body.subject.trim().slice(0, 255),
      message: (body.message ?? '').slice(0, 500),
      sender: req.user!.id,
      collection: body.collection,
      item: body.item
    })
    return reply.code(201).send({ ok: true })
  })

  // POST /bulk — admin broadcast to a scope-dimension audience (EFP Bulk
  // Message port, generalized): recipients = users whose RESTRICT-mode scope
  // for `dimension` intersects `values`, plus any explicit user_ids. Email
  // rides sendRawMail (mail test mode applies); in-app rides notifyUser.
  app.post('/bulk', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      subject?: string
      message?: string
      html?: string
      dimension?: string
      values?: Array<string | number>
      user_ids?: string[]
      channels?: { inapp?: boolean; email?: boolean }
    }
    if (!body.subject?.trim()) return reply.code(400).send({ error: 'subject is required' })
    if (!body.message?.trim() && !body.html?.trim()) {
      return reply.code(400).send({ error: 'message or html is required' })
    }
    const channels = { inapp: true, email: true, ...(body.channels ?? {}) }

    const recipientIds = new Set<string>((body.user_ids ?? []).map((u) => String(u)))
    if (body.dimension && body.values?.length) {
      const wanted = new Set(body.values.map(String))
      const rows = (await db('nivaro_user_scopes')
        .where({ dimension: body.dimension, mode: 'restrict' })
        .select('user', 'values')) as Array<{ user: string; values: string | null }>
      for (const row of rows) {
        const vals = parseJsonSafe<Array<string | number>>(row.values) ?? []
        if (vals.some((v) => wanted.has(String(v)))) recipientIds.add(String(row.user))
      }
    }
    if (recipientIds.size === 0) {
      return reply.code(400).send({ error: 'No recipients matched the selected audience' })
    }

    const users = (await db('nivaro_users')
      .whereIn('id', [...recipientIds])
      .where({ status: 'active', is_redacted: false })
      .select('id', 'email')) as Array<{ id: string; email: string | null }>
    if (users.length === 0) {
      return reply.code(400).send({ error: 'No active recipients matched' })
    }

    const subject = body.subject.trim().slice(0, 255)
    const text = (body.message ?? '').trim()
    const html =
      body.html?.trim() ||
      `<p style="margin:0 0 12px;white-space:pre-wrap;">${text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')}</p>`

    let emailed = 0
    for (const u of users) {
      if (channels.inapp) {
        await notifyUser(app, u.id, {
          subject,
          message: text.slice(0, 500) || subject,
          sender: req.user!.id
        }).catch(() => undefined)
      }
      if (channels.email && u.email) {
        await sendRawMail({ to: u.email, subject, html })
          .then(() => {
            emailed++
          })
          .catch(() => undefined)
      }
    }

    await logActivity({
      action: 'bulk-message',
      user: req.user!.id,
      collection: 'nivaro_notifications',
      comment: `${subject} → ${users.length} recipient(s)`,
      req
    })
    return reply.send({ data: { recipients: users.length, emails_sent: emailed } })
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
