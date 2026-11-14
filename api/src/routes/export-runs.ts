import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { cancelExportRun, getExportRun } from '../services/export-runs.js'

/**
 * /api/export-runs — background exports (services/export-runs.ts).
 *
 *   GET  /:id          the caller's run: status, rows done / total, file_id once ready
 *   POST /:id/cancel   stop it (its starter, or an administrator)
 *
 * Runs are started by the export endpoints themselves (`background=auto|1`): export presets,
 * GET /items/:collection/export, the audit report's CSV. Another person's run answers 404.
 */
export async function exportRunsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const run = await getExportRun(req.user!.id, Number(req.params.id))
    if (!run) return reply.code(404).send({ error: 'Not found' })
    reply.header('Cache-Control', 'no-store')
    return { data: run }
  })

  app.post<{ Params: { id: string } }>(
    '/:id/cancel',
    { preHandler: requireAuth },
    async (req, reply) => {
      const outcome = await cancelExportRun(app, req.user!, Number(req.params.id), !!req.isAdmin)
      if (outcome === 'not_found') return reply.code(404).send({ error: 'Not found' })
      return { data: { outcome } }
    }
  )
}
