import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { collectionTitle, isPkLabel } from '../services/record-label-fallback.js'

// Per-user pinned/starred records (generic — catalog-picker favorites etc.).
// Deliberately unlogged: per-user UI preference, same precedent as queue
// column prefs / preset activation.
export async function pinnedRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAuth)

  // GET /pinned → every pin of the caller across collections, newest first
  // (dashboard "pinned records"). Labels are what the pinning client sent — except
  // a missing or pk-only one ("Workflow 370973", older clients sent those): that pin
  // is labelled now, as the caller (services/record-labels-as-viewer.ts), never by its pk.
  app.get('/', async (req, reply) => {
    const rows = await db('nivaro_pinned_items')
      .where({ user: req.user!.id })
      .orderBy('created_at', 'desc')
      .select('collection', 'item_id', 'label', 'created_at')
    const pins = rows.map((r) => ({
      collection: String(r.collection),
      id: String(r.item_id),
      label: (r.label as string | null) ?? null,
      pinned_at: r.created_at
    }))
    if (pins.length > 0) {
      // The names an old fallback label may carry ("Workflow 370973" = singular + pk).
      const meta = (await db('nivaro_collections')
        .whereIn('collection', [...new Set(pins.map((p) => p.collection))])
        .select('collection', 'display_name', 'singular')
        .catch(() => [])) as Array<{
        collection: string
        display_name: string | null
        singular: string | null
      }>
      const namesOf = (c: string) => {
        const m = meta.find((r) => r.collection === c)
        return [c, m?.display_name, m?.singular, collectionTitle(c, m?.display_name)]
      }
      const stale = pins.filter((p) => isPkLabel(p.label, p.id, namesOf(p.collection)))
      if (stale.length > 0) {
        const { recordLabelsAsViewer } = await import('../services/record-labels-as-viewer.js')
        const labels = await recordLabelsAsViewer(req.user!, stale).catch(
          () => ({}) as Record<string, string>
        )
        for (const p of stale) {
          const m = meta.find((r) => r.collection === p.collection)
          p.label =
            labels[`${p.collection}:${p.id}`] ?? collectionTitle(p.collection, m?.display_name)
        }
      }
    }
    return reply.send({ data: pins })
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
