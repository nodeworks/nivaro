import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { globalSearch } from '../services/global-search.js'

/**
 * Cross-collection search. Everything is resolved AS THE REQUESTING USER
 * through the items service, so results can never include a row the caller
 * could not open directly.
 */
export async function searchRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { q?: string; collections?: string; limit?: string; per_collection?: string }
  }>('/', { preHandler: requireAuth }, async (req, reply) => {
    const q = (req.query.q ?? '').trim()
    if (q.length < 2) {
      return reply.code(400).send({ error: 'q must be at least 2 characters' })
    }
    const outcome = await globalSearch(req.user!, q, {
      collections: req.query.collections
        ? req.query.collections.split(',').map((c) => c.trim()).filter(Boolean)
        : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      perCollection: req.query.per_collection ? Number(req.query.per_collection) : undefined
    })
    return reply.send({ data: outcome.hits, meta: {
      searched: outcome.searched.length,
      skipped: outcome.skipped,
      truncated: outcome.truncated
    } })
  })
}
