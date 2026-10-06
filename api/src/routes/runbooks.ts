import type { ExtensionRunbookDecl } from '@nivaro/extension-kit'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { extensionRunbooks } from '../extensions/loader.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { readLogChunk } from '../services/release-runs.js'
import { needsDryRun } from '../services/runbook-admission.js'
import { liveEstimate, planEstimate, stallAfterSecs } from '../services/runbook-estimate.js'
import {
  cancelHostRun,
  type HostRunSummary,
  hostQueueAvailable,
  lastLineAt,
  listAgents,
  listHostRuns,
  parseEvents,
  queueHostRun,
  readHostLines,
  readHostRun,
  readTimings,
  summarizeHostRun
} from '../services/runbook-queue.js'
import {
  cancelRunbookRun,
  dryRunGate,
  listRunbookRuns,
  parseRunbookLog,
  RunbookLockedError,
  readRunbookRun,
  runbookArgv,
  runbooksAvailable,
  startRunbookRun,
  stepStates,
  validateTarget
} from '../services/runbook-runs.js'

const UNAVAILABLE = { error: 'Runbooks are not available here' }
const RUN_ID = /^[a-f0-9-]{36}$/i // host run ids come back upper-case from SQL Server
/** The cron line that installs the host agent, shown when no agent checks in. */
const AGENT_CRON =
  '* * * * * bash -lc \'cd <checkout>/api && . "$HOME/.nvm/nvm.sh" >/dev/null && npx tsx src/scripts/runbook-agent.ts --once\' >> <checkout>/logs/runbook-agent.log 2>&1'

type Decl = ExtensionRunbookDecl & { extension: string }

/**
 * /api/runbooks — the admin Runbooks console (#720): run and watch an
 * operator script an extension declared (EFP's go-live chain is one).
 * `local` runbooks run on this machine and exist only in local development;
 * `host` runbooks are queued from any instance and run by the host agent
 * (scripts/runbook-agent.ts) on the machine that checked in for them.
 */
