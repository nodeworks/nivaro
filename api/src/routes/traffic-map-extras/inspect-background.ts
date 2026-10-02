// api/src/routes/traffic-map-extras/inspect-background.ts
import type { FastifyInstance } from 'fastify'
import {
  aiCallsForRequest,
  apisOfDownNode,
  flowDryRun,
  runForSource,
  submissionsFor
} from '../../services/traffic-inspect/background.js'
import { isUuid, parseRunSource } from '../../services/traffic-inspect/background-logic.js'
import { parseInspectAt, parseInspectWindow } from '../../services/traffic-inspect.js'

/**
 * Group "background" routes beyond the generic inspect ones (Traffic Map drill-down Task 5):
 *
 *   GET  /traffic-map/inspect/ai-for-request/:rid          → { data: { calls, kept_days } }
 *   GET  /traffic-map/inspect/job-for?source=&at=           → { data: { kind, id, covering } | null }
 *   GET  /traffic-map/inspect/submissions-for?node=&api=&chain=&at=&window=
 *                                                          → { data: { rows, matched_by, reason } }
 *   POST /traffic-map/inspect/flow-dry-run/:runId          → { data: { steps, output, error } }
 *
 * Admin only and 404 in cloud mode (inherited). Ids are shape-checked before any query; a
 * failure answers a sentence, never the statement. The dry run takes no body: the server reads
 * the run's stored payload itself, so the client never posts back the masked view it was shown.
 */
const REQUEST_ID_RE = /^[0-9a-f-]{8,64}$/i
/** A partner down node: `ext:<api id>` or an extension-declared `x:<extension>.<id>`. */
const DOWN_NODE_RE = /^(ext:\d{1,9}|x:[A-Za-z0-9][A-Za-z0-9_.:-]{0,120})$/

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

  app.get<{
    Querystring: { node?: string; api?: string; chain?: string; at?: string; window?: string }
  }>('/inspect/submissions-for', async (req, reply) => {
    const rawApi = req.query.api
    const api =
      rawApi == null || rawApi === '' ? null : /^\d{1,9}$/.test(rawApi) ? Number(rawApi) : -1
    const chain = req.query.chain ? String(req.query.chain) : null
    const node = req.query.node ? String(req.query.node) : null
    if (
      api === -1 ||
      (chain != null && !isUuid(chain)) ||
      (node != null && !DOWN_NODE_RE.test(node)) ||
      (api == null && chain == null && node == null)
    ) {
      return reply.code(400).send({
        error: 'Give node=<partner node id>, api=<external api id> and/or chain=<chain id>',
        code: 'INSPECT_ID_INVALID'
      })
    }
    try {
      let apiIds: number[] = []
      let reason: string | null = null
      if (node) {
        const resolved = await apisOfDownNode(node)
        apiIds = resolved.ids
        reason = resolved.reason
      }
      const found = await submissionsFor({
        apiId: api,
        apiIds,
        chainId: chain,
        at: parseInspectAt(req.query.at),
        windowSec: parseInspectWindow(req.query.window)
      })
      return { data: { ...found, reason: found.matched_by == null ? reason : null } }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map submissions-for failed')
      return reply
        .code(500)
        .send({ error: 'The partner push log could not be read', code: 'INSPECT_FAILED' })
    }
  })

  app.post<{ Params: { runId: string } }>('/inspect/flow-dry-run/:runId', async (req, reply) => {
    const runId = String(req.params.runId ?? '')
    if (!isUuid(runId)) {
      return reply
        .code(400)
        .send({ error: 'That is not a valid flow run id', code: 'INSPECT_ID_INVALID' })
    }
    try {
      const result = await flowDryRun(runId, { userId: req.user?.id, log: req.log })
      if (!result) {
        return reply.code(404).send({
          error: 'No such flow run, or its flow was deleted',
          code: 'INSPECT_NOT_FOUND'
        })
      }
      return { data: result }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map flow-dry-run failed')
      return reply.code(500).send({ error: 'The dry run could not start', code: 'INSPECT_FAILED' })
    }
  })
}
