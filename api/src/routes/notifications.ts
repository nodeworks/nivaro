import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { builtinAllowed } from '../services/bulk-actions.js'
import { sendRawMail } from '../services/mail.js'
import { parseJsonSafe } from '../services/metric-alerts.js'
import {
  classifyNotification,
  laneFromRow,
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_LABELS,
  type NotificationLane,
  type NotifyCategory,
  notifyUser,
  parseDelivery,
  parseDetail
} from '../services/notification-channels.js'
import {
  actionsFor,
  deriveTarget,
  describeTarget,
  parseStoredTarget,
  resolveTargetUrl
} from '../services/notification-target.js'

// Actual schema (migration 003 + renamed in 012):
// id INT, timestamp datetime, status varchar ('inbox'|'read'),
// recipient uuid FK→nivaro_users, sender uuid|null,
// subject varchar(255), message text|null, collection|null, item|null

function serialize(row: Record<string, unknown>) {
  // Stored target (written by notifyUser) or derived for legacy rows — the
  // client resolves it against ITS routes; `url` below is the server's answer
  // for the recipient's app, the fallback when the client has no route.
  const target =
    parseStoredTarget(row.target) ??
    deriveTarget({
      collection: row.collection as string | null,
      item: row.item as string | null,
      subject: row.subject as string | null
    })
  const category =
    (row.category as NotifyCategory | null) ?? classifyNotification(String(row.subject ?? ''))
  const actions = actionsFor(target, { category })
  const lane =
    (row.lane as NotificationLane | null) ??
    laneFromRow({
      subject: row.subject as string,
      category,
      kind: target?.kind ?? null,
      action: target?.action ?? null,
      actions
    })
  // Rows written before delivery tracking existed: the row IS the in-app
  // delivery, nothing else is known.
  const delivery = parseDelivery(row.delivery) ?? { inapp: { status: 'delivered' } }
  // #77 — every row explains itself. Rows written before `detail` existed
  // (or by writers that stamp none) fall back to the honest default: the
  // recipient's rules for the category are on.
  const detail = parseDetail(row.detail)
  const why = detail?.why ?? {
    kind: row.sender ? 'message' : 'rules',
    text: row.sender
      ? 'Sent to you directly.'
      : `Your notification rules for "${NOTIFY_CATEGORY_LABELS[category] ?? category}" are on.`,
    label: null,
    id: null
  }
  return {
    id: row.id,
    user: row.recipient,
    title: row.subject,
    message: row.message,
    type: 'notification',
    read: row.status !== 'inbox',
    read_at: row.read_at ?? null,
    collection: row.collection,
    item: row.item,
    sender: row.sender ?? null,
    data: null,
    snoozed_until: row.snoozed_until ?? null,
    created_at: row.timestamp,
    target,
    kind: target?.kind ?? null,
    target_label: describeTarget(target),
    category,
    lane,
    delivery,
    detail: detail ? { ...detail, why: undefined } : null,
    why,
    actions,
    url: null as string | null
  }
}

/** Lane filter → SQL. `attention` = the two lanes the badge counts. A NULL
 *  lane (a row written by an old image) counts as needs-you, never silently
 *  FYI — under-counting the badge is the worse failure. */
function applyLane(query: ReturnType<typeof db>, lane: string | undefined) {
  if (!lane) return query
  if (lane === 'attention')
    return query.where((qb) => qb.whereIn('lane', ['critical', 'needs_you']).orWhereNull('lane'))
  if (lane === 'needs_you')
    return query.where((qb) => qb.where('lane', 'needs_you').orWhereNull('lane'))
  if (lane === 'critical' || lane === 'fyi') return query.where('lane', lane)
  return query
}

/** Unread counts per lane + the badge figure (critical + needs you). */
async function laneCounts(userId: string) {
  const rows = (await db('nivaro_notifications')
    .where({ recipient: userId, status: 'inbox' })
    .where((qb) => qb.whereNull('snoozed_until').orWhere('snoozed_until', '<=', new Date()))
    .select(db.raw("COALESCE(lane, 'needs_you') as lane"))
    .count({ count: '*' })
    .groupBy(db.raw("COALESCE(lane, 'needs_you')"))) as Array<{
    lane: string
    count: string | number
  }>
  const lanes = { critical: 0, needs_you: 0, fyi: 0 }
  for (const r of rows) {
    const k = r.lane as keyof typeof lanes
    if (k in lanes) lanes[k] += Number(r.count)
  }
  const unread = lanes.critical + lanes.needs_you + lanes.fyi
  return { unread, attention: lanes.critical + lanes.needs_you, lanes }
}

