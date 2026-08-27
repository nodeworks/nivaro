import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { buildCoverageGapReport, buildOooRunway } from '../services/coverage-gaps.js'

/**
 * Coverage gaps — see services/coverage-gaps.ts. Computed live per request;
 * admin-only because the report names people and their absence.
 */
export async function coverageGapsRoutes(app: FastifyInstance) {
  app.get('/coverage-gaps', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ data: await buildCoverageGapReport() })
  })

  /** OOO runway (#727): upcoming absences vs the approval load they touch. */
  app.get('/coverage-gaps/runway', { preHandler: requireAdmin }, async (req, reply) => {
    const days = Math.min(60, Math.max(7, Number((req.query as { days?: string }).days) || 21))
    return reply.send({ data: { days, entries: await buildOooRunway(days) } })
  })
}
