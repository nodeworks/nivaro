import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { searchConfig } from '../services/config-search/index.js'

/**
 * GET /global-search/config?q=&ai=1 — config search in plain words (search
 * program item 24). Every hit links to the exact screen (tab + item). Admin-only
 * config answers administrators only; everyone else gets the personal screens.
 * `ai=1` lets an administrator's thin keyword answer take one AI rewrite of the
 * question (keywords + kinds + collection, names only — services/config-search).
 *
 * Not to be confused with /config-search (#37, routes/config-search.ts): that
 * admin tool scans config TEXT/JSON for a literal string ("who references
 * update_workflow.php"); this one answers "where is X set up" by name.
 */
export async function configPlainSearchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/config', async (req, reply) => {
    const { q: rawQ, ai, limit } = req.query as { q?: string; ai?: string; limit?: string }
    const q = String(rawQ ?? '')
      .trim()
      .slice(0, 300)
    if (q.length < 2) return reply.send({ data: { hits: [], rewrite: null, ai: 'not_needed' } })
    const data = await searchConfig(q, {
      isAdmin: req.isAdmin === true,
      ai: ai === '1' || ai === 'true',
      limit: Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)))
    })
    return reply.send({ data })
  })
}
