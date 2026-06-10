import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'

/**
 * Per-user activity feed (admin only).
 *
 * GET /user-activity/:userId?page=&limit=50&action=create&collection=orders&sort=asc
 * GET /user-activity/:userId/summary
 */
export async function userActivityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const q = req.query as Record<string, string>
    const limit = Math.min(q.limit ? Number(q.limit) : 50, 200)
    const page = Math.max(q.page ? Number(q.page) : 1, 1)
    const offset = (page - 1) * limit
    const sortDir = q.sort === 'asc' ? 'asc' : 'desc'

    let query = db('nivaro_activity').where('user', userId)
    let countQuery = db('nivaro_activity').where('user', userId)

    if (q.action) {
      query = query.where('action', q.action)
      countQuery = countQuery.where('action', q.action)
    }
    if (q.collection) {
      query = query.where('collection', q.collection)
      countQuery = countQuery.where('collection', q.collection)
    }
    if (q.date_from) {
      query = query.where('timestamp', '>=', q.date_from)
      countQuery = countQuery.where('timestamp', '>=', q.date_from)
    }
    if (q.date_to) {
      query = query.where('timestamp', '<=', q.date_to)
      countQuery = countQuery.where('timestamp', '<=', q.date_to)
    }

    const [data, countRows] = await Promise.all([
      query
        .select('id', 'action', 'user', 'timestamp', 'ip', 'collection', 'item', 'comment')
        .orderBy('timestamp', sortDir)
        .limit(limit)
        .offset(offset),
      countQuery.count('id as count')
    ])

    const total = Number((countRows[0] as { count: string | number }).count)
    return reply.send({ data, total, page, limit })
  })

  app.get('/:userId/summary', async (req, reply) => {
    const { userId } = req.params as { userId: string }

    const [actionRows, collectionRows, totalRows] = await Promise.all([
      db('nivaro_activity')
        .select('action')
        .count('id as count')
        .where('user', userId)
        .groupBy('action')
        .orderByRaw('count(id) desc'),
      db('nivaro_activity')
        .select('collection')
        .count('id as count')
        .where('user', userId)
        .whereNotNull('collection')
        .groupBy('collection')
        .orderByRaw('count(id) desc')
        .limit(10),
      db('nivaro_activity').where('user', userId).count('id as count')
    ])

    return reply.send({
      data: {
        total: Number((totalRows[0] as { count: string | number }).count),
        actions: (actionRows as Array<{ action: string; count: string | number }>).map((r) => ({
          action: r.action,
          count: Number(r.count)
        })),
        collections: (collectionRows as Array<{ collection: string; count: string | number }>).map(
          (r) => ({ collection: r.collection, count: Number(r.count) })
        )
      }
    })
  })
}
