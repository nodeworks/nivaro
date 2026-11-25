import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam } from '../services/hub/apps.js'
import {
  backupChecklist,
  lastBackupSeen,
  recordBackupSeen,
  startDbBackup
} from '../services/hub/data/backup.js'
import { startRestoreDrill } from '../services/hub/data/drill.js'
import { envData, serverAccessOf } from '../services/hub/data/env-db.js'
import { startFilesBackup } from '../services/hub/data/files-backup.js'
import {
  publicPolicy,
  readPolicy,
  savePolicy,
  validatePolicy
} from '../services/hub/data/policy.js'
import {
  planRefresh,
  resumeRefresh,
  rollbackRefusal,
  startRefresh,
  startRefreshRollback
} from '../services/hub/data/refresh.js'
import { startRehearsal } from '../services/hub/data/rehearsal.js'
import { latestRuns, listRuns, readRun } from '../services/hub/data/runs.js'
import { DATA_TICK_CRON, dataTick } from '../services/hub/data/schedule.js'
import { DATA_RUN_KINDS, DataError, type DataRunKind } from '../services/hub/data/types.js'
import { moveOpenMessage, openMoveFor } from '../services/hub/move-open.js'
import { HubSecretError } from '../services/hub/secrets.js'
import { listShared } from '../services/hub/shared/store.js'

/**
 * Nivaro Hub data care, mounted under /api/hub by hub.ts (HUB=on only). Every route is a Hub
 * administrator's (403 otherwise); every write is logged (collection nivaro_hub_data_runs, the
 * run id; a policy edit on nivaro_hub_backup_policies, the environment id).
 *
 *   GET  /data/environments                       every environment with its backup summary
 *   GET  /environments/:envId/data                policy (secrets masked), last backup seen, DBA
 *                                                 checklist, what the Hub can do here, newest runs
 *   PUT  /environments/:envId/data/policy         save the policy
 *   POST /environments/:envId/data/backup         database backup now          → 202 {run_id}
 *   POST /environments/:envId/data/files-backup   files backup now             → 202 {run_id}
 *   POST /environments/:envId/data/drill          restore drill now            → 202 {run_id}
 *   POST /environments/:envId/data/backup-seen    {at?, note?} a DBA backup seen → 201 {run_id}
 *   POST /environments/:envId/data/refresh/plan   {source_env_id, transfer_path?} → {data: plan}
 *   POST /environments/:envId/data/refresh        {…, plan_hash, confirm, accept_core_keeps?} → 202
 *   POST /environments/:envId/data/rehearsal      {shared_id}                  → 202 {run_id}
 *   GET  /environments/:envId/data/runs           ?kind=…  newest first
 *   GET  /data/runs/:id                           one run
 *   POST /data/runs/:id/resume                    an interrupted refresh       → 202
 *   POST /data/runs/:id/rollback                  {confirm} a refresh, within its window → 202
 *
 * Refusals are {statusCode, error, message, code} (+ `plan` on PLAN_CHANGED / PLAN_BLOCKED).
 */

const RUNS = 'nivaro_hub_data_runs'

function refuse(reply: FastifyReply, status: number, code: string, message: string, extra = {}) {
  return reply.code(status).send({ statusCode: status, error: message, message, code, ...extra })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '') || null

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

async function guarded(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof DataError) return refuse(reply, e.status, e.code, e.message, e.extra ?? {})
    if (e instanceof HubSecretError) return refuse(reply, 409, e.code, e.message)
    throw e
  }
}

async function logRun(req: FastifyRequest, kind: string, runId: number, envId: number) {
  await logActivity({
    action: `hub-data-${kind}`,
    user: userId(req),
    collection: RUNS,
    item: String(runId),
    comment: `environment ${envId}`,
    req
  })
}

/** What the Hub can do for this environment's database, and why not. */
function nativeOf(d: Awaited<ReturnType<typeof envData>>) {
  try {
    serverAccessOf(d)
    return { native: true, reason: null as string | null }
  } catch (e) {
    return {
      native: false,
      reason: e instanceof DataError ? e.message : 'The Hub cannot reach this database’s server.'
    }
  }
}

