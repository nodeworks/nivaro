import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { requireSqlServer } from '../db/dialect/sqlserver-features.js'
import { resolveDb } from '../db/index.js'
import { extensionRunbooks } from '../extensions/loader.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  directionKey,
  EnvRefreshRefused,
  refreshDecl,
  resolveDirection
} from '../services/env-refresh/directions.js'
import { buildPlanFromDatabases } from '../services/env-refresh/inspect.js'
import type { SqlRunner } from '../services/env-refresh/keep-set.js'
import { REFRESH_PHASES, ROLLBACK_PHASES } from '../services/env-refresh/plan.js'
import { allKeeps } from '../services/env-refresh/registry.js'
import {
  type HostRunSummary,
  hostQueueAvailable,
  listAgents,
  listHostRuns,
  queueHostRun
} from '../services/runbook-queue.js'
import { dryRunGate, runbookArgv } from '../services/runbook-runs.js'

/** Pure: when the newest finished refresh of `targetKey` can still be rolled back (ISO), or null. */
export function rollbackUntil(
  runs: Array<
    Pick<HostRunSummary, 'mode' | 'state' | 'target' | 'finished_at' | 'started_at' | 'failed_step'>
  >,
  targetKey: string,
  hours: number,
  now = Date.now()
): string | null {
  // A real run that got past the restore (done, or failed after it) replaced the target.
  const run = runs.find(
    (r) =>
      r.mode === 'go' &&
      typeof r.target === 'string' &&
      r.target.endsWith(`-to-${targetKey}`) &&
      (r.state === 'done' ||
        (r.state === 'failed' &&
          ['migrate', 'keep', 'safety', 'verify'].includes(r.failed_step ?? '')))
  )
  if (!run) return null
  const until = Date.parse(run.started_at) + hours * 3600_000
  return until > now ? new Date(until).toISOString() : null
}

/** Pure: the reason a queued refresh is refused, or null. */
export function refreshRunRefusal(o: {
  mode: unknown
  confirm: unknown
  database: string
  runs: HostRunSummary[]
  extension: string
  runbook: string
  target: string
  now?: number
}): string | null {
  if (o.mode !== 'dry' && o.mode !== 'go') return 'mode must be dry or go'
  const active = o.runs.find((r) => r.state === 'queued' || r.state === 'running')
  if (active) return `a ${active.runbook} run is already ${active.state}`
  if (o.mode === 'dry') return null
  if (!dryRunGate(o.runs as any, o.extension, o.runbook, o.target, o.now ?? Date.now()))
    return 'run the dry run of this direction first — a real run needs a finished dry run from the last 24 hours'
  if (o.confirm !== o.database) return `type ${o.database} to confirm`
  return null
}

/**
 * /api/env-refresh — Environments → Runbooks → "Refresh an environment" (admin).
 * GET    /                 what can be refreshed, the runs, rollback windows
 * POST   /plan             {direction} the dry-run plan, read-only, right now
 * POST   /runs             {direction, mode dry|go, confirm} queues the host runbook
 * POST   /rollback         {target, mode dry|go, confirm} queues the rollback runbook
 * Production is never a target (directions.ts refuses it here, and the host runner again).
 */
