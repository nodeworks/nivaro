import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { StatementCancelled } from '../services/bounded-sql.js'
import { withReadGate } from '../services/read-gate.js'
import { readSlowScreens } from '../services/slow-screens.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/slow-screens/:userId?days=7|30 — one person's slowest pages: median and p95 load
 * time, how often, the browsers and screen sizes, the slowest calls behind each page and a
 * replay of a slow visit when one was recorded. Read-only, administrators only (the people
 * page's Activity tab and support tickets about slowness).
 */
export async function slowScreensRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const q = req.query as { days?: string }
    if (!UUID.test(userId)) return reply.code(400).send({ error: 'Not a person id' })
    const days = q.days === '30' ? 30 : 7
    const person = await db('nivaro_users').where('id', userId).first('id')
    if (!person) return reply.code(404).send({ error: 'No such person' })
    try {
      const data = await withReadGate(
        req.user?.id,
        () => readSlowScreens(String(person.id).toUpperCase(), days),
        { label: 'slow-screens' }
      )
      return { data }
    } catch (err) {
      if (err instanceof StatementCancelled)
        return reply
          .code(503)
          .send({ error: 'Their timings took too long to read; try again', code: 'SLOW_READ' })
      throw err
    }
  })
}
