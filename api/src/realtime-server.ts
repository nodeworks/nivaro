import { STATUS_CODES } from 'node:http'
import fastifyCors from '@fastify/cors'
import fastify, { type FastifyInstance } from 'fastify'
import { registerSession } from './auth/session.js'
import { config } from './config.js'
import { db } from './db/index.js'
import { authenticate } from './middleware/authenticate.js'
import { resolveWorkspace } from './middleware/workspace.js'
import { apiLoggerPlugin } from './plugins/api-logger.js'
import { graphqlPlugin, rebuildGraphQLSchema } from './plugins/graphql.js'
import { metricsPlugin } from './plugins/metrics.js'
import { redisPlugin } from './plugins/redis.js'
import { localBoardCollector, socketioPlugin } from './plugins/socketio.js'
import { eventsStreamRoutes } from './routes/events-stream.js'
import { viewStreamRoutes } from './routes/view-stream.js'
import { bootState } from './services/boot-phases.js'
import { trackError } from './services/error-tracking.js'
import { instanceKey } from './services/instance-key.js'
import { INSTANCE_ID } from './services/instance-roster.js'
import {
  DB_BUDGET_MS,
  judgeReady,
  REDIS_BUDGET_MS,
  type ReadyCheck,
  timedCheck
} from './services/ready-probe.js'
import { NIVARO_VERSION } from './version.js'

/**
 * The realtime tier (post-mortem 3.3, NIVARO_ROLE=realtime): a process that only holds live
 * connections, so they scale apart from request handling and delivery never waits behind a
 * request thread that is busy.
 *
 * Serves: Socket.io (/socket.io), graphql-ws (/api/graphql-ws), the SSE streams
 * (/api/events/stream, /api/events/views/:id/stream, /api/graphql/stream), the stream ticket,
 * /api/version, /api/ready, /api/health and /api/metrics — REALTIME_HTTP_ROUTES in
 * services/process-role.ts, held by a test. Nothing else: no REST routes, no crons, no
 * extensions, no hooks, no migrations, no media or render work.
 *
 * Sockets authenticate exactly as on a web process: the client mints a one-shot ws token on a
 * web process (GET /api/auth/ws-token) and sends it in the `auth` event; the token lives in
 * Redis, so any process redeems it. Streams take the session cookie, a Bearer token or a
 * one-shot ticket (GET /api/events/ticket).
 *
 * Rooms and fan-out go through the Socket.io Redis adapter; record changes written on the web
 * processes arrive on the event stream (services/event-stream.ts) and reach this process's
 * sockets, saved-view streams and SSE streams from there.
 *
 * The wiring below mirrors the realtime part of buildServer() (server.ts) — a service the
 * socket handlers start to need goes in both.
 */
/** Every `METHOD path` the realtime server registered (tests hold it to REALTIME_HTTP_ROUTES). */
const served: string[] = []
export function servedRealtimeRoutes(): readonly string[] {
  return served
}

