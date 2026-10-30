import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { hasColumn } from '../lib/column-probe.js'
import { hasChainColumns } from '../services/chain-columns.js'
import { mcpCallerKey, mcpLogColumns, mcpStampOf } from '../services/mcp-calls.js'
import { roomListeners } from '../services/realtime-board.js'
import { MASK, maskBodySecrets, maskQueryString, maskUrlPath } from '../services/secret-mask.js'
import { instanceKey } from '../services/settings-overrides.js'
import { requestTenantKey } from '../services/socket-tenant.js'
import { accessLogEnabled, accessLogLine, noteAccessLine } from '../services/telemetry-store.js'
import { tenantScopedRoom } from '../services/tenant-rooms.js'
import { errorCode, hasCacheHit, noteRequest } from '../services/traffic-map.js'
import { notePublicHit } from '../services/traffic-taps/public-clients.js'

interface ApiLogRow {
  method: string
  path: string
  status: number
  latency_ms: number
  user: string | null
  collection: string | null
  api_key_id: number | null
  auth: string | null
  ip: string | null
  user_agent: string | null
  error: string | null
  query: string | null
  request_body: string | null
  /** GraphQL operation analytics (#607, migration 362) — null on every
   *  non-GraphQL row and on a tenant behind the migration. */
  graphql_operation?: string | null
  graphql_kind?: string | null
  graphql_depth?: number | null
  graphql_selections?: number | null
  graphql_errors?: number | null
  graphql_deprecated?: string | null
  created_at: Date
  /** The request's integration chain (plugins/chain.ts). */
  chain_id?: string | null
  /** null = this request started the chain (the ROOT row); else the caller's open step. */
  chain_parent?: string | null
  /** The request id (= its trace id, migration 389) — joins the row to Traffic Map events. */
  request_id?: string | null
  /** MCP calls (#2466, migration 480, services/mcp-calls.ts) — absent on every other row. */
  mcp_conn?: string | null
  mcp_client?: string | null
  mcp_tool?: string | null
  mcp_outcome?: string | null
  mcp_bytes?: number | null
}

// #67 — keep the JSON body of an inbound INTEGRATION write (token / api-key
// caller, not a person's browser session) so a rejected push can be replayed
// from the request log. Capped; multipart and non-JSON bodies are skipped.
const REQUEST_BODY_CAP = 64 * 1024
export interface GraphQLStampLike {
  operation: string | null
  kind: string | null
  depth: number | null
  selections: number | null
  errors: number
  deprecated: string[]
}

/** The GraphQL columns of a log row, from the stamp plugins/graphql.ts left
 *  on the request; nothing for every other request. */
function graphqlColumns(req: { __nvrGql?: GraphQLStampLike }): Partial<ApiLogRow> {
  const g = req.__nvrGql
  if (!g) return {}
  return {
    graphql_operation: g.operation,
    graphql_kind: g.kind,
    graphql_depth: g.depth,
    graphql_selections: g.selections,
    graphql_errors: g.errors,
    graphql_deprecated: g.deprecated.length > 0 ? g.deprecated.join(',').slice(0, 500) : null
  }
}

/**
 * Key names whose values are credentials in an inbound write body. Narrower than the call
 * log's own pattern on purpose: these bodies become inbound-mapping test fixtures, so business
 * fields that merely contain "key" (item_key, sort_key) must survive.
 */
const LOGGED_BODY_SECRET_KEY =
  /password|passwd|passphrase|^pass$|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|credential/i

/** A JSON request body with every credential-named value (any depth) replaced by `••••••`;
 *  anything that is not JSON — or JSON already cut off — goes through the shared masker. */
export function maskLoggedBody(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return maskBodySecrets(raw) ?? raw
  }
  let changed = false
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (LOGGED_BODY_SECRET_KEY.test(k) && x != null && x !== '' && typeof x !== 'object') {
          out[k] = MASK
          changed = true
        } else out[k] = walk(x)
      }
      return out
    }
    return v
  }
  const masked = walk(parsed)
  return changed ? JSON.stringify(masked) : raw
}

