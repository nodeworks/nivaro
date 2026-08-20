import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { notifyUser } from '../services/notification-channels.js'
import { sendRawMail } from '../services/mail.js'
import { sendSms } from '../services/sms.js'

/**
 * Broadcasts — admin-authored messages to a chosen audience over any mix of
 * channels: an in-app BANNER (persistent until dismissed/expired), an in-app
 * inbox MESSAGE, EMAIL, and SMS (offered only when a provider is configured).
 * The audience is roles, scope-dimension values (the Bulk Message zones
 * model), explicit users, or everyone. Delivery channels resolve recipients
 * at SEND time; the banner filters its viewers at READ time with the same
 * audience rules, so someone who joins Zone 1 tomorrow still sees a live
 * Zone-1 banner.
 */

const CHANNELS = ['banner', 'message', 'email', 'sms'] as const
type Channel = (typeof CHANNELS)[number]

interface Audience {
  roles?: string[]
  dimension?: string
  values?: Array<string | number>
  user_ids?: string[]
}

function parseJsonSafe<T>(raw: unknown): T | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

/** Resolve the concrete users an audience means, for send-time channels.
 *  Empty audience = every active user. */
async function resolveAudienceUsers(
  aud: Audience
): Promise<Array<{ id: string; email: string | null; phone: string | null }>> {
  const explicit = new Set<string>((aud.user_ids ?? []).map(String))
  let scoped: Set<string> | null = null
  if (aud.dimension && aud.values?.length) {
    scoped = new Set<string>()
    const wanted = new Set(aud.values.map(String))
    const rows = (await db('nivaro_user_scopes')
      .where({ dimension: aud.dimension, mode: 'restrict' })
      .select('user', 'values')) as Array<{ user: string; values: string | null }>
    for (const row of rows) {
      const vals = parseJsonSafe<Array<string | number>>(row.values) ?? []
      if (vals.some((v) => wanted.has(String(v)))) scoped.add(String(row.user))
    }
  }
  let roleUsers: Set<string> | null = null
  if (aud.roles?.length) {
    roleUsers = new Set(
      (
        (await db('nivaro_users')
          .whereIn('role', aud.roles)
          .select('id')) as Array<{ id: string }>
      ).map((r) => String(r.id))
    )
  }

  const q = db('nivaro_users')
    .where({ status: 'active', is_redacted: false })
    .select('id', 'email', 'phone')
  const all = (await q) as Array<{ id: string; email: string | null; phone: string | null }>
  return all.filter((u) => {
    const id = String(u.id)
    // Explicit users are always in; otherwise every configured constraint
    // must admit them; no constraints at all = everyone.
    if (explicit.has(id)) return true
    if (scoped === null && roleUsers === null && explicit.size > 0) return false
    if (scoped !== null && !scoped.has(id)) return false
    if (roleUsers !== null && !roleUsers.has(id)) return false
    return true
  })
}

async function smsConfigured(): Promise<boolean> {
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('sms_provider')) as
      | { sms_provider?: string | null }
      | undefined
    return !!row?.sms_provider
  } catch {
    return false
  }
}

