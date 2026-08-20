import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { runReadinessChecks } from '../services/readiness.js'

/** Run every registered readiness check and score the result. Read-only —
 *  a scorecard someone refreshes, deliberately unlogged. */
export async function readinessRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAdmin }, async () => {
    return { data: await runReadinessChecks() }
  })
}
