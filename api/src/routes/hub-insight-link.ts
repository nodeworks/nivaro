import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { getTenantDb, withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubSharedConfig, isMultiTenant, tenantSource } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import { dependencyReport, usageReport } from '../services/hub-link/insight-report.js'
import { bearerMatches } from '../services/render-peer.js'
import { deploymentLinkBearer } from '../services/tenancy/hub-contract.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../services/tenancy/types.js'

/**
 * Hub insight, app side (enhancements 36 + 37): read-only aggregates a Nivaro Hub collects —
 * usage counts (people per day, busiest screens, under a privacy floor of at least 5 people) and
 * the hosts / extensions this app depends on (services/hub-link/insight-report.ts).
 *
 * Dedicated app (registered under /api/hub-link, mounted only where HUB_TOKEN ≥ 32 characters is
 * set and never on a deployment that serves many apps — Nivaro Cloud or a Hub shared deployment):
 *
 *   GET /api/hub-link/ops/usage?days=14&floor=5 → UsageReport
 *   GET /api/hub-link/ops/dependencies          → DependencyReport
 *
 * Hub shared deployment (registered under /api/hub-deployment, mounted only where the tenant list
 * comes from the Hub; bearer = deploymentLinkBearer(HUB_DEPLOYMENT_TOKEN)), inside that app:
 *
 *   GET /api/hub-deployment/ops/apps/:id/usage?days=14&floor=5
 *   GET /api/hub-deployment/ops/apps/:id/dependencies
 *
 * Both: `Authorization: Bearer …` compared timing-safe in an onRequest hook on EVERY route of the
 * plugin (never decided from the URL), 401 / 429 after 20 failures a minute from one address,
 * `Cache-Control: no-store`, GET only. Counts, route patterns and host names only — never a
 * person, a record, a raw URL, a path or a credential.
 */

const REFUSED = 'HUB_LINK_REFUSED'
const DEPLOYMENT_REFUSED = 'DEPLOYMENT_LINK_REFUSED'

function refuse(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

function intOf(q: unknown, key: string): number | undefined {
  const raw = (q as Record<string, unknown> | null)?.[key]
  const n = Number(raw)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

const usageOpts = (q: unknown) => ({ days: intOf(q, 'days'), floor: intOf(q, 'floor') })

/** GET /api/hub-link/ops/usage|dependencies on a dedicated app (HUB_TOKEN). */
export async function hubInsightLinkRoutes(app: FastifyInstance): Promise<void> {
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

  app.get('/ops/usage', async (req, reply) => {
    try {
      return reply.send(await usageReport(usageOpts(req.query)))
    } catch (err) {
      req.log.warn(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: usage report failed'
      )
      return refuse(reply, 503, 'The usage summary could not be read', 'INSIGHT_READ_FAILED')
    }
  })

  app.get('/ops/dependencies', async (req, reply) => {
    try {
      return reply.send(await dependencyReport({ oidcIssuer: () => config.OIDC_ISSUER || null }))
    } catch (err) {
      req.log.warn(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: dependency report failed'
      )
      return refuse(reply, 503, 'The dependency list could not be read', 'INSIGHT_READ_FAILED')
    }
  })
}

async function tenantById(registry: TenantRegistry, id: string): Promise<TenantRecord | null> {
  if (registry.byId) return registry.byId(id)
  const all = registry.listAll ? await registry.listAll() : await registry.listActive()
  return all.find((t) => t.id === id) ?? null
}

/** GET /api/hub-deployment/ops/apps/:id/usage|dependencies on a Hub shared deployment. */
export async function hubInsightDeploymentRoutes(app: FastifyInstance): Promise<void> {
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

  const inApp = async <T>(
    reply: FastifyReply,
    id: string,
    what: string,
    fn: () => Promise<T>
  ): Promise<FastifyReply> => {
    const registry = getTenantRegistry()
    if (!registry)
      return refuse(reply, 503, 'The tenant list is not loaded yet', 'REGISTRY_NOT_READY')
    const t = await tenantById(registry, id)
    if (!t) return refuse(reply, 404, 'This deployment does not serve that app', 'UNKNOWN_APP')
    try {
      return reply.send(await withTenant(t, fn, t.origin))
    } catch (err) {
      app.log.warn(
        { tenant: t.id, code: (err as { code?: unknown } | null)?.code ?? null },
        `deployment link: ${what} failed`
      )
      return refuse(reply, 503, `The ${what} could not be read`, 'INSIGHT_READ_FAILED')
    }
  }

  app.get<{ Params: { id: string } }>('/ops/apps/:id/usage', async (req, reply) =>
    inApp(reply, req.params.id, 'usage summary', () =>
      usageReport(usageOpts(req.query), getTenantDb())
    )
  )

  // One process serves many apps here: the sign-in issuer is the deployment's, not this app's,
  // so it is not named (the Hub knows each app's sign-in from its own records).
  app.get<{ Params: { id: string } }>('/ops/apps/:id/dependencies', async (req, reply) =>
    inApp(reply, req.params.id, 'dependency list', () =>
      dependencyReport({ oidcIssuer: () => null }, getTenantDb())
    )
  )
}
