import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Ops assistant (#1967, #2015, #2016) — administrators only:
 *  - GET  /proposals/:id          an approval card's state
 *  - POST /proposals/:id/approve  run the proposed action AS THE APPROVER (its own admin route)
 *  - POST /proposals/:id/dismiss
 *  - GET  /channel · PUT /channel the admin-only chat channel incident threads open in
 *  - GET  /incident               incident mode now + recent threads
 *  - POST /incident {on, title?, reason?}  turn incident mode on / off
 *  - GET  /status?section=        the facts the chat tools read (for the console)
 */
export async function opsAssistantRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Params: { id: string } }>('/proposals/:id', async (req, reply) => {
    const { loadProposal, proposalCard } = await import('../services/ops-proposals.js')
    const p = await loadProposal(app, req.params.id)
    if (!p) return reply.code(404).send({ error: 'This proposal has expired or does not exist' })
    return { data: proposalCard(p) }
  })

  for (const decision of ['approve', 'dismiss'] as const) {
    app.post<{ Params: { id: string } }>(`/proposals/:id/${decision}`, async (req, reply) => {
      const { decideProposal, ProposalError, proposalCard } = await import(
        '../services/ops-proposals.js'
      )
      try {
        const p = await decideProposal(app, req, req.params.id, decision)
        return { data: proposalCard(p) }
      } catch (err) {
        if (err instanceof ProposalError)
          return reply.code(err.statusCode).send({ error: err.message })
        throw err
      }
    })
  }

  app.get('/channel', async () => {
    const { opsChannel } = await import('../services/ops-incidents.js')
    const { opsRoomVerdict } = await import('../services/ops-assistant.js')
    const room = await opsChannel()
    return { data: { room, verdict: room ? await opsRoomVerdict(room) : null } }
  })

  app.put<{ Body: { room?: string | null } }>('/channel', async (req, reply) => {
    const { setOpsChannel } = await import('../services/ops-incidents.js')
    const room =
      typeof req.body?.room === 'string' && req.body.room.trim() ? req.body.room.trim() : null
    try {
      await setOpsChannel(room)
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      if (code) return reply.code(code).send({ error: (err as Error).message })
      throw err
    }
    const { logActivity } = await import('../services/activity.js')
    await logActivity({
      action: 'ops-channel-set',
      user: req.user?.id,
      comment: room ?? '(none)',
      req
    })
    return { data: { room } }
  })

  app.get('/incident', async () => {
    const { currentIncident, recentIncidents } = await import('../services/ops-incidents.js')
    return { data: { current: await currentIncident(), recent: await recentIncidents(10) } }
  })

  app.post<{ Body: { on?: boolean; title?: string | null; reason?: string | null } }>(
    '/incident',
    async (req, reply) => {
      const { endIncident, IncidentError, startIncident } = await import(
        '../services/ops-incidents.js'
      )
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null
      try {
        const row =
          req.body?.on === false
            ? await endIncident(app, req.user!, reason)
            : await startIncident(app, req.user!, req.body?.title ?? null, reason)
        return { data: row }
      } catch (err) {
        if (err instanceof IncidentError)
          return reply.code(err.statusCode).send({ error: err.message })
        throw err
      }
    }
  )

  app.get<{ Querystring: { section?: string } }>('/status', async (req) => {
    const { opsFacts, OPS_SECTIONS } = await import('../services/ops-assistant.js')
    const section = (OPS_SECTIONS as readonly string[]).includes(String(req.query.section))
      ? (req.query.section as (typeof OPS_SECTIONS)[number])
      : 'overview'
    return { data: await opsFacts(app, section) }
  })
}
