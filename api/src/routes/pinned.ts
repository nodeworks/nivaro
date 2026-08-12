import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'

// Per-user pinned/starred records (generic — catalog-picker favorites etc.).
// Deliberately unlogged: per-user UI preference, same precedent as queue
// column prefs / preset activation.
export async function pinnedRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAuth)

  // GET /pinned/:collection → { data: string[] } (item ids)
  app.get('/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const rows = await db('nivaro_pinned_items')
      .where({ user: req.user!.id, collection })
      .select('item_id')
    return reply.send({ data: rows.map((r) => String(r.item_id)) })
  })

  // POST /pinned/:collection/:itemId/toggle → { data: { pinned: boolean } }
  app.post('/:collection/:itemId/toggle', async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }
    const existing = await db('nivaro_pinned_items')
      .where({ user: req.user!.id, collection, item_id: itemId })
      .first()
    if (existing) {
      await db('nivaro_pinned_items').where({ id: existing.id }).del()
      return reply.send({ data: { pinned: false } })
    }
    await db('nivaro_pinned_items').insert({
      user: req.user!.id,
      collection,
      item_id: itemId
    })
    return reply.send({ data: { pinned: true } })
  })
}
