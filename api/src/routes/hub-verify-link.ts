import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubSharedConfig, isMultiTenant, tenantSource } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import { extensionInventory, parseReads, runVerifyReads } from '../services/hub-link/verify.js'
import { bearerMatches } from '../services/render-peer.js'
import { deploymentLinkBearer } from '../services/tenancy/hub-contract.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../services/tenancy/types.js'

/**
 * Hub verification, app side (0.3.215+): the post-deploy smoke reads and the extension inventory a
 * Nivaro Hub asks for (services/hub-link/verify.ts).
 *
 * Dedicated app (registered under /api/hub-link; mounted only where HUB_TOKEN ≥ 32 characters is
 * set, never on a deployment that serves many apps):
 *
 *   POST /api/hub-link/verify/run         {reads: [...]} → {version, results: [{status, ms, rows, code}]}
 *   GET  /api/hub-link/verify/extensions  → {version, extensions: [{id, status, enabled, version, build}]}
 *
 * Hub shared deployment (registered under /api/hub-deployment; bearer = deploymentLinkBearer of
 * HUB_DEPLOYMENT_TOKEN), inside that app:
 *
 *   POST /api/hub-deployment/verify/apps/:id/run
 *   GET  /api/hub-deployment/verify/apps/:id/extensions
 *
 * Both: timing-safe bearer, 401 / 429 after 20 failures a minute from one address,
 * `Cache-Control: no-store`. /api/hub-link/ and /api/hub-deployment/ are free paths, so the
 * maintenance freeze never stops them (a smoke read is a read; the temporary key it mints is the
 * app's own bookkeeping). Facts only: statuses, milliseconds, row counts, ids and builds.
 */

const REFUSED = 'HUB_LINK_REFUSED'
const DEPLOYMENT_REFUSED = 'DEPLOYMENT_LINK_REFUSED'

function refuse(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

async function runReads(
  req: FastifyRequest,
  reply: FastifyReply,
  host: string | null
): Promise<FastifyReply> {
  const reads = parseReads(req.body)
  if (!Array.isArray(reads)) return refuse(reply, 400, reads.error, 'BAD_READS')
  try {
    return reply.send(
      await runVerifyReads(reads, { inject: req.server.inject.bind(req.server), host })
    )
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    if (code === 'NO_ADMIN_ROLE')
      return refuse(reply, 409, 'This app has no administrator role', 'NO_ADMIN_ROLE')
    req.log.warn({ code: code ?? null }, 'hub link: smoke reads failed')
    return refuse(reply, 503, 'The smoke reads could not run', 'VERIFY_FAILED')
  }
}

/** /api/hub-link/verify/* on a dedicated app (HUB_TOKEN). */
export async function hubVerifyLinkRoutes(app: FastifyInstance): Promise<void> {
  const token = hubLinkToken()
  if (!token || isMultiTenant()) return
  const authFails = failedAuthLimiter()
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (authFails.blocked(req.ip)) return refuse(reply, 429, 'Too many attempts', REFUSED)
    if (!bearerMatches(req.headers.authorization, token)) {
      authFails.fail(req.ip)
      return refuse(reply, 401, 'Unauthorized', REFUSED)
    }
  })

  app.post('/verify/run', async (req, reply) => runReads(req, reply, null))
  app.get('/verify/extensions', async (_req, reply) => reply.send(extensionInventory()))
}

async function tenantById(registry: TenantRegistry, id: string): Promise<TenantRecord | null> {
  if (registry.byId) return registry.byId(id)
  const all = registry.listAll ? await registry.listAll() : await registry.listActive()
  return all.find((t) => t.id === id) ?? null
}

function hostOf(origin: string | null | undefined): string | null {
  try {
    return origin ? new URL(origin).host : null
  } catch {
    return null
  }
}

/** /api/hub-deployment/verify/apps/:id/* on a Hub shared deployment, inside that app. */
export async function hubVerifyDeploymentRoutes(app: FastifyInstance): Promise<void> {
  if (tenantSource() !== 'hub') return
  const cfg = hubSharedConfig()
  if (!cfg || cfg.token.length < 32) return
  const bearer = deploymentLinkBearer(cfg.token)
  const authFails = failedAuthLimiter()
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (authFails.blocked(req.ip))
      return refuse(reply, 429, 'Too many attempts', DEPLOYMENT_REFUSED)
    if (!bearerMatches(req.headers.authorization, bearer)) {
      authFails.fail(req.ip)
      return refuse(reply, 401, 'Unauthorized', DEPLOYMENT_REFUSED)
    }
  })

  /** The app `id` names, or the refusal already sent. */
  const tenant = async (
    reply: FastifyReply,
    id: string
  ): Promise<{ t: TenantRecord } | { sent: FastifyReply }> => {
    const registry = getTenantRegistry()
    if (!registry)
      return {
        sent: refuse(reply, 503, 'The tenant list is not loaded yet', 'REGISTRY_NOT_READY')
      }
    const t = await tenantById(registry, id)
    if (!t)
      return { sent: refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP') }
    return { t }
  }

  app.post<{ Params: { id: string } }>('/verify/apps/:id/run', async (req, reply) => {
    const found = await tenant(reply, req.params.id)
    if ('sent' in found) return found.sent
    const { t } = found
    return withTenant(t, () => runReads(req, reply, hostOf(t.origin)), t.origin)
  })

  app.get<{ Params: { id: string } }>('/verify/apps/:id/extensions', async (req, reply) => {
    const found = await tenant(reply, req.params.id)
    if ('sent' in found) return found.sent
    // One process serves every app here: what it loaded is the same for each of them.
    return reply.send(extensionInventory())
  })
}
