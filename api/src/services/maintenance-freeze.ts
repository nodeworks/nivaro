/**
 * Maintenance mode's instance-wide write freeze (reads stay open).
 *
 * Registered ONCE on the root app (server.ts), before any route plugin, so it
 * covers every write: the core routes, GraphQL mutations (judged inside the
 * handler, where the operation is known — see plugins/graphql.ts), the legacy
 * compat paths (/files, /items forwards, /graphql → /api/graphql) and every
 * extension route. Until 2026-11-06 it lived inside `registerRoutes` and so
 * missed GraphQL, the legacy paths and extensions: LinX created a workflow
 * through POST /graphql during the staging rebuild before the id counters were
 * seeded (CR26-1).
 *
 * Exempt callers: only a PERSON who is an administrator, signed in with their
 * own session — never a static token, API key, connected app, phone token,
 * View-as, an MCP tool call or an integration/service account, admin role or
 * not. Integrations must stay paused while the database is being converted.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

/** Paths whose writes stay open during maintenance (sign-in, telemetry heartbeats, …). */
export function maintenanceExemptPath(url: string): boolean {
  return (
    url.startsWith('/api/auth') ||
    // Settings (the maintenance switch itself) are NOT exempt by path (REVIEW-R5 L2): an
    // admin-role static token (LinX) could switch maintenance off. The person who may turn
    // it off — an administrator on their own session — passes as the exempt caller.
    url.startsWith('/api/rum') ||
    // Quiet background telemetry (army 5 b11-N7: 503s from these during the staging
    // window). Each writes only its own telemetry table, never business data:
    // user_presence (the presence row, pinned to that one collection),
    // nivaro_page_views, nivaro_session_recordings/_events, nivaro_record_views.
    /^\/api\/items\/user_presence(\/|\?|$)/.test(url) ||
    /^\/api\/analytics\/pageview(\/[^/?]+)?(\?|$)/.test(url) ||
    /^\/api\/session-recordings(\/[^/?]+\/(events|end))?(\?|$)/.test(url) ||
    /^\/api\/record-views\/[^/?]+\/[^/?]+\/touch(\?|$)/.test(url) ||
    // Chaos Stop all (#2861) must work during maintenance (operators, and the phone push).
    url.startsWith('/api/chaos/stop-all') ||
    // The render peer (#2789) renders for another process's request, which
    // that process already judged; it carries a bearer, never a person.
    url.startsWith('/api/internal/render/') ||
    // Teams calls the bot with a Connector JWT, never a person; the route judges its own
    // activities (message/install stay answerable, invokes say "in maintenance" themselves).
    url.startsWith('/api/teams/messages') ||
    // Batches of reads (#1304, people cards) are POSTs only because they carry a body.
    url.startsWith('/api/items/batch-read') ||
    // Batched GETs (services/batch-get.ts): each part is its own in-process GET.
    url.startsWith('/api/batch-get') ||
    url.startsWith('/api/users/cards') ||
    // Activity sentence labels (migration 516): a read carrying the page's refs.
    url.startsWith('/api/activity/labels') ||
    // The promote chain's overwrite check (routes/config-drift.ts): a read carrying the
    // source's rows; promotions run while the target is in maintenance.
    /^\/api\/config-drift\/guard(\?|$)/.test(url) ||
    // Bulk update's preview (?dry_run=1 writes nothing — routes/items.ts answers before any write).
    /^\/api\/items\/[^/?]+\/bulk-update\?(?:[^#]*&)?dry_run=(1|true)(&|$)/.test(url) ||
    // The layout editor canvas's draft field rows: a read carrying placements.
    /^\/api\/field-config\/[^/?]+\/project(\?|$)/.test(url) ||
    // Presence heartbeats (never a record write; were outside the freeze before).
    /^\/api\/presence\/(ping|disconnect)(\?|$)/.test(url) ||
    // The MCP endpoint only carries protocol messages; each tool call inside it is its
    // own in-process API request (app.inject), judged by this hook on its own method and
    // path — and an MCP tool call is never an exempt caller.
    url === '/api/mcp' ||
    url.startsWith('/api/mcp?') ||
    // GraphQL: queries stay open, so the endpoint judges MUTATIONS itself once the
    // document is parsed (plugins/graphql.ts). The legacy /graphql is forwarded there.
    /^\/(api\/)?graphql(\/stream)?(\?|$)/.test(url) ||
    // OAuth sign-in for connected apps + discovery (sign-in stays open like /api/auth).
    url.startsWith('/oauth/') ||
    url.startsWith('/.well-known/') ||
    url.startsWith('/socket.io/') ||
    // Cloud provisioning (/admin/provision, /admin/migrate…): the operator's secret, never a
    // person; registered before this hook anyway — listed so a reorder cannot freeze it.
    url.startsWith('/admin/')
  )
}

/**
 * The one caller a maintenance freeze lets write: a person (no account_kind)
 * whose role is an administrator, signed in with a session as themselves.
 */
export function maintenanceExemptCaller(req: FastifyRequest): boolean {
  if (!req.isAdmin) return false
  if (req.authMethod !== 'session') return false
  if (req.masqueradeAdminId) return false
  if (req.mcpInner) return false
  const kind = (req.user as { account_kind?: string | null } | undefined)?.account_kind
  return !kind
}

/**
 * Refuse this write with 503 MAINTENANCE when maintenance is on and the caller
 * is not exempt. Returns true when it answered (the caller must stop).
 * `graphql` answers in the GraphQL error shape.
 */
export async function maintenanceRefusal(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { graphql?: boolean } = {}
): Promise<boolean> {
  const { maintenanceState, MAINTENANCE_EXPLAINER, MAINTENANCE_DEFAULT_MESSAGE } = await import(
    './security.js'
  )
  const maint = await maintenanceState()
  if (!maint.on) return false
  // An app-level hook runs BEFORE the routes' own authenticate preHandler, so
  // identity isn't resolved yet — resolve it here (only while maintenance is
  // actually on) so a signed-in administrator stays exempt.
  if (!req.user) {
    const { authenticate } = await import('../middleware/authenticate.js')
    await authenticate(req, reply).catch(() => {})
  }
  if (maintenanceExemptCaller(req)) return false
  const message = `${(maint.message || MAINTENANCE_DEFAULT_MESSAGE).trim()} ${MAINTENANCE_EXPLAINER}`
  reply.code(503).header('Retry-After', '300')
  if (opts.graphql) {
    await reply.send({
      data: null,
      errors: [{ message, extensions: { code: 'MAINTENANCE', status: 503, until: maint.until } }],
      code: 'MAINTENANCE',
      until: maint.until
    })
  } else {
    await reply.send({ error: message, code: 'MAINTENANCE', until: maint.until })
  }
  return true
}

/** The root preHandler (server.ts). */
export async function maintenanceFreezeHook(req: FastifyRequest, reply: FastifyReply) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
  if (maintenanceExemptPath(req.url)) return
  if (await maintenanceRefusal(req, reply)) return reply
}
