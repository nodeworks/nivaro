import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { inferContractForEndpoint } from '../services/contract-inference.js'
import { apiSlo, apiUptime, probeApi } from '../services/external-api-health.js'
import { listRecorder, recorderDetail } from '../services/outbound-recorder.js'

/**
 * Outbound call tooling on an external API (admin): the flight recorder
 * (#626) with Copy as curl (#605), health probes + uptime (#612), SLOs
 * (#603) and contract-from-traffic (#623). Mounted under /external-apis.
 */
export async function externalApiObservabilityRoutes(app: FastifyInstance) {
  const apiExists = async (id: number) =>
    !!(await db('nivaro_external_apis').where({ id }).first('id'))

  // Flight recorder timeline — every outbound request this API made in the
  // window: partner calls, mocked answers, token fetches, probes, tests.
  app.get<{
    Params: { id: string }
    Querystring: { hours?: string; kind?: string; failed?: string; limit?: string }
  }>('/:id/recorder', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    if (!(await apiExists(id))) return reply.code(404).send({ error: 'Not found' })
    const rows = await listRecorder(id, {
      hours: Number(req.query.hours) || 24,
      kind: req.query.kind || undefined,
      failedOnly: req.query.failed === '1' || req.query.failed === 'true',
      limit: Number(req.query.limit) || 300
    })
    return { data: rows }
  })

  app.get<{ Params: { id: string; source: string; rowId: string } }>(
    '/:id/recorder/:source/:rowId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const source = req.params.source === 'side' ? 'side' : 'call'
      const row = await recorderDetail(Number(req.params.id), source, Number(req.params.rowId))
      if (!row) return reply.code(404).send({ error: 'Not found' })
      return { data: row }
    }
  )

  // Probe now — the same check the 5-minute cron runs.
  app.post<{ Params: { id: string } }>(
    '/:id/probe',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!(await apiExists(id))) return reply.code(404).send({ error: 'Not found' })
      const result = await probeApi(id, 'manual')
      await logActivity({
        action: 'external-api-probe',
        collection: 'nivaro_external_apis',
        item: String(id),
        user: req.user?.id,
        comment: result.skipped
          ? `skipped: ${result.skipped}`
          : `${result.ok ? 'ok' : 'failed'} — ${result.detail}`.slice(0, 500),
        req
      })
      return { data: result }
    }
  )

  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>(
    '/:id/uptime',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!(await apiExists(id))) return reply.code(404).send({ error: 'Not found' })
      const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24))
      const map = await apiUptime([id], hours)
      return { data: { hours, ...(map.get(id) ?? { buckets: [], uptime_pct: null, probes: 0 }) } }
    }
  )

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/:id/slo',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!(await apiExists(id))) return reply.code(404).send({ error: 'Not found' })
      return { data: await apiSlo(id, Number(req.query.days) || 7) }
    }
  )

  // A contract proposal from the endpoint's last successful answers. Nothing
  // is saved — the editor puts it in the contract box for the admin to keep.
  app.post<{ Params: { eid: string } }>(
    '/endpoints/:eid/contract/infer',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const eid = Number(req.params.eid)
      if (!Number.isInteger(eid)) return reply.code(400).send({ error: 'Bad endpoint id' })
      const exists = await db('nivaro_external_api_endpoints').where({ id: eid }).first('id')
      if (!exists) return reply.code(404).send({ error: 'Not found' })
      return { data: await inferContractForEndpoint(eid) }
    }
  )
}
