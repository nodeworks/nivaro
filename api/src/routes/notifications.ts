import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { sendRawMail } from '../services/mail.js'
import { parseJsonSafe } from '../services/metric-alerts.js'
import { notifyUser } from '../services/notification-channels.js'

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
    snoozed_until: row.snoozed_until ?? null,
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

    const qf = req.query as { search?: string; collection?: string; sender?: string; snoozed?: string }
    const filtered = () => {
      let query = db('nivaro_notifications').where({ recipient: userId })
      if (q.status === 'inbox' || q.unread === 'true') query = query.andWhere({ status: 'inbox' })
      else if (q.status === 'read') query = query.andWhere({ status: 'read' })
      // Snoozed rows hide from the normal views until they wake; ?snoozed=true
      // lists exactly the sleeping ones instead.
      if (qf.snoozed === 'true') {
        query = query.where('snoozed_until', '>', new Date())
      } else {
        query = query.where((qb) =>
          qb.whereNull('snoozed_until').orWhere('snoozed_until', '<=', new Date())
        )
      }
      if (qf.collection) query = query.andWhere({ collection: qf.collection })
      if (qf.sender) query = query.andWhere({ sender: qf.sender })
      if (qf.search) {
        const like = `%${qf.search.replace(/[%_[]/g, (c) => `[${c}]`)}%`
        query = query.where((qb) =>
          qb.where('subject', 'like', like).orWhere('message', 'like', like)
        )
      }
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
      .where((qb) => qb.whereNull('snoozed_until').orWhere('snoozed_until', '<=', new Date()))
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

  /**
   * Message the stakeholders of a record selection (#51): resolves current
   * pipeline owners and/or record creators for the picked ids, dedupes across
   * records, and delivers in-app (+ optional email, mail-test-mode safe).
   * Gated on read permission for the collection — you can only message about
   * records you could open yourself. Sender is excluded from the audience.
   */
  app.post('/message-stakeholders', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body as {
      collection?: string
      ids?: Array<string | number>
      subject?: string
      message?: string
      include?: { owners?: boolean; creators?: boolean }
      email?: boolean
      preview?: boolean
    }
    const collection = String(b.collection ?? '')
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean).slice(0, 200)
    const subject = String(b.subject ?? '').trim()
    const message = String(b.message ?? '').trim()
    if (!/^[A-Za-z0-9_]+$/.test(collection) || /^nivaro_/i.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    if (ids.length === 0) return reply.code(400).send({ error: 'ids is required' })
    if (!b.preview && (!subject || !message)) {
      return reply.code(400).send({ error: 'subject and message are required' })
    }
    const { can } = await import('../services/permissions.js')
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const wantOwners = b.include?.owners !== false
    const wantCreators = b.include?.creators !== false
    const audience = new Set<string>()

    if (wantOwners) {
      const instances = (await db('nivaro_workflow_instances')
        .where({ collection })
        .whereIn('item', ids)
        .whereNull('completed_at')
        .select('id', 'item', 'current_state', 'collection')) as Array<Record<string, unknown>>
      if (instances.length > 0) {
        const { resolveStateOwnersBatch } = await import('../services/pipeline-engine.js')
        const ownersByKey = await resolveStateOwnersBatch(
          instances.map((i) => ({
            key: String(i.item),
            stateId: String(i.current_state),
            instanceId: String(i.id),
            collection,
            itemId: String(i.item)
          }))
        )
        for (const owners of ownersByKey.values()) {
          for (const o of owners as Array<{ id: unknown }>) audience.add(String(o.id))
        }
      }
    }
    if (wantCreators) {
      // Creator column varies by collection (workflows: creator; most others:
      // user_created) — take whichever physically exists.
      const cols = (await db('information_schema.columns' as never)
        .where({ table_name: collection })
        .whereIn('column_name', ['user_created', 'creator'])
        .select('column_name')) as Array<{ column_name: string }>
      for (const c of cols) {
        const rows = (await db(collection)
          .whereIn('id', ids)
          .whereNotNull(c.column_name)
          .distinct(c.column_name)) as Array<Record<string, unknown>>
        for (const r of rows) audience.add(String(r[c.column_name]))
      }
    }
    audience.delete(String(req.user!.id))

    const users = audience.size
      ? ((await db('nivaro_users')
          .whereIn('id', [...audience])
          .where('is_redacted', 0)
          .where((qb) => qb.whereNull('status').orWhereNot('status', 'suspended'))
          .select('id', 'first_name', 'last_name', 'email')) as Array<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string | null
        }>)
      : []

    if (b.preview) {
      return {
        data: {
          count: users.length,
          users: users
            .map((u) => ({
              id: u.id,
              name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email
            }))
            .sort((a, z) => String(a.name).localeCompare(String(z.name)))
        }
      }
    }

    let sent = 0
    for (const u of users) {
      await notifyUser(app, u.id, {
        subject,
        message,
        sender: req.user!.id,
        collection,
        item: ids.length === 1 ? ids[0] : null
      }).catch(() => {})
      if (b.email && u.email) {
        await sendRawMail({
          to: u.email,
          subject,
          html: `<p>${message.replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p><p style="color:#64748b;font-size:12px">Sent about ${ids.length} ${collection} record(s).</p>`
        }).catch(() => {})
      }
      sent++
    }
    await logActivity({
      action: 'message-stakeholders',
      user: req.user?.id,
      collection,
      comment: `${sent} recipient(s) across ${ids.length} record(s): ${subject}`.slice(0, 300),
      req
    })
    return { data: { sent, records: ids.length } }
  })

  /** Snooze: hide from the inbox until `until`, then resurface UNREAD. Own
   *  rows only. `until: null` unsnoozes immediately. */
  // Record mute (#401): own-row toggle — GET reports state, POST toggles.
  app.get('/mutes/:collection/:item', async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }
    const row = await db('nivaro_notification_mutes')
      .where({ user: req.user!.id, collection, item })
      .first('id')
    return reply.send({ data: { muted: !!row } })
  })
  app.post('/mutes/:collection/:item/toggle', async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || /^nivaro_/i.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const existing = await db('nivaro_notification_mutes')
      .where({ user: req.user!.id, collection, item })
      .first('id')
    if (existing) {
      await db('nivaro_notification_mutes').where({ id: existing.id }).del()
      return reply.send({ data: { muted: false } })
    }
    try {
      await db('nivaro_notification_mutes').insert({
        user: req.user!.id,
        collection,
        item,
        created_at: new Date()
      })
    } catch {
      // unique race — the mute exists, which is the requested state
    }
    return reply.send({ data: { muted: true } })
  })

  app.post('/:id/snooze', async (req, reply) => {
    const b = req.body as { until?: string | null }
    const until = b.until == null ? null : new Date(String(b.until))
    if (until !== null && (Number.isNaN(until.getTime()) || until <= new Date())) {
      return reply.code(400).send({ error: 'until must be a future timestamp (or null to wake)' })
    }
    const updated = await db('nivaro_notifications')
      .where({ id: req.params && (req.params as { id: string }).id, recipient: req.user!.id })
      .update({ snoozed_until: until, status: 'inbox' })
    if (updated === 0) return reply.code(404).send({ error: 'Notification not found' })
    return { data: { snoozed_until: until } }
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

  // Batch mark-read — the bell's per-record groups mark several rows in one
  // call. Own rows only; foreign ids are silently ignored by the WHERE.
  app.post<{ Body: { ids?: Array<string | number> } }>('/mark-read', async (req, reply) => {
    const ids = (req.body?.ids ?? []).filter((i) => i != null).slice(0, 200)
    if (ids.length === 0) return reply.send({ data: { updated: 0 } })
    const updated = await db('nivaro_notifications')
      .whereIn('id', ids)
      .where({ recipient: req.user!.id, status: 'inbox' })
      .update({ status: 'read' })
    // Consistency with the sibling read endpoints, which all log.
    if (updated > 0) {
      void logActivity({
        action: 'notification-read',
        user: req.user!.id,
        collection: 'nivaro_notifications',
        comment: `batch mark-read (${updated})`,
        req
      })
    }
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
