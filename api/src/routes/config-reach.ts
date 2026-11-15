import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { getRecordViewerSnapshot } from '../plugins/socketio.js'
import { configReach, parseReachCollections } from '../services/config-reach.js'

/**
 * GET /api/realtime/config-reach?collections=a,b (rt8 #25, administrators) — how many open
 * record forms and people a config change to those collections reaches right now. In memory
 * (the realtime board), no database read; the caller's own forms are left out.
 */
export async function configReachRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { collections?: string } }>(
    '/config-reach',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const collections = parseReachCollections(req.query.collections)
      if (collections.length === 0)
        return reply.code(400).send({ error: 'Name at least one collection' })
      const reach = configReach(getRecordViewerSnapshot(), collections, String(req.user!.id))
      return { data: { collections, ...reach, at: new Date().toISOString() } }
    }
  )
}
