import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import {
  BackgroundRunError,
  estimateRead,
  getRun,
  getRunResult,
  listRuns,
  matchReplayable,
  publicRun,
  type StartInput,
  slowThresholdMs,
  startBackgroundRun
} from '../services/background-runs.js'

/**
 * /api/background-runs — slow reads handed to the server (#2759).
 *
 *   GET  /estimate?method=&url=  how long this read typically takes and whether it is slow
 *   POST /                       {method, url, body?, label?, href?} → 202 {data: run}
 *   GET  /                       the caller's runs (newest first)
 *   GET  /:id                    one of the caller's runs
 *   GET  /:id/result             the finished response, exactly as the route answered it
 *
 * Every run belongs to the person who started it: another person's id answers 404. The read
 * itself is replayed AS the caller, so its own route decides access and scope.
 */
export async function backgroundRunsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/estimate', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as { method?: string; url?: string }
    const target = matchReplayable(String(q.method ?? 'POST'), String(q.url ?? ''))
    if (!target) return reply.code(400).send({ error: 'That read cannot run in the background' })
    const est = await estimateRead(target.kind, target.subject, app.redis ?? null)
    return { data: { ...est, threshold_ms: slowThresholdMs() } }
  })

  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { run, joined } = await startBackgroundRun(app, req, (req.body ?? {}) as StartInput)
      return reply.code(joined ? 200 : 202).send({ data: { ...publicRun(run), joined } })
    } catch (err) {
      if (err instanceof BackgroundRunError)
        return reply.code(err.statusCode).send({ error: err.message })
      throw err
    }
  })

  app.get('/', { preHandler: requireAuth }, async (req) => {
    const runs = await listRuns(app.redis ?? null, req.user!.id)
    return { data: runs.map(publicRun) }
  })

  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const run = await getRun(app.redis ?? null, req.params.id)
    if (!run || run.user !== req.user!.id) return reply.code(404).send({ error: 'Not found' })
    return { data: publicRun(run) }
  })

  app.get<{ Params: { id: string } }>(
    '/:id/result',
    { preHandler: requireAuth },
    async (req, reply) => {
      const run = await getRun(app.redis ?? null, req.params.id)
      if (!run || run.user !== req.user!.id) return reply.code(404).send({ error: 'Not found' })
      if (run.status === 'running')
        return reply.code(409).send({ error: 'Still running', code: 'BACKGROUND_RUN_RUNNING' })
      if (run.status === 'error') return reply.code(422).send({ error: run.error ?? 'Failed' })
      const body = run.result_kept ? await getRunResult(app.redis ?? null, run.id) : null
      if (body == null)
        return reply
          .code(410)
          .send({ error: 'The result is no longer kept — run it again', code: 'RESULT_GONE' })
      return reply.type('application/json').send(body)
    }
  )
}
