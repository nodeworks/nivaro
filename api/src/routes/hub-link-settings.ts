import type { FastifyInstance, FastifyReply } from 'fastify'
import { getTenantDb, withTenant } from '../db/tenant-context.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord } from '../services/tenancy/types.js'

/**
 * Hub providers (Task 13), APP side: the Hub pushes a managed resource's output (an SMTP password,
 * an AI key) into one of this app's allow-listed settings (services/hub-link/settings-apply.ts).
 * Registered INSIDE the hub link (routes/hub-link.ts, `/api/hub-link/settings/apply`, a dedicated
 * app) and the deployment link (routes/hub-deployment-link.ts,
 * `/api/hub-deployment/apps/:id/settings/apply`), after each plugin's bearer hook — so the route
 * inherits that link's unconditional bearer check. It writes the app's own data, so on the hub
 * link it is frozen by maintenance and refused once retired, like the template install
 * (services/hub-link/retire.ts isHubLinkAppWrite).
 *
 *   POST settings/apply  {settings: {key: value|null}} → {applied: [key]}
 *                        400 SETTING_NOT_ALLOWED (a key off the list; nothing written)
 *                        409 SETTING_NOT_ON_THIS_APP (no such setting on this version)
 */

function fail(reply: FastifyReply, status: number, code: string, message: string, keys?: string[]) {
  return reply
    .code(status)
    .send({ statusCode: status, error: message, message, code, ...(keys ? { keys } : {}) })
}

type InApp = <T>(
  id: string | undefined,
  reply: FastifyReply,
  fn: () => Promise<T>
) => Promise<T | FastifyReply>

function settingsRoutes(app: FastifyInstance, prefix: string, inApp: InApp) {
  app.post<{ Params: { id?: string } }>(`${prefix}/apply`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return inApp(req.params.id, reply, async () => {
      try {
        const { applyHubSettings } = await import('../services/hub-link/settings-apply.js')
        const out = await applyHubSettings(req.body, { k: getTenantDb() })
        if (!out.ok) return fail(reply, out.status, out.code, out.message, out.keys)
        return reply.send({ applied: out.applied })
      } catch (err) {
        app.log.error(
          { code: (err as { code?: unknown } | null)?.code ?? null },
          'hub link: applying settings failed'
        )
        return fail(reply, 500, 'SETTINGS_APPLY_FAILED', 'The settings could not be saved')
      }
    })
  })
}

/** Inside routes/hub-link.ts (after its bearer hook): `/api/hub-link/settings/apply`. */
export function hubLinkSettingsRoutes(app: FastifyInstance): void {
  settingsRoutes(app, '/settings', async (_id, _reply, fn) => fn())
}

async function tenantById(id: string): Promise<TenantRecord | null> {
  const registry = getTenantRegistry()
  if (!registry) return null
  if (registry.byId) return registry.byId(id)
  const all = registry.listAll ? await registry.listAll() : await registry.listActive()
  return all.find((t) => t.id === id) ?? null
}

/** Inside routes/hub-deployment-link.ts: `/api/hub-deployment/apps/:id/settings/apply`. */
export function deploymentLinkSettingsRoutes(app: FastifyInstance): void {
  const inApp: InApp = async (id, reply, fn) => {
    const t = id ? await tenantById(id) : null
    if (!t) return fail(reply, 404, 'UNKNOWN_APP', 'This deployment does not serve that app')
    return withTenant(t, fn, t.origin)
  }
  settingsRoutes(app, '/apps/:id/settings', inApp)
}
