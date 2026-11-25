import type { FastifyInstance, FastifyReply } from 'fastify'
import { getTenantDb, withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubSharedConfig, isMultiTenant, tenantSource } from '../services/deployment-mode.js'
import { hubLinkToken } from '../services/hub/mode.js'
import { filesUsage, issueRollup } from '../services/hub-link/ops-report.js'
import { bearerMatches } from '../services/render-peer.js'
import { deploymentLinkBearer } from '../services/tenancy/hub-contract.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord, TenantRegistry } from '../services/tenancy/types.js'

/**
 * Hub operations, app side (enhancements 10 + 20): read-only aggregates a Nivaro Hub collects —
 * issue / crash group summaries and stored-files usage (services/hub-link/ops-report.ts).
 *
 * Dedicated app (registered under /api/hub-link, mounted only where HUB_TOKEN ≥ 32 characters is
 * set and never on a deployment that serves many apps — Nivaro Cloud or a Hub shared deployment):
 *
 *   GET /api/hub-link/ops/issues?days=30 → IssueRollup
 *   GET /api/hub-link/ops/files          → FilesUsage
 *
 * Hub shared deployment (registered under /api/hub-deployment, mounted only where the tenant list
 * comes from the Hub; bearer = deploymentLinkBearer(HUB_DEPLOYMENT_TOKEN)), inside that app:
 *
 *   GET /api/hub-deployment/ops/apps/:id/issues?days=30
 *   GET /api/hub-deployment/ops/apps/:id/files
 *
 * Both: `Authorization: Bearer …` compared timing-safe, 401 / 429 after 20 failures a minute from
 * one address, `Cache-Control: no-store`, GET only (the maintenance freeze and the retire gate
 * never stop them: /api/hub-link/ and /api/hub-deployment/ are free paths). Counts, scrubbed
 * titles and ids only — never a stack, a record value, a person or a file name.
 */

const REFUSED = 'HUB_LINK_REFUSED'
const DEPLOYMENT_REFUSED = 'DEPLOYMENT_LINK_REFUSED'

function refuse(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

function daysOf(q: unknown): number {
  const raw = (q as { days?: unknown } | null)?.days
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.min(90, Math.round(n)) : 30
}

/** GET /api/hub-link/ops/* on a dedicated app (HUB_TOKEN). */
export async function hubOpsLinkRoutes(app: FastifyInstance): Promise<void> {
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

  app.get('/ops/issues', async (req, reply) => {
    try {
      return reply.send(await issueRollup({ days: daysOf(req.query) }))
    } catch (err) {
      req.log.warn(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: issue rollup failed'
      )
      return refuse(reply, 503, 'The issue summary could not be read', 'OPS_READ_FAILED')
    }
  })

  app.get('/ops/files', async (req, reply) => {
    try {
      return reply.send(await filesUsage())
    } catch (err) {
      req.log.warn(
        { code: (err as { code?: unknown } | null)?.code ?? null },
        'hub link: files usage failed'
      )
      return refuse(reply, 503, 'The files usage could not be read', 'OPS_READ_FAILED')
    }
  })
}

async function tenantById(registry: TenantRegistry, id: string): Promise<TenantRecord | null> {
  if (registry.byId) return registry.byId(id)
  const all = registry.listAll ? await registry.listAll() : await registry.listActive()
  return all.find((t) => t.id === id) ?? null
}

/** GET /api/hub-deployment/ops/apps/:id/* on a Hub shared deployment, inside that app. */
export async function hubOpsDeploymentRoutes(app: FastifyInstance): Promise<void> {
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
      return refuse(reply, 503, `The ${what} could not be read`, 'OPS_READ_FAILED')
    }
  }

  app.get<{ Params: { id: string } }>('/ops/apps/:id/issues', async (req, reply) =>
    inApp(reply, req.params.id, 'issue summary', () =>
      issueRollup({ days: daysOf(req.query) }, getTenantDb())
    )
  )

  app.get<{ Params: { id: string } }>('/ops/apps/:id/files', async (req, reply) =>
    inApp(reply, req.params.id, 'files usage', () => filesUsage(getTenantDb()))
  )
}
