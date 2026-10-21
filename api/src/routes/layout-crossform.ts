import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { computeCrossform, searchFieldPlacements } from '../services/layout-crossform.js'

/**
 * Across-forms reads under /collection-layouts (admin-only, like the editor):
 * label differences, near-duplicate forms and thumbnails for one collection
 * (#2631 #2660 #2664), and every form that places a field (#2658).
 */
export function registerLayoutCrossformRoutes(app: FastifyInstance): void {
  app.get('/crossform', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    return reply.send({ data: await computeCrossform(collection) })
  })

  app.get('/field-search', { preHandler: requireAdmin }, async (req, reply) => {
    const { q, collection } = req.query as { q?: string; collection?: string }
    const query = typeof q === 'string' ? q.trim() : ''
    if (query.length < 2) return reply.code(400).send({ error: 'Type at least 2 characters' })
    return reply.send({ data: await searchFieldPlacements(query, collection || null) })
  })
}
