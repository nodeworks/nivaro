import type { FastifyInstance } from 'fastify'
import { attentionForRequest } from '../services/command-center/attention.js'
import { ccCredKey, ccIsAdmin, ccReadAuth, ccWriteAuth } from '../services/command-center/auth.js'
import { flowForRequest } from '../services/command-center/flow.js'
import { forecastForRequest } from '../services/command-center/forecast.js'
import { liveNudgeDeps, runNudge } from '../services/command-center/nudge.js'
import { readCcScope } from '../services/command-center/scope.js'
import { tenantMemo } from '../services/command-center/work-access.js'
import { WorkloadForbidden, workloadForRequest } from '../services/command-center/workload.js'

/**
 * Command Center — work & actions (program slice 2), mounted under /command-center:
 *   GET  /flow       per-state depth: ages, stuck, 7-day change, clears in (CC-9)
 *   GET  /attention  ranked "needs attention" list with actions (CC-6)
 *   GET  /workload   open owned vs usual per person — admins + managers (CC-32)
 *   GET  /forecast   today's arrivals / completions vs the usual curve (CC-33; ?tz=)
 *   POST /nudge      notify a record's current owners, once per 30 min (CC-30)
 * Every read is as the caller (services/command-center/work-access.ts). Bulk reassign, approve
 * and transitions run from the board through the app's existing routes, never from here.
 */
export async function commandCenterWorkRoutes(app: FastifyInstance) {
  app.addHook('preHandler', ccReadAuth)

  const viewerKey = (req: import('fastify').FastifyRequest, name: string) => {
    const s = readCcScope(req.query)
    return `${name}:${String(req.user!.id).toUpperCase()}:${ccCredKey(req)}:${ccIsAdmin(req) ? 'a' : 'u'}:${s.region ?? ''}:${
      s.at ? Math.floor(s.at.getTime() / 60_000) : 'live'
    }`
  }

  app.get('/flow', async (req, reply) => {
    const data = await tenantMemo(viewerKey(req, 'cc:flow'), 30_000, () => flowForRequest(req))
    return reply.send({ data: data ?? [] })
  })

  app.get('/attention', async (req, reply) => {
    const out = await tenantMemo(viewerKey(req, 'cc:attention'), 30_000, () =>
      attentionForRequest(req)
    )
    return reply.send({
      data: out?.items ?? [],
      meta: { live_only: out?.live_only ?? false, region_applies: out?.region_applies ?? null }
    })
  })

  app.get('/workload', { config: { ccNoKiosk: true } }, async (req, reply) => {
    try {
      const out = await workloadForRequest(app, req)
      return reply.send({
        data: out.rows,
        meta: { region_applies: out.region_applies, truncated: out.truncated }
      })
    } catch (err) {
      if (err instanceof WorkloadForbidden) return reply.code(403).send({ error: err.message })
      throw err
    }
  })

  app.get('/forecast', async (req, reply) => {
    return reply.send({ data: await forecastForRequest(req) })
  })

  app.post('/nudge', { preHandler: ccWriteAuth }, async (req, reply) => {
    const r = await runNudge(req.user!, ccIsAdmin(req), req.body, liveNudgeDeps(app, req))
    return reply.code(r.status).send(r.body)
  })
}