/** serialize + the URL for the app the caller runs in (`?app=`), else the
 *  recipient's preferred app. */
async function serializeFor(
  row: Record<string, unknown>,
  opts: { recipientUserId: string; app?: 'portal' | 'admin' }
) {
  const out = serialize(row)
  out.url = await resolveTargetUrl(out.target, opts).catch(() => null)
  return out
}

export async function notificationsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET /?page=&limit=&status=all|inbox|read (legacy ?unread=true still honored)
  app.get('/', async (req, reply) => {
    const userId = req.user!.id
    const q = req.query as { unread?: string; page?: string; limit?: string; status?: string }

    const page = Math.max(1, Number(q.page) || 1)
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))

    const qf = req.query as {
      search?: string
      collection?: string
      sender?: string
      snoozed?: string
      lane?: string
      category?: string
    }
    const filtered = () => {
      let query = db('nivaro_notifications').where({ recipient: userId })
      query = applyLane(query, qf.lane)
      if (qf.category && NOTIFY_CATEGORIES.includes(qf.category as NotifyCategory))
        query = query.andWhere({ category: qf.category })
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

    const appQ = (req.query as { app?: string }).app
    const app = appQ === 'portal' || appQ === 'admin' ? appQ : undefined
    // Sender names in one lookup — the rows carry the uuid only.
    const senderIds = [
      ...new Set(
        rows
          .map((r) => r.sender)
          .filter(Boolean)
          .map(String)
      )
    ]
    const senderNames = new Map<string, string>()
    if (senderIds.length > 0) {
      const users = (await db('nivaro_users')
        .whereIn('id', senderIds)
        .select('id', 'first_name', 'last_name', 'email')
        .catch(() => [])) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
      }>
      for (const u of users)
        senderNames.set(
          String(u.id).toUpperCase(),
          `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || ''
        )
    }
    const data = await Promise.all(
      rows.map(async (r) => ({
        ...(await serializeFor(r as Record<string, unknown>, { recipientUserId: userId, app })),
        sender_name: r.sender ? (senderNames.get(String(r.sender).toUpperCase()) ?? null) : null
      }))
    )
    return reply.send({ data, total, page, limit })
  })

  // Unread count + lane split. `attention` is what the badge shows: Critical
  // and Needs-you rows; FYI rows sit in the inbox without pulling the eye.
  app.get('/count', async (req, reply) => reply.send(await laneCounts(req.user!.id)))

  /** #64 — read receipts for what the CALLER sent. One "send" = the rows
   *  sharing a subject within the same minute (message-stakeholders, a
   *  broadcast, a direct message fan out one row per recipient); each
   *  recipient's read state rides along. Critical sends by default — that is
   *  where "did they see it?" matters — `?lane=all` for everything. */
  app.get('/sent', async (req, reply) => {
    const userId = req.user!.id
    const q = req.query as { lane?: string; limit?: string }
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 50))
    let query = db('nivaro_notifications').where({ sender: userId })
    if (q.lane !== 'all') query = query.where('lane', 'critical')
    const rows = (await query
      .orderBy('timestamp', 'desc')
      .limit(2000)
      .select(
        'id',
        'subject',
        'message',
        'timestamp',
        'lane',
        'category',
        'collection',
        'item',
        'recipient',
        'status',
        'read_at'
      )) as Array<Record<string, unknown>>
    type Group = {
      key: string
      subject: string
      message: string | null
      created_at: unknown
      lane: string | null
      category: string | null
      collection: string | null
      item: string | null
      recipients: Array<{ id: string; name: string; read: boolean; read_at: unknown }>
    }
    const groups = new Map<string, Group>()
    for (const r of rows) {
      const minute = new Date(r.timestamp as string).toISOString().slice(0, 16)
      const key = `${String(r.subject)}|${minute}`
      let g = groups.get(key)
      if (!g) {
        if (groups.size >= limit) continue
        g = {
          key,
          subject: String(r.subject),
          message: (r.message as string | null) ?? null,
          created_at: r.timestamp,
          lane: (r.lane as string | null) ?? null,
          category: (r.category as string | null) ?? null,
          collection: (r.collection as string | null) ?? null,
          item: (r.item as string | null) ?? null,
          recipients: []
        }
        groups.set(key, g)
      }
      g.recipients.push({
        id: String(r.recipient),
        name: '',
        read: r.status !== 'inbox',
        read_at: r.read_at ?? null
      })
    }
    const ids = [...new Set([...groups.values()].flatMap((g) => g.recipients.map((x) => x.id)))]
    const names = new Map<string, string>()
    if (ids.length > 0) {
      const users = (await db('nivaro_users')
        .whereIn('id', ids)
        .select('id', 'first_name', 'last_name', 'email')
        .catch(() => [])) as Array<Record<string, unknown>>
      for (const u of users)
        names.set(
          String(u.id).toUpperCase(),
          `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? '')
        )
    }
    const data = [...groups.values()].map((g) => ({
      ...g,
      recipients: g.recipients
        .map((x) => ({ ...x, name: names.get(x.id.toUpperCase()) ?? x.id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      read_count: g.recipients.filter((x) => x.read).length,
      total: g.recipients.length
    }))
    return reply.send({ data })
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
      category?: string
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
      item: body.item,
      category: NOTIFY_CATEGORIES.find((c) => c === body.category)
    })
    return reply.code(201).send({ ok: true })
  })

  // POST /bulk — admin broadcast to a scope-dimension audience:
  // recipients = users whose RESTRICT-mode scope
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
    if (collection && !(await builtinAllowed(collection, 'message', req)))
      return reply.code(403).send({ error: 'Messaging stakeholders is not available to you here' })
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
      .update({ status: 'read', read_at: new Date() })
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
      .update({ status: 'read', read_at: new Date() })
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
      .update({ status: 'read', read_at: new Date() })
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
  app.get('/unread-count', async (req, reply) => reply.send(await laneCounts(req.user!.id)))

  /**
   * Sender analytics (admin): where the noise comes from and whether it is
   * read. Category / kind / sender / collection rollups over the window,
   * read rate + time-to-read (read_at, stamped since delivery tracking), a
   * daily series, per-channel delivery outcomes, and mutes — the "stop
   * telling me about this" signal — per collection against what was sent.
   */
  app.get('/analytics', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { days?: string }
    const days = Math.min(365, Math.max(1, Number(q.days) || 30))
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = (await db('nivaro_notifications')
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(20_000)
      .select(
        'id',
        'timestamp',
        'status',
        'read_at',
        'recipient',
        'sender',
        'subject',
        'collection',
        'kind',
        'category',
        'lane',
        'delivery'
      )) as Array<Record<string, unknown>>

    const bump = <K extends string>(
      m: Map<K, { sent: number; read: number; ttr: number[] }>,
      key: K,
      r: Record<string, unknown>
    ) => {
      const cur = m.get(key) ?? { sent: 0, read: 0, ttr: [] }
      cur.sent++
      if (r.status !== 'inbox') cur.read++
      if (r.read_at && r.timestamp) {
        const mins =
          (new Date(r.read_at as string).getTime() - new Date(r.timestamp as string).getTime()) /
          60_000
        if (Number.isFinite(mins) && mins >= 0) cur.ttr.push(mins)
      }
      m.set(key, cur)
    }
    const byCategory = new Map<string, { sent: number; read: number; ttr: number[] }>()
    const byKind = new Map<string, { sent: number; read: number; ttr: number[] }>()
    const bySender = new Map<string, { sent: number; read: number; ttr: number[] }>()
    const byCollection = new Map<string, { sent: number; read: number; ttr: number[] }>()
    const byLane = new Map<string, { sent: number; read: number; ttr: number[] }>()
    const byDay = new Map<string, { sent: number; read: number }>()
    const channels = {
      inapp: { delivered: 0, skipped: 0 },
      push: { sent: 0, no_subscription: 0, skipped: 0, failed: 0 },
      email: {
        sent: 0,
        deferred: 0,
        dropped: 0,
        failed: 0,
        off: 0,
        no_address: 0,
        not_requested: 0
      },
      sms: { sent: 0, failed: 0, skipped: 0, not_requested: 0 }
    }
    const allTtr: number[] = []
    let readTotal = 0
    for (const r of rows) {
      const category =
        (r.category as string | null) ?? classifyNotification(String(r.subject ?? ''))
      bump(byCategory, category, r)
      bump(byKind, (r.kind as string | null) ?? 'record', r)
      bump(bySender, (r.sender as string | null) ?? '__system__', r)
      bump(byCollection, (r.collection as string | null) ?? '(none)', r)
      bump(byLane, (r.lane as string | null) ?? 'fyi', r)
      const day = new Date(r.timestamp as string).toISOString().slice(0, 10)
      const d = byDay.get(day) ?? { sent: 0, read: 0 }
      d.sent++
      if (r.status !== 'inbox') {
        d.read++
        readTotal++
      }
      byDay.set(day, d)
      if (r.read_at && r.timestamp) {
        const mins =
          (new Date(r.read_at as string).getTime() - new Date(r.timestamp as string).getTime()) /
          60_000
        if (Number.isFinite(mins) && mins >= 0) allTtr.push(mins)
      }
      const dv = parseDelivery(r.delivery)
      if (dv) {
        const bucket = (obj: Record<string, number>, k: string | undefined) => {
          if (k && k in obj) obj[k]++
        }
        bucket(channels.inapp as Record<string, number>, dv.inapp?.status)
        bucket(channels.push as Record<string, number>, dv.push?.status)
        bucket(channels.email as Record<string, number>, dv.email?.status)
        bucket(channels.sms as Record<string, number>, dv.sms?.status)
      }
    }
    const median = (xs: number[]) => {
      if (xs.length === 0) return null
      const s = [...xs].sort((a, b) => a - b)
      return s[Math.floor(s.length / 2)]
    }
    const roll = (m: Map<string, { sent: number; read: number; ttr: number[] }>) =>
      [...m.entries()]
        .map(([key, v]) => ({
          key,
          sent: v.sent,
          read: v.read,
          read_rate: v.sent ? v.read / v.sent : 0,
          median_minutes_to_read: median(v.ttr)
        }))
        .sort((a, b) => b.sent - a.sent)

    // Senders: resolve names for the top rows (null sender = the system).
    const senders = roll(bySender).slice(0, 15)
    const senderIds = senders.map((s) => s.key).filter((k) => k !== '__system__')
    const names = new Map<string, string>()
    if (senderIds.length > 0) {
      const users = (await db('nivaro_users')
        .whereIn('id', senderIds)
        .select('id', 'first_name', 'last_name', 'email')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
      }>
      for (const u of users)
        names.set(
          String(u.id).toUpperCase(),
          `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || String(u.id)
        )
    }
    const senderRows = senders.map((s) => ({
      ...s,
      label:
        s.key === '__system__' ? 'System / automations' : (names.get(s.key.toUpperCase()) ?? s.key)
    }))

    // Mutes: per collection, against what that collection sent — the
    // "stop telling me" rate.
    let mutes: Array<{ collection: string; mutes: number; sent: number; mute_rate: number }> = []
    let muteTotal = 0
    let mutingUsers = 0
    try {
      const muteRows = (await db('nivaro_notification_mutes')
        .select('collection')
        .count({ count: '*' })
        .groupBy('collection')) as Array<{ collection: string; count: string | number }>
      const mu = (await db('nivaro_notification_mutes').countDistinct({ count: 'user' }).first()) as
        | { count: string | number }
        | undefined
      mutingUsers = Number(mu?.count ?? 0)
      mutes = muteRows
        .map((m) => {
          const sent = byCollection.get(m.collection)?.sent ?? 0
          muteTotal += Number(m.count)
          return {
            collection: m.collection,
            mutes: Number(m.count),
            sent,
            mute_rate: sent ? Number(m.count) / sent : 0
          }
        })
        .sort((a, b) => b.mutes - a.mutes)
        .slice(0, 15)
    } catch {
      mutes = []
    }
    const activeUsers = (await db('nivaro_users')
      .where({ status: 'active' })
      .count({ count: '*' })
      .first()) as { count: string | number } | undefined

    const series = [...byDay.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.day.localeCompare(b.day))
    return reply.send({
      data: {
        days,
        total: rows.length,
        read: readTotal,
        read_rate: rows.length ? readTotal / rows.length : 0,
        median_minutes_to_read: median(allTtr),
        truncated: rows.length >= 20_000,
        by_category: roll(byCategory).map((r) => ({
          ...r,
          label: NOTIFY_CATEGORY_LABELS[r.key as NotifyCategory] ?? r.key
        })),
        by_kind: roll(byKind),
        by_lane: roll(byLane),
        by_sender: senderRows,
        by_collection: roll(byCollection).slice(0, 20),
        series,
        channels,
        mutes: {
          total: muteTotal,
          muting_users: mutingUsers,
          active_users: Number(activeUsers?.count ?? 0),
          top: mutes
        }
      }
    })
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
