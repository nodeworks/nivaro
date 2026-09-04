import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'

// Per-user pinned/starred records (generic — catalog-picker favorites etc.).
// Deliberately unlogged: per-user UI preference, same precedent as queue
// column prefs / preset activation.
export async function pinnedRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAuth)

  // GET /pinned → every pin of the caller across collections, newest first
  // (dashboard "pinned records"). Labels are what the pinning client sent.
  app.get('/', async (req, reply) => {
    const rows = await db('nivaro_pinned_items')
      .where({ user: req.user!.id })
      .orderBy('created_at', 'desc')
      .select('collection', 'item_id', 'label', 'created_at')
    return reply.send({
      data: rows.map((r) => ({
        collection: String(r.collection),
        id: String(r.item_id),
        label: r.label ?? null,
        pinned_at: r.created_at
      }))
    })
  })

  // GET /pinned/:collection → { data: string[] } (item ids)
  app.get('/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const rows = await db('nivaro_pinned_items')
      .where({ user: req.user!.id, collection })
      .select('item_id')
    return reply.send({ data: rows.map((r) => String(r.item_id)) })
  })

  // POST /pinned/:collection/:itemId/toggle {label?} → { data: { pinned: boolean } }
  app.post('/:collection/:itemId/toggle', async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }
    const body = (req.body ?? {}) as { label?: unknown }
    const label =
      typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 500) : null
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
      item_id: itemId,
      label
    })
    return reply.send({ data: { pinned: true } })
  })
}
