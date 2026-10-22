import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logSearch, markOpened, searchSummary } from '../services/search-analytics.js'
import {
  coveredBy,
  createSynonymGroup,
  deleteSynonymGroup,
  listSynonymGroups,
  SynonymError,
  updateSynonymGroup
} from '../services/search-synonyms.js'

/**
 * /api/search-analytics (#1581). Any signed-in person's client logs the search
 * they ran and what they opened (fire-and-forget; a failure never reaches the
 * person). Only administrators read the summary — queries are personal data.
 * Synonym groups (services/search-synonyms.ts) are administrator config too.
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
      const summary = await searchSummary(days)
      if (!summary.ready) return { data: summary }
      // Mark the empty searches a synonym already covers (added after they ran).
      const groups = await listSynonymGroups().catch(() => [])
      return {
        data: {
          ...summary,
          zero_results: summary.zero_results.map((l) => ({
            ...l,
            synonym_id: coveredBy(groups, l.query, l.collection)?.id ?? null
          }))
        }
      }
    }
  )

  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof SynonymError) return reply.code(e.status).send({ error: e.message })
    throw e
  }

  app.get('/synonyms', { preHandler: requireAdmin }, async () => ({
    data: await listSynonymGroups()
  }))

  app.post<{ Body: Record<string, unknown> }>(
    '/synonyms',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const { group, merged } = await createSynonymGroup(req.user!.id, req.body ?? {})
        return reply.code(merged ? 200 : 201).send({ data: group, meta: { merged } })
      } catch (e) {
        return fail(reply, e)
      }
    }
  )

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/synonyms/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return {
          data: await updateSynonymGroup(Number(req.params.id), req.user!.id, req.body ?? {})
        }
      } catch (e) {
        return fail(reply, e)
      }
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/synonyms/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ok = await deleteSynonymGroup(Number(req.params.id))
      return ok ? reply.code(204).send() : reply.code(404).send({ error: 'Synonym not found' })
    }
  )
}
