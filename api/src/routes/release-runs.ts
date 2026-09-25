import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  cancelRun,
  currentRun,
  isAvailable,
  listRuns,
  parseEvents,
  RunLockedError,
  readLogChunk,
  readRun,
  runPlan,
  startRun,
  validateStartBody
} from '../services/release-runs.js'

const UNAVAILABLE = { error: 'Release runs are not available here' }
const NO_SUCH_RUN = { error: 'No such run' }
const RUN_ID_RE = /^[a-f0-9-]{36}$/i

/**
 * /api/release — the admin's Release button. Local development only: it needs
 * the git checkouts and credentials on this machine, so every route answers
 * 404 unless the API runs from a source checkout with scripts/release-chain.mjs
 * and release-chain.config.json present. Inputs are enums only; the child is
 * started with a fixed argument list and no shell.
 */
export async function releaseRunsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  const available = () => isAvailable(config.NODE_ENV)
  const tail = (s: string) => s.slice(-4000)

  app.get('/status', async () => {
    if (!available()) return { available: false, current: null, runs: [] }
    const [current, runs] = await Promise.all([currentRun(), listRuns(10)])
    return { available: true, current, runs }
  })

  app.post('/plan', async (_req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    const r = await runPlan()
    if (!r.ok || !r.plan)
      return reply.code(502).send({ error: 'release-chain plan failed', log_tail: tail(r.log) })
    return { plan: r.plan, log_tail: tail(r.log) }
  })

  app.post('/runs', async (req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    const v = validateStartBody(req.body)
    if (!v.ok) return reply.code(400).send({ error: v.error })
    const user = req.user!.id
    try {
      const run = await startRun({ mode: 'go', args: v.args, user })
      await logActivity({
        action: 'release-run-start',
        user,
        collection: 'release',
        item: run.id,
        comment: v.args.join(' '),
        req
      })
      return reply.code(201).send({ run })
    } catch (err) {
      if (err instanceof RunLockedError)
        return reply.code(409).send({ error: err.message, current: err.current ?? null })
      throw err
    }
  })

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/runs/:id',
    async (req, reply) => {
      if (!available()) return reply.code(404).send(UNAVAILABLE)
      if (!RUN_ID_RE.test(req.params.id)) return reply.code(404).send(NO_SUCH_RUN)
      const r = await readRun(req.params.id)
      if (!r) return reply.code(404).send(NO_SUCH_RUN)
      // `after` is the previous response's next_offset: an index into the log string.
      const after = Number(req.query.after ?? 0)
      const offset = Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0
      const { chunk, next_offset } = readLogChunk(r.log, offset)
      const { events, plan } = parseEvents(r.log)
      return { run: r.run, events, plan, log_chunk: chunk, next_offset }
    }
  )

  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    if (!RUN_ID_RE.test(req.params.id)) return reply.code(404).send(NO_SUCH_RUN)
    const run = await cancelRun(req.params.id)
    if (!run) return reply.code(404).send(NO_SUCH_RUN)
    await logActivity({
      action: 'release-run-cancel',
      user: req.user!.id,
      collection: 'release',
      item: run.id,
      req
    })
    return { run }
  })
}