function captureRequestBody(req: {
  method: string
  authMethod?: string
  user?: unknown
  body?: unknown
  headers: Record<string, unknown>
}): string | null {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return null
  if (req.authMethod !== 'token' && req.authMethod !== 'api_key') return null
  // A refused credential is still stamped token / api_key so the failure is
  // attributed — but a payload from a caller nobody recognised is not kept.
  if (!req.user) return null
  const ct = String(req.headers['content-type'] ?? '')
  if (!ct.includes('json')) return null
  if (req.body == null) return null
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    // Values under credential-looking keys (password, token, secret, key…) are masked before
    // the body is stored: the request log is readable by admins and kept 14 days (security
    // audit Low). A replay from the log therefore never re-sends a credential.
    const str = maskLoggedBody(raw)
    return str.length > REQUEST_BODY_CAP ? `${str.slice(0, REQUEST_BODY_CAP)}…` : str
  } catch {
    return null
  }
}

/**
 * Root-level Directus-era aliases (plugins/legacy-compat.ts) that third
 * parties still call. They sit outside /api/ but ARE API traffic — without
 * this an integration's file pushes were invisible to every log surface.
 */
const LEGACY_ALIASES = new Set(['/files', '/graphql'])
/**
 * Header the /graphql alias sets on its inner app.inject — log the OUTER call
 * once, not both. The value is a single-use random token registered in
 * `internalDispatchTokens` by the dispatching handler; a caller on the wire
 * can send the header name but cannot guess a registered value, so it cannot
 * exempt its own requests from the log.
 */
export const INTERNAL_DISPATCH_HEADER = 'x-nivaro-internal-dispatch'
export const internalDispatchTokens = new Set<string>()
/**
 * The inner dispatched GraphQL request's operation stamp, by dispatch token: the alias copies it
 * onto the OUTER request, so the one logged row names the operation (#1102 — partners calling the
 * root /graphql otherwise read as `anonymous` in history). Set in onSend (before the inject
 * resolves), removed by the alias as soon as it has read it.
 */
export const internalDispatchStamps = new Map<string, GraphQLStampLike>()

function isInternalDispatch(req: { headers: Record<string, unknown> }): boolean {
  const t = req.headers[INTERNAL_DISPATCH_HEADER]
  return typeof t === 'string' && internalDispatchTokens.has(t)
}
/** Root-level public pages (share links, public forms) — outside /api, seen by the map's
 *  public-client tap only (#1152). */
const PUBLIC_PAGE_RE = /^\/(share|form)\/[^/]+$/
const ERROR_BODY_CAP = 1000

const FLUSH_INTERVAL_MS = 5000
const FLUSH_THRESHOLD = 50
const RETENTION_DAYS = 14
const CLEANUP_PROBABILITY = 0.01
const DEV_PRUNE_INTERVAL_MS = 10 * 60 * 1000

/** Extract the collection slug from /api/items/:collection[/...] paths. */
function extractCollection(path: string): string | null {
  const match = path.match(/^\/api\/items\/([^/?]+)/)
  return match ? match[1] : null
}

/**
 * The caller's address as Fastify resolved it: `req.ip` honours TRUST_PROXY, so a forwarded
 * address is believed only from a trusted proxy. Reading `X-Forwarded-For` directly let any
 * caller write whatever address they liked into the request log (security audit Low).
 */
function clientIp(req: { headers: Record<string, unknown>; ip: string }): string | null {
  return req.ip ? String(req.ip).slice(0, 64) : null
}

function shouldSkip(path: string, method: string): boolean {
  if (!path.startsWith('/api/')) return !(LEGACY_ALIASES.has(path) && method === 'POST')
  if (path.startsWith('/api/health')) return true
  // #1088 — a Prometheus scrape every 15s is not traffic anyone reads here.
  if (path === '/api/metrics' || path.startsWith('/api/metrics?')) return true
  // #2789 — the render peer's calls are the slim process's own requests, already logged there.
  if (path.startsWith('/api/internal/render/')) return true
  if (path.startsWith('/api/api-analytics')) return true
  return false
}

