import type { FastifyInstance } from 'fastify'
import { itemActionRegistry } from '../extensions/item-actions.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

export async function itemActionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List actions available for a collection
  app.get('/item-actions/registered', { preHandler: [requireAuth] }, async (req) => {
    const q = req.query as Record<string, string>
    const collection = q.collection
    const item = q.item
    const actions = itemActionRegistry.list(collection)
    // With ?item=, per-record applicability gates run so the client only
    // renders buttons that can actually do something on THIS record.
    const kept = item
      ? (
          await Promise.all(
            actions.map(async (a) => {
              if (!a.applicable || !collection) return a
              const ok = await a
                .applicable({ collection, itemId: item })
                .catch(() => true) // broken check must not hide a working action
              return ok ? a : null
            })
          )
        ).filter((a): a is (typeof actions)[number] => a !== null)
      : actions
    return {
      data: kept.map(({ execute: _x, applicable: _a, ...rest }) => rest)
    }
  })

  // Execute a registered item action
  app.post<{
    Params: { id: string }
    Body: { collection: string; itemId: string | number; payload?: Record<string, unknown> }
  }>('/item-actions/:id/execute', { preHandler: [requireAuth] }, async (req, reply) => {
    const action = itemActionRegistry.get(req.params.id)
    if (!action) return reply.status(404).send({ error: 'Item action not found' })

    const { collection, itemId, payload } = req.body
    if (!collection || itemId == null) {
      return reply.status(400).send({ error: 'collection and itemId are required' })
    }

    try {
      const result = await action.execute({
        collection,
        itemId,
        payload,
        userId: req.user?.id
      })
      // The mutation itself lives in extension code — log the invocation.
      await logActivity({
        action: 'item-action-execute',
        user: req.user?.id,
        collection,
        item: String(itemId),
        comment: req.params.id,
        req
      })
      return { data: result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed'
      return reply.status(500).send({ error: msg })
    }
  })
}
