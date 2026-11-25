import type { FastifyInstance, FastifyReply } from 'fastify'
import { getTenantDb, withTenant } from '../db/tenant-context.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord } from '../services/tenancy/types.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Hub security, APP side (0.3.215+): access-review reads and break-glass grants
 * (services/hub-link/security.ts). Registered INSIDE the hub link (routes/hub-link.ts,
 * `/api/hub-link/security/*`, a dedicated app) and the deployment link
 * (routes/hub-deployment-link.ts, `/api/hub-deployment/apps/:id/security/*`, one app of a shared
 * deployment), after each plugin's bearer hook — so every route here inherits that link's
 * unconditional bearer check (no route decides for itself whether to authenticate). Both prefixes
 * are free paths of the maintenance freeze and the retire gate.
 *
 *   GET  security/role-holders          → {version, accounts, total, truncated}
 *   POST security/break-glass           {ref, emails?, entra?, until, reason} → {state, user_id, until}
 *   POST security/break-glass/revoke    {ref, user_id} → {state}
 *
 * The app's own revoke job `hub-break-glass-expire` is a core job (server.ts, every install):
 * a grant ends on time even where the hub link is gone.
 */

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

type InApp = <T>(
  id: string | undefined,
  reply: FastifyReply,
  fn: () => Promise<T>
) => Promise<T | FastifyReply>

function securityRoutes(app: FastifyInstance, prefix: string, inApp: InApp) {
  app.get<{ Params: { id?: string } }>(`${prefix}/role-holders`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return inApp(req.params.id, reply, async () => {
      try {
        const { listRoleHolders } = await import('../services/hub-link/security.js')
        return reply.send({ version: NIVARO_VERSION, ...(await listRoleHolders(getTenantDb())) })
      } catch (err) {
        app.log.error(
          { code: (err as { code?: unknown } | null)?.code ?? null },
          'hub link: the role holders could not be read'
        )
        return fail(reply, 500, 'ROLE_HOLDERS_FAILED', 'The role holders could not be read')
      }
    })
  })

  app.post<{ Params: { id?: string } }>(`${prefix}/break-glass`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return inApp(req.params.id, reply, async () => {
      try {
        const { grantBreakGlass } = await import('../services/hub-link/security.js')
        const out = await grantBreakGlass(req.body, { k: getTenantDb() })
        if (!out.ok) return fail(reply, out.status, out.code, out.message)
        return reply.send({ state: out.state, user_id: out.user_id, until: out.until })
      } catch (err) {
        app.log.error(
          { code: (err as { code?: unknown } | null)?.code ?? null },
          'hub link: a break-glass grant failed'
        )
        return fail(reply, 500, 'GRANT_FAILED', 'The grant could not be made')
      }
    })
  })

  app.post<{ Params: { id?: string } }>(`${prefix}/break-glass/revoke`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return inApp(req.params.id, reply, async () => {
      try {
        const { revokeBreakGlass } = await import('../services/hub-link/security.js')
        const out = await revokeBreakGlass(req.body, { k: getTenantDb() })
        if (!out.ok) return fail(reply, out.status, out.code, out.message)
        return reply.send({ state: out.state })
      } catch (err) {
        app.log.error(
          { code: (err as { code?: unknown } | null)?.code ?? null },
          'hub link: a break-glass revoke failed'
        )
        return fail(reply, 500, 'REVOKE_FAILED', 'The grant could not be revoked')
      }
    })
  })
}

/** Inside routes/hub-link.ts (after its bearer hook): `/api/hub-link/security/*`. */
export function hubLinkSecurityRoutes(app: FastifyInstance): void {
  securityRoutes(app, '/security', async (_id, _reply, fn) => fn())
}

async function tenantById(id: string): Promise<TenantRecord | null> {
  const registry = getTenantRegistry()
  if (!registry) return null
  if (registry.byId) return registry.byId(id)
  const all = registry.listAll ? await registry.listAll() : await registry.listActive()
  return all.find((t) => t.id === id) ?? null
}

/** Inside routes/hub-deployment-link.ts (after its bearer hook): `/api/hub-deployment/apps/:id/security/*`. */
export function deploymentLinkSecurityRoutes(app: FastifyInstance): void {
  const inApp: InApp = async (id, reply, fn) => {
    const t = id ? await tenantById(id) : null
    if (!t) return fail(reply, 404, 'UNKNOWN_APP', 'This deployment does not serve that app')
    return withTenant(t, fn, t.origin)
  }
  securityRoutes(app, '/apps/:id/security', inApp)
}
