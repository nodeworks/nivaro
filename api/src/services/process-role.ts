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
 *   importer  runs staged imports only (services/import-handoff.ts): drains the import hand-off
 *             list, ticks no crons (cron-ticks.ts), runs no migrations, answers only
 *             /api/version, /api/ready, /api/health and /api/metrics
 *   exporter  runs background exports only (services/export-handoff.ts): drains the export
 *             hand-off list, ticks no crons, runs no migrations, answers only /api/version,
 *             /api/ready, /api/health and /api/metrics (the importer's list)
 *   canary    a deploy canary that serves nobody (render-peer.ts canaryLenient)
 *
 * A web process with SOCKETS=off serves no /socket.io; what it emits reaches the clients on the
 * realtime processes through the Socket.io Redis adapter and the event stream. Nothing set =
 * one process that does everything, sockets included (the historic behaviour).
 *
 * Where: self-hosted (one app), and a Hub shared deployment (many apps), where a realtime
 * process resolves the app per connection and per stream request exactly as a shared web
 * process does (realtime-server.ts). Never Nivaro Cloud: every Cloud process serves its own
 * sockets and NIVARO_ROLE=realtime is refused there (realtimeRoleProblem).
 */
import { isNivaroCloud, tenantSource } from './deployment-mode.js'

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
 * Does this process serve socket connections? Realtime: always. Nivaro Cloud: always (it has no
 * realtime tier). Otherwise — self-hosted, and a Hub shared deployment whose realtime service
 * holds the sockets — unless SOCKETS=off.
 */
export function socketsServed(env: Env = process.env): boolean {
  if (isRealtimeRole(env) || isNivaroCloud(env)) return true
  return (env.SOCKETS ?? '').trim().toLowerCase() !== 'off'
}

/**
 * Why this deployment cannot run a realtime process (NIVARO_ROLE=realtime), or null when it can.
 * Self-hosted and a Hub shared deployment can; Nivaro Cloud cannot (every Cloud process serves
 * its own sockets, and its edge routes no path to a realtime tier). index.ts refuses the boot
 * with this sentence and buildRealtimeServer() throws it.
 */
export function realtimeRoleProblem(env: Env = process.env): string | null {
  if (!isNivaroCloud(env)) return null
  return 'NIVARO_ROLE=realtime is not available on Nivaro Cloud: every Cloud process serves its own live connections. Unset NIVARO_ROLE.'
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
  beat_at?: unknown
}

/** A roster entry older than this is not counted (beats every 30 s; the key lives 90 s). */
export const REALTIME_BEAT_STALE_MS = 45_000

export interface RealtimeJudgement {
  status: 'ok' | 'warn' | 'fail'
  summary: string
  /** Realtime processes of this deployment in the roster. */
  realtime: number
}

/**
 * Can people get live updates through this process's deployment? A process that serves
 * sockets itself passes. A process with SOCKETS=off needs:
 *   - Redis and the event stream (REALTIME_EVENT_STREAM): record changes reach the realtime
 *     processes' streams and saved views on the stream;
 *   - a realtime process (NIVARO_ROLE=realtime) of its own deployment slot that beat within
 *     45 s: none FAILS (every browser would sit on "Live updates paused"), one warns (a restart
 *     drops every live connection until it is back);
 *   - when probed, the proxy sending the stream path to a realtime process (`routed`).
 */
export function judgeRealtimeTier(ctx: {
  served: boolean
  redis: boolean
  roster: RealtimeRosterEntry[]
  /** This process's deployment slot (instanceKey()); entries of other slots are not counted. */
  instance: string
  /** REALTIME_EVENT_STREAM is on (default true). */
  stream?: boolean
  /** The public stream path answered from a realtime process (null = not probed). */
  routed?: boolean | null
  now?: number
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
  if (ctx.stream === false)
    return {
      status: 'fail',
      summary:
        'SOCKETS=off with REALTIME_EVENT_STREAM=off: record changes would reach the realtime processes by pub/sub only, and their saved-view and SSE streams would miss them. Turn the event stream on.',
      realtime: 0
    }
  const now = ctx.now ?? Date.now()
  const mine = ctx.roster.filter((e) => {
    if (
      String(e.role ?? '')
        .trim()
        .toLowerCase() !== 'realtime'
    )
      return false
    if (e.instance !== ctx.instance) return false
    const beat = Date.parse(String(e.beat_at ?? ''))
    return !Number.isFinite(beat) || now - beat <= REALTIME_BEAT_STALE_MS
  })
  if (mine.length === 0)
    return {
      status: 'fail',
      summary:
        'SOCKETS=off but no realtime process (NIVARO_ROLE=realtime) is running: nobody gets live updates. Start the realtime service, or set SOCKETS=on.',
      realtime: 0
    }
  if (ctx.routed === false)
    return {
      status: 'fail',
      summary:
        'SOCKETS=off, but the proxy does not send /api/events/stream to a realtime process: browsers reach a process that serves no live connections. Add the realtime router.',
      realtime: mine.length
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

interface EmitterAdapterLike {
  channel?: string
  requestChannel?: string
  serverCount(): Promise<number>
}

/**
 * A SOCKETS=off process publishes through the Redis adapter but needs nothing back from it:
 * it holds no sockets to deliver broadcasts to and none to answer fetchSockets with. Leaving
 * the broadcast pattern and the request channel keeps it from decoding every broadcast on a
 * busy request thread and takes it out of the request quorum (every fetchSockets otherwise
 * waits for every web process). It still counts itself, because the adapter subtracts the
 * requester from the subscriber count: without the +1, a request it makes would wait for one
 * realtime process fewer than there are.
 */
export async function emitterOnlyAdapter(
  adapter: unknown,
  sub: { punsubscribe(p: string): unknown; unsubscribe(c: string): unknown },
  warn: (msg: string, err: unknown) => void = () => {}
): Promise<boolean> {
  const a = adapter as EmitterAdapterLike
  if (typeof a?.serverCount !== 'function' || !a.channel || !a.requestChannel) return false
  try {
    await sub.punsubscribe(`${a.channel}*`)
  } catch (err) {
    // Only a cost: broadcasts are decoded here for nobody.
    warn('SOCKETS=off: could not leave the Socket.io broadcast feed', err)
  }
  try {
    await sub.unsubscribe(a.requestChannel)
  } catch (err) {
    // Still in the quorum, so it still answers requests: counting itself again would make
    // every request it makes wait for one answer too many (the 5 s timeout).
    warn('SOCKETS=off: could not leave the Socket.io request channel; staying in the quorum', err)
    return false
  }
  // Only once the unsubscribe has landed: the adapter subtracts the requester from NUMSUB.
  const count = a.serverCount.bind(a)
  a.serverCount = async () => (await count()) + 1
  return true
}

/**
 * Does the public stream path reach a realtime process? An unauthenticated GET of
 * `<base>/api/events/stream` answers 401 from whichever process the proxy picked; a realtime
 * process stamps `X-Nivaro-Role: realtime` on every response. Null when it cannot tell (no base
 * URL, network error, timeout).
 */
export async function probeRealtimeRouting(
  base: string | undefined,
  fetcher: typeof fetch = fetch,
  timeoutMs = 3000
): Promise<boolean | null> {
  if (!base) return null
  try {
    const res = await fetcher(`${base.replace(/\/$/, '')}/api/events/stream`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    void res.body?.cancel().catch(() => {})
    return res.headers.get('x-nivaro-role') === 'realtime'
  } catch {
    return null
  }
}

/**
 * Where the routing probe (probeRealtimeRouting) asks. Self-hosted: PUBLIC_URL. A Hub shared
 * deployment sets no PUBLIC_URL, and its fallback (http://localhost:<PORT>) is the web process
 * itself, whose tenant hook refuses the host `localhost` with no X-Nivaro-Role — every app would
 * read "the proxy does not route". There the probe asks the app's own origin (`appOrigin`: the
 * verified origin the request runs in, tenantOrigin()), the address the proxy routes; with no app
 * origin (a check run outside an app) nothing is probed (undefined: the probe answers null, "cannot
 * tell", never a failure). Nivaro Cloud serves its own sockets and never probes.
 */
export function realtimeProbeBase(
  publicUrl: string | undefined,
  appOrigin: string | null | undefined,
  env: Env = process.env
): string | undefined {
  if (tenantSource(env) === 'hub') return appOrigin || undefined
  return publicUrl
}

/**
 * Does this process take part in the realtime board (services/realtime-board.ts)? Self-hosted,
 * and a Hub shared deployment, whose web processes with SOCKETS=off hold no sockets: without the
 * board every "is anyone watching?" gate in front of an emit (roomListeners, recordRoomHasViewers)
 * reads 0 there and the Traffic Map feed, flow watch, live AI calls and agent presence never fire.
 * Every room the board carries on a shared deployment is app-scoped (`t:<app>:`); its answers keyed
 * by a user id alone stay off there (boardAnswersUsers). Never Nivaro Cloud (per-process answers).
 */
export function realtimeBoardRuns(env: Env = process.env): boolean {
  return !isNivaroCloud(env)
}

/** Roles that run one queue only and answer nothing but health (importer, exporter). */
export function isWorkerOnlyRole(env: Env = process.env): boolean {
  const r = processRole(env)
  return r === 'importer' || r === 'exporter'
}
