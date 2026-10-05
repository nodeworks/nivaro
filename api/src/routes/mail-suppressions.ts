import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  clearSuppression,
  normalizeAddress,
  type SuppressionRow,
  suppressionFor
} from '../services/mail-suppressions.js'

/**
 * Bounce handling (#1299): the suppressed-address list. Admins list, search
 * and clear; anyone signed in may ask whether ONE address is suppressed —
 * that is what the profile header and the contact card render as the mark.
 */
export async function mailSuppressionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>('/', { preHandler: requireAdmin }, async (req) => {
    const q = String(req.query.q ?? '')
      .trim()
      .toLowerCase()
    let query = db('nivaro_mail_suppressions as s')
      .leftJoin('nivaro_users as u', function joinByAddress() {
        this.on(db.raw('LOWER(u.email) = s.address'))
      })
      .orderBy('s.last_seen', 'desc')
      .limit(500)
      .select(
        's.id',
        's.address',
        's.reason',
        's.first_seen',
        's.last_seen',
        's.count',
        's.notified_at',
        'u.id as user_id',
        'u.first_name',
        'u.last_name'
      )
    if (q) {
      const like = `%${q.replace(/[%_[]/g, (c) => `[${c}]`)}%`
      query = query.where((inner) =>
        inner
          .where('s.address', 'like', like)
          .orWhere('u.first_name', 'like', like)
          .orWhere('u.last_name', 'like', like)
      )
    }
    const rows = (await query) as Array<
      SuppressionRow & {
        user_id: string | null
        first_name: string | null
        last_name: string | null
      }
    >
    return {
      data: rows.map((r) => ({
        id: r.id,
        address: r.address,
        reason: r.reason,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        count: Number(r.count ?? 0),
        notified_at: r.notified_at,
        user_id: r.user_id,
        user_name: r.user_id ? [r.first_name, r.last_name].filter(Boolean).join(' ') || null : null
      }))
    }
  })

  // The mark on a profile / contact card. Authenticated, not admin — the
  // address is already on the page it decorates.
  app.get<{ Querystring: { address?: string } }>(
    '/check',
    { preHandler: requireAuth },
    async (req, reply) => {
      const address = normalizeAddress(String(req.query.address ?? ''))
      if (!address.includes('@')) return reply.code(400).send({ error: 'address is required' })
      const row = await suppressionFor(address)
      if (!row) return { data: { suppressed: false, reason: null, since: null, id: null } }
      return {
        data: {
          suppressed: true,
          id: row.id,
          reason: row.reason,
          since: row.first_seen,
          last_seen: row.last_seen,
          count: Number(row.count ?? 0)
        }
      }
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await clearSuppression(req.params.id, req.user?.id)
      if (!row) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'mail-suppression-clear',
        user: req.user?.id,
        collection: 'nivaro_mail_suppressions',
        item: String(row.id),
        comment:
          `${row.address} cleared after ${row.count} bounce(s)${row.reason ? ` — ${row.reason}` : ''}`.slice(
            0,
            500
          ),
        req
      })
      return { data: { cleared: true, address: row.address } }
    }
  )
}
