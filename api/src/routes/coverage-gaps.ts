import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { buildCoverageGapReport } from '../services/coverage-gaps.js'

/**
 * Coverage gaps — see services/coverage-gaps.ts. Computed live per request;
 * admin-only because the report names people and their absence.
 */
export async function coverageGapsRoutes(app: FastifyInstance) {
  app.get('/coverage-gaps', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ data: await buildCoverageGapReport() })
  })
}