export async function buildRealtimeServer(): Promise<FastifyInstance> {
  if (process.env.CLOUD_META_DB_URL)
    throw new Error(
      'NIVARO_ROLE=realtime is self-hosted only: cloud mode resolves a tenant per request and keeps sockets on every process.'
    )

  const app = fastify({
    trustProxy: config.TRUST_PROXY,
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
            }
          }
        : {})
    },
    ajv: { customOptions: { strict: false } },
    pluginTimeout: 30000
  })

  served.length = 0
  app.addHook('onRoute', (route) => {
    for (const m of Array.isArray(route.method) ? route.method : [route.method])
      if (m !== 'HEAD' && m !== 'OPTIONS') served.push(`${m} ${route.url}`)
  })

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Nivaro-Version', NIVARO_VERSION)
    reply.header('X-Nivaro-Role', 'realtime')
    return payload
  })

  // POST /api/graphql/stream carries a JSON body; an empty one is no body (as in server.ts).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || (body as string).trim() === '') {
      done(null, undefined)
      return
    }
    try {
      done(null, JSON.parse(body as string))
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  await app.register(
    fastifyCors,
    corsOrigins.length > 0
      ? { origin: corsOrigins, credentials: true }
      : { origin: '*', credentials: false }
  )

  await app.register(redisPlugin)
  // The request log (stream opens, health) and Prometheus, as on web.
  await app.register(apiLoggerPlugin)
  await app.register(metricsPlugin)
  await registerSession(app)
  // Traffic Map circuit breakers every replica honours.
  {
    const { startBreakerSync } = await import('./services/traffic-breaker.js')
    startBreakerSync(app.redis as never)
  }

  await app.register(socketioPlugin)
  {
    const { setAppRef, setIo } = await import('./services/io-holder.js')
    setIo(app.io)
    setAppRef(app)
    const { wireOpsLive } = await import('./services/ops-live.js')
    wireOpsLive()
    const { setJournalRedis } = await import('./services/event-journal.js')
    setJournalRedis(app.redis)
    const { startTrafficMapEmitter } = await import('./services/traffic-map.js')
    const stopTrafficMap = startTrafficMapEmitter({ node: INSTANCE_ID })
    app.addHook('onClose', async () => stopTrafficMap())
    // GraphQL subscriptions hear record changes on the item-event channel.
    const { initItemEvents, closeItemEvents } = await import('./services/item-events.js')
    await initItemEvents(app.redis)
    app.addHook('onClose', async () => {
      await closeItemEvents()
    })
    // Record changes from the web processes: the event stream delivers them to this process's
    // sockets and journal listeners (saved-view streams); the bridge hands them to /events/stream.
    const { initEventStream, closeEventStream } = await import('./services/event-stream.js')
    await initEventStream(app.redis)
    const { alignJournalSequence, flushJournal } = await import('./services/event-journal.js')
    void alignJournalSequence()
    const { startSseRemoteBridge } = await import('./services/sse-hub.js')
    startSseRemoteBridge()
    const { wireJournalFallback } = await import('./services/event-journal.js')
    const stopFallback = wireJournalFallback(app.redis)
    app.addHook('onClose', async () => stopFallback())
    app.addHook('onClose', async () => {
      await flushJournal().catch(() => {})
      await closeEventStream()
    })
    const { setMetadataL2Redis } = await import('./db/metadata-l2.js')
    setMetadataL2Redis(app.redis)
    // Socket room checks run can() — the compiled permission cache, when on, must follow the
    // same Redis versions as every other process (PERMISSION_CACHE is all-or-nothing).
    const pc = await import('./services/permission-cache.js')
    if (pc.permissionCacheEnabled()) pc.setPermissionCacheRedis(app.redis)
    // What this process's sockets know, for the SOCKETS=off processes (services/realtime-board.ts).
    // Traffic Map: the watch room's presence/resync events live with the sockets, and the
    // cluster relay announces this process's watchers so the web processes send it their
    // frames (and answers snapshot requests). On web both start from the map's route plugins.
    const { attachTrafficPresence } = await import('./services/traffic-map-presence.js')
    attachTrafficPresence(app.io)
    if (process.env.NODE_ENV !== 'test') {
      const { startInflightCluster } = await import('./services/inflight-cluster.js')
      const stopInflight = startInflightCluster(app.redis)
      app.addHook('onClose', async () => stopInflight())
      try {
        const { startTrafficCluster } = await import('./services/traffic-cluster.js')
        const { localSnapshot } = await import('./routes/traffic-map-extras/cluster.js')
        const { getIo } = await import('./services/io-holder.js')
        const { listInstances } = await import('./services/instance-roster.js')
        const stopCluster = await startTrafficCluster(app.redis, {
          node: INSTANCE_ID,
          io: () => getIo() as never,
          snapshotOf: localSnapshot,
          peers: {
            list: async () => (await listInstances()).map((r) => String(r.id ?? '')).filter(Boolean)
          }
        })
        app.addHook('onClose', async () => stopCluster())
      } catch (err) {
        app.log.warn({ err }, 'traffic-map cluster relay did not start on this realtime process')
      }
    }
    // Publishes once a reader or another realtime process is registered; reads the other
    // realtime processes' viewers so `record:viewers` lists everyone on the record.
    const { startBoard } = await import('./services/realtime-board.js')
    const stopBoard = startBoard(app.redis, {
      serves: true,
      collect: localBoardCollector(app.io)
    })
    // Off the board as soon as the drain starts, so nobody trusts this process's viewers.
    app.addHook('preClose', async () => stopBoard())
  }

  {
    const { startRuntimeMonitor } = await import('./services/runtime-monitor.js')
    startRuntimeMonitor()
    const { registerKnownCaches } = await import('./services/cache-registrations.js')
    registerKnownCaches()
    const { CONFIG_EPOCH, onEpoch, onEpochReset, startEpochWatch, stopEpochWatch } = await import(
      './db/config-epoch.js'
    )
    const { bustAllCaches } = await import('./services/cache-registry.js')
    // A configuration change elsewhere: drop caches, and rebuild the GraphQL schema the
    // subscriptions run on only when what it is built from changed (collections, fields,
    // relations, pipeline bindings) — most moves are layout autosaves, rules, settings. One check
    // at a time; a move during a check runs one more after it.
    const { schemaInputsFingerprint } = await import('./services/schema-builder.js')
    const { createSchemaWatcher } = await import('./services/schema-watch.js')
    const schemaWatch = createSchemaWatcher({
      fingerprint: schemaInputsFingerprint,
      rebuild: rebuildGraphQLSchema,
      warn: (err) =>
        app.log.warn({ err }, 'GraphQL schema check after a configuration change failed')
    })
    const rebuildSchemaSoon = () => schemaWatch.moved()
    // Baseline once the boot build has run.
    app.addHook('onReady', async () => {
      void schemaWatch.baseline()
    })
    app.addHook('onClose', async () => schemaWatch.stop())
    onEpoch(CONFIG_EPOCH, () => {
      bustAllCaches()
      rebuildSchemaSoon()
    })
    const restored = (why: string) => {
      const names = bustAllCaches()
      rebuildSchemaSoon()
      app.log.warn({ caches: names.length, why }, 'Database restored underneath — caches cleared')
    }
    onEpochReset((e) => {
      if (e.backwards) restored('configuration number went backwards')
    })
    const { onMetadataL2IdentityChange } = await import('./db/metadata-l2.js')
    onMetadataL2IdentityChange(() => restored('database incarnation changed'))
    startEpochWatch(Number(process.env.CACHE_EPOCH_POLL_MS ?? 5000))
    app.addHook('onClose', async () => stopEpochWatch())
    const { startInstanceRoster } = await import('./services/instance-roster.js')
    startInstanceRoster(app.redis)
    // Per-minute event-loop lag peaks for the stall monitor (ops-signals.ts): realtime processes
    // are judged like every other node.
    const { startOpsSignals } = await import('./services/ops-signals.js')
    void startOpsSignals(app.redis ?? null).catch(() => {})
    const { startPoolAttribution } = await import('./services/pool-attribution.js')
    startPoolAttribution()
    const { startDbHealthProbe, isDbHealthy } = await import('./services/db-health.js')
    startDbHealthProbe()
    app.addHook('onRequest', async (req, reply) => {
      if (!isDbHealthy() && /^\/api\/(events|graphql)\//.test(req.url))
        return reply.code(503).send({
          error: 'The database is unreachable — retrying automatically.',
          code: 'DB_UNAVAILABLE'
        })
    })
  }

  app.addHook('preHandler', resolveWorkspace)

  // 5xx → the issue log, as on web (without the request sketch: no request bodies here). The
  // answer has web's shape: a coded 4xx keeps its machine code.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500)
      void trackError({
        source: 'server',
        route: `${req.method} ${req.routeOptions?.url ?? req.url} (realtime)`,
        message: err.message,
        stack: err.stack,
        userId: req.user?.id ?? null
      }).catch(() => {})
    req.log.error(err)
    const coded = !!err.code && status < 500 && /^[A-Z][A-Z0-9_]+$/.test(err.code)
    return reply.code(status).send({
      statusCode: status,
      error: STATUS_CODES[status] ?? 'Error',
      message: err.message,
      ...(coded ? { code: err.code } : {})
    })
  })

  await app.register(realtimeHealthRoutes, { prefix: '/api' })
  await app.register(eventsStreamRoutes, { prefix: '/api/events' })
  await app.register(viewStreamRoutes, { prefix: '/api/events/views' })
  await app.register(graphqlPlugin, { prefix: '/api', streamsOnly: true })

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: 'Not found',
      message: `${req.method} ${req.url.split('?')[0]} is not served by a realtime process (NIVARO_ROLE=realtime): route it to the web processes.`
    })
  )

  app.log.info('Realtime process: sockets and streams only (NIVARO_ROLE=realtime)')
  return app
}