export async function runbookRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  const localAvailable = () => runbooksAvailable(config.NODE_ENV)
  const decls = (): Decl[] =>
    [...extensionRunbooks].flatMap(([extension, list]) => list.map((d) => ({ ...d, extension })))
  const visible = (): Decl[] =>
    decls().filter((d) => (d.runs_on === 'host' ? true : localAvailable()))
  const find = (ext: string, key: string) =>
    visible().find((d) => d.extension === ext && d.key === key) ?? null
  const hasHost = () => decls().some((d) => d.runs_on === 'host')

  async function allRuns() {
    const local = localAvailable()
      ? (await listRunbookRuns(30)).map((r) => ({ ...r, source: 'local' as const }))
      : []
    const host = hasHost() ? await listHostRuns(50) : []
    return { local, host }
  }

  app.get('/', async () => {
    const list = visible()
    if (list.length === 0)
      return { available: false, runbooks: [], runs: [], current: null, agents: [] }
    const { local, host } = await allRuns()
    const agents = hasHost() ? await listAgents() : []
    const runs = [...local, ...host].sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
    const runbooks = await Promise.all(
      list.map(async (d) => {
        const own = d.runs_on === 'host' ? host : local
        const mine = own.filter((r) => r.extension === d.extension && r.runbook === d.key)
        const phases = d.phases ?? []
        const timings =
          d.runs_on === 'host' && phases.length ? await readTimings(d.extension, d.key) : []
        return {
          extension: d.extension,
          key: d.key,
          label: d.label,
          description: d.description ?? null,
          runs_on: d.runs_on === 'host' ? 'host' : 'local',
          phases,
          // Typical durations from history (per phase and from each start), per mode.
          typical: phases.length
            ? {
                go: planEstimate(phases, timings, 'go'),
                dry: planEstimate(phases, timings, 'dry')
              }
            : null,
          target_env: d.target_env ?? null,
          refuse_targets: d.refuse_targets ?? [],
          resumable: !!d.resume_flag,
          // A host runbook that a queued or running run already holds.
          active:
            d.runs_on === 'host'
              ? (mine.find((r) => r.state === 'queued' || r.state === 'running') ?? null)
              : null,
          agents:
            d.runs_on === 'host'
              ? agents
                  .filter((a) => a.runbooks.includes(`${d.extension}:${d.key}`))
                  .map((a) => ({ host: a.host, last_seen: a.last_seen, online: a.online }))
              : [],
          // Each target's freshest finished dry run: the gate for a real run.
          dry_runs: mine
            .filter((r) => r.mode === 'dry' && r.state === 'done')
            .map((r) => ({
              id: r.id,
              target: r.target,
              finished_at: r.finished_at ?? r.started_at,
              summary: r.summary
            }))
        }
      })
    )
    return {
      available: true,
      runbooks,
      runs,
      current: local.find((r) => r.state === 'running') ?? null,
      agents,
      agent_cron: AGENT_CRON
    }
  })

  app.post<{
    Params: { ext: string; key: string }
    Body: { mode?: string; target?: string; confirm?: string; resume?: boolean; from?: string }
  }>('/:ext/:key/runs', async (req, reply) => {
    const decl = find(req.params.ext, req.params.key)
    if (!decl) return reply.code(404).send({ error: 'No such runbook' })
    const host = decl.runs_on === 'host'
    if (host && !(await hostQueueAvailable()))
      return reply
        .code(409)
        .send({ error: 'The runbook queue is not set up on this database (migration 403)' })
    const mode = req.body?.mode === 'go' ? 'go' : req.body?.mode === 'dry' ? 'dry' : null
    if (!mode) return reply.code(400).send({ error: 'mode must be dry or go' })
    const t = validateTarget(decl, req.body?.target)
    if (!t.ok) return reply.code(400).send({ error: t.error })
    let from: string | undefined
    if (req.body?.from) {
      if (!decl.resume_flag || !(decl.phases ?? []).some((p) => p.key === req.body.from))
        return reply.code(400).send({ error: "from must be one of the runbook's phases" })
      from = req.body.from
    }
    const { local, host: hostRuns } = await allRuns()
    const runs: Array<{
      id: string
      extension: string
      runbook: string
      mode: 'dry' | 'go'
      target: string | null
      state: string
      started_at: string
      finished_at?: string
      failed_step?: string
    }> = host ? hostRuns : local
    let resumeOf: string | null = null
    if (mode === 'go') {
      if (needsDryRun(decl) && !dryRunGate(runs as any, req.params.ext, decl.key, t.target))
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
        from = newest.failed_step
        resumeOf = newest.id
      }
    }
    const user = req.user!.id
    const where = `${req.params.ext}:${decl.key} ${mode}${t.target ? ` → ${t.target}` : ''}${from ? ` from ${from}` : ''}`
    if (host) {
      const active = (hostRuns as HostRunSummary[]).find(
        (r) =>
          r.extension === req.params.ext &&
          r.runbook === decl.key &&
          (r.state === 'queued' || r.state === 'running')
      )
      if (active)
        return reply
          .code(409)
          .send({ error: `a run of this runbook is already ${active.state}`, current: active })
      const run = await queueHostRun({
        extension: req.params.ext,
        runbook: decl.key,
        mode,
        target: t.target,
        args: (() => {
          const a = runbookArgv(decl, mode, from)
          return [a.file, ...a.args]
        })(),
        from: from ?? null,
        resumeOf,
        user
      })
      await logActivity({
        action: 'runbook-run-queue',
        user,
        collection: 'runbooks',
        item: run.id,
        comment: where,
        req
      })
      return reply.code(201).send({ run })
    }
    if (!localAvailable()) return reply.code(404).send(UNAVAILABLE)
    try {
      const run = await startRunbookRun({
        extension: req.params.ext,
        decl,
        mode,
        target: t.target,
        resumeFrom: from,
        user
      })
      await logActivity({
        action: 'runbook-run-start',
        user,
        collection: 'runbooks',
        item: run.id,
        comment: where,
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
      if (!RUN_ID.test(req.params.id)) return reply.code(404).send({ error: 'No such run' })
      const after = Number(req.query.after ?? 0)
      const from = Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0
      const local = localAvailable() ? await readRunbookRun(req.params.id) : null
      if (local) {
        const { chunk, next_offset } = readLogChunk(local.log, from)
        const { steps, events } = parseRunbookLog(local.log)
        return {
          run: { ...local.run, source: 'local' },
          steps: stepStates(steps, events, local.run.state),
          log_chunk: chunk,
          next_offset
        }
      }
      const row = hasHost() ? await readHostRun(req.params.id) : null
      if (!row) return reply.code(404).send(UNAVAILABLE)
      const run = summarizeHostRun(row)
      const decl = decls().find((d) => d.extension === row.extension && d.key === row.runbook)
      const [lines, timings, lastLine] = await Promise.all([
        readHostLines(row.id, from),
        readTimings(row.extension, row.runbook),
        lastLineAt(row.id)
      ])
      const phases = decl?.phases ?? []
      const events = parseEvents(row.events)
      const state =
        run.state === 'refused' ? 'failed' : run.state === 'queued' ? 'running' : run.state
      const now = Date.now()
      const live =
        run.state === 'running' || run.state === 'lost'
          ? liveEstimate({
              phases,
              from: row.from_step,
              events,
              rows: timings,
              mode: run.mode,
              startedAt: run.started_at,
              now
            })
          : null
      return {
        run,
        steps: stepStates(
          phases.map((p) => p.key),
          events,
          state
        ),
        phases,
        estimate: live,
        // Live signals: when the run last said something, when its agent last
        // reported, and how long a silence is unusual for the running phase.
        last_line_at: lastLine,
        stall_after_secs: live?.current ? stallAfterSecs(timings, live.current) : null,
        typical: phases.length ? planEstimate(phases, timings, run.mode) : null,
        server_now: new Date(now).toISOString(),
        log_chunk: lines.map((l) => `${l.line}\n`).join(''),
        next_offset: lines.length ? lines[lines.length - 1].seq : from
      }
    }
  )

  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
    if (!RUN_ID.test(req.params.id)) return reply.code(404).send({ error: 'No such run' })
    const local = localAvailable() ? await cancelRunbookRun(req.params.id) : null
    const run = local ?? (hasHost() ? await cancelHostRun(req.params.id) : null)
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
