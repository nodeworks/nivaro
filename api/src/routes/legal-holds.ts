import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Legal holds: exemptions from retention, trash purge and (future) archival,
 * with reason + placer + release audit. A hold names EITHER a record
 * (collection + item_id) or a user. Admin-only to manage; the record-level
 * existence check is authenticated so record forms can show a hold badge.
 */
export async function legalHoldRoutes(app: FastifyInstance): Promise<void> {
  /** Is this record held? (badge check — read permission implied by use.) */
  app.get<{ Params: { collection: string; id: string } }>(
    '/check/:collection/:id',
    { preHandler: requireAuth },
    async (req) => {
      const hold = await db('nivaro_legal_holds')
        .where({ collection: req.params.collection, item_id: req.params.id })
        .whereNull('released_at')
        .first('id', 'reason', 'created_at')
      return { data: hold ?? null }
    }
  )

  app.get('/', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { include_released?: string }
    let query = db('nivaro_legal_holds as h')
      .leftJoin('nivaro_users as u', 'u.id', 'h.user')
      .leftJoin('nivaro_users as p', 'p.id', 'h.placed_by')
      .orderBy('h.id', 'desc')
      .select(
        'h.*',
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
        ),
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, '')))) as placed_by_name"
        )
      )
    if (q.include_released !== 'true') query = query.whereNull('h.released_at')
    return { data: await query.limit(500) }
  })

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as { collection?: string; item_id?: string; user?: string; reason?: string }
    const reason = String(b.reason ?? '').trim()
    if (!reason) return reply.code(400).send({ error: 'A reason is required — holds are audited' })
    const isRecord = !!(b.collection && b.item_id)
    const isUser = !!b.user
    if (isRecord === isUser) {
      return reply.code(400).send({ error: 'A hold names either a record (collection + item_id) or a user' })
    }
    if (isRecord && !/^[A-Za-z0-9_]+$/.test(String(b.collection))) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const [inserted] = await db('nivaro_legal_holds')
      .insert({
        collection: isRecord ? b.collection : null,
        item_id: isRecord ? String(b.item_id) : null,
        user: isUser ? b.user : null,
        reason: reason.slice(0, 1000),
        placed_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({
      action: 'legal-hold-place',
      user: req.user?.id,
      collection: isRecord ? String(b.collection) : 'nivaro_users',
      item: isRecord ? String(b.item_id) : String(b.user),
      comment: reason.slice(0, 300),
      req
    })
    return reply.code(201).send({ data: { id } })
  })

  app.post<{ Params: { id: string } }>('/:id/release', { preHandler: requireAdmin }, async (req, reply) => {
    const row = await db('nivaro_legal_holds').where('id', req.params.id).whereNull('released_at').first()
    if (!row) return reply.code(404).send({ error: 'Active hold not found' })
    await db('nivaro_legal_holds')
      .where('id', row.id)
      .update({ released_at: new Date(), released_by: req.user?.id ?? null })
    await logActivity({
      action: 'legal-hold-release',
      user: req.user?.id,
      collection: row.collection ?? 'nivaro_users',
      item: String(row.item_id ?? row.user),
      req
    })
    return { data: { released: true } }
  })
}