/** /version, /ready and /health for a realtime process: no migrations, no extensions. */
async function realtimeHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/version', async () => ({
    version: NIVARO_VERSION,
    environment: config.NODE_ENV,
    instance: instanceKey(),
    role: 'realtime',
    cloud: false
  }))

  app.get('/ready', async (_req, reply) => {
    const state = bootState()
    if (state.shutting_down)
      return reply
        .code(503)
        .send(judgeReady([{ id: 'boot', ok: false, summary: 'Shutting down — draining.' }]))
    const boot: ReadyCheck = {
      id: 'boot',
      ok: state.ready,
      summary: state.ready ? 'Boot finished.' : 'Still booting.'
    }
    const [database, redis] = await Promise.all([
      timedCheck('database', 'Database', DB_BUDGET_MS, () => db.raw('SELECT 1')),
      timedCheck('redis', 'Redis', REDIS_BUDGET_MS, () => app.redis.ping())
    ])
    // Redis carries every event a realtime process delivers: without it, it is not ready. A slow
    // database (sign-ins after a restart moved every socket here) only warns: pulling the last
    // realtime process out of the proxy would take every live connection down with it.
    const report = judgeReady([boot, redis])
    return reply.code(report.ready ? 200 : 503).send({
      ...report,
      checks: [boot, database.ok ? database : { ...database, ok: true, warn: true }, redis]
    })
  })

  app.get('/health', async (req, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      db
        .raw('SELECT 1')
        .then(() => true)
        .catch(() => false),
      app.redis
        .ping()
        .then((r) => r === 'PONG')
        .catch(() => false)
    ])
    const ok = dbOk && redisOk
    // The socket count is for administrators, like the host details on web's /api/health.
    const admin = await authenticate(req, reply)
      .then(() => !!req.isAdmin)
      .catch(() => false)
    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      version: NIVARO_VERSION,
      role: 'realtime',
      ...(admin ? { sockets: app.io.engine?.clientsCount ?? 0 } : {}),
      db: { status: dbOk ? 'connected' : 'disconnected' },
      redis: { status: redisOk ? 'connected' : 'disconnected' },
      ts: new Date().toISOString()
    })
  })
}
