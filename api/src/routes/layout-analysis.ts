import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import {
  type CoverageDeps,
  cachedLintContext,
  computeLayoutCoverage,
  computeLayoutHealth
} from '../services/layout-analysis.js'
import { getLayoutStyle, LayoutStyleError, saveLayoutStyle } from '../services/layout-style.js'

/**
 * Layout analysis routes under /collection-layouts (admin-only, like the
 * editor): what the lint reads about a collection (#2592), a health score per
 * form (#2612), which form sampled real records land on (#2581) and the
 * label house style the lint applies (#3184, per instance). The
 * resolver comes in from collection-layouts.ts (a value import back would be
 * a cycle).
 */
export function registerLayoutAnalysisRoutes(app: FastifyInstance, deps: CoverageDeps): void {
  app.get('/lint-context', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    return reply.send({ data: await cachedLintContext(collection) })
  })

  // Label house style (#3184): which style rules are off, the longest label,
  // extra abbreviations and words that keep their capital. Per instance.
  app.get('/lint-style', { preHandler: requireAdmin }, async (_req, reply) =>
    reply.send({ data: await getLayoutStyle() })
  )

  app.patch('/lint-style', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      return reply.send({ data: await saveLayoutStyle(req.body ?? {}) })
    } catch (err) {
      if (err instanceof LayoutStyleError) return reply.code(400).send({ error: err.message })
      throw err
    }
  })

  app.get('/health', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    return reply.send({ data: { rows: await computeLayoutHealth(collection) } })
  })

  app.get('/coverage', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection, fresh } = req.query as { collection?: string; fresh?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    const result = await computeLayoutCoverage(collection, req.user?.id ?? null, deps, {
      fresh: fresh === '1' || fresh === 'true'
    })
    if (!result) return reply.code(404).send({ error: 'Collection not found' })
    return reply.send({ data: result })
  })
}
