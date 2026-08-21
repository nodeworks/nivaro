import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
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
      // item optional (#55): a bare collection request means "I can't see this
      // collection at all" — it lands in the grant queue.
      if (!collection || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) {
        return reply.code(400).send({ error: 'collection is required' })
      }
      if (/^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a requestable collection' })
      }

      // Once per day per record — a stuck user clicking five times must not
      // page every admin five times.
      const since = new Date(Date.now() - 24 * 3600 * 1000)
      const dup = await db('nivaro_activity')
        .where({ action: 'access-request', user: req.user!.id, collection })
        .where('item', item || '')
        .where('timestamp', '>', since)
        .first('id')
      if (dup) {
        return reply.send({ data: { requested: true, already: true } })
      }

      await logActivity({
        action: 'access-request',
        user: req.user!.id,
        collection,
        item: item || undefined,
        comment: note || undefined,
        req
      })

      // Collection-level requests join the admin grant queue (#55) — a
      // pending row an admin can grant or deny with one click.
      if (!item) {
        const pending = await db('nivaro_access_requests')
          .where({ user: req.user!.id, collection, status: 'pending' })
          .first('id')
          .catch(() => undefined)
        if (!pending) {
          await db('nivaro_access_requests')
            .insert({
              user: req.user!.id,
              collection,
              note: note || null,
              status: 'pending',
              created_at: new Date()
            })
            .catch(() => {})
        }
      }

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
          subject: `${requester} requested access to ${item ? `${collection}/${item}` : collection}`,
          message: note || 'They hit the access-denied panel and asked for help.',
          sender: req.user?.id ?? null,
          collection,
          item
        }).catch(() => {})
      }

      return reply.send({ data: { requested: true, notified: admins.length } })
    }
  )

  /** Pending grant queue (#55) — admin list + one-click grant/deny. */
  app.get('/access-requests', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { status?: string }
    const status = ['pending', 'granted', 'denied'].includes(String(q.status)) ? String(q.status) : 'pending'
    const rows = (await db('nivaro_access_requests as r')
      .leftJoin('nivaro_users as u', 'u.id', 'r.user')
      .where('r.status', status)
      .orderBy('r.id', 'desc')
      .limit(200)
      .select(
        'r.*',
        db.raw("LTRIM(RTRIM(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,'')))) as user_name"),
        'u.email as user_email',
        'u.role as user_role'
      )
      .catch(() => [])) as Array<Record<string, unknown>>
    return { data: rows }
  })

  /** Grant: adds a READ policy for the requester's ROLE on the collection —
   *  the smallest change that satisfies the request, made by an explicit
   *  admin click. Wider grants stay a Roles-page decision. */
  app.post<{ Params: { id: string }; Body: { decision?: string } }>(
    '/access-requests/:id/resolve',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = (await db('nivaro_access_requests')
        .where({ id: req.params.id, status: 'pending' })
        .first()) as Record<string, unknown> | undefined
      if (!row) return reply.code(404).send({ error: 'Pending request not found' })
      const decision = req.body?.decision === 'grant' ? 'granted' : 'denied'
      let policyAdded = false
      if (decision === 'granted') {
        const requester = await db('nivaro_users').where({ id: row.user }).first('role')
        if (!requester?.role) {
          return reply.code(400).send({ error: 'The requester has no role to grant against' })
        }
        const existing = await db('nivaro_policies')
          .where({ role: requester.role, collection: String(row.collection), action: 'read' })
          .first('id')
        if (!existing) {
          await db('nivaro_policies').insert({
            role: requester.role,
            collection: String(row.collection),
            action: 'read'
          })
          policyAdded = true
        }
      }
      await db('nivaro_access_requests')
        .where({ id: row.id })
        .update({ status: decision, resolved_by: req.user?.id ?? null, resolved_at: new Date() })
      await logActivity({
        action: decision === 'granted' ? 'access-request-grant' : 'access-request-deny',
        user: req.user?.id,
        collection: String(row.collection),
        comment: `for user ${row.user}${policyAdded ? ' (read policy added to their role)' : ''}`,
        req
      })
      await notifyUser(app, String(row.user), {
        subject:
          decision === 'granted'
            ? `Access granted: ${row.collection}`
            : `Access request declined: ${row.collection}`,
        message:
          decision === 'granted'
            ? 'An administrator granted your role read access. Reload and try again.'
            : 'An administrator reviewed and declined this request.',
        sender: req.user?.id ?? null
      }).catch(() => {})
      return { data: { status: decision, policy_added: policyAdded } }
    }
  )
}
