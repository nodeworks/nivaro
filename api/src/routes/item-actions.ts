import type { FastifyInstance } from 'fastify'
import { itemActionRegistry } from '../extensions/item-actions.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'

export async function itemActionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List actions available for a collection
  app.get('/item-actions/registered', { preHandler: [requireAuth] }, async (req) => {
    const collection = (req.query as Record<string, string>).collection
    const actions = itemActionRegistry.list(collection)
    return {
      data: actions.map(({ execute: _x, ...rest }) => rest)
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
      return { data: result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed'
      return reply.status(500).send({ error: msg })
    }
  })
}
