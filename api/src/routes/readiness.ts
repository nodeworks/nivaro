import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { listRemediations, readReadiness, startRemediation } from '../services/readiness.js'

/** The scored readiness checklist. Read-only — a scorecard someone refreshes,
 *  deliberately unlogged. Default: the stored results (each with its
 *  computed_at; stale ones refresh in the background). `?fresh=1`: every check
 *  live — the deploy gate, the pre-deploy snapshot and the Re-run button. */
export async function readinessRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { fresh?: string } }>('/', { preHandler: requireAdmin }, async (req) => {
    const fresh = ['1', 'true', 'yes'].includes(String(req.query?.fresh ?? '').toLowerCase())
    return { data: await readReadiness({ fresh }) }
  })

  /** Fire a check's automatic fix as a background job; poll /remediations. */
  app.post<{ Params: { id: string } }>(
    '/:id/remediate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const result = startRemediation(req.params.id, req.user?.id ?? null)
      if (result === 'no_remediation') {
        return reply.code(400).send({ error: 'This check has no automatic fix' })
      }
      if (result === 'already_running') {
        return reply.code(409).send({ error: 'A fix is already running for this check' })
      }
      await logActivity({
        action: 'readiness-remediate',
        user: req.user?.id,
        collection: 'nivaro_readiness_snapshots',
        comment: req.params.id,
        req
      })
      return reply.code(202).send({ data: { started: true } })
    }
  )

  app.get('/remediations', { preHandler: requireAdmin }, async () => {
    return { data: listRemediations() }
  })

  /** Daily score history (the 06:50 snapshot cron) — the trend toward 100%. */
  app.get('/trend', { preHandler: requireAdmin }, async () => {
    const { db } = await import('../db/index.js')
    const rows = await db('nivaro_readiness_snapshots')
      .orderBy('snapshot_date', 'desc')
      .limit(60)
      .select('snapshot_date', 'score', 'counts')
    return { data: rows.reverse() }
  })
}
