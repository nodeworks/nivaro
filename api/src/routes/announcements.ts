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

/** One audience group: ANDed scope conditions ({division: [2], project_type: [35]}
 *  = "Zone 2 AND Node Splits"). Multiple groups OR together. */
type AudienceGroup = Record<string, Array<string | number>>

interface Audience {
  roles?: string[]
  groups?: AudienceGroup[]
  /** Legacy single-dimension form — normalized into one group. */
  dimension?: string
  values?: Array<string | number>
  user_ids?: string[]
}

function normalizeGroups(aud: Audience): AudienceGroup[] {
  const groups = (Array.isArray(aud.groups) ? aud.groups : [])
    .map((g) => {
      const out: AudienceGroup = {}
      for (const [k, v] of Object.entries(g ?? {})) {
        if (typeof k === 'string' && k && Array.isArray(v) && v.length > 0) out[k] = v
      }
      return out
    })
    .filter((g) => Object.keys(g).length > 0)
  if (groups.length === 0 && aud.dimension && aud.values?.length) {
    groups.push({ [aud.dimension]: aud.values })
  }
  return groups
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
async function resolveAudienceUsers(aud: Audience): Promise<
  Array<{
    id: string
    email: string | null
    phone: string | null
    first_name: string | null
    last_name: string | null
  }>
> {
  const explicit = new Set<string>((aud.user_ids ?? []).map(String))
  const groups = normalizeGroups(aud)

  // The referenced dimensions' restrict scopes, loaded once: user -> dim -> ids.
  let scopeByUser: Map<string, Map<string, Set<string>>> | null = null
  if (groups.length > 0) {
    scopeByUser = new Map()
    const dims = [...new Set(groups.flatMap((g) => Object.keys(g)))]
    const rows = (await db('nivaro_user_scopes')
      .whereIn('dimension', dims)
      .where('mode', 'restrict')
      .select('user', 'dimension', 'values')) as Array<{
      user: string
      dimension: string
      values: string | null
    }>
    for (const row of rows) {
      const uid = String(row.user)
      const byDim = scopeByUser.get(uid) ?? new Map<string, Set<string>>()
      byDim.set(
        row.dimension,
        new Set((parseJsonSafe<Array<string | number>>(row.values) ?? []).map(String))
      )
      scopeByUser.set(uid, byDim)
    }
  }
  // A group matches when EVERY condition in it intersects the user's scope;
  // groups OR. Send channels require actual scope membership on each named
  // dimension (an unrestricted user is out -- same as the old single-dim form).
  const matchesGroups = (id: string): boolean =>
    groups.some((g) =>
      Object.entries(g).every(([dim, vals]) => {
        const mine = scopeByUser?.get(id)?.get(dim)
        if (!mine) return false
        return vals.some((v) => mine.has(String(v)))
      })
    )

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

  const all = (await db('nivaro_users')
    .where({ status: 'active', is_redacted: false })
    .select('id', 'email', 'phone', 'first_name', 'last_name')) as Array<{
    id: string
    email: string | null
    phone: string | null
    first_name: string | null
    last_name: string | null
  }>
  // One pass over the unique user list: a user matching several groups still
  // appears exactly once, so multi-group audiences never double-send.
  return all.filter((u) => {
    const id = String(u.id)
    if (explicit.has(id)) return true
    if (groups.length === 0 && roleUsers === null && explicit.size > 0) return false
    if (groups.length > 0 && !matchesGroups(id)) return false
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

/** Human-readable "who this went to" per broadcast, labels resolved in batch:
 *  scope values via each dimension's target collection, roles via nivaro_roles,
 *  explicit users by name. */
async function buildAudienceSummaries(
  rows: Array<Record<string, unknown>>
): Promise<Map<number, string>> {
  const parsed = rows.map((r) => ({
    id: Number(r.id),
    aud: parseJsonSafe<Audience>(r.audience) ?? {},
    roles: parseJsonSafe<string[]>(r.roles) ?? []
  }))

  // Collect every referenced dimension value, role id, and user id.
  const valueIdsByDim = new Map<string, Set<string>>()
  const roleIds = new Set<string>()
  const userIds = new Set<string>()
  for (const p of parsed) {
    for (const g of normalizeGroups(p.aud)) {
      for (const [dim, vals] of Object.entries(g)) {
        const set = valueIdsByDim.get(dim) ?? new Set<string>()
        for (const v of vals) set.add(String(v))
        valueIdsByDim.set(dim, set)
      }
    }
    for (const rid of p.roles) roleIds.add(String(rid))
    for (const uid of p.aud.user_ids ?? []) userIds.add(String(uid))
  }

  const dims = valueIdsByDim.size
    ? ((await db('nivaro_scope_dimensions')
        .whereIn('name', [...valueIdsByDim.keys()])
        .select('name', 'label', 'target_collection', 'display_field')) as Array<{
        name: string
        label: string
        target_collection: string
        display_field: string | null
      }>)
    : []
  const valueLabels = new Map<string, string>() // `${dim}:${id}` -> label
  for (const d of dims) {
    const ids = [...(valueIdsByDim.get(d.name) ?? [])]
    if (ids.length === 0) continue
    try {
      const opts = (await db(d.target_collection)
        .whereIn('id', ids)
        .select('id', `${d.display_field || 'name'} as label`)) as Array<{
        id: unknown
        label: unknown
      }>
      for (const o of opts) valueLabels.set(`${d.name}:${String(o.id)}`, String(o.label ?? o.id))
    } catch {
      // renamed collection/column — raw ids still render
    }
  }
  const dimLabel = new Map(dims.map((d) => [d.name, d.label]))

  const roleNames = new Map<string, string>()
  if (roleIds.size) {
    const rs = (await db('nivaro_roles')
      .whereIn('id', [...roleIds])
      .select('id', 'name')) as Array<{ id: string; name: string }>
    for (const r of rs) roleNames.set(String(r.id).toLowerCase(), r.name)
  }
  const userNames = new Map<string, string>()
  if (userIds.size) {
    const us = (await db('nivaro_users')
      .whereIn('id', [...userIds])
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
    for (const u of us) {
      userNames.set(
        String(u.id),
        `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? u.id)
      )
    }
  }

  const out = new Map<number, string>()
  for (const p of parsed) {
    const parts: string[] = []
    const groups = normalizeGroups(p.aud)
    if (groups.length > 0) {
      parts.push(
        groups
          .map((g) =>
            Object.entries(g)
              .map(([dim, vals]) => {
                const labels = vals.map((v) => valueLabels.get(`${dim}:${String(v)}`) ?? String(v))
                return `${dimLabel.get(dim) ?? dim}: ${labels.join(', ')}`
              })
              .join(' + ')
          )
          .join('  —or—  ')
      )
    }
    if (p.roles.length > 0) {
      parts.push(
        `roles: ${p.roles.map((rid) => roleNames.get(String(rid).toLowerCase()) ?? rid).join(', ')}`
      )
    }
    const uids = p.aud.user_ids ?? []
    if (uids.length > 0) {
      const names = uids.slice(0, 3).map((uid) => userNames.get(String(uid)) ?? String(uid))
      parts.push(uids.length > 3 ? `${names.join(', ')} +${uids.length - 3} more` : names.join(', '))
    }
    out.set(p.id, parts.length > 0 ? parts.join(' · ') : 'Everyone')
  }
  return out
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
      const groups = normalizeGroups(aud)
      if (groups.length > 0) {
        // A group admits the viewer when every condition passes; a viewer
        // UNRESTRICTED on a dimension passes that condition (they can see the
        // data, so they should see the notice about it).
        const passes = groups.some((g) =>
          Object.entries(g).every(([dim, vals]) => {
            const mine = myScopeValues.get(dim)
            if (!mine) return true
            return vals.some((v) => mine.has(String(v)))
          })
        )
        if (!passes) return false
      }
      return true
    })
    const data = visible.map((r) => ({
      id: r.id as number,
      message: r.message,
      subject: r.subject,
      severity: r.severity,
      ends_at: r.ends_at,
      dismissable: true,
      require_ack: !!r.require_ack
    }))
    // Maintenance mode rides the same banner surface — synthetic row, not
    // dismissable (acking it would make the freeze invisible while it holds).
    const { maintenanceState } = await import('../services/security.js')
    const maint = await maintenanceState()
    if (maint.on) {
      data.unshift({
        id: -1,
        message:
          maint.message || 'Maintenance in progress — changes are temporarily disabled.',
        subject: 'Maintenance',
        severity: 'critical',
        ends_at: null,
        dismissable: false,
        require_ack: false
      })
    }
    return { data }
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
    const summaries = await buildAudienceSummaries(rows as Array<Record<string, unknown>>)
    return {
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        roles: parseJsonSafe<string[]>(r.roles),
        channels: parseJsonSafe<Channel[]>(r.channels) ?? ['banner'],
        audience: parseJsonSafe<Audience>(r.audience),
        audience_summary: summaries.get(Number(r.id)) ?? 'Everyone',
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
      require_ack?: boolean
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
      groups: Array.isArray(b.audience?.groups) ? b.audience?.groups : undefined,
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
        // Must-acknowledge (#90): only meaningful on banner rows — the ack IS
        // the dismissal, it just can't be ignored.
        require_ack: !!b.require_ack && channels.includes('banner'),
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
      // Per-user, per-channel receipts — "who got what and when" is the
      // history's whole value, so every outcome (incl. no-address skips) is
      // a row, not just a counter.
      const receipts: Array<{
        announcement: number
        user: string
        channel: string
        status: 'sent' | 'failed' | 'skipped'
        delivered_at: Date
      }> = []
      const record = (userId: string, channel: string, status: 'sent' | 'failed' | 'skipped') =>
        receipts.push({
          announcement: Number(id),
          user: userId,
          channel,
          status,
          delivered_at: new Date()
        })
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
              record(u.id, 'message', 'sent')
            })
            .catch(() => record(u.id, 'message', 'failed'))
        }
        if (channels.includes('email')) {
          if (!u.email) record(u.id, 'email', 'skipped')
          else {
            await sendRawMail({ to: u.email, subject, html })
              .then(() => {
                reached = true
                record(u.id, 'email', 'sent')
              })
              .catch(() => record(u.id, 'email', 'failed'))
          }
        }
        if (channels.includes('sms')) {
          if (!u.phone) record(u.id, 'sms', 'skipped')
          else {
            await sendSms(String(u.phone), `${subject}: ${message}`.slice(0, 500))
              .then(() => {
                reached = true
                record(u.id, 'sms', 'sent')
              })
              .catch(() => record(u.id, 'sms', 'failed'))
          }
        }
        if (reached) delivered++
      }
      for (let i = 0; i < receipts.length; i += 300) {
        await db('nivaro_announcement_deliveries')
          .insert(receipts.slice(i, i + 300))
          .catch(() => {})
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

  /** Live audience resolution for the compose form: how many unique people a
   *  (partial or full) audience reaches, and who they are. Same resolver as
   *  the real send, so the number can't lie. */
  app.post('/preview-audience', { preHandler: requireAdmin }, async (req) => {
    const b = req.body as { audience?: Audience }
    const users = await resolveAudienceUsers(b.audience ?? {})
    const named = users
      .map((u) => ({
        id: u.id,
        name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || u.id,
        email: u.email
      }))
      .sort((a, z) => a.name.localeCompare(z.name))
    return {
      data: {
        count: users.length,
        users: named.slice(0, 2000),
        truncated: users.length > 2000
      }
    }
  })

  /** Who saw / received what, and when: banner dismissals (acks) + every
   *  send-channel outcome per user. */
  app.get<{ Params: { id: string } }>(
    '/:id/receipts',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_announcements').where('id', req.params.id).first('id')
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const [acks, deliveries] = await Promise.all([
        db('nivaro_announcement_acks as a')
          .leftJoin('nivaro_users as u', 'u.id', 'a.user')
          .where('a.announcement', row.id)
          .orderBy('a.acked_at', 'desc')
          .select(
            'a.acked_at',
            db.raw(
              "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
            ),
            'u.email as user_email'
          ),
        db('nivaro_announcement_deliveries as d')
          .leftJoin('nivaro_users as u', 'u.id', 'd.user')
          .where('d.announcement', row.id)
          .orderBy('d.id', 'asc')
          .select(
            'd.channel',
            'd.status',
            'd.delivered_at',
            db.raw(
              "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
            ),
            'u.email as user_email'
          )
      ])
      return { data: { acks, deliveries } }
    }
  )

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
