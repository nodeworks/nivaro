import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { extensionRunbooks } from '../extensions/loader.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { readLogChunk } from '../services/release-runs.js'
import {
  cancelRunbookRun,
  dryRunGate,
  listRunbookRuns,
  parseRunbookLog,
  RunbookLockedError,
  readRunbookRun,
  runbooksAvailable,
  startRunbookRun,
  stepStates,
  validateTarget
} from '../services/runbook-runs.js'

const UNAVAILABLE = { error: 'Runbooks are not available here' }
const RUN_ID = /^[a-f0-9-]{36}$/

/**
 * /api/runbooks — the admin Runbooks console (#720): run and watch an
 * operator script an extension declared (EFP's go-live chain is one).
 * Local development only; every route answers 404 elsewhere.
 */
export async function runbookRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  const available = () => runbooksAvailable(config.NODE_ENV)
  const find = (ext: string, key: string) =>
    (extensionRunbooks.get(ext) ?? []).find((d) => d.key === key) ?? null

  app.get('/', async () => {
    if (!available()) return { available: false, runbooks: [], runs: [], current: null }
    const runs = await listRunbookRuns(30)
    const runbooks = [...extensionRunbooks].flatMap(([extension, list]) =>
      list.map((d) => ({
        extension,
        key: d.key,
        label: d.label,
        description: d.description ?? null,
        target_env: d.target_env ?? null,
        refuse_targets: d.refuse_targets ?? [],
        resumable: !!d.resume_flag,
        // Each target's freshest finished dry run: the gate for a real run.
        dry_runs: runs
          .filter(
            (r) =>
              r.extension === extension &&
              r.runbook === d.key &&
              r.mode === 'dry' &&
              r.state === 'done'
          )
          .map((r) => ({
            id: r.id,
            target: r.target,
            finished_at: r.finished_at ?? r.started_at,
            summary: r.summary
          }))
      }))
    )
    return {
      available: true,
      runbooks,
      runs,
      current: runs.find((r) => r.state === 'running') ?? null
    }
  })

  app.post<{
    Params: { ext: string; key: string }
    Body: { mode?: string; target?: string; confirm?: string; resume?: boolean }
  }>('/:ext/:key/runs', async (req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    const decl = find(req.params.ext, req.params.key)
    if (!decl) return reply.code(404).send({ error: 'No such runbook' })
    const mode = req.body?.mode === 'go' ? 'go' : req.body?.mode === 'dry' ? 'dry' : null
    if (!mode) return reply.code(400).send({ error: 'mode must be dry or go' })
    const t = validateTarget(decl, req.body?.target)
    if (!t.ok) return reply.code(400).send({ error: t.error })
    let resumeFrom: string | undefined
    if (mode === 'go') {
      const runs = await listRunbookRuns(100)
      if (!dryRunGate(runs, req.params.ext, decl.key, t.target))
        return reply.code(409).send({
          error: `Run the dry run against ${t.target ?? 'this runbook'} first — a real run needs a finished dry run from the last 24 hours`
        })
      const expected = t.target ?? decl.key
      if (req.body?.confirm !== expected)
        return reply.code(400).send({ error: `type ${expected} to confirm` })
      if (req.body?.resume) {
        if (!decl.resume_flag) return reply.code(400).send({ error: 'this runbook cannot resume' })
        const newest = runs.find(
          (r) =>
            r.extension === req.params.ext &&
            r.runbook === decl.key &&
            r.mode === 'go' &&
            (r.target ?? null) === t.target
        )
        if (newest?.state !== 'failed' || !newest.failed_step)
          return reply
            .code(409)
            .send({ error: 'only a real run that failed at a step can be resumed' })
        resumeFrom = newest.failed_step
      }
    }
    const user = req.user!.id
    try {
      const run = await startRunbookRun({
        extension: req.params.ext,
        decl,
        mode,
        target: t.target,
        resumeFrom,
        user
      })
      await logActivity({
        action: 'runbook-run-start',
        user,
        collection: 'runbooks',
        item: run.id,
        comment: `${req.params.ext}:${decl.key} ${mode}${t.target ? ` → ${t.target}` : ''}${resumeFrom ? ` from ${resumeFrom}` : ''}`,
        req
      })
      return reply.code(201).send({ run })
    } catch (err) {
      if (err instanceof RunbookLockedError)
        return reply.code(409).send({ error: err.message, current: err.current })
      throw err
    }
  })

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/runs/:id',
    async (req, reply) => {
      if (!available()) return reply.code(404).send(UNAVAILABLE)
      if (!RUN_ID.test(req.params.id)) return reply.code(404).send({ error: 'No such run' })
      const r = await readRunbookRun(req.params.id)
      if (!r) return reply.code(404).send({ error: 'No such run' })
      const after = Number(req.query.after ?? 0)
      const { chunk, next_offset } = readLogChunk(
        r.log,
        Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0
      )
      const { steps, events } = parseRunbookLog(r.log)
      return {
        run: r.run,
        steps: stepStates(steps, events, r.run.state),
        log_chunk: chunk,
        next_offset
      }
    }
  )

  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    if (!RUN_ID.test(req.params.id)) return reply.code(404).send({ error: 'No such run' })
    const run = await cancelRunbookRun(req.params.id)
    if (!run) return reply.code(404).send({ error: 'No such run' })
    await logActivity({
      action: 'runbook-run-cancel',
      user: req.user!.id,
      collection: 'runbooks',
      item: run.id,
      req
    })
    return { run }
  })
}