/**
 * Buffered API request logger. Captures method/path/status/latency for every
 * /api/* response into an in-memory buffer, flushed to nivaro_api_logs every
 * 5 seconds or once 50 rows accumulate. On ~1% of flushes, rows older than
 * 14 days are pruned (mail + external API call logs: 30 days).
 */
const INSTANCE = instanceKey().slice(0, 60)

export const apiLoggerPlugin = fp(async (app: FastifyInstance) => {
  let buffer: ApiLogRow[] = []
  let flushing = false

  // The flush starts from a request's onResponse (or the timer), so left alone it
  // borrowed a REQUEST-pool connection for its insert and prune. Under load those
  // writes waited in the same queue as the people they were logging (staging load
  // test 2026-10-24); the background pool is where bookkeeping belongs.
  function flush(): Promise<void> {
    return runInBackgroundPool(() => flushNow())
  }

  async function flushNow(): Promise<void> {
    if (flushing || buffer.length === 0) return
    flushing = true
    const rows = buffer
    buffer = []
    try {
      // A tenant that has not run migration 351 has no chain columns —
      // drop both fields rather than fail the whole flush.
      const stamp = await hasChainColumns('nivaro_api_logs')
      const chained = stamp ? rows : rows.map(({ chain_id: _c, chain_parent: _p, ...rest }) => rest)
      // Same for the query string (migration 357).
      const withQuery = (await hasColumn('nivaro_api_logs', 'query'))
        ? chained
        : chained.map(({ query: _q, ...rest }) => rest)
      // And the GraphQL columns (migration 362).
      const shaped = (await hasColumn('nivaro_api_logs', 'graphql_operation'))
        ? withQuery
        : withQuery.map(
            ({
              graphql_operation: _a,
              graphql_kind: _b,
              graphql_depth: _c,
              graphql_selections: _d,
              graphql_errors: _e,
              graphql_deprecated: _f,
              ...rest
            }) => rest
          )
      // And the request id (migration 389).
      const withRequestId = (await hasColumn('nivaro_api_logs', 'request_id'))
        ? shaped
        : shaped.map(({ request_id: _r, ...rest }) => rest)
      // And the MCP call columns (migration 480).
      const withMcp = (await hasColumn('nivaro_api_logs', 'mcp_conn'))
        ? withRequestId
        : withRequestId.map(
            ({
              mcp_conn: _a,
              mcp_client: _b,
              mcp_tool: _c,
              mcp_outcome: _d,
              mcp_bytes: _e,
              ...rest
            }) => rest
          )
      // #666 — which instance served it (migration 379); the SLO dashboard
      // groups by it because several instances can share one database.
      const stamped = (await hasColumn('nivaro_api_logs', 'instance'))
        ? withMcp.map((r) => ({ ...r, instance: INSTANCE }))
        : withMcp
      // Insert in modest chunks to stay under MSSQL parameter limits
      for (let i = 0; i < stamped.length; i += 50) {
        await db('nivaro_api_logs').insert(stamped.slice(i, i + 50))
      }
      if (Math.random() < CLEANUP_PROBABILITY) {
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
        await db('nivaro_api_logs').where('created_at', '<', cutoff).delete()
        await db('nivaro_rum_events')
          .where('created_at', '<', cutoff)
          .delete()
          .catch(() => {})
        // Search log (#1581) is personal data — its own, shorter retention.
        await import('../services/search-analytics.js')
          .then((m) => m.pruneSearchLog())
          .catch(() => {})
        // Outbound call log + flight recorder (#626): counter rows 31 days
        // (per-API SLOs), recorded bodies 24 hours, side traffic by kind.
        await import('../services/outbound-recorder.js')
          .then((m) => m.pruneOutboundRecorder())
          .catch(() => {})
        // Mail log rides the same pass — 30 days answers "did it send".
        await db('nivaro_mail_log')
          .where('created_at', '<', new Date(Date.now() - 30 * 86_400_000))
          .delete()
          .catch(() => {})
        // External API call logs (full request/response bodies, up to 50 KB
        // each) — 30 days, same as the mail log, so they never grow unbounded.
        // Chunked: a first pass after deploy can face months of rows, and one
        // unbounded DELETE would time out and roll back on every pass.
        const callCutoff = new Date(Date.now() - 30 * 86_400_000)
        for (let i = 0; i < 20; i++) {
          const res = (await db
            .raw('DELETE TOP (500) FROM nivaro_external_api_logs WHERE created_at < ?', [
              callCutoff
            ])
            .catch(() => null)) as unknown
          // Same affected-count read as pruneObligations (knex/mssql raw shape).
          const affected =
            Number(
              typeof res === 'number'
                ? res
                : ((res as { rowCount?: number } | null)?.rowCount ??
                    (res as number[] | null)?.[0] ??
                    0)
            ) || 0
          if (res == null || affected < 500) break
        }
      }
    } catch (err) {
      app.log.warn({ err }, 'Failed to flush API logs')
    } finally {
      flushing = false
    }
  }

  const timer = setInterval(() => {
    void flush()
  }, FLUSH_INTERVAL_MS)
  timer.unref()

  // #1052 — request-log rows from development instances (laptops and probes
  // sharing the database) go after 3 hours instead of 14 days, so a deployed
  // instance's caller cards and failure lists stay its own. Every process
  // runs it; the delete is idempotent and batched.
  const devPrune = setInterval(() => {
    void import('../services/api-log-instances.js')
      .then((m) => m.pruneDevInstanceLogs())
      .then((n) => {
        if (n > 0) app.log.info({ rows: n }, 'pruned development-instance API log rows')
      })
      .catch((err) => app.log.warn({ err }, 'Failed to prune development-instance API log rows'))
  }, DEV_PRUNE_INTERVAL_MS)
  devPrune.unref()

  // Keep the first KB of an error body so a rejected integration call can be
  // read back from the request list ("why did my push 400") without replaying
  // it. Only string/Buffer payloads — streams (static files) pass untouched.
  // Every response also leaves its body size (Traffic Map taps); null = a stream.
  app.addHook('onSend', async (req, reply, payload) => {
    const headers = req.headers as Record<string, unknown>
    if (isInternalDispatch({ headers })) {
      const g = (req as unknown as { __nvrGql?: GraphQLStampLike }).__nvrGql
      if (g) internalDispatchStamps.set(headers[INTERNAL_DISPATCH_HEADER] as string, g)
    }
    // Logical (uncompressed) body size: compression runs after this hook.
    ;(req as unknown as { __nvrBytes?: number | null }).__nvrBytes =
      typeof payload === 'string'
        ? Buffer.byteLength(payload)
        : Buffer.isBuffer(payload)
          ? payload.length
          : payload == null
            ? 0
            : null
    if (reply.statusCode < 400) return payload
    if (typeof payload === 'string') {
      ;(req as unknown as { __nvrErr?: string }).__nvrErr = payload.slice(0, ERROR_BODY_CAP)
    } else if (Buffer.isBuffer(payload)) {
      ;(req as unknown as { __nvrErr?: string }).__nvrErr = payload
        .subarray(0, ERROR_BODY_CAP)
        .toString('utf8')
    }
    return payload
  })

  app.addHook('onResponse', async (req, reply) => {
    const rawUrl = req.raw.url ?? req.url
    const mark = rawUrl.indexOf('?')
    const path = maskUrlPath(mark < 0 ? rawUrl : rawUrl.slice(0, mark))
    if (PUBLIC_PAGE_RE.test(path)) {
      const ua = req.headers['user-agent']
      notePublicHit({
        method: req.method,
        path,
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
        at: Date.now(),
        ip: clientIp(req as unknown as { headers: Record<string, unknown>; ip: string }),
        userAgent: typeof ua === 'string' ? ua : null,
        signedIn: !!req.user
      })
    }
    if (shouldSkip(path, req.method)) return
    // #2466 / #2469 — a call that came through /api/mcp (the tool call or one of its in-process
    // calls) names its connection on the row and is its own Traffic Map caller.
    const mcp = mcpStampOf(req, path)
    // Traffic Map (per-node aggregator): memory only, never awaits. The inner internally
    // dispatched GraphQL request carries the operation stamp, so it is counted; the outer
    // root-alias `/graphql` request is not (GraphQL counts once, with its real operation).
    if (path !== '/graphql') {
      const gql = (req as unknown as { __nvrGql?: GraphQLStampLike }).__nvrGql
      noteRequest({
        method: req.method,
        path,
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
        authMethod: req.authMethod ?? null,
        apiKeyId: req.apiKeyId ?? null,
        userId: req.user?.id ?? null,
        mcpCaller: mcp ? mcpCallerKey(mcp.client) : null,
        graphqlOperation: gql?.operation ?? null,
        graphqlKind: gql?.kind ?? null,
        cacheHit: hasCacheHit(req),
        at: Date.now(),
        errorCode: errorCode((req as unknown as { __nvrErr?: string }).__nvrErr),
        req,
        reply,
        responseBytes: (req as unknown as { __nvrBytes?: number | null }).__nvrBytes ?? null
      })
    }
    if (isInternalDispatch(req as unknown as { headers: Record<string, unknown> })) return

    const ua = req.headers['user-agent']
    const row: ApiLogRow = {
      method: req.method,
      path: path.slice(0, 500),
      status: reply.statusCode,
      latency_ms: Math.round(reply.elapsedTime),
      user: req.user?.id ?? null,
      collection: extractCollection(path),
      api_key_id: req.apiKeyId ?? null,
      auth: req.authMethod ?? (req.user ? 'session' : 'none'),
      ip: clientIp(req as unknown as { headers: Record<string, unknown>; ip: string }),
      user_agent: typeof ua === 'string' ? ua.slice(0, 300) : null,
      error: (req as unknown as { __nvrErr?: string }).__nvrErr ?? null,
      query: mark < 0 ? null : maskQueryString(rawUrl.slice(mark + 1)),
      request_body: captureRequestBody(
        req as unknown as {
          method: string
          authMethod?: string
          user?: unknown
          body?: unknown
          headers: Record<string, unknown>
        }
      ),
      ...graphqlColumns(req as unknown as { __nvrGql?: GraphQLStampLike }),
      created_at: new Date(),
      chain_id: req.chainId ?? null,
      chain_parent: req.chainParent ?? null,
      request_id: req.requestId ?? null,
      ...mcpLogColumns(mcp)
    }
    buffer.push(row)
    // #2544 — the same request as one structured line for the long-history telemetry store
    // (the request log above prunes at 14 days). Ids, route, status and timing only.
    if (accessLogEnabled()) {
      noteAccessLine()
      app.log.info(
        accessLogLine({
          ...row,
          instance: INSTANCE,
          traced: !!(req as unknown as { __nvrTraceExported?: boolean }).__nvrTraceExported,
          response_bytes: (req as unknown as { __nvrBytes?: number | null }).__nvrBytes ?? null
        }),
        'api'
      )
    }

    // Live traffic view (#276): stream to admin watchers only when someone is
    // actually watching — the room-size probe is a local map lookup.
    // Cloud: the request's tenant's room (the tenant hook stamps it; onResponse may run
    // outside the request's context).
    const trafficRoom = tenantScopedRoom('watch:traffic', requestTenantKey(req))
    // Post-mortem 3.3 — with SOCKETS=off the watchers sit on the realtime processes (the board).
    const watchers = roomListeners(app.io, trafficRoom)
    if (watchers > 0) {
      app.io.to(trafficRoom).emit('traffic:request', {
        method: req.method,
        path: path.slice(0, 300),
        status: reply.statusCode,
        latency_ms: Math.round(reply.elapsedTime),
        user: req.user?.id ?? null,
        auth: req.authMethod ?? null,
        at: Date.now()
      })
    }

    if (buffer.length >= FLUSH_THRESHOLD) void flush()
  })

  app.addHook('onClose', async () => {
    clearInterval(timer)
    clearInterval(devPrune)
    await flush()
  })

  app.log.info('API logger ready')
})
