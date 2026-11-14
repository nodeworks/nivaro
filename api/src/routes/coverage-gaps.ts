import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { buildCoverageGapReport, buildOooRunway } from '../services/coverage-gaps.js'
import {
  noOwnerReportFor,
  noOwnerSectionRows,
  sharedNoOwnerSteps
} from '../services/no-owner-steps.js'
import { registerOpsSection } from '../services/ops-report/sections.js'
import type { User } from '../types.js'

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

  /**
   * Steps with no owner (services/no-owner-steps.ts): open records on a step
   * with owner-only moves that nobody is ASSIGNED to own — only an
   * administrator can move them. Shared answer at most 2 minutes old
   * (`fresh=1` recomputes), then only the records this administrator may read.
   */
  app.get('/coverage-gaps/no-owner', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { fresh?: string; sample?: string }
    const user = req.user as User
    const shared = await sharedNoOwnerSteps({
      fresh: q.fresh === '1' || q.fresh === 'true',
      who: String(user.id)
    })
    return reply.send({
      data: await noOwnerReportFor(user, shared, { sample: Number(q.sample) || 10 })
    })
  })

  // Health → Daily report: "Steps with no owner" (counts; the email links the tab).
  registerOpsSection('owner_gaps', 'Steps with no owner', async () =>
    noOwnerSectionRows(await sharedNoOwnerSteps())
  )
}
