import type { FastifyInstance, FastifyReply } from 'fastify'
import { withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubSharedConfig, isMultiTenant, tenantSource } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import { CloneExportError, exportCloneBlueprint } from '../services/hub-link/clone-export.js'
import { instanceKey } from '../services/instance-key.js'
import { bearerMatches } from '../services/render-peer.js'
import { deploymentLinkBearer } from '../services/tenancy/hub-contract.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../services/tenancy/types.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Hub app cloning, app side (Hub enhancement 46; services/hub-link/clone-export.ts): the one read a
 * Nivaro Hub makes to copy this app's STRUCTURE into a new app — collections, fields, relations,
 * workflows and pipelines, layouts, queues, rules, roles and flows; never records, files, people
 * or secrets (secrets are emptied here, before the bundle leaves).
 *
 * Dedicated app (registered under /api/hub-link; mounted only where HUB_TOKEN ≥ 32 characters is
 * set, never on a deployment that serves many apps):
 *
 *   GET /api/hub-link/clone/blueprint → {package, scrubbed, review, bytes, version}
 *
 * Hub shared deployment (registered under /api/hub-deployment; bearer =
 * deploymentLinkBearer(HUB_DEPLOYMENT_TOKEN)), inside that app:
 *
 *   GET /api/hub-deployment/clone/apps/:id/blueprint
 *
 * Both: EVERY request this plugin serves needs the bearer (the onRequest hook is plugin-scoped
 * and never looks at the URL), compared timing-safe; 401 / 429 after 20 failures a minute from
 * one address; `Cache-Control: no-store`. A GET, so the maintenance freeze never stops it (a frozen
 * or retiring app can still be cloned).
 */

const REFUSED = 'HUB_LINK_REFUSED'
const DEPLOYMENT_REFUSED = 'DEPLOYMENT_LINK_REFUSED'

function refuse(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

async function answer(
  app: FastifyInstance,
  reply: FastifyReply,
  label: string
): Promise<FastifyReply> {
  try {
    const out = await exportCloneBlueprint({ label })
    return reply.send({ ...out, version: NIVARO_VERSION })
  } catch (err) {
    if (err instanceof CloneExportError) return refuse(reply, err.status, err.message, err.code)
    app.log.warn(
      { code: (err as { code?: unknown } | null)?.code ?? null },
      'hub link: the structure export for a clone failed'
    )
    return refuse(reply, 503, 'The structure could not be exported', 'CLONE_EXPORT_FAILED')
  }
}

/** GET /api/hub-link/clone/blueprint on a dedicated app (HUB_TOKEN). */
export async function hubLinkCloneRoutes(app: FastifyInstance): Promise<void> {
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

  app.get('/clone/blueprint', async (_req, reply) => answer(app, reply, instanceKey()))
}

async function tenantById(registry: TenantRegistry, id: string): Promise<TenantRecord | null> {
  if (registry.byId) return registry.byId(id)
  const all = registry.listAll ? await registry.listAll() : await registry.listActive()
  return all.find((t) => t.id === id) ?? null
}

/** GET /api/hub-deployment/clone/apps/:id/blueprint on a Hub shared deployment, inside that app. */
export async function hubDeploymentCloneRoutes(app: FastifyInstance): Promise<void> {
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

  app.get<{ Params: { id: string } }>('/clone/apps/:id/blueprint', async (req, reply) => {
    const registry = getTenantRegistry()
    if (!registry)
      return refuse(reply, 503, 'The tenant list is not loaded yet', 'REGISTRY_NOT_READY')
    const t = await tenantById(registry, req.params.id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    return withTenant(t, () => answer(app, reply, t.id), t.origin)
  })
}
