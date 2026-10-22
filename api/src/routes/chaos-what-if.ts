import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { DEPENDENCIES, WhatIfError, whatIf } from '../services/chaos/what-if.js'

/**
 * "What if X died?" (#2860) under /api/chaos/what-if — admin, read-only, never arms anything.
 *
 *   GET /                 the dependencies it answers for
 *   GET /?dependency=     claims + last proven, blast radius, last runs, a draft experiment and
 *                         the builder link that opens it pre-filled
 *
 * The MCP tool `chaos_what_if` re-enters here as the caller; Ask AI calls the service directly.
 * Answers in cloud mode and on production too: it only reads.
 */
export async function chaosWhatIfRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { dependency?: string } }>('/', async (req, reply) => {
    const raw = req.query.dependency
    if (raw == null || raw === '')
      return {
        data: {
          dependencies: DEPENDENCIES.map((d) => ({
            key: d.key,
            label: d.label,
            map_node: d.map_node
          }))
        }
      }
    try {
      return { data: await whatIf(String(raw).slice(0, 80)) }
    } catch (err) {
      if (err instanceof WhatIfError)
        return reply.code(400).send({ error: err.message, code: 'CHAOS_WHAT_IF' })
      throw err
    }
  })
}
