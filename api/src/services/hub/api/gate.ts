import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  RouteOptions
} from 'fastify'
import { requireAdmin, requireAuth } from '../../../middleware/authenticate.js'
import { accessFor, type HubAccess } from './catalog.js'
import { hubScopeLevel } from './scopes.js'

/**
 * Who may call a Hub route, by credential (Hub mode only; every /api/hub route a person or key
 * reaches goes through here — installHubCredentialGate swaps the routes' requireAuth /
 * requireAdmin for the two below, so no Hub route file changes).
 *
 *   browser session / static token / phone   unchanged: admin or owner, as each route says
 *   named API key (nvk_)                     needs `hub:read` (reads and plans) or `hub:write`
 *                                            (every write). `*` never implies it. An admin's key
 *                                            with a Hub scope passes the admin routes; an owner's
 *                                            key acts as the owner.
 *   connected app (OAuth nvo_)               needs the `hub:read` OAuth scope (the person ticks it
 *                                            on the consent page; offered only on a Hub); reads
 *                                            and plans only (403 HUB_WRITE_NOT_FOR_AGENTS)
 *   MCP tool call (any credential)           reads and plans only; a connection limited to named
 *                                            collections never reaches the Hub
 *   Teams bot                                never (403 HUB_SCOPE_MISSING)
 *   View-as (nvm_), run-as-key (nvq_)        reads and plans only (403 NOT_WHILE_MASQUERADING);
 *                                            a run-as-key also needs the key's Hub scope
 */

export interface HubRefusal {
  status: number
  code: string
  error: string
}

type Caller = Pick<
  FastifyRequest,
  'authMethod' | 'apiKeyScopes' | 'mcpInner' | 'masqueradeAdminId' | 'oauthScopes' | 'mcpScope'
>

/** The OAuth scope a connected app needs on the Hub (lib/oauth.ts OAUTH_HUB_SCOPE). */
const OAUTH_HUB_READ = 'hub:read'

const missing = (error: string): HubRefusal => ({ status: 403, code: 'HUB_SCOPE_MISSING', error })

/** The refusal for this caller on a route needing `access`, else null. */
export function hubCredentialRefusal(req: Caller, access: HubAccess): HubRefusal | null {
  const method = req.authMethod
  if (method === 'api_key' || method === 'key_sim') {
    const level = hubScopeLevel(req.apiKeyScopes)
    const need = access === 'write' ? 'write' : 'read'
    if (level === 'none' || (need === 'write' && level !== 'write'))
      return missing(`This API key needs the hub:${need} scope for this Hub route.`)
  }
  if (method === 'oauth' && !(req.oauthScopes ?? []).includes(OAUTH_HUB_READ))
    return missing(
      'This connected app was not given the hub:read scope. Connect it again and tick “read the Hub”.'
    )
  if (method === 'teams') return missing('The Teams bot does not reach the Hub.')
  // A connection limited to named collections (services/mcp-scope.ts) never reaches the Hub (a
  // collection list cannot name it); a kit that is gone allows nothing.
  if (
    req.mcpInner === true &&
    req.mcpScope &&
    (req.mcpScope.kit_missing || req.mcpScope.collections != null)
  )
    return missing('This MCP connection is limited to named collections, not the Hub.')
  if (access !== 'write') return null
  if (req.mcpInner === true || method === 'oauth')
    return {
      status: 403,
      code: 'HUB_WRITE_NOT_FOR_AGENTS',
      error:
        'Connected apps and assistants may read the Hub and plan, never change it. Make the change in the Hub, or with an API key that has hub:write.'
    }
  if (method === 'masquerade' || method === 'key_sim' || req.masqueradeAdminId)
    return {
      status: 403,
      code: 'NOT_WHILE_MASQUERADING',
      error: 'Not while viewing as someone else'
    }
  return null
}

function thrown(r: HubRefusal): Error {
  return Object.assign(new Error(r.error), { statusCode: r.status, code: r.code })
}

function routeAccess(req: FastifyRequest): HubAccess {
  return accessFor(req.method, req.routeOptions?.url ?? null)
}

function isKey(req: FastifyRequest): boolean {
  return req.authMethod === 'api_key' || req.authMethod === 'key_sim'
}

/** requireAuth for a Hub route: signed in, and the credential may reach this route. */
export async function hubRequireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply)
  const refusal = hubCredentialRefusal(req, routeAccess(req))
  if (refusal) throw thrown(refusal)
}

/**
 * requireAdmin for a Hub route: requireAdmin itself, except that a key with a Hub scope stands in
 * for its "keys limited to named collections stay out of administration" — the Hub scope IS the
 * named grant (the key's owner must still be an administrator).
 */
export async function hubRequireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await requireAdmin(req, reply)
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    if (code !== 'API_KEY_SCOPE_MISSING' || !isKey(req) || req.isAdmin !== true) throw err
  }
  const refusal = hubCredentialRefusal(req, routeAccess(req))
  if (refusal) throw thrown(refusal)
}

type Handler = preHandlerHookHandler | ((req: FastifyRequest, reply: FastifyReply) => unknown)

function swap(h: Handler): Handler {
  if (h === requireAuth) return hubRequireAuth as Handler
  if (h === requireAdmin) return hubRequireAdmin as Handler
  return h
}

/**
 * Every route registered after this in the plugin (and its children) gets the Hub gate in place
 * of requireAuth / requireAdmin. Call first thing in a Hub route plugin.
 */
export function installHubCredentialGate(app: FastifyInstance): void {
  app.addHook('onRoute', (opts: RouteOptions) => {
    const ph = opts.preHandler as Handler | Handler[] | undefined
    if (!ph) return
    opts.preHandler = (Array.isArray(ph) ? ph.map(swap) : swap(ph)) as RouteOptions['preHandler']
  })
}
