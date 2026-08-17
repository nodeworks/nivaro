import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

/**
 * "Edited 3d ago by Beth" — the newest human-relevant activity row for one
 * record, for the record-header chip. Deliberately its own tiny endpoint:
 * the /activity listing is admin-gated and has no per-item filter, and the
 * chip needs exactly one row.
 */
export async function lastTouchRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string } }>(
    '/last-touch/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const row = (await db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where({ 'a.collection': collection, 'a.item': String(id) })
        .whereIn('a.action', ['create', 'update'])
        .orderBy('a.id', 'desc')
        .first(
          'a.action',
          'a.timestamp',
          'a.user',
          'u.first_name',
          'u.last_name',
          'u.email'
        )) as
        | {
            action: string
            timestamp: Date
            user: string | null
            first_name: string | null
            last_name: string | null
            email: string | null
          }
        | undefined
      if (!row) return reply.send({ data: null })
      return reply.send({
        data: {
          action: row.action,
          timestamp: new Date(row.timestamp).toISOString(),
          user_id: row.user ?? null,
          user_name:
            [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || null
        }
      })
    }
  )
}
