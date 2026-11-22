import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { getTenantDb, withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubSharedConfig, tenantSource } from '../services/deployment-mode.js'
import { seedFirstAdmin } from '../services/hub-link/first-admin.js'
import { INSTANCE_ID } from '../services/instance-roster.js'
import { poolCounters } from '../services/pool-attribution.js'
import { bearerMatches } from '../services/render-peer.js'
import { appSchemaStatus } from '../services/tenancy/app-migrations.js'
import {
  type AppSchemaState,
  appStatusFor,
  checkDatabase,
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

/**
 * Deployment link (Hub phase 6) — the shared twin of the per-app hub link (routes/hub-link.ts):
 * what a Nivaro Hub may read and ask of the shared deployment it runs.
 *
 *   GET  /api/hub-deployment/status                  → DeploymentStatus
 *   GET  /api/hub-deployment/apps/:id/status         → DeploymentAppStatus (404 UNKNOWN_APP)
 *   POST /api/hub-deployment/apps/:id/first-admin    → as POST /api/hub-link/first-admin, in that app
 *   POST /api/hub-deployment/refresh                 → 202; every replica re-reads its tenant list
 *   POST /api/hub-deployment/db-check {client, connection} → {reachable, ledger, db_identity, error}
 *
 * Mounted only on a Hub shared deployment (tenantSource() === 'hub'), never in Nivaro Cloud and
 * never on a dedicated app (HUB_TOKEN alone). The tenant hook frees `/api/hub-deployment/`, so a
 * call on the deployment's own address (no app hostname) still reaches it.
 *
 * Auth (ruling R7): `Authorization: Bearer <deploymentLinkBearer(HUB_DEPLOYMENT_TOKEN)>`, the
 * HMAC of the deployment token — the token itself never crosses this link. Timing-safe; 401
 * DEPLOYMENT_LINK_REFUSED, 429 after 20 failures a minute from one address. Every answer is
 * `Cache-Control: no-store`. Counts and health figures only: never a record, a connection
 * string, an app key (its fingerprint only) or a driver's raw error text.
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
        pool: poolFigures()
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
    const b = (req.body ?? {}) as { client?: unknown; connection?: unknown }
    const client = typeof b.client === 'string' ? b.client : ''
    const connection = typeof b.connection === 'string' ? b.connection.trim() : ''
    if (!DB_CHECK_CLIENTS.has(client))
      return refuse(reply, 400, 'Unknown database client', 'BAD_DB_CLIENT')
    if (!connection || connection.length > CONNECTION_MAX)
      return refuse(reply, 400, 'A connection is required', 'BAD_DB_CONNECTION')
    return reply.send(await checkDatabase(client, connection))
  })
}
