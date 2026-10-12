import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'

/**
 * GET /users/:id/activity-summary?days=7&ai=1 (#1968) — what a person did
 * this week, for administrators and the person's own manager only. Every
 * count and record is narrowed to what the viewer may read
 * (services/person-activity-summary.ts). `ai=1` adds a few plain lines
 * written from that narrowed payload.
 */
export async function personSummaryRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { days?: string; ai?: string } }>(
    '/:id/activity-summary',
    { preHandler: authenticate },
    async (req, reply) => {
      const viewer = req.user!
      const id = req.params.id === 'me' ? String(viewer.id) : req.params.id
      if (!/^[0-9A-Fa-f-]{36}$/.test(id)) return reply.code(404).send({ error: 'Not found' })
      if (!req.isAdmin) {
        const { isManagerOf } = await import('../services/team.js')
        if (!(await isManagerOf(String(viewer.id), id)))
          return reply.code(403).send({
            error: "Only administrators and this person's manager can see their activity summary",
            code: 'NOT_THEIR_MANAGER'
          })
      }
      const days = Math.min(31, Math.max(1, Math.round(Number(req.query.days) || 7)))
      const { buildPersonWeek, summarizePersonWeek } = await import(
        '../services/person-activity-summary.js'
      )
      const week = await buildPersonWeek(viewer, id, days)
      if (!week) return reply.code(404).send({ error: 'Not found' })
      let summary: string | null = null
      if (req.query.ai === '1') {
        summary = await summarizePersonWeek(week).catch((err) => {
          req.log.warn({ err }, 'person activity summary failed')
          return null
        })
        const { logActivity } = await import('../services/activity.js')
        await logActivity({
          action: 'person-activity-summary',
          user: viewer.id,
          collection: 'nivaro_users',
          item: id,
          comment: `${days} days`,
          req
        })
      }
      return reply.send({ data: { ...week, summary } })
    }
  )
}
