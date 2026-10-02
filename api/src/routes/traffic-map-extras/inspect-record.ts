import type { FastifyPluginAsync } from 'fastify'
// Loads the group's inspect sources (they register at module load).
import { recordingFor } from '../../services/traffic-inspect/record.js'
import { UUID_RE } from '../../services/traffic-inspect/record-logic.js'

/**
 * Group "record" routes beyond the generic inspect ones (admin only, 404 in cloud mode — both
 * inherited from the traffic-map extras plugin):
 *
 *   GET /traffic-map/inspect/recording-for?user=<uuid>&at=<epoch ms>
 *     → { data: { found: true, recording_id, offset_ms, clip, distance_ms }
 *               | { found: false, none: true, reason } }
 *     The live or ended recording covering that moment (started_at ≤ at ≤ last event), else the
 *     nearest error clip within ±2 min, else none with the reason.
 */
export const inspectRecordRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { user?: string; at?: string } }>(
    '/inspect/recording-for',
    async (req, reply) => {
      const user = String(req.query.user ?? '')
      if (!UUID_RE.test(user))
        return reply
          .code(400)
          .send({ error: 'user must be a user id (uuid)', code: 'INSPECT_ID_INVALID' })
      const at = Number(req.query.at)
      if (!Number.isFinite(at) || at <= 0)
        return reply
          .code(400)
          .send({ error: 'at must be a time in epoch milliseconds', code: 'INSPECT_ID_INVALID' })
      try {
        const pick = await recordingFor(user, Math.round(at))
        if (!pick.found) return { data: { found: false, none: true, reason: pick.reason } }
        return {
          data: {
            found: true,
            recording_id: pick.id,
            offset_ms: pick.offset_ms,
            clip: pick.clip,
            distance_ms: pick.distance_ms
          }
        }
      } catch (err) {
        req.log.warn({ err }, 'traffic-map recording-for failed')
        return reply
          .code(500)
          .send({ error: 'Could not look up recordings', code: 'INSPECT_FAILED' })
      }
    }
  )
}
