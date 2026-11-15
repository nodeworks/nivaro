import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { measureUsage, readLiveUsage } from '../services/usage-live.js'

/**
 * GET /api/usage/live (administrators) — what this instance holds right now: records (from the
 * database's row-count statistics, `records.approx`), file storage, AI tokens this calendar month
 * (UTC) and people who can sign in. Cached a few seconds per tenant; the `usage` ops topic
 * (`ops:changed {topic: 'usage'}`) says when to read it again. Generic: no plan, no limit — a
 * hosting layer sets these against its own plan (services/usage-live.ts).
 */
export async function usageLiveRoutes(app: FastifyInstance) {
  app.get('/usage/live', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      return { data: await readLiveUsage(() => measureUsage(db)) }
    } catch (err) {
      req.log.warn({ err }, 'usage: live figures not read')
      return reply
        .code(503)
        .send({ error: 'Could not read the usage figures. Try again.', code: 'USAGE_UNAVAILABLE' })
    }
  })
}
