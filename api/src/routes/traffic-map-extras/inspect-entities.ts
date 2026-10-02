// api/src/routes/traffic-map-extras/inspect-entities.ts
import type { FastifyPluginAsync } from 'fastify'
// Loads the group's inspect sources (they register at module load).
import '../../services/traffic-inspect/entities.js'
import { callerDependencySummary } from '../../services/traffic-inspect/entities-caller.js'
import { parseCallerKey } from '../../services/traffic-inspect/entities-logic.js'

/**
 * Group "entities" routes beyond the generic inspect ones (admin only, 404 in cloud mode —
 * inherited from the traffic-map plugin):
 *
 *   GET /traffic-map/inspect/caller-deps?key=<caller key>
 *     → { data: { found, collections, endpoints, operations, … } | null }
 *     The fields, endpoints and GraphQL operations a caller depends on (14 days of the API log,
 *     services/partner-dependencies.ts). Kept off the caller detail because the first build of
 *     the dependency map scans two weeks of requests.
 */
export const inspectEntitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { key?: string } }>('/inspect/caller-deps', async (req, reply) => {
    const key = String(req.query.key ?? '')
    const c = parseCallerKey(key)
    if (!c) {
      return reply
        .code(400)
        .send({ error: 'That is not a valid caller key', code: 'INSPECT_ID_INVALID' })
    }
    if (c.kind !== 'key' && c.kind !== 'person') {
      return { data: null }
    }
    try {
      return { data: await callerDependencySummary(key) }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map caller dependencies failed')
      return reply
        .code(503)
        .send({ error: 'Field dependencies could not be read right now', code: 'INSPECT_FAILED' })
    }
  })
}