export async function announcementRoutes(app: FastifyInstance): Promise<void> {
  /** What the compose form can offer on this instance. */
  app.get('/config', { preHandler: requireAdmin }, async () => {
    return { data: { sms_enabled: await smsConfigured() } }
  })

  /** Active banners for the current user — window, role, scope-dimension and
   *  explicit-user filtered, minus anything they already dismissed. */
  app.get('/active', { preHandler: requireAuth }, async (req) => {
    const now = new Date()
    const rows = (await db('nivaro_announcements')
      .where('is_active', true)
      .where((qb) => qb.whereNull('starts_at').orWhere('starts_at', '<=', now))
      .where((qb) => qb.whereNull('ends_at').orWhere('ends_at', '>=', now))
      .orderBy('id', 'desc')) as Array<Record<string, unknown>>
    const acked = new Set(
      (
        (await db('nivaro_announcement_acks')
          .where('user', req.user?.id ?? '')
          .select('announcement')) as Array<{ announcement: number }>
      ).map((a) => a.announcement)
    )
    const userId = String(req.user?.id ?? '')
    const userRole = String(req.user?.role ?? '').toLowerCase()
    // The viewer's restrict scopes, loaded once, for dimension-targeted banners.
    const myScopes = (await db('nivaro_user_scopes')
      .where({ user: userId, mode: 'restrict' })
      .select('dimension', 'values')) as Array<{ dimension: string; values: string | null }>
    const myScopeValues = new Map<string, Set<string>>()
    for (const s of myScopes) {
      myScopeValues.set(
        s.dimension,
        new Set((parseJsonSafe<Array<string | number>>(s.values) ?? []).map(String))
      )
    }

    const visible = rows.filter((r) => {
      if (acked.has(Number(r.id))) return false
      const channels = parseJsonSafe<Channel[]>(r.channels)
      // Rows sent without the banner channel are inbox/email history only.
      if (channels && !channels.includes('banner')) return false
      const roles = parseJsonSafe<string[]>(r.roles)
      const aud = parseJsonSafe<Audience>(r.audience) ?? {}
      if (aud.user_ids?.length && aud.user_ids.map(String).includes(userId)) return true
      if (roles && !roles.some((x) => x.toLowerCase() === userRole)) return false
      if (aud.dimension && aud.values?.length) {
        const mine = myScopeValues.get(aud.dimension)
        // Unrestricted-on-that-dimension viewers see dimension-wide banners:
        // they can see the data, so they should see the notice about it.
        if (mine && !aud.values.some((v) => mine.has(String(v)))) return false
      }
      return true
    })
    return {
      data: visible.map((r) => ({
        id: r.id,
        message: r.message,
        subject: r.subject,
        severity: r.severity,
        ends_at: r.ends_at
      }))
    }
  })

  app.post<{ Params: { id: string } }>(
    '/:id/ack',
    { preHandler: requireAuth },
    async (req, reply) => {
      const row = await db('nivaro_announcements').where('id', req.params.id).first('id')
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const exists = await db('nivaro_announcement_acks')
        .where({ announcement: row.id, user: req.user!.id })
        .first('id')
      if (!exists) {
        await db('nivaro_announcement_acks')
          .insert({ announcement: row.id, user: req.user!.id, acked_at: new Date() })
          .catch(() => {}) // ack races are harmless
      }
      return { data: { acked: true } }
    }
  )

  // ── Admin: list / send / manage ───────────────────────────────────────────
  app.get('/', { preHandler: requireAdmin }, async () => {
    const rows = await db('nivaro_announcements').orderBy('id', 'desc').limit(100)
    const ackCounts = (await db('nivaro_announcement_acks')
      .groupBy('announcement')
      .count({ c: '*' })
      .select('announcement')) as Array<{ announcement: number; c: number }>
    const ackMap = new Map(ackCounts.map((a) => [Number(a.announcement), Number(a.c)]))
    return {
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        roles: parseJsonSafe<string[]>(r.roles),
        channels: parseJsonSafe<Channel[]>(r.channels) ?? ['banner'],
        audience: parseJsonSafe<Audience>(r.audience),
        ack_count: ackMap.get(Number(r.id)) ?? 0
      }))
    }
  })

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as {
      subject?: string
      message?: string
      severity?: string
      channels?: Channel[]
      audience?: Audience
      starts_at?: string
      ends_at?: string
    }
    const message = String(b.message ?? '').trim()
    if (!message) return reply.code(400).send({ error: 'message is required' })
    const channels = (Array.isArray(b.channels) ? b.channels : ['banner']).filter(
      (c): c is Channel => (CHANNELS as readonly string[]).includes(String(c))
    )
    if (channels.length === 0) {
      return reply.code(400).send({ error: 'Pick at least one channel' })
    }
    if (channels.includes('sms') && !(await smsConfigured())) {
      return reply.code(400).send({ error: 'SMS is not configured on this instance' })
    }
    const subject = String(b.subject ?? '').trim() || message.slice(0, 120)
    const aud: Audience = {
      roles: Array.isArray(b.audience?.roles) ? b.audience?.roles : undefined,
      dimension: b.audience?.dimension || undefined,
      values: Array.isArray(b.audience?.values) ? b.audience?.values : undefined,
      user_ids: Array.isArray(b.audience?.user_ids) ? b.audience?.user_ids : undefined
    }

    const [inserted] = await db('nivaro_announcements')
      .insert({
        subject: subject.slice(0, 500),
        message,
        severity: ['info', 'warn', 'critical'].includes(String(b.severity)) ? b.severity : 'info',
        roles: aud.roles?.length ? JSON.stringify(aud.roles) : null,
        channels: JSON.stringify(channels),
        audience: JSON.stringify(aud),
        starts_at: b.starts_at ? new Date(String(b.starts_at)) : null,
        ends_at: b.ends_at ? new Date(String(b.ends_at)) : null,
        // Only banner rows stay "active" — send-only broadcasts are history.
        is_active: channels.includes('banner'),
        created_by: req.user?.id ?? null,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted

    // ── Send-time channels ────────────────────────────────────────────────
    let delivered = 0
    const needsSend = channels.some((c) => c !== 'banner')
    if (needsSend) {
      const users = await resolveAudienceUsers(aud)
      const html = `<p style="margin:0 0 12px;white-space:pre-wrap;">${message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')}</p>`
      for (const u of users) {
        let reached = false
        if (channels.includes('message')) {
          await notifyUser(app, u.id, {
            subject,
            message: message.slice(0, 500),
            sender: req.user!.id
          })
            .then(() => {
              reached = true
            })
            .catch(() => {})
        }
        if (channels.includes('email') && u.email) {
          await sendRawMail({ to: u.email, subject, html })
            .then(() => {
              reached = true
            })
            .catch(() => {})
        }
        if (channels.includes('sms') && u.phone) {
          await sendSms(String(u.phone), `${subject}: ${message}`.slice(0, 500))
            .then(() => {
              reached = true
            })
            .catch(() => {})
        }
        if (reached) delivered++
      }
      await db('nivaro_announcements').where('id', id).update({ delivered_count: delivered })
    }

    await logActivity({
      action: 'announcement-create',
      user: req.user?.id,
      collection: 'nivaro_announcements',
      item: String(id),
      comment: `${channels.join('+')} · ${subject.slice(0, 100)}`,
      req
    })
    return reply.code(201).send({ data: { id, delivered } })
  })

  app.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const row = await db('nivaro_announcements').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (b.message !== undefined) patch.message = String(b.message)
    if (b.severity !== undefined && ['info', 'warn', 'critical'].includes(String(b.severity))) {
      patch.severity = b.severity
    }
    if (b.ends_at !== undefined) patch.ends_at = b.ends_at ? new Date(String(b.ends_at)) : null
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    await db('nivaro_announcements').where('id', row.id).update(patch)
    await logActivity({
      action: 'announcement-update',
      user: req.user?.id,
      collection: 'nivaro_announcements',
      item: String(row.id),
      req
    })
    return { data: { id: row.id } }
  })

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const row = await db('nivaro_announcements').where('id', req.params.id).first('id')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_announcements').where('id', row.id).del()
    await logActivity({
      action: 'announcement-delete',
      user: req.user?.id,
      collection: 'nivaro_announcements',
      item: String(row.id),
      req
    })
    return { data: { deleted: true } }
  })
}
