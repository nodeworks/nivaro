import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { runReadinessChecks } from '../services/readiness.js'

/** Run every registered readiness check and score the result. Read-only —
 *  a scorecard someone refreshes, deliberately unlogged. */
export async function readinessRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAdmin }, async () => {
    return { data: await runReadinessChecks() }
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
