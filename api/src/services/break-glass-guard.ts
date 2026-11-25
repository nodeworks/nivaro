import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  RouteOptions
} from 'fastify'

/**
 * What a break-glass grantee may NOT do while the grant holds (security review H1): their admin
 * access is borrowed, so it must not be turned into lasting admin access.
 *
 *  - no write to roles or policies (create, change, delete — the role editor, the policy editor,
 *    the role UI permissions, and the same tables through /api/items);
 *  - no role set on any account, their own included (user edit, invite, bulk role changes, and
 *    nivaro_users through /api/items).
 *
 * Refused 403 BREAK_GLASS_ACTIVE. `req.breakGlass` is set by authenticate (hydrateRole) only
 * while a grant holds the caller. The guard is appended to every matching route at registration
 * (installBreakGlassWriteGuard, once at the root of the API routes), after the route's own
 * sign-in, so no route file changes. Reads that are POSTs (role simulate, row-filter impact)
 * stay open.
 *
 * And when the grant ends the role always comes back if it carries admin access
 * (services/break-glass-role.ts roleAfterGrant), so even a change made some other way is undone.
 */

export const BREAK_GLASS_ACTIVE = 'BREAK_GLASS_ACTIVE'

const READ_POSTS = /\/roles\/:id\/(simulate|row-filter-impact)$/
const ROLE_KEYS = ['role', 'role_id', 'role_ids', 'roles']
const GUARDED_ITEMS = new Set(['nivaro_roles', 'nivaro_policies', 'nivaro_permissions'])

const isWrite = (m: string | string[]) =>
  (Array.isArray(m) ? m : [m]).some((x) => !['GET', 'HEAD', 'OPTIONS'].includes(x.toUpperCase()))

function setsRole(body: unknown): boolean {
  const check = (v: unknown) =>
    !!v && typeof v === 'object' && ROLE_KEYS.some((k) => k in (v as Record<string, unknown>))
  if (Array.isArray(body)) return body.some(check)
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (check(b)) return true
  // Bulk shapes: {data: {...}}, {items: [...]}, {changes: {...}}.
  return [b.data, b.items, b.changes, b.patch].some((x) =>
    Array.isArray(x) ? x.some(check) : check(x)
  )
}

/** Which kind of guarded route a registration is (null = not guarded). */
export function guardKind(
  url: string,
  method: string | string[]
): 'roles' | 'users' | 'items' | null {
  if (!isWrite(method)) return null
  if (/^\/api\/roles(\/|$)/.test(url)) return READ_POSTS.test(url) ? null : 'roles'
  if (/^\/api\/users(\/|$)/.test(url)) return 'users'
  if (/^\/api\/items\/:collection(\/|$)/.test(url)) return 'items'
  return null
}

/** The refusal for this request, or null. Pure over the request. */
export function breakGlassRefusal(
  kind: 'roles' | 'users' | 'items',
  req: Pick<FastifyRequest, 'breakGlass' | 'body' | 'params'>
): string | null {
  if (!req.breakGlass) return null
  if (kind === 'roles')
    return 'While a break-glass grant holds your account you cannot change roles or policies.'
  if (kind === 'users')
    return setsRole(req.body)
      ? 'While a break-glass grant holds your account you cannot change anyone’s role, your own included.'
      : null
  const c = String((req.params as { collection?: unknown } | undefined)?.collection ?? '')
  if (GUARDED_ITEMS.has(c))
    return 'While a break-glass grant holds your account you cannot change roles or policies.'
  if (c === 'nivaro_users' && setsRole(req.body))
    return 'While a break-glass grant holds your account you cannot change anyone’s role, your own included.'
  return null
}

function guardFor(kind: 'roles' | 'users' | 'items'): preHandlerHookHandler {
  return async function breakGlassWriteGuard(req: FastifyRequest, reply: FastifyReply) {
    const why = breakGlassRefusal(kind, req)
    if (why) return reply.code(403).send({ error: why, code: BREAK_GLASS_ACTIVE })
  } as preHandlerHookHandler
}

/** Once at the root of the API routes, before any route plugin registers. */
export function installBreakGlassWriteGuard(app: FastifyInstance): void {
  app.addHook('onRoute', (opts: RouteOptions) => {
    const kind = guardKind(opts.url, opts.method)
    if (!kind) return
    const guard = guardFor(kind)
    const pre = opts.preHandler
    opts.preHandler = (
      pre ? [...(Array.isArray(pre) ? pre : [pre]), guard] : [guard]
    ) as RouteOptions['preHandler']
  })
}
