import type { FastifyInstance } from 'fastify'
import { bulkActionRegistry } from '../extensions/bulk-actions.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'

export async function bulkActionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List actions available for a collection
  app.get('/bulk-actions/registered', { preHandler: [requireAuth] }, async (req) => {
    const collection = (req.query as Record<string, string>).collection
    const actions = bulkActionRegistry.list(collection)
    return {
      data: actions.map(({ execute: _x, ...rest }) => rest)
    }
  })

  // Execute a registered bulk action
  app.post<{
    Params: { id: string }
    Body: { collection: string; ids: (string | number)[]; payload?: Record<string, unknown> }
  }>('/bulk-actions/:id/execute', { preHandler: [requireAuth] }, async (req, reply) => {
    const action = bulkActionRegistry.get(req.params.id)
    if (!action) return reply.status(404).send({ error: 'Bulk action not found' })

    const { collection, ids, payload } = req.body
    if (!collection || !Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ error: 'collection and ids are required' })
    }

    try {
      const result = await action.execute({
        collection,
        ids,
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
