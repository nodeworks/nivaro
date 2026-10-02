// api/src/routes/traffic-map-extras/inspect-background.ts
import type { FastifyInstance } from 'fastify'
import {
  aiCallsForRequest,
  runForSource,
  submissionsFor
} from '../../services/traffic-inspect/background.js'
import { isUuid, parseRunSource } from '../../services/traffic-inspect/background-logic.js'
import { parseInspectAt, parseInspectWindow } from '../../services/traffic-inspect.js'

/**
 * Group "background" routes beyond the generic inspect ones (Traffic Map drill-down Task 5):
 *
 *   GET /traffic-map/inspect/ai-for-request/:rid          → { data: { calls, kept_days } }
 *   GET /traffic-map/inspect/job-for?source=&at=           → { data: { kind, id, covering } | null }
 *   GET /traffic-map/inspect/submissions-for?api=&chain=&at=&window=
 *                                                         → { data: { rows, matched_by } }
 *
 * Admin only and 404 in cloud mode (inherited). Ids are shape-checked before any query; a
 * failure answers a sentence, never the statement.
 */
const REQUEST_ID_RE = /^[0-9a-f-]{8,64}$/i

export async function inspectBackgroundRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { rid: string } }>('/inspect/ai-for-request/:rid', async (req, reply) => {
    const rid = String(req.params.rid ?? '')
    if (!REQUEST_ID_RE.test(rid)) {
      return reply
        .code(400)
        .send({ error: 'That is not a valid request id', code: 'INSPECT_ID_INVALID' })
    }
    try {
      return { data: await aiCallsForRequest(rid) }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map ai-for-request failed')
      return reply
        .code(500)
        .send({ error: 'The AI call log could not be read', code: 'INSPECT_FAILED' })
    }
  })

  app.get<{ Querystring: { source?: string; at?: string } }>(
    '/inspect/job-for',
    async (req, reply) => {
      const source = String(req.query.source ?? '')
      if (!parseRunSource(source)) {
        return reply.code(400).send({
          error: 'source must be cron:<job> or flow:<flow id>',
          code: 'INSPECT_ID_INVALID'
        })
      }
      const at = parseInspectAt(req.query.at) ?? Date.now()
      try {
        return { data: await runForSource(source, at) }
      } catch (err) {
        req.log.warn({ err }, 'traffic-map job-for failed')
        return reply
          .code(500)
          .send({ error: 'The run history could not be read', code: 'INSPECT_FAILED' })
      }
    }
  )

  app.get<{ Querystring: { api?: string; chain?: string; at?: string; window?: string } }>(
    '/inspect/submissions-for',
    async (req, reply) => {
      const rawApi = req.query.api
      const api =
        rawApi == null || rawApi === '' ? null : /^\d{1,9}$/.test(rawApi) ? Number(rawApi) : -1
      const chain = req.query.chain ? String(req.query.chain) : null
      if (api === -1 || (chain != null && !isUuid(chain)) || (api == null && chain == null)) {
        return reply.code(400).send({
          error: 'Give api=<external api id> and/or chain=<chain id>',
          code: 'INSPECT_ID_INVALID'
        })
      }
      try {
        return {
          data: await submissionsFor({
            apiId: api,
            chainId: chain,
            at: parseInspectAt(req.query.at),
            windowSec: parseInspectWindow(req.query.window)
          })
        }
      } catch (err) {
        req.log.warn({ err }, 'traffic-map submissions-for failed')
        return reply
          .code(500)
          .send({ error: 'The partner push log could not be read', code: 'INSPECT_FAILED' })
      }
    }
  )
}
