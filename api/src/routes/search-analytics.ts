import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logSearch, markOpened, searchSummary } from '../services/search-analytics.js'

/**
 * /api/search-analytics (#1581). Any signed-in person's client logs the search
 * they ran and what they opened (fire-and-forget; a failure never reaches the
 * person). Only administrators read the summary — queries are personal data.
 */
export async function searchAnalyticsRoutes(app: FastifyInstance) {
  app.post('/log', { preHandler: requireAuth }, async (req) => {
    const id = await logSearch(req.user!.id, (req.body ?? {}) as Record<string, unknown>).catch(
      () => null
    )
    return { data: { id } }
  })

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/log/:id/open',
    { preHandler: requireAuth },
    async (req) => {
      const ok = await markOpened(Number(req.params.id), req.user!.id, req.body ?? {}).catch(
        () => false
      )
      return { data: { ok } }
    }
  )

  app.get<{ Querystring: { days?: string } }>(
    '/summary',
    { preHandler: requireAdmin },
    async (req) => {
      const days = Math.min(365, Math.max(1, Math.trunc(Number(req.query.days)) || 30))
      return { data: await searchSummary(days) }
    }
  )
}
