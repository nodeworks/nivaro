import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { parseSelectionAsk, readSelectionChanges } from '../services/selection-changes.js'

/**
 * Before a bulk action (realtime round 8):
 *
 *   POST /api/bulk-preflight/changes {collection, items: [{id, since}]}
 *     → { data: { changes: {id: {at, by, fields, moved_to?, deleted?}}, labels } }
 *
 * Which of the selected records someone else changed since the list picked them, judged as
 * the caller (services/selection-changes.ts). A read: POST only because it carries the ids.
 * Three bounded reads (≤200 records), so it is not a gated heavy read. Who has them open /
 * is editing them comes from the presence and lock reads the list already makes
 * (useRowPresence, /item-locks/:c/active).
 */
export async function bulkPreflightRoutes(app: FastifyInstance) {
  app.post('/changes', { preHandler: requireAuth }, async (req, reply) => {
    const ask = parseSelectionAsk(req.body)
    if (!ask)
      return reply.send({
        data: { changes: {}, labels: { records: {}, users: {}, fields: {} } }
      })
    const data = await readSelectionChanges(req.user!, !!req.isAdmin, ask)
    return reply.send({ data })
  })
}
