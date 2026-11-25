import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  RouteOptions
} from 'fastify'
import { ACCESS_ROUTES } from './record-events.js'

/**
 * What a break-glass grantee may NOT do while the grant holds (security review H1 + the second
 * review): their admin access is borrowed, so nothing they do may outlast it. DENY BY DEFAULT on
 * everything that decides who can do what, or that mints a way back in:
 *
 *  - every write the ACCESS_ROUTES registry names (services/record-events.ts — the ONE list of
 *    "writes that may change who can read which records": roles + policies, user scopes, scope
 *    dimensions, tree permissions, access-request decisions, user edits, bulk + copy-access), plus
 *    the other access surfaces it does not list: user groups, workspaces, settings;
 *  - EVERY write on accounts — /api/users/* and /api/auth/me (email, password, provider, static
 *    tokens, roles, anyone's) — and on any system table through /api/items (nivaro_* / directus_*);
 *    the one exception is the caller's own preferences, an explicit list of keys;
 *  - every credential mint: API keys (create, change, run-as), MCP connections, View-as starts,
 *    OAuth / phone sign-in grants (routes/oauth.ts refuses the consent itself), GraphQL mutations.
 *  Ending things stays open: revoking a key or a connection, signing out, ending a View-as.
 *
 * Refused 403 BREAK_GLASS_ACTIVE. `req.breakGlass` is set by authenticate (hydrateRole) only
 * while a grant holds the caller. The guard is appended to EVERY write route under /api at
 * registration (installBreakGlassWriteGuard, once at the root of the API routes), after the
 * route's own sign-in, and judges both the route template and the request path (either match
 * refuses). MCP tool calls re-enter these routes as the caller, so they are judged too.
 *
 * And at the end of a grant the app takes back what the grantee made during it
 * (break-glass-grants.ts revokeGrantCredentials).
 */

export const BREAK_GLASS_ACTIVE = 'BREAK_GLASS_ACTIVE'

/** Access surfaces ACCESS_ROUTES does not list (it is about record visibility). */
const MORE_ACCESS = /^\/api\/(user-groups|workspaces|settings|security|session-policy)(\/|$)/
/** Accounts and the credentials of anyone. */
const ACCOUNTS = /^\/api\/(users|auth\/(me|masquerade|setup|totp|devices))(\/|$)/
/** Credential mints. */
const CREDENTIALS = /^\/api\/(api-keys|mcp-connections|oauth|push\/phones|push\/relay)(\/|$)/
/** System tables through the generic record routes. */
const SYSTEM_ITEMS = /^\/api\/items\/(nivaro_|directus_)/i

/** What ending is always allowed (revoke a key or a connection, end a View-as, sign out). */
const ENDINGS: Array<{ method: string; re: RegExp }> = [
  { method: 'DELETE', re: /^\/api\/(api-keys|mcp-connections|oauth\/connections)\/[^/]+$/ },
  { method: 'POST', re: /^\/api\/api-keys\/[^/]+\/revoke$/ },
  { method: 'DELETE', re: /^\/api\/auth\/(masquerade|devices\/[^/]+)$/ },
  { method: 'DELETE', re: /^\/api\/users\/me\/token$/ },
  { method: 'PATCH', re: /^\/api\/auth\/me\/last-page$/ }
]

/** The caller's own preferences: these keys only (routes/users.ts PATCH /me/preferences). */
export const OWN_PREFERENCE_KEYS: readonly string[] = [
  'email_digest',
  'link_app',
  'digest_hour',
  'nav_favorite_groups',
  'nav_layout',
  'theme',
  'timezone',
  'language',
  'locale',
  'density',
  'support_email_updates',
  'ops_report_email'
]

const PLAIN =
  'While a break-glass grant holds your account you can fix things, but not change who has access, accounts or credentials. Ask another administrator.'

const isWrite = (m: string) => !['GET', 'HEAD', 'OPTIONS'].includes(m.toUpperCase())
const pathOf = (url: string) => url.split('?')[0].replace(/\/{2,}/g, '/')

function ownPreferences(path: string, method: string, body: unknown): boolean {
  if (method !== 'PATCH' || path !== '/api/users/me/preferences') return false
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const keys = Object.keys(body as Record<string, unknown>)
  return keys.length > 0 && keys.every((k) => OWN_PREFERENCE_KEYS.includes(k))
}

function graphqlMutation(body: unknown): boolean {
  const q = (body as { query?: unknown } | null)?.query
  if (typeof q !== 'string') return Array.isArray(body) // a batch: judged closed
  return /\bmutation\b/i.test(q)
}

/**
 * The refusal for one write by a grantee, or null. Judged on the route template AND the request
 * path; either one matching refuses. Pure.
 */
export function breakGlassRefusal(o: {
  method: string
  template: string
  url: string
  body?: unknown
}): string | null {
  const method = o.method.toUpperCase()
  if (!isWrite(method)) return null
  const paths = [o.template, pathOf(o.url)]
  const any = (re: RegExp) => paths.some((p) => re.test(p))
  if (paths.every((p) => ENDINGS.some((e) => e.method === method && e.re.test(p)))) return null
  if (paths.every((p) => ownPreferences(p, method, o.body))) return null
  if (any(/^\/api\/graphql(\/|$)/)) return graphqlMutation(o.body) ? PLAIN : null
  // The registry is matched on real paths (its `users/(?!me)…` reads `:id` as an id).
  if (any(ACCESS_ROUTES) || any(MORE_ACCESS) || any(ACCOUNTS) || any(CREDENTIALS)) return PLAIN
  if (any(SYSTEM_ITEMS)) return PLAIN
  return null
}

const guard: preHandlerHookHandler = async function breakGlassWriteGuard(
  req: FastifyRequest,
  reply: FastifyReply
) {
  if (!req.breakGlass) return
  const why = breakGlassRefusal({
    method: req.method,
    template: req.routeOptions?.url ?? '',
    url: req.url,
    body: req.body
  })
  if (why) return reply.code(403).send({ error: why, code: BREAK_GLASS_ACTIVE })
}

/** Once at the root of the API routes, before any route plugin registers: every write under
 *  /api gets the guard as its last preHandler. */
export function installBreakGlassWriteGuard(app: FastifyInstance): void {
  app.addHook('onRoute', (opts: RouteOptions) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method]
    if (!methods.some((m) => isWrite(String(m)))) return
    if (!/^\/api(\/|$)/.test(opts.url)) return
    const pre = opts.preHandler
    opts.preHandler = (
      pre ? [...(Array.isArray(pre) ? pre : [pre]), guard] : [guard]
    ) as RouteOptions['preHandler']
  })
}

/** The guard itself (tests: it is what every write route carries). */
export const breakGlassWriteGuard = guard
