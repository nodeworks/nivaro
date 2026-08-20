import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Announcement banners — admin-authored, role-targeted, time-windowed
 * messages shown at the top of every app ("maintenance Friday 6pm").
 * Dismissing acknowledges: the banner stays gone for that user, and admins
 * can see who has seen what.
 */

function parseRoles(raw: unknown): string[] | null {
  if (!raw) return null
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) && v.length > 0 ? v.map(String) : null
  } catch {
    return null
  }
}

export async function announcementRoutes(app: FastifyInstance): Promise<void> {
  /** Active banners for the current user — window + role filtered, minus
   *  anything they already dismissed. */
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
    const userRole = String(req.user?.role ?? '').toLowerCase()
    const visible = rows.filter((r) => {
      if (acked.has(Number(r.id))) return false
      const roles = parseRoles(r.roles)
      return !roles || roles.some((x) => x.toLowerCase() === userRole)
    })
    return {
      data: visible.map((r) => ({
        id: r.id,
        message: r.message,
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

  // ── Admin management ──────────────────────────────────────────────────────
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
        roles: parseRoles(r.roles),
        ack_count: ackMap.get(Number(r.id)) ?? 0
      }))
    }
  })

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as Record<string, unknown>
    const message = String(b.message ?? '').trim()
    if (!message) return reply.code(400).send({ error: 'message is required' })
    const [inserted] = await db('nivaro_announcements')
      .insert({
        message,
        severity: ['info', 'warn', 'critical'].includes(String(b.severity)) ? b.severity : 'info',
        roles: Array.isArray(b.roles) && b.roles.length > 0 ? JSON.stringify(b.roles) : null,
        starts_at: b.starts_at ? new Date(String(b.starts_at)) : null,
        ends_at: b.ends_at ? new Date(String(b.ends_at)) : null,
        is_active: b.is_active !== false,
        created_by: req.user?.id ?? null,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({
      action: 'announcement-create',
      user: req.user?.id,
      collection: 'nivaro_announcements',
      item: String(id),
      comment: message.slice(0, 120),
      req
    })
    return reply.code(201).send({ data: { id } })
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
    if (b.roles !== undefined) {
      patch.roles = Array.isArray(b.roles) && b.roles.length > 0 ? JSON.stringify(b.roles) : null
    }
    if (b.starts_at !== undefined) patch.starts_at = b.starts_at ? new Date(String(b.starts_at)) : null
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
