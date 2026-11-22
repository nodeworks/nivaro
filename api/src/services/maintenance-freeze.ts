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
import { tenantSource } from './deployment-mode.js'
import {
  APP_MOVED,
  APP_MOVED_MESSAGE,
  isRetiredSync,
  retiredExemptPath
} from './hub-link/retire.js'

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
    // A Hub's deployment link (phase 6, routes/hub-deployment-link.ts): a bearer, never a person,
    // on no app; its first-admin call checks the app's own switch inside that app.
    (url.startsWith('/api/hub-deployment/') && tenantSource() === 'hub') ||
    // The Hub's OpenID provider (phase 7): apps sign people in through it during maintenance.
    url.startsWith('/api/hub/oidc/') ||
    // Apps report sign-ins to the Hub's switcher (and ask it, a read carrying the identity in a
    // body) with their hub token, never a person.
    /^\/api\/hub\/app-link\/(signins|switcher)(\?|$)/.test(url) ||
    // Hub phase 6: the Hub's own calls over the hub link (HUB_TOKEN bearer, never a person) —
    // switching the strict maintenance of a move off again, retire, file tickets — and the
    // file transfer a move's target pulls from. The first administrator stays frozen (a person
    // account is written there).
    /^\/api\/hub-link\/(?!first-admin(\/|\?|$))/.test(url) ||
    url.startsWith('/api/hub-transfer/') ||
    // Teams calls the bot with a Connector JWT, never a person; the route judges its own
    // activities (message/install stay answerable, invokes say "in maintenance" themselves).
    url.startsWith('/api/teams/messages') ||
    // Batches of reads (#1304, people cards) are POSTs only because they carry a body.
    url.startsWith('/api/items/batch-read') ||
    // Batched GETs (services/batch-get.ts): each part is its own in-process GET.
    url.startsWith('/api/batch-get') ||
    url.startsWith('/api/users/cards') ||
    // "Changed since you picked them" before a bulk action (rt8): a read carrying the ids.
    /^\/api\/bulk-preflight\/changes(\?|$)/.test(url) ||
    // Activity sentence labels (migration 516): a read carrying the page's refs.
    url.startsWith('/api/activity/labels') ||
    // The activity stream over related records (Project 360): a read carrying the sources.
    url.startsWith('/api/activity/feed') ||
    // "Needed by <partner>" badges (idea 43): a read carrying the form's values.
    /^\/api\/partner-needs\/[^/?]+(\?|$)/.test(url) ||
    // Picker status badges and list cell-lock holders (rt6): reads carrying ids.
    /^\/api\/(picker-badges|cell-locks\/read)(\?|$)/.test(url) ||
    // The promote chain's overwrite check (routes/config-drift.ts): a read carrying the
    // source's rows; promotions run while the target is in maintenance.
    /^\/api\/config-drift\/guard(\?|$)/.test(url) ||
    // A Hub promotion plan (routes/hub.ts): a read carrying the version and kind; the start
    // (POST …/promote) stays frozen.
    /^\/api\/hub\/environments\/\d+\/promote\/plan(\?|$)/.test(url) ||
    // Bulk update's preview (?dry_run=1 writes nothing — routes/items.ts answers before any write).
    /^\/api\/items\/[^/?]+\/bulk-update\?(?:[^#]*&)?dry_run=(1|true)(&|$)/.test(url) ||
    // The layout editor canvas's draft field rows: a read carrying placements.
    /^\/api\/field-config\/[^/?]+\/project(\?|$)/.test(url) ||
    // Nivaro Hub "Create app" preview (phase 3): gathers and plans, never locks or writes.
    /^\/api\/hub\/apps\/create\/plan(\?|$)/.test(url) ||
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
  // Hub phase 6: the Hub's strict freeze (a move) exempts nobody, administrators included.
  if (!maint.strict) {
    // An app-level hook runs BEFORE the routes' own authenticate preHandler, so
    // identity isn't resolved yet — resolve it here (only while maintenance is
    // actually on) so a signed-in administrator stays exempt.
    if (!req.user) {
      const { authenticate } = await import('../middleware/authenticate.js')
      await authenticate(req, reply).catch(() => {})
    }
    if (maintenanceExemptCaller(req)) return false
  }
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

/**
 * Hub phase 6 (Decision 10): a retired app (moved away by the Hub) answers 503 APP_MOVED on
 * every method and path except the hub link, the file transfer and the probes. Returns true when
 * it answered.
 */
export function retiredRefusal(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!isRetiredSync()) return false
  if (req.method === 'OPTIONS' || retiredExemptPath(req.url)) return false
  reply.code(503).header('Retry-After', '60').header('Cache-Control', 'no-store')
  void reply.send({
    statusCode: 503,
    error: APP_MOVED_MESSAGE,
    message: APP_MOVED_MESSAGE,
    code: APP_MOVED
  })
  return true
}

/** The root preHandler (server.ts). */
export async function maintenanceFreezeHook(req: FastifyRequest, reply: FastifyReply) {
  // Before the read early return below: a retired app refuses reads too (ruling M17).
  if (retiredRefusal(req, reply)) return reply
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
  if (maintenanceExemptPath(req.url)) return
  if (await maintenanceRefusal(req, reply)) return reply
}
