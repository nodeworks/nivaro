import type { FastifyInstance, FastifyReply } from 'fastify'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { readUsage } from '../services/capacity/app-usage.js'
import { hubSharedConfig, isMultiTenant, tenantSource } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import { bearerMatches } from '../services/render-peer.js'
import { deploymentLinkBearer } from '../services/tenancy/hub-contract.js'

/**
 * Capacity figures for the Hub (Hub capacity view, idea 9), app side.
 *
 *   GET /api/hub-deployment/usage  → CapacityUsage, every app of this shared deployment
 *   GET /api/hub-link/usage        → CapacityUsage, this dedicated app (one app, id `app`)
 *
 * Each is its own plugin beside the link it belongs to (routes/hub-deployment-link.ts,
 * routes/hub-link.ts) and mounted under the same conditions, with the same bearer: the
 * deployment link's derived bearer (ruling R7) on a shared deployment, HUB_TOKEN on a dedicated
 * app. Counts, timings and bytes only (services/capacity/app-usage.ts); never mounted in Nivaro
 * Cloud. `Cache-Control: no-store`; 401 / 429 like the links themselves.
 */

function refuse(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

function guard(app: FastifyInstance, bearer: string, code: string): void {
  const authFails = failedAuthLimiter()
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (authFails.blocked(req.ip)) return refuse(reply, 429, 'Too many attempts', code)
    if (!bearerMatches(req.headers.authorization, bearer)) {
      authFails.fail(req.ip)
      return refuse(reply, 401, 'Unauthorized', code)
    }
  })
}

/** On a Hub shared deployment, under /api/hub-deployment. */
export async function hubDeploymentUsageRoutes(app: FastifyInstance): Promise<void> {
  if (tenantSource() !== 'hub') return
  const cfg = hubSharedConfig()
  if (!cfg || cfg.token.length < 32) return
  guard(app, deploymentLinkBearer(cfg.token), 'DEPLOYMENT_LINK_REFUSED')
  app.get('/usage', async (_req, reply) => reply.send(await readUsage()))
}

/** On a hub-linked dedicated app (HUB_TOKEN), under /api/hub-link. */
export async function hubLinkUsageRoutes(app: FastifyInstance): Promise<void> {
  const token = hubLinkToken()
  if (!token || isMultiTenant()) return
  guard(app, token, 'HUB_LINK_REFUSED')
  app.get('/usage', async (_req, reply) => reply.send(await readUsage()))
}
