import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── Cron administration ─────────────────────────────────────────────────────
// Scheduled jobs (core + extension-registered) were previously only observable
// from the process itself. These routes let an admin see what is scheduled and
// re-run a job out of band — the operator need after a nightly job fails, and
// the only practical way to exercise a cron-driven integration on demand.

export async function cronRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAdmin }, async () => {
    return { data: app.cron.list() }
  })

  // #198 — pause/resume a cron without a deploy. Persisted in
  // settings.paused_crons so a restart keeps the choice; the schedule itself
  // stays registered so resume is instant.
  for (const action of ['pause', 'resume'] as const) {
    app.post<{ Params: { id: string } }>(
      `/:id/${action}`,
      { preHandler: requireAdmin },
      async (req, reply) => {
        const { id } = req.params
        if (!app.cron.list().some((j) => j.id === id)) {
          return reply.code(404).send({ error: 'No scheduled job with that id' })
        }
        if (action === 'pause') app.cron.pause(id)
        else app.cron.resume(id)
        const { db } = await import('../db/index.js')
        const paused = app.cron.list().filter((j) => j.paused).map((j) => j.id)
        await db('nivaro_settings')
          .orderBy('id', 'asc')
          .first('id')
          .then((row) =>
            row
              ? db('nivaro_settings').where({ id: row.id }).update({ paused_crons: JSON.stringify(paused) })
              : null
          )
          .catch(() => {})
        await logActivity({ action: `cron-${action}`, user: req.user?.id, req, comment: id })
        return { data: { id, paused: action === 'pause' } }
      }
    )
  }

  app.post<{ Params: { id: string } }>(
    '/:id/run',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const known = app.cron.list().some((j) => j.id === id)
      if (!known) return reply.code(404).send({ error: 'No scheduled job with that id' })

      const startedAt = Date.now()
      try {
        await app.cron.runNow(id, req.user?.id ?? null)
        await logActivity({
          action: 'cron-run-now',
          user: req.user?.id,
          req,
          comment: `${id} (${Date.now() - startedAt}ms)`
        })
        return { data: { id, ran: true, duration_ms: Date.now() - startedAt } }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await logActivity({
          action: 'cron-run-now-failed',
          user: req.user?.id,
          req,
          comment: `${id}: ${message.slice(0, 300)}`
        })
        return reply.code(500).send({ error: message })
      }
    }
  )
}
