import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { getTenantDb, withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubSharedConfig, tenantSource } from '../services/deployment-mode.js'
import { seedFirstAdmin } from '../services/hub-link/first-admin.js'
import { instanceKey } from '../services/instance-key.js'
import { INSTANCE_ID } from '../services/instance-roster.js'
import { poolCounters } from '../services/pool-attribution.js'
import { bearerMatches } from '../services/render-peer.js'
import { appSchemaStatus } from '../services/tenancy/app-migrations.js'
import {
  type AppSchemaState,
  appStatusFor,
  checkDatabase,
  checkSqliteDatabase,
  DB_CHECK_CLIENTS,
  type DeploymentStatus,
  oidcIdentity,
  type PreflightSummary
} from '../services/tenancy/app-status.js'
import { deploymentLinkBearer } from '../services/tenancy/hub-contract.js'
import { type HubTenantRegistry, tenancyRefreshChannel } from '../services/tenancy/hub-source.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../services/tenancy/types.js'
import { NIVARO_VERSION } from '../version.js'
import { deploymentLinkDataRoutes } from './hub-link-data.js'

/**
 * Deployment link (Hub phase 6) — the shared twin of the per-app hub link (routes/hub-link.ts):
 * what a Nivaro Hub may read and ask of the shared deployment it runs.
 *
 *   GET  /api/hub-deployment/status                  → DeploymentStatus
 *   GET  /api/hub-deployment/apps/:id/status         → DeploymentAppStatus (404 UNKNOWN_APP)
 *   POST /api/hub-deployment/apps/:id/first-admin    → as POST /api/hub-link/first-admin, in that app
 *   POST /api/hub-deployment/refresh                 → 202; every replica re-reads its tenant list
 *   POST /api/hub-deployment/db-check {client, connection} → {reachable, ledger, db_identity, error}
 *        (SQLite, 0.3.215: {client: 'sqlite', connection: <file name>, tenant: <app id>})
 *
 * Mounted only on a Hub shared deployment (tenantSource() === 'hub'), never in Nivaro Cloud and
 * never on a dedicated app (HUB_TOKEN alone). The tenant hook frees `/api/hub-deployment/`, so a
 * call on the deployment's own address (no app hostname) still reaches it.
 *
 * Auth (ruling R7): `Authorization: Bearer <deploymentLinkBearer(HUB_DEPLOYMENT_TOKEN)>`, the
 * HMAC of the deployment token — the token itself never crosses this link. Timing-safe; 401
 * DEPLOYMENT_LINK_REFUSED, 429 after 20 failures a minute from one address. Every answer is
 * `Cache-Control: no-store`. Counts and health figures only: never a record, a connection
 * string, an app key (its fingerprint only) or a driver's raw error text. The `process` block
 * carries the process's own figures across every app (sockets, heavy-read budget, app pools
 * summed) — the operator's view; each app's own figures stay in that app.
 */

export const DEPLOYMENT_LINK_REFUSED = 'DEPLOYMENT_LINK_REFUSED'

const CONNECTION_MAX = 8_192

