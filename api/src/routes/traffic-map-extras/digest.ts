// api/src/routes/traffic-map-extras/digest.ts
import type { FastifyInstance } from 'fastify'
import { buildTrafficDigestSection, registerTrafficDigest } from '../../services/traffic-digest.js'

/**
 * #1128 — the Traffic Map section of the daily summary. Registers the section + its opt-in
 * audience at boot; GET /traffic-map/digest/preview shows what today's section would say.
 * Turning it on is the `traffic_digest` preference (PATCH /users/me/preferences).
 */
export async function digestRoutes(app: FastifyInstance): Promise<void> {
  await registerTrafficDigest()

  app.get('/digest/preview', async (req, reply) => {
    try {
      return { data: await buildTrafficDigestSection() }
    } catch (err) {
      req.log.warn({ err }, 'traffic digest preview failed')
      return reply.code(503).send({
        error: 'Traffic history could not be read right now',
        code: 'TRAFFIC_HISTORY_UNAVAILABLE'
      })
    }
  })
}
