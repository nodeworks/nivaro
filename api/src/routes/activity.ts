import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'

export async function activityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    const q = req.query as Record<string, string>
    const limit = Math.min(q.limit ? Number(q.limit) : 25, 200)
    const offset = q.offset ? Number(q.offset) : 0

    const base = () => db('nivaro_activity as a').leftJoin('nivaro_users as u', 'a.user', 'u.id')

    const query = base()
      .select(
        'a.id',
        'a.action',
        'a.user',
        'a.timestamp',
        'a.ip',
        'a.collection',
        'a.item',
        'a.comment',
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )
      .orderBy('a.timestamp', 'desc')
      .limit(limit)
      .offset(offset)

    const countQuery = base().count('a.id as count')

    if (q.collection) {
      query.where('a.collection', q.collection)
      countQuery.where('a.collection', q.collection)
    }
    if (q.action) {
      query.where('a.action', q.action)
      countQuery.where('a.action', q.action)
    }
    if (q.user) {
      query.where('a.user', q.user)
      countQuery.where('a.user', q.user)
    }

    const [data, countRows] = await Promise.all([query, countQuery])
    const total = Number((countRows[0] as { count: string | number }).count)
    return reply.send({ data, total, limit, offset })
  })

  app.get('/actions', async (_req, reply) => {
    const rows = await db('nivaro_activity').distinct('action').orderBy('action')
    return reply.send({ data: rows.map((r: { action: string }) => r.action) })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'a.user', 'u.id')
      .select(
        'a.id',
        'a.action',
        'a.user',
        'a.timestamp',
        'a.ip',
        'a.user_agent',
        'a.collection',
        'a.item',
        'a.comment',
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )
      .where('a.id', Number(id))
      .first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: row })
  })

  app.post('/', async (req, reply) => {
    const body = req.body as {
      action: string
      collection?: string
      item?: string
      comment?: string
    }
    await db('nivaro_activity').insert({
      action: body.action,
      user: req.user!.id,
      collection: body.collection ?? null,
      item: body.item ?? null,
      comment: body.comment ?? null,
      ip: req.ip,
      user_agent: req.headers['user-agent'] ?? null
    })
    return reply.code(201).send({ ok: true })
  })
}