export async function envRefreshRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  // backups and restores between databases on one server: SQL Server only (501 elsewhere)
  app.addHook('preHandler', requireSqlServer)

  const setup = () => {
    const decl = refreshDecl()
    if (!decl) return null
    const books = extensionRunbooks.get(decl.extension) ?? []
    const refresh = books.find((b) => b.key === decl.runbook && b.runs_on === 'host') ?? null
    const rollback = decl.rollback_runbook
      ? (books.find((b) => b.key === decl.rollback_runbook && b.runs_on === 'host') ?? null)
      : null
    return refresh ? { decl, refresh, rollback } : null
  }

  async function hostRuns(ext: string, keys: string[]) {
    if (!(await hostQueueAvailable())) return []
    return (await listHostRuns(100)).filter((r) => r.extension === ext && keys.includes(r.runbook))
  }

  app.get('/', async () => {
    const s = setup()
    if (!s) return { available: false }
    const { decl } = s
    const keys = [decl.runbook, ...(decl.rollback_runbook ? [decl.rollback_runbook] : [])]
    const runs = await hostRuns(decl.extension, keys)
    const agents = (await listAgents().catch(() => [])).filter((a) =>
      a.runbooks.includes(`${decl.extension}:${decl.runbook}`)
    )
    const hours = decl.rollback_hours ?? 24
    const refreshRuns = runs.filter((r) => r.runbook === decl.runbook)
    const now = Date.now()
    return {
      available: true,
      extension: decl.extension,
      runbook: decl.runbook,
      rollback_runbook: s.rollback ? decl.rollback_runbook : null,
      phases: REFRESH_PHASES,
      rollback_phases: ROLLBACK_PHASES,
      rollback_hours: hours,
      environments: decl.environments.map((e) => ({
        key: e.key,
        label: e.label,
        database: e.database,
        production: e.production === true
      })),
      directions: decl.directions.map((d) => {
        const key = directionKey(d.from, d.to)
        const dry = dryRunGate(refreshRuns as any, decl.extension, decl.runbook, key, now)
        return {
          key,
          from: d.from,
          to: d.to,
          fresh_dry_run: dry ? { id: dry.id, finished_at: dry.finished_at ?? dry.started_at } : null
        }
      }),
      rollback: decl.environments
        .filter((e) => !e.production)
        .map((e) => {
          const dry = s.rollback
            ? dryRunGate(runs as any, decl.extension, decl.rollback_runbook!, e.key, now)
            : null
          return {
            target: e.key,
            until: s.rollback ? rollbackUntil(refreshRuns, e.key, hours, now) : null,
            fresh_dry_run: dry
              ? { id: dry.id, finished_at: dry.finished_at ?? dry.started_at }
              : null
          }
        }),
      runs: runs.slice(0, 20),
      active: runs.find((r) => r.state === 'queued' || r.state === 'running') ?? null,
      agents: agents.map((a) => ({ host: a.host, last_seen: a.last_seen, online: a.online })),
      kept: allKeeps().map((e) => ({ id: e.id, label: e.label, kind: e.kind, table: e.table }))
    }
  })

  app.post<{ Body: { direction?: string } }>('/plan', async (req, reply) => {
    const s = setup()
    if (!s) return reply.code(404).send({ error: 'Environment refresh is not set up here' })
    let dir: ReturnType<typeof resolveDirection>
    try {
      dir = resolveDirection(s.decl, req.body?.direction)
    } catch (e) {
      if (e instanceof EnvRefreshRefused) return reply.code(400).send({ error: e.message })
      throw e
    }
    const active = (await hostQueueAvailable())
      ? (await listHostRuns(50)).find((r) => r.state === 'queued' || r.state === 'running')
      : undefined
    // SELECTs only (inspect.ts), each well inside the request timeout.
    const knex = resolveDb() as unknown as Knex
    const sql: SqlRunner = {
      async raw(q, b) {
        const r = await knex.raw(q, (b ?? []) as any)
        return (Array.isArray(r) ? r : []) as Array<Record<string, unknown>>
      }
    }
    const { plan } = await buildPlanFromDatabases(sql, {
      decl: s.decl,
      dir,
      entries: allKeeps(),
      busy: active ? `${active.extension}:${active.runbook} is ${active.state}` : null,
      filesFallback: dir.source.uploads_dir ?? null,
      sampleOver: 2000
    })
    return { plan }
  })

  app.post<{ Body: { direction?: string; mode?: string; confirm?: string } }>(
    '/runs',
    async (req, reply) => {
      const s = setup()
      if (!s) return reply.code(404).send({ error: 'Environment refresh is not set up here' })
      if (!(await hostQueueAvailable()))
        return reply.code(409).send({ error: 'The runbook queue is not set up on this database' })
      let dir: ReturnType<typeof resolveDirection>
      try {
        dir = resolveDirection(s.decl, req.body?.direction)
      } catch (e) {
        if (e instanceof EnvRefreshRefused) return reply.code(400).send({ error: e.message })
        throw e
      }
      const all = (await listHostRuns(100)).filter((r) => r.extension === s.decl.extension)
      const refusal = refreshRunRefusal({
        mode: req.body?.mode,
        confirm: req.body?.confirm,
        database: dir.target.database,
        runs: all,
        extension: s.decl.extension,
        runbook: s.decl.runbook,
        target: dir.key
      })
      if (refusal) return reply.code(409).send({ error: refusal })
      const mode = req.body!.mode as 'dry' | 'go'
      const a = runbookArgv(s.refresh, mode)
      const run = await queueHostRun({
        extension: s.decl.extension,
        runbook: s.decl.runbook,
        mode,
        target: dir.key,
        args: [a.file, ...a.args],
        from: null,
        resumeOf: null,
        user: req.user!.id
      })
      await logActivity({
        action: 'env-refresh-queue',
        user: req.user!.id,
        collection: 'runbooks',
        item: run.id,
        comment: `${mode === 'dry' ? 'Dry run' : 'Refresh'}: ${dir.source.label} → ${dir.target.label} (${dir.target.database})`,
        req
      })
      return reply.code(201).send({ run })
    }
  )

  app.post<{ Body: { target?: string; mode?: string; confirm?: string } }>(
    '/rollback',
    async (req, reply) => {
      const s = setup()
      if (!s?.rollback) return reply.code(404).send({ error: 'Roll back is not set up here' })
      if (!(await hostQueueAvailable()))
        return reply.code(409).send({ error: 'The runbook queue is not set up on this database' })
      const env = s.decl.environments.find((e) => e.key === req.body?.target)
      if (!env || env.production)
        return reply
          .code(400)
          .send({ error: 'target must be an environment a refresh can roll back' })
      const all = (await listHostRuns(100)).filter((r) => r.extension === s.decl.extension)
      const until = rollbackUntil(
        all.filter((r) => r.runbook === s.decl.runbook),
        env.key,
        s.decl.rollback_hours ?? 24
      )
      if (!until)
        return reply.code(409).send({
          error: `There is no refresh of ${env.label} from the last ${s.decl.rollback_hours ?? 24} hours to roll back`
        })
      const refusal = refreshRunRefusal({
        mode: req.body?.mode,
        confirm: req.body?.confirm,
        database: env.database,
        runs: all,
        extension: s.decl.extension,
        runbook: s.decl.rollback_runbook!,
        target: env.key
      })
      if (refusal) return reply.code(409).send({ error: refusal })
      const mode = req.body!.mode as 'dry' | 'go'
      const a = runbookArgv(s.rollback, mode)
      const run = await queueHostRun({
        extension: s.decl.extension,
        runbook: s.decl.rollback_runbook!,
        mode,
        target: env.key,
        args: [a.file, ...a.args],
        from: null,
        resumeOf: null,
        user: req.user!.id
      })
      await logActivity({
        action: 'env-refresh-rollback',
        user: req.user!.id,
        collection: 'runbooks',
        item: run.id,
        comment: `${mode === 'dry' ? 'Roll back check' : 'Roll back'}: ${env.label} (${env.database})`,
        req
      })
      return reply.code(201).send({ run })
    }
  )
}
