import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { notifyUser } from '../services/notification-channels.js'

/**
 * "Request access" — the access-denied panel explains WHY a record is hidden;
 * this closes the loop by notifying admins instead of ending in a side-channel
 * message. One request per user+record per day (the dedupe is the activity
 * log itself — no new table for a button).
 */
export async function accessRequestRoutes(app: FastifyInstance) {
  app.post<{ Body: { collection?: string; item?: string; note?: string } }>(
    '/access-requests',
    { preHandler: requireAuth },
    async (req, reply) => {
      const collection = String(req.body?.collection ?? '').trim()
      const item = String(req.body?.item ?? '').trim()
      const note = String(req.body?.note ?? '').trim().slice(0, 300)
      if (!collection || !item || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) {
        return reply.code(400).send({ error: 'collection and item are required' })
      }
      if (/^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a requestable collection' })
      }

      // Once per day per record — a stuck user clicking five times must not
      // page every admin five times.
      const since = new Date(Date.now() - 24 * 3600 * 1000)
      const dup = await db('nivaro_activity')
        .where({ action: 'access-request', user: req.user!.id, collection, item })
        .where('timestamp', '>', since)
        .first('id')
      if (dup) {
        return reply.send({ data: { requested: true, already: true } })
      }

      await logActivity({
        action: 'access-request',
        user: req.user!.id,
        collection,
        item,
        comment: note || undefined,
        req
      })

      const requester =
        [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') ||
        req.user?.email ||
        'A user'
      const admins = (await db('nivaro_users as u')
        .join('nivaro_roles as r', 'r.id', 'u.role')
        .where('r.admin_access', true)
        .where((qb) => void qb.where('u.status', 'active').orWhereNull('u.status'))
        .limit(10)
        .select('u.id')) as Array<{ id: string }>
      for (const a of admins) {
        await notifyUser(app, String(a.id), {
          subject: `${requester} requested access to ${collection}/${item}`,
          message: note || 'They hit the access-denied panel and asked for help.',
          sender: req.user?.id ?? null,
          collection,
          item
        }).catch(() => {})
      }

      return reply.send({ data: { requested: true, notified: admins.length } })
    }
  )
}
