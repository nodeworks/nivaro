import type { FastifyInstance, FastifyReply } from 'fastify'
import { withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubSharedConfig, isMultiTenant, tenantSource } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import {
  applyPromotion,
  PromoteError,
  planPromotion,
  promotionStatus,
  readPromotionSnapshot,
  undoPromotion
} from '../services/hub-link/config-promote.js'
import { bearerMatches } from '../services/render-peer.js'
import { deploymentLinkBearer } from '../services/tenancy/hub-contract.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../services/tenancy/types.js'

/**
 * Hub config promotion (idea 30), APP side — the four calls a Nivaro Hub makes to move an app's
 * configuration between its environments (services/hub-link/config-promote.ts does the work with
 * the config restore engine):
 *
 *   POST snapshot {tables}                         → {version, environment, snapshot}  (source)
 *   POST plan     {snapshot, tables, deletes, …}   → field diff, plan hash, kept, held  (target)
 *   POST apply    {… + plan_hash, overwrite_prod_changes?} → counts, pre-apply restore point
 *   POST status   {run_key}                        → applied / undone / not_applied (lost answer)
 *   POST undo     {run_key, mode, plan_hash?, …}   → preview / put back the rows that run wrote
 *
 * Dedicated app: /api/hub-link/config/* — mounted only where HUB_TOKEN (≥ 32 characters) is set,
 * never on a deployment that serves many apps. Hub shared deployment: /api/hub-deployment/config/
 * apps/:id/* inside that app — mounted only where the tenant list comes from the Hub; bearer =
 * deploymentLinkBearer(HUB_DEPLOYMENT_TOKEN). Both: the bearer is checked on EVERY request of the
 * plugin (never by URL), timing-safe, 401 / 429 after 20 failures a minute from one address,
 * `Cache-Control: no-store`; plan/apply bodies up to 128 MB (a snapshot). /api/hub-link/ and
 * /api/hub-deployment/ are free paths (the maintenance freeze and the retire gate never stop them).
 */

const REFUSED = 'HUB_LINK_REFUSED'
const DEPLOYMENT_REFUSED = 'DEPLOYMENT_LINK_REFUSED'
const BIG = { bodyLimit: 128 * 1024 * 1024 }

function refuse(
  reply: FastifyReply,
  status: number,
  message: string,
  code: string,
  extra: Record<string, unknown> = {}
) {
  return reply.code(status).send({ statusCode: status, error: message, message, code, ...extra })
}

type Work = (body: unknown) => Promise<unknown>
const WORK: Record<string, Work> = {
  snapshot: (b) => readPromotionSnapshot((b as { tables?: unknown } | null)?.tables),
  plan: planPromotion,
  apply: applyPromotion,
  status: promotionStatus,
  undo: undoPromotion
}

async function run(
  app: FastifyInstance,
  reply: FastifyReply,
  what: string,
  fn: () => Promise<unknown>
): Promise<FastifyReply> {
  try {
    return reply.send(await fn())
  } catch (err) {
    if (err instanceof PromoteError)
      return refuse(reply, err.status, err.message, err.code, err.extra)
    app.log.warn(
      { code: (err as { code?: unknown } | null)?.code ?? null },
      `hub config promotion: ${what} failed`
    )
    return refuse(reply, 500, `The config ${what} failed`, 'CONFIG_PROMOTE_FAILED')
  }
}

function bearerHook(app: FastifyInstance, bearer: string, code: string) {
  const authFails = failedAuthLimiter()
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (authFails.blocked(req.ip)) return refuse(reply, 429, 'Too many attempts', code)
    if (!bearerMatches(req.headers.authorization, bearer)) {
      if (authFails.fail(req.ip)) app.log.warn({ ip: req.ip }, 'hub config link: wrong bearer')
      return refuse(reply, 401, 'Unauthorized', code)
    }
  })
}

/** /api/hub-link/config/* on a dedicated app (HUB_TOKEN). */
export async function hubConfigLinkRoutes(app: FastifyInstance): Promise<void> {
  const token = hubLinkToken()
  if (!token || isMultiTenant()) return
  bearerHook(app, token, REFUSED)
  for (const [name, fn] of Object.entries(WORK))
    app.post(`/config/${name}`, BIG, async (req, reply) =>
      run(app, reply, name, () => fn(req.body))
    )
}

/** An app this deployment serves now (active or in maintenance) — never a retired or suspended one. */
async function tenantById(registry: TenantRegistry, id: string): Promise<TenantRecord | null> {
  const t = registry.byId
    ? await registry.byId(id)
    : ((await registry.listActive()).find((x) => x.id === id) ?? null)
  return t && (t.status === 'active' || t.status === 'maintenance') ? t : null
}

/** /api/hub-deployment/config/apps/:id/* on a Hub shared deployment, inside that app. */
export async function hubConfigDeploymentRoutes(app: FastifyInstance): Promise<void> {
  if (tenantSource() !== 'hub') return
  const cfg = hubSharedConfig()
  if (!cfg || cfg.token.length < 32) return
  bearerHook(app, deploymentLinkBearer(cfg.token), DEPLOYMENT_REFUSED)
  for (const [name, fn] of Object.entries(WORK))
    app.post<{ Params: { id: string } }>(`/config/apps/:id/${name}`, BIG, async (req, reply) => {
      const registry = getTenantRegistry()
      if (!registry)
        return refuse(reply, 503, 'The tenant list is not loaded yet', 'REGISTRY_NOT_READY')
      const t = await tenantById(registry, req.params.id)
      if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
      return run(app, reply, name, () => withTenant(t, () => fn(req.body), t.origin))
    })
}