function refuse(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

/** One app's schema state on this deployment (services/tenancy/app-migrations.ts): `pending`
 *  until this process has migrated it (or adopted another replica's run), the error scrubbed. */
function appSchemaFor(tenantId: string): {
  state: AppSchemaState
  version: string | null
  error: string | null
} {
  const s = appSchemaStatus(tenantId)
  return { state: s.state, version: s.version, error: s.error }
}

async function allTenants(registry: TenantRegistry): Promise<TenantRecord[]> {
  return registry.listAll ? registry.listAll() : registry.listActive()
}

async function tenantById(registry: TenantRegistry, id: string): Promise<TenantRecord | null> {
  if (registry.byId) return registry.byId(id)
  return (await allTenants(registry)).find((t) => t.id === id) ?? null
}

function loadedExtensions(registry: Map<string, { id: string; status: string; enabled: boolean }>) {
  return [...registry.values()]
    .filter((e) => e.status === 'loaded' && e.enabled)
    .map((e) => e.id)
    .sort()
}

/**
 * The process's own figures across every app (counts only, never which app): sockets and people
 * connected, the shared heavy-read budget, and every watched app pool summed. What is per app is
 * kept in each app (app-pool-monitor, app-concurrency-sample, the app's own Traffic Map).
 */
async function processFigures(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  try {
    const { getLocalConcurrency } = await import('../plugins/socketio.js')
    out.sockets = getLocalConcurrency()
  } catch {
    out.sockets = null
  }
  try {
    const { readGateProcessFigures } = await import('../services/read-gate.js')
    out.heavy_reads = readGateProcessFigures()
  } catch {
    out.heavy_reads = null
  }
  try {
    const { appPoolTotals } = await import('../services/app-pool-pressure.js')
    out.app_pools = appPoolTotals()
  } catch {
    out.app_pools = null
  }
  return out
}

function poolFigures(): { used: number; free: number; pending: number } | null {
  try {
    const p = poolCounters('main')
    return p ? { used: p.used, free: p.free, pending: p.pending_acquires } : null
  } catch {
    return null
  }
}

export async function hubDeploymentLinkRoutes(app: FastifyInstance): Promise<void> {
  if (tenantSource() !== 'hub') return
  const cfg = hubSharedConfig()
  if (!cfg || cfg.token.length < 32) return
  const bearer = deploymentLinkBearer(cfg.token)

  const authFails = failedAuthLimiter()
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (authFails.blocked(req.ip))
      return refuse(reply, 429, 'Too many attempts', DEPLOYMENT_LINK_REFUSED)
    if (!bearerMatches(req.headers.authorization, bearer)) {
      if (authFails.fail(req.ip))
        app.log.warn({ ip: req.ip }, 'deployment link: wrong or missing bearer')
      return refuse(reply, 401, 'Unauthorized', DEPLOYMENT_LINK_REFUSED)
    }
  })

  // Hub data care (0.3.215): /apps/:id/data/* (routes/hub-link-data.ts).
  deploymentLinkDataRoutes(app)

  const registryOr503 = (reply: FastifyReply): TenantRegistry | null => {
    const r = getTenantRegistry()
    if (!r) refuse(reply, 503, 'The tenant list is not loaded yet', 'REGISTRY_NOT_READY')
    return r
  }

  const preflightFor = async (): Promise<PreflightSummary> => {
    const { runPreflight } = await import('./preflight.js')
    const { status, checks } = await runPreflight(app)
    return { status, failing: checks.filter((c) => c.status === 'fail').map((c) => c.id) }
  }

  app.get('/status', async (_req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const st = registry.status()
    const details = (registry as Partial<HubTenantRegistry>).details?.()
    const tenants = await allTenants(registry)
    let extensions: string[] = []
    try {
      const { extensionRegistry } = await import('../extensions/loader.js')
      extensions = loadedExtensions(extensionRegistry)
    } catch {
      extensions = []
    }
    const body: DeploymentStatus = {
      version: NIVARO_VERSION,
      instance: INSTANCE_ID,
      instance_key: instanceKey(),
      registry: {
        count: st.count,
        loaded_at: st.loadedAt,
        etag: details?.etag ?? null,
        stale: st.stale,
        dropped: details?.dropped ?? []
      },
      apps: tenants.map((t) => ({ id: t.id, schema: appSchemaFor(t.id) })),
      extensions,
      oidc: oidcIdentity(config.OIDC_ISSUER),
      process: {
        uptime_s: Math.round(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1048576),
        pool: poolFigures(),
        ...(await processFigures())
      }
    }
    return reply.send(body)
  })

  app.get<{ Params: { id: string } }>('/apps/:id/status', async (req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const t = await tenantById(registry, req.params.id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    try {
      return reply.send(await appStatusFor(t, { preflight: preflightFor }))
    } catch (err) {
      app.log.warn(
        { tenant: t.id, code: (err as { code?: unknown } | null)?.code ?? null },
        'deployment link: app status could not be read'
      )
      return refuse(reply, 503, "The app's database could not be read", 'APP_UNREACHABLE')
    }
  })

  // The same answers as POST /api/hub-link/first-admin, inside the app (its database, its
  // activity log). A frozen app (its own maintenance switch) answers 503 MAINTENANCE as the
  // hub link does.
  app.post<{ Params: { id: string } }>('/apps/:id/first-admin', async (req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const t = await tenantById(registry, req.params.id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    try {
      const out = await withTenant(
        t,
        async () => {
          const { maintenanceState } = await import('../services/security.js')
          if ((await maintenanceState()).on) return 'frozen' as const
          return seedFirstAdmin(req.body, getTenantDb())
        },
        t.origin
      )
      if (out === 'frozen')
        return refuse(reply, 503, 'The app is in maintenance mode', 'MAINTENANCE')
      if (!out.ok) return refuse(reply, out.status, out.message, out.code)
      return reply.code(201).send({ user_id: out.user_id, created: out.created })
    } catch (err) {
      app.log.error(
        { tenant: t.id, code: (err as { code?: unknown } | null)?.code ?? null },
        'deployment link: seeding the first administrator failed'
      )
      return refuse(reply, 500, 'The first administrator could not be saved', 'FIRST_ADMIN_FAILED')
    }
  })

  // Every replica re-reads its tenant list (services/tenancy/hub-source.ts listens on the
  // deployment's channel). `every_replica` only when at least one subscriber heard it; otherwise
  // (no Redis, a failed publish, nobody subscribed) this process kicks itself, folded like a
  // channel message, so repeated calls never run fetch after fetch.
  app.post('/refresh', async (_req, reply) => {
    const redis = (
      app as unknown as { redis?: { publish(c: string, m: string): Promise<unknown> } }
    ).redis
    let heard = 0
    if (redis) {
      try {
        heard = Number(
          await redis.publish(tenancyRefreshChannel(cfg.deployment), String(Date.now()))
        )
      } catch {
        heard = 0
      }
    }
    const everyReplica = Number.isFinite(heard) && heard > 0
    if (!everyReplica) (getTenantRegistry() as Partial<HubTenantRegistry> | null)?.kick?.()
    return reply.code(202).send({ accepted: true, every_replica: everyReplica })
  })

  app.post('/db-check', async (req, reply) => {
    const b = (req.body ?? {}) as { client?: unknown; connection?: unknown; tenant?: unknown }
    const client = typeof b.client === 'string' ? b.client : ''
    const connection = typeof b.connection === 'string' ? b.connection.trim() : ''
    // 0.3.215: a SQLite app's file — `connection` is its file name, `tenant` the app it belongs to
    // (the file lives in that app's own folder here).
    if (client === 'sqlite') {
      const tenant = typeof b.tenant === 'string' ? b.tenant : ''
      if (!tenant || !connection)
        return refuse(reply, 400, 'A SQLite check names the app and its file', 'BAD_DB_CONNECTION')
      return reply.send(await checkSqliteDatabase(cfg.deployment, tenant, connection))
    }
    if (!DB_CHECK_CLIENTS.has(client))
      return refuse(reply, 400, 'Unknown database client', 'BAD_DB_CLIENT')
    if (!connection || connection.length > CONNECTION_MAX)
      return refuse(reply, 400, 'A connection is required', 'BAD_DB_CONNECTION')
    return reply.send(await checkDatabase(client, connection))
  })

  // ─── Hub phase 6 Task 10: file transfer for a move, per app (services/hub-transfer/*) ─────
  // The same three calls as the hub link's /files/*, for one app of this deployment. A ticket is
  // minted FOR that app (the ticket decides the app the serve route reads, ruling R16); a pull
  // runs inside that app (its rows, its storage scope, its Redis keys) and its run is seen only
  // there. The ticket is never logged (the request log skips /api/hub-deployment/ here) or
  // answered back.

  app.post<{ Params: { id: string } }>('/apps/:id/files/ticket', async (req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const t = await tenantById(registry, req.params.id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    const { mintTransferTicket } = await import('../services/hub-transfer/tickets.js')
    try {
      return reply.send(await mintTransferTicket(t.id))
    } catch {
      return refuse(
        reply,
        503,
        'The transfer ticket could not be stored (Redis)',
        'REDIS_UNAVAILABLE'
      )
    }
  })

  // Revoke a ticket minted for this app ({ticket} → 200 {revoked}); another app's stays valid.
  app.delete<{ Params: { id: string } }>('/apps/:id/files/ticket', async (req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const t = await tenantById(registry, req.params.id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    const { revokeTransferTicket, TRANSFER_TICKET_RE } = await import(
      '../services/hub-transfer/tickets.js'
    )
    const ticket = (req.body as { ticket?: unknown } | null)?.ticket
    if (typeof ticket !== 'string' || !TRANSFER_TICKET_RE.test(ticket))
      return refuse(reply, 400, 'ticket must be a transfer ticket', 'BAD_TICKET')
    try {
      return reply.send({ revoked: await revokeTransferTicket(ticket, t.id) })
    } catch {
      return refuse(reply, 503, 'The ticket could not be revoked (Redis)', 'REDIS_UNAVAILABLE')
    }
  })

  app.post<{ Params: { id: string } }>('/apps/:id/files/pull', async (req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const t = await tenantById(registry, req.params.id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    const { startPull, PullError, errorShape } = await import('../services/hub-transfer/pull.js')
    const b = (req.body ?? {}) as {
      source?: unknown
      ticket?: unknown
      mode?: unknown
      objects?: unknown
      env_objects?: unknown
      replays?: unknown
      source_scope?: unknown
    }
    try {
      const out = await withTenant(
        t,
        () =>
          startPull({
            source: b.source as string,
            ticket: b.ticket as string,
            mode: b.mode as 'full' | 'delta',
            objects: b.objects === true,
            env_objects: b.env_objects === true,
            replays: b.replays === true,
            ...(typeof b.source_scope === 'string' ? { source_scope: b.source_scope } : {})
          }),
        t.origin
      )
      return reply.code(202).send(out)
    } catch (err) {
      if (err instanceof PullError) return refuse(reply, err.statusCode, err.message, err.code)
      app.log.error(
        { tenant: t.id, ...errorShape(err) },
        'deployment link: the file copy could not be started'
      )
      return refuse(reply, 500, 'The file copy could not be started', 'PULL_FAILED')
    }
  })

  // ─── Hub gap sqlite (0.3.215): a SQLite app's database file in a move ──────────────────────
  // Review 4 (N2/N3): the copy and the checksum are start-then-poll jobs
  // (services/hub-transfer/database-jobs.ts) — they can take longer than one call may stay open.
  // POST   /apps/:id/database/pull {source, ticket, move_id?} → 202 {job}: fetched with the
  //        ticket, checked (checksum, integrity_check in a child process, ledger), put in place of
  //        the app's file; a pull that passes its own deadline removes its copy and fails.
  // POST   /apps/:id/database/sum → 202 {job} (a source, before release): result {sha256, bytes}
  // GET    /apps/:id/database/jobs/:job → {job}: state running | done | failed, result, code
  // DELETE /apps/:id/database/jobs/:job → {cancelled}: the Hub gave up (review 5 M1); a running
  //        pull is aborted and never puts its copy in place
  // DELETE /apps/:id/database {sha256} → {discarded}: a rollback before release throws the copy
  //        away (only the copy whose checksum it names; under the file's lock).
  const databaseRefusal = (reply: FastifyReply, err: unknown, what: string) => {
    const e = err as { code?: unknown; statusCode?: unknown; message?: unknown; name?: unknown }
    if (
      e?.name === 'DatabaseTransferError' ||
      e?.name === 'SqliteTenantError' ||
      e?.name === 'SqliteTransferError' ||
      e?.name === 'DatabaseJobError'
    )
      return refuse(
        reply,
        typeof e.statusCode === 'number' ? e.statusCode : 409,
        String(e.message),
        String(e.code)
      )
    app.log.error({ err_name: e?.name ?? null }, `deployment link: ${what}`)
    return refuse(reply, 500, 'The database copy failed here', 'DATABASE_COPY_FAILED')
  }

  app.post<{ Params: { id: string } }>('/apps/:id/database/pull', async (req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const t = await tenantById(registry, req.params.id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    const { pullDatabaseShared } = await import('../services/hub-transfer/database.js')
    const { startDatabaseJob } = await import('../services/hub-transfer/database-jobs.js')
    const b = (req.body ?? {}) as { source?: unknown; ticket?: unknown; move_id?: unknown }
    const moveId =
      typeof b.move_id === 'number' && Number.isSafeInteger(b.move_id) && b.move_id > 0
        ? b.move_id
        : null
    try {
      // Review 5 H1: no tenant pool here — a move's target has no database file until this pull
      // puts the copy in place (its pool opens after the install, from the app's next request).
      // M1: right before the install, the app is read again from the list.
      const job = startDatabaseJob(
        t.id,
        'pull',
        moveId ? `move:${moveId}` : `pull:${Date.now()}`,
        (signal) =>
          pullDatabaseShared(
            t,
            { source: b.source as string, ticket: b.ticket as string },
            { signal, current: () => tenantById(registry, t.id) }
          )
      )
      return reply.code(202).send({ job })
    } catch (err) {
      return databaseRefusal(reply, err, 'the database copy failed')
    }
  })

  app.post<{ Params: { id: string } }>('/apps/:id/database/sum', async (req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const t = await tenantById(registry, req.params.id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    const { databaseSum } = await import('../services/hub-transfer/database.js')
    const { startDatabaseJob } = await import('../services/hub-transfer/database-jobs.js')
    try {
      const job = await withTenant(
        t,
        async () => startDatabaseJob(t.id, 'sum', 'sum', () => databaseSum(t)),
        t.origin
      )
      return reply.code(202).send({ job })
    } catch (err) {
      return databaseRefusal(reply, err, 'the database checksum could not be read')
    }
  })

  app.get<{ Params: { id: string; job: string } }>(
    '/apps/:id/database/jobs/:job',
    async (req, reply) => {
      const registry = registryOr503(reply)
      if (!registry) return reply
      const t = await tenantById(registry, req.params.id)
      if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
      const { readDatabaseJob, JOB_ID_RE } = await import(
        '../services/hub-transfer/database-jobs.js'
      )
      const job = JOB_ID_RE.test(req.params.job) ? readDatabaseJob(t.id, req.params.job) : null
      if (!job) return refuse(reply, 404, 'No such database job here', 'UNKNOWN_JOB')
      return reply.send({ job })
    }
  )

  app.delete<{ Params: { id: string; job: string } }>(
    '/apps/:id/database/jobs/:job',
    async (req, reply) => {
      const registry = registryOr503(reply)
      if (!registry) return reply
      const { cancelDatabaseJob, JOB_ID_RE } = await import(
        '../services/hub-transfer/database-jobs.js'
      )
      // An app no longer listed has had its jobs aborted already (forgetDatabaseJobs).
      const ok = JOB_ID_RE.test(req.params.job)
      return reply.send({
        cancelled: ok ? cancelDatabaseJob(req.params.id, req.params.job) : false
      })
    }
  )

  app.delete<{ Params: { id: string } }>('/apps/:id/database', async (req, reply) => {
    const registry = registryOr503(reply)
    if (!registry) return reply
    const t = await tenantById(registry, req.params.id)
    if (!t) return reply.send({ discarded: false })
    const { discardDatabaseShared } = await import('../services/hub-transfer/database.js')
    const sha = (req.body as { sha256?: unknown } | null)?.sha256
    try {
      return reply.send(await discardDatabaseShared(t, typeof sha === 'string' ? sha : null))
    } catch (err) {
      return databaseRefusal(reply, err, 'the database copy could not be discarded')
    }
  })

  app.get<{ Params: { id: string; runId: string } }>(
    '/apps/:id/files/pull/:runId',
    async (req, reply) => {
      const registry = registryOr503(reply)
      if (!registry) return reply
      const t = await tenantById(registry, req.params.id)
      if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
      const { readPullStatus } = await import('../services/hub-transfer/pull.js')
      const s = await withTenant(t, () => readPullStatus(req.params.runId), t.origin)
      if (!s) return refuse(reply, 404, 'No file copy with that id here', 'UNKNOWN_RUN')
      return reply.send(s)
    }
  )
}
