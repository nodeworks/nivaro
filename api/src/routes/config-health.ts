import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { runConfigHealthSweep } from '../services/config-health.js'

/** Config health: findings list + dismiss + run-now. Admin-only. */
export async function configHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (req) => {
    const q = req.query as { family?: string; include_dismissed?: string }
    let query = db('nivaro_config_health').orderBy([
      { column: 'severity', order: 'desc' },
      { column: 'id', order: 'asc' }
    ])
    if (q.family === 'hygiene' || q.family === 'lint') query = query.where('family', q.family)
    if (q.include_dismissed !== 'true') query = query.where('status', 'open')
    const rows = await query
    const counts = (await db('nivaro_config_health')
      .groupBy('family', 'status')
      .count({ c: '*' })
      .select('family', 'status')) as Array<{ family: string; status: string; c: number }>
    return { data: rows, counts }
  })

  app.post('/run', async (req) => {
    const { startJobRun } = await import('../services/job-runs.js')
    const run = await startJobRun('cron', 'config-health-sweep', { triggeredBy: req.user?.id ?? null })
    try {
      const outcome = await runConfigHealthSweep()
      await run.complete(outcome)
      await logActivity({ action: 'config-health-run', user: req.user?.id, comment: outcome, req })
      return { data: { outcome } }
    } catch (err) {
      await run.fail(err)
      throw err
    }
  })

  app.post<{ Params: { id: string } }>('/:id/dismiss', async (req, reply) => {
    const row = await db('nivaro_config_health').where('id', req.params.id).first('id', 'status')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const next = row.status === 'dismissed' ? 'open' : 'dismissed'
    await db('nivaro_config_health')
      .where('id', row.id)
      .update({ status: next, dismissed_by: next === 'dismissed' ? (req.user?.id ?? null) : null })
    return { data: { status: next } }
  })
}