export function hubDataRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAdmin }

  app.get('/data/environments', admin, async () => {
    const rows = (await db('nivaro_hub_environments as e')
      .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
      .whereNot('e.status', 'archived')
      .select('e.id', 'e.key', 'e.position', 'e.status', 'a.key as app_key', 'a.name as app_name')
      .orderBy([{ column: 'a.key' }, { column: 'e.position' }])) as Record<string, unknown>[]
    const policies = new Map(
      (
        (await db('nivaro_hub_backup_policies').select(
          'environment_id',
          'db_enabled',
          'files_enabled',
          'drill_enabled'
        )) as Record<string, unknown>[]
      ).map((p) => [Number(p.environment_id), p])
    )
    const last = new Map<string, Record<string, unknown>>()
    for (const r of (await db(RUNS)
      .whereIn('kind', ['db_backup', 'files_backup', 'restore_drill', 'backup_seen'])
      .where({ status: 'done' })
      .groupBy('environment_id', 'kind')
      .select('environment_id', 'kind')
      .max('finished_at as at')) as Record<string, unknown>[])
      last.set(`${r.environment_id}|${r.kind}`, r)
    const at = (id: unknown, kind: string) => {
      const v = last.get(`${id}|${kind}`)?.at
      return v ? new Date(String(v)).toISOString() : null
    }
    const on = (v: unknown) => v === true || Number(v) === 1
    return {
      data: rows.map((r) => {
        const p = policies.get(Number(r.id))
        return {
          env_id: Number(r.id),
          env_key: String(r.key),
          position: Number(r.position ?? 0),
          status: String(r.status),
          app_key: String(r.app_key),
          app_name: String(r.app_name),
          policy: {
            db: on(p?.db_enabled),
            files: on(p?.files_enabled),
            drill: on(p?.drill_enabled)
          },
          last: {
            db_backup: at(r.id, 'db_backup'),
            backup_seen: at(r.id, 'backup_seen'),
            files_backup: at(r.id, 'files_backup'),
            restore_drill: at(r.id, 'restore_drill')
          }
        }
      })
    }
  })

  app.get<{ Params: { envId: string } }>('/environments/:envId/data', admin, async (req, reply) => {
    const envId = idParam(req.params.envId)
    if (!envId) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    return guarded(reply, async () => {
      const d = await envData(envId)
      const policy = await readPolicy(envId)
      const [seen, latest, shared] = await Promise.all([
        lastBackupSeen(envId).catch(() => null),
        latestRuns(envId),
        listShared().catch(() => [])
      ])
      const refresh = latest.refresh ?? null
      return {
        data: {
          environment: { ...d.env, production: d.production },
          app: d.app,
          database: d.database,
          server: d.server
            ? {
                id: d.server.id,
                name: d.server.name,
                provision_mode: d.server.provision_mode,
                engine: d.server.engine
              }
            : null,
          ...nativeOf(d),
          policy: publicPolicy(policy),
          last_seen: seen,
          checklist: backupChecklist(d, policy),
          latest,
          refresh_rollback: refresh
            ? {
                run_id: refresh.id,
                refusal: rollbackRefusal(refresh),
                expires_at: refresh.expires_at
              }
            : null,
          refresh_sources: d.siblings
            .filter((s) => s.position > d.env.position)
            .map((s) => ({ env_id: s.id, env_key: s.key })),
          shared_deployments: shared
            .filter((s) => s.status !== 'retired')
            .map((s) => ({ id: s.id, key: s.key, name: s.name }))
        }
      }
    })
  })

  app.put<{ Params: { envId: string } }>(
    '/environments/:envId/data/policy',
    admin,
    async (req, reply) => {
      const envId = idParam(req.params.envId)
      if (!envId) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
      return guarded(reply, async () => {
        await envData(envId)
        const b = body(req)
        const next = validatePolicy(b, await readPolicy(envId))
        const saved = await savePolicy(next, userId(req))
        await logActivity({
          action: 'update',
          user: userId(req),
          collection: 'nivaro_hub_backup_policies',
          item: String(envId),
          req,
          changed_fields: Object.keys(b).filter((k) => k !== 'target_secret')
        })
        return { data: publicPolicy(saved) }
      })
    }
  )

  const startRoute = (
    path: string,
    kind: string,
    start: (envId: number, req: FastifyRequest) => Promise<number>,
    code = 202
  ) =>
    app.post<{ Params: { envId: string } }>(
      `/environments/:envId/data/${path}`,
      admin,
      async (req, reply) => {
        const envId = idParam(req.params.envId)
        if (!envId) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
        return guarded(reply, async () => {
          const runId = await start(envId, req)
          await logRun(req, kind, runId, envId)
          return reply.code(code).send({ data: { run_id: runId } })
        })
      }
    )

  startRoute('backup', 'backup', (envId, req) => startDbBackup(envId, { by: userId(req) }))
  startRoute('files-backup', 'files-backup', (envId, req) =>
    startFilesBackup(envId, { by: userId(req) })
  )
  startRoute('drill', 'drill', (envId, req) => startRestoreDrill(envId, { by: userId(req) }))
  startRoute(
    'backup-seen',
    'backup-seen',
    (envId, req) => recordBackupSeen(envId, body(req), userId(req)),
    201
  )
  startRoute('refresh', 'refresh', (envId, req) => startRefresh(envId, body(req), userId(req)))
  startRoute('rehearsal', 'rehearsal', async (envId, req) => {
    const move = await openMoveFor({ envIds: [envId] })
    if (move) throw new DataError('MOVE_OPEN', moveOpenMessage(move))
    return startRehearsal(envId, body(req), userId(req))
  })

  app.post<{ Params: { envId: string } }>(
    '/environments/:envId/data/refresh/plan',
    admin,
    async (req, reply) => {
      const envId = idParam(req.params.envId)
      if (!envId) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
      return guarded(reply, async () => ({ data: await planRefresh(envId, body(req)) }))
    }
  )

  app.get<{ Params: { envId: string }; Querystring: { kind?: string; limit?: string } }>(
    '/environments/:envId/data/runs',
    admin,
    async (req, reply) => {
      const envId = idParam(req.params.envId)
      if (!envId) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
      const kinds = String(req.query.kind ?? '')
        .split(',')
        .filter((k): k is DataRunKind => (DATA_RUN_KINDS as readonly string[]).includes(k))
      return {
        data: await listRuns({ environmentId: envId, kinds, limit: Number(req.query.limit) || 50 })
      }
    }
  )

  app.get<{ Params: { id: string } }>('/data/runs/:id', admin, async (req, reply) => {
    const id = idParam(req.params.id)
    const run = id ? await readRun(id) : null
    if (!run) return refuse(reply, 404, 'NOT_FOUND', 'No such run.')
    return { data: run }
  })

  app.post<{ Params: { id: string } }>('/data/runs/:id/resume', admin, async (req, reply) => {
    const id = idParam(req.params.id)
    if (!id) return refuse(reply, 404, 'NOT_FOUND', 'No such run.')
    return guarded(reply, async () => {
      const run = await readRun(id)
      if (!run) throw new DataError('NOT_FOUND', 'No such run.', 404)
      if (run.kind !== 'refresh')
        throw new DataError(
          'NOT_RESUMABLE',
          'Only a refresh can be resumed; start a new run instead.'
        )
      await resumeRefresh(id)
      await logRun(req, 'resume', id, run.environment_id)
      return reply.code(202).send({ data: { run_id: id } })
    })
  })

  app.post<{ Params: { id: string } }>('/data/runs/:id/rollback', admin, async (req, reply) => {
    const id = idParam(req.params.id)
    if (!id) return refuse(reply, 404, 'NOT_FOUND', 'No such run.')
    return guarded(reply, async () => {
      const runId = await startRefreshRollback(id, body(req), userId(req))
      const run = await readRun(runId)
      await logRun(req, 'rollback', runId, run?.environment_id ?? 0)
      return reply.code(202).send({ data: { run_id: runId } })
    })
  })

  if (app.cron) {
    app.cron.schedule(
      'hub-data-tick',
      DATA_TICK_CRON,
      async () => {
        const r = await dataTick()
        if (r.started.length || r.healed.length || r.expired.length)
          app.log.info(
            `hub-data-tick: ${r.started.length} started, ${r.healed.length} healed, ${r.expired.length} rollback points expired`
          )
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every 5 minutes (Hub only) — starts the database backups, files backups and restore drills the backup policies make due, marks data runs whose process stopped, and deletes refresh rollback points past their window.'
      }
    )
  }
}
