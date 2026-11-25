import type { FastifyInstance, FastifyReply } from 'fastify'
import { withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubSharedConfig, isMultiTenant, tenantSource } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import {
  type BannerRedis,
  type BannerWrite,
  clearStatusBanner,
  setStatusBanner
} from '../services/hub-link/status-banner.js'
import { bearerMatches } from '../services/render-peer.js'
import { deploymentLinkBearer } from '../services/tenancy/hub-contract.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../services/tenancy/types.js'

/**
 * Hub incident status banner, app side (Hub enhancement 32; services/hub-link/status-banner.ts).
 * The narrow write a Hub makes while one of its incidents is open — one line of plain text every
 * signed-in person of this app sees, and its removal. Nothing else is reachable here.
 *
 * Dedicated app (under /api/hub-link, mounted only where HUB_TOKEN ≥ 32 characters is set and
 * never on a deployment that serves many apps):
 *   PUT    /api/hub-link/status-banner  {text, tone, incident_id} → {banner}
 *   DELETE /api/hub-link/status-banner  {incident_id?}            → {banner: null | the other}
 *
 * Hub shared deployment (under /api/hub-deployment, only where the tenant list comes from the
 * Hub; bearer = deploymentLinkBearer(HUB_DEPLOYMENT_TOKEN)), inside that app:
 *   PUT | DELETE /api/hub-deployment/apps/:id/status-banner
 *
 * Both: EVERY request this plugin serves needs `Authorization: Bearer …` (the onRequest hook is
 * plugin-scoped and never looks at the URL), compared timing-safe, 401 / 429 after 20 failures a minute from
 * one address, `Cache-Control: no-store`. Exempt from the app's own maintenance freeze like every
 * hub-link call (a banner is how people learn about the outage).
 */

const REFUSED = 'HUB_LINK_REFUSED'
const DEPLOYMENT_REFUSED = 'DEPLOYMENT_LINK_REFUSED'

function refuse(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

function redisOf(app: FastifyInstance): BannerRedis | null {
  return ((app as unknown as { redis?: BannerRedis }).redis ?? null) as BannerRedis | null
}

function answer(reply: FastifyReply, out: BannerWrite) {
  if (!out.ok) return refuse(reply, out.status, out.message, out.code)
  return reply.send({ banner: out.banner })
}

/** PUT / DELETE /api/hub-link/status-banner on a dedicated app (HUB_TOKEN). */
export async function hubLinkBannerRoutes(app: FastifyInstance): Promise<void> {
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

  app.put('/status-banner', async (req, reply) => {
    try {
      return answer(reply, await setStatusBanner(redisOf(app), req.body))
    } catch {
      return refuse(reply, 503, 'The banner could not be stored (Redis)', 'REDIS_UNAVAILABLE')
    }
  })

  app.delete('/status-banner', async (req, reply) => {
    try {
      return answer(reply, await clearStatusBanner(redisOf(app), req.body))
    } catch {
      return refuse(reply, 503, 'The banner could not be cleared (Redis)', 'REDIS_UNAVAILABLE')
    }
  })
}

async function tenantById(registry: TenantRegistry, id: string): Promise<TenantRecord | null> {
  if (registry.byId) return registry.byId(id)
  const all = registry.listAll ? await registry.listAll() : await registry.listActive()
  return all.find((t) => t.id === id) ?? null
}

/** PUT / DELETE /api/hub-deployment/apps/:id/status-banner on a Hub shared deployment. */
export async function hubDeploymentBannerRoutes(app: FastifyInstance): Promise<void> {
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

  const inApp = async (
    reply: FastifyReply,
    id: string,
    fn: () => Promise<BannerWrite>
  ): Promise<FastifyReply> => {
    const registry = getTenantRegistry()
    if (!registry)
      return refuse(reply, 503, 'The tenant list is not loaded yet', 'REGISTRY_NOT_READY')
    const t = await tenantById(registry, id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    try {
      return answer(reply, await withTenant(t, fn, t.origin))
    } catch {
      return refuse(reply, 503, 'The banner could not be written (Redis)', 'REDIS_UNAVAILABLE')
    }
  }

  app.put<{ Params: { id: string } }>('/apps/:id/status-banner', async (req, reply) =>
    inApp(reply, req.params.id, () => setStatusBanner(redisOf(app), req.body))
  )
  app.delete<{ Params: { id: string } }>('/apps/:id/status-banner', async (req, reply) =>
    inApp(reply, req.params.id, () => clearStatusBanner(redisOf(app), req.body))
  )
}
