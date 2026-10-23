/**
 * Process roles (NIVARO_ROLE) and the realtime tier (post-mortem 3.3).
 *
 *   web       request handling (REST, GraphQL queries, the admin build); sockets too unless
 *             SOCKETS=off
 *   worker    a web-shaped process that ticks crons and drains media work (CRON_TICKS etc.)
 *   realtime  holds the live connections only: Socket.io (/socket.io), graphql-ws, and the SSE
 *             streams (/api/events/stream, /api/events/views/:id/stream, /api/graphql/stream).
 *             No REST routes beyond health and stream tickets, no crons, no media work, no
 *             migrations (realtime-server.ts)
 *   canary    a deploy canary that serves nobody (render-peer.ts canaryLenient)
 *
 * A web process with SOCKETS=off serves no /socket.io; what it emits reaches the clients on the
 * realtime processes through the Socket.io Redis adapter and the event stream. Nothing set =
 * one process that does everything, sockets included (the historic behaviour).
 */

type Env = Record<string, string | undefined>

/** NIVARO_ROLE, trimmed and lower-cased; null when unset. */
export function processRole(env: Env = process.env): string | null {
  const r = (env.NIVARO_ROLE ?? '').trim().toLowerCase()
  return r || null
}

export function isRealtimeRole(env: Env = process.env): boolean {
  return processRole(env) === 'realtime'
}

/**
 * Does this process serve socket connections? Realtime: always. Cloud mode: always (the
 * realtime tier is self-hosted only). Otherwise unless SOCKETS=off.
 */
export function socketsServed(env: Env = process.env): boolean {
  if (isRealtimeRole(env) || env.CLOUD_META_DB_URL) return true
  return (env.SOCKETS ?? '').trim().toLowerCase() !== 'off'
}

/**
 * Everything a realtime process answers over HTTP (`METHOD path` as Fastify registers it).
 * Socket.io and graphql-ws attach to the HTTP server's upgrade path, not as routes. A test holds
 * buildRealtimeServer() to this list.
 */
export const REALTIME_HTTP_ROUTES: readonly string[] = [
  'GET /api/version',
  'GET /api/ready',
  'GET /api/health',
  'GET /api/metrics',
  'GET /api/events/ticket',
  'GET /api/events/stream',
  'GET /api/events/views/:id/stream',
  'GET /api/graphql/stream',
  'POST /api/graphql/stream'
]

/** Paths a proxy sends to the realtime tier (for docs, the compose example and tests). */
export const REALTIME_PROXY_PATHS: readonly string[] = [
  '/socket.io/',
  '/api/graphql-ws',
  '/api/graphql/stream',
  '/api/events/stream',
  '/api/events/views/:id/stream'
]

export interface RealtimeRosterEntry {
  role?: unknown
  instance?: unknown
  version?: unknown
  host?: unknown
}

export interface RealtimeJudgement {
  status: 'ok' | 'warn' | 'fail'
  summary: string
  /** Realtime processes of this deployment in the roster. */
  realtime: number
}

/**
 * Can people get live updates through this process's deployment? A process that serves
 * sockets itself passes. A process with SOCKETS=off needs a realtime process in the instance
 * roster (same deployment slot): none FAILS (every browser would sit on "Live updates paused"),
 * one only warns (a restart drops every live connection until it is back).
 */
export function judgeRealtimeTier(ctx: {
  served: boolean
  redis: boolean
  roster: RealtimeRosterEntry[]
  /** This process's deployment slot (instanceKey()); entries of other slots are not counted. */
  instance: string
}): RealtimeJudgement {
  if (ctx.served)
    return { status: 'ok', summary: 'This process serves live connections itself.', realtime: 0 }
  if (!ctx.redis)
    return {
      status: 'fail',
      summary:
        'SOCKETS=off and no Redis: nothing this process emits can reach a realtime process. Turn sockets back on or fix Redis.',
      realtime: 0
    }
  const mine = ctx.roster.filter(
    (e) =>
      String(e.role ?? '')
        .trim()
        .toLowerCase() === 'realtime' &&
      (!e.instance || e.instance === ctx.instance)
  )
  if (mine.length === 0)
    return {
      status: 'fail',
      summary:
        'SOCKETS=off but no realtime process (NIVARO_ROLE=realtime) is running: nobody gets live updates. Start the realtime service, or set SOCKETS=on.',
      realtime: 0
    }
  if (mine.length === 1)
    return {
      status: 'warn',
      summary:
        'One realtime process holds every live connection: a restart drops them all until it is back. Run two.',
      realtime: 1
    }
  return {
    status: 'ok',
    summary: `${mine.length} realtime processes hold the live connections.`,
    realtime: mine.length
  }
}

interface NamespaceLike {
  listenerCount(event: string): number
}

/**
 * Connection handlers on every namespace: the core's, plus any extension's
 * `app.io.on('connection')` / `app.io.of('/x').on('connection')`.
 */
export function connectionHandlerCount(io: {
  of(name: string): NamespaceLike
  _nsps?: Map<string, NamespaceLike>
}): number {
  const spaces = io._nsps instanceof Map ? [...io._nsps.values()] : [io.of('/')]
  let n = 0
  for (const ns of spaces) n += ns.listenerCount('connection') + ns.listenerCount('connect')
  return n
}

/**
 * An extension that listens for socket connections would never hear one on a process that
 * serves no sockets, and a realtime process loads no extensions: with SOCKETS=off, an extension
 * adding a connection handler stops the boot instead of failing silently.
 */
export function refuseExtensionSocketHandlers(
  before: number,
  after: number,
  served: boolean = socketsServed()
): void {
  if (served || after <= before) return
  throw new Error(
    `SOCKETS=off, but an extension registered ${after - before} Socket.io connection handler(s) (app.io.on('connection')). Sockets are served by the realtime processes, which load no extensions, so the handler would never run. Move that work to an event the API emits, or run this deployment without SOCKETS=off.`
  )
}
