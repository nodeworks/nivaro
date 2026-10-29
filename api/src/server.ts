import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { STATUS_CODES } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream'
import fastifyCors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import fastify from 'fastify'
import { registerSession } from './auth/session.js'
import { config } from './config.js'
import { db } from './db/index.js'
import { getTenantId, getTenantSlug } from './db/tenant-context.js'
import { loadCloudExtensions, loadExtensions, setApp } from './extensions/loader.js'
import { registerFileCleanup } from './hooks/file-cleanup.js'
import {
  anonymousBodyTooLarge,
  capStream,
  defaultBodyLimit,
  largeBodyLimit,
  needsStreamingCap,
  routeBodyLimit
} from './lib/body-limits.js'
import { describeDbRefusal, errorText, isPoolBusy, messageWithoutSql } from './lib/db-refusal.js'
import { applyEarlyHints, loadEarlyHints } from './lib/early-hints.js'
import { registerJsonBodyParser } from './lib/json-body.js'
import { applySecurityHeaders } from './lib/security-headers.js'
import { isSourceMapPath, sourceMapsPublic } from './lib/source-maps.js'
import { adminAssetCacheControl } from './lib/static-cache.js'
import { fastifyTrustProxy, trustProxyFromEnv } from './lib/trust-proxy.js'
import { scopeRefusalBody } from './middleware/authenticate.js'
import { getMetaDb, tenantHook } from './middleware/tenant.js'
import { resolveWorkspace } from './middleware/workspace.js'
import { apiLoggerPlugin } from './plugins/api-logger.js'
import { chainPlugin } from './plugins/chain.js'
import { cronPlugin } from './plugins/cron.js'
import { registerEtags } from './plugins/etag.js'
import { graphqlPlugin } from './plugins/graphql.js'
import { legacyCompatRoutes } from './plugins/legacy-compat.js'
import { metricsPlugin } from './plugins/metrics.js'
import { callerRateLimitPlugin, rateLimitPlugin } from './plugins/rate-limit.js'
import { redisPlugin } from './plugins/redis.js'
import { requestTracePlugin } from './plugins/request-trace.js'
import { socketioPlugin } from './plugins/socketio.js'
import { trafficActionsPlugin } from './plugins/traffic-actions.js'
import { adminProvisionRoutes } from './routes/admin/provision.js'
import { adminTrafficTenantRoutes } from './routes/admin/traffic-tenants.js'
import { loadScheduledFlows } from './routes/flows.js'
import { formRendererRoutes } from './routes/form-renderer.js'
import { registerRoutes } from './routes/index.js'
import { oauthPublicRoutes } from './routes/oauth.js'
import { presencePublicRoutes } from './routes/presence.js'
import { purgeExpiredRecordings } from './routes/session-recordings.js'
import { sharePublicRoutes } from './routes/share-links.js'
import { statusPublicRoutes } from './routes/status.js'
import { setPulseApp } from './services/activity.js'
import { pruneAiCalls } from './services/ai-log.js'
import { bootPhase } from './services/boot-phases.js'
import { CRON_DESCRIPTIONS } from './services/cron-descriptions.js'
import { registerMissedCronProbe } from './services/cron-misses.js'
import { logRouteError } from './services/error-log-level.js'
import { trackError } from './services/error-tracking.js'
import { callExternalApi } from './services/external-apis.js'
import { markMcpInnerRequest } from './services/mcp-config.js'
import { registerQueueSnapshotCron } from './services/queue-snapshots.js'
import { registerStagedImportWorker } from './services/staged-import-worker.js'
import { purgeExpiredTrash } from './services/trash.js'
import { NIVARO_VERSION } from './version.js'

export async function buildServer() {
  // File-size ceiling from settings, read BEFORE the server exists because it
  // feeds fastify's GLOBAL bodyLimit too (the large ceiling = file ceiling +
  // headroom for big JSON bodies; a BID template re-import once died on a 1MB
  // global). Core routes are lowered to BODY_LIMIT_MB (default 1MB) by the
  // onRoute hook below unless their group receives large bodies — see
  // lib/body-limits.ts (M20, security audit 2026-10-27).
  const _fsMb = process.env.CLOUD_META_DB_URL
    ? null
    : await db('nivaro_settings')
        .first('file_max_size_mb')
        .catch(() => null)
  const _fileSizeMb = (_fsMb?.file_max_size_mb as number | null) ?? 50
  const smallBodyLimit = defaultBodyLimit()
  const trustProxy = trustProxyFromEnv()

  const app = fastify({
    bodyLimit: largeBodyLimit(_fileSizeMb),
    // TRUST_PROXY: true | false | hop count | IP/CIDR list (M14) — lib/trust-proxy.ts.
    trustProxy: fastifyTrustProxy(trustProxy.value),
    // A uuid request id (never a client-supplied one: requestIdHeader stays off). The request
    // trace adopts it, so the reqId on every req.log line is the same id as the api_logs row,
    // the x-nivaro-request-id header and the trace — one id joins a server error to its request.
    genReqId: () => randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      // Request lines never carry the query string: tokens and tickets ride some URLs
      // (?st=, ?token=, ?code=), and log lines are shipped to the long-history store.
      serializers: {
        req: (req: {
          method?: string
          url?: string
          host?: string
          ip?: string
          socket?: { remotePort?: number }
        }) => ({
          method: req.method,
          url: String(req.url ?? '').split('?')[0],
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort
        })
      },
      // Log viewer (#156): tee every line into the in-process ring buffer.
      hooks: {
        logMethod(args: unknown[], method: (...a: unknown[]) => void, level: number) {
          try {
            const parts = args.map((a) =>
              typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)
            )
            void import('./services/log-ring.js').then(({ pushLog }) =>
              pushLog(level, parts.join(' '))
            )
          } catch {
            /* the log line itself must never fail */
          }
          method.apply(this, args)
        }
      },
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

  if (trustProxy.warning) app.log.warn(`[boot] ${trustProxy.warning}`)

  // M20 — core routes get the small body ceiling unless their group receives large bodies or
  // they declare their own; routes registered after `coreRoutes` closes (extensions, often
  // lazily) keep the large global one. lib/body-limits.ts.
  let coreRoutes = true
  app.addHook('onRoute', (route) => {
    const limit = routeBodyLimit(route, { core: coreRoutes, small: smallBodyLimit })
    if (limit !== undefined) route.bodyLimit = limit
  })

  // Every response to a signed-in caller names the running build — clients use it to notice a
  // deploy (client-version.ts). Anonymous answers leave it out; GET /api/version stays the
  // public "what is running" probe.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.user || req.headers.authorization || req.session?.userId) {
      reply.header('X-Nivaro-Version', NIVARO_VERSION)
    }
    // M21 — nosniff, referrer policy, framing (SAMEORIGIN / frame-ancestors), base-uri,
    // object-src, HSTS over https. A route's own header wins. lib/security-headers.ts.
    applySecurityHeaders(req, reply)
    return payload
  })

  // ─── Cloud multi-tenant: resolve tenant DB per request ────────────────────
  // Only active when CLOUD_META_DB_URL is set. Self-hosted: this hook is never
  // registered — behaviour is identical to before for self-hosted users.
  if (process.env.CLOUD_META_DB_URL) {
    app.addHook('onRequest', tenantHook)
    // Internal provisioning endpoint — not tenant-scoped, no tenant hook needed
    await app.register(adminProvisionRoutes)
    // #1185 — the operator's noisy-tenant ranking (same provision secret, tenant-free path)
    await app.register(adminTrafficTenantRoutes)
  }

  // application/json: empty body = undefined (the SDK sends the header on bodyless writes),
  // __proto__ / constructor.prototype keys stripped, raw text kept only for signed webhooks.
  registerJsonBodyParser(app)

  // ─── CORS ──────────────────────────────────────────────────────────────────
  // Default: open to all origins, no credentials — tracker runs on external
  // sites, token (Bearer) clients work cross-origin, and the admin UI is
  // same-origin in prod (Vite proxy makes it same-origin in dev).
  // CORS_ORIGINS (comma-separated) switches to an explicit allowlist WITH
  // credentials, for external frontends that need cookie-session auth.
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

  // ─── Multipart (file uploads) ──────────────────────────────────────────────
  // File ceiling read above (it also sets the global bodyLimit).
  await app.register(fastifyMultipart, {
    limits: { fileSize: _fileSizeMb * 1024 * 1024 }
  })

  // ─── Redis ─────────────────────────────────────────────────────────────────
  await app.register(redisPlugin)

  // ─── Rate limiting + API analytics logging ────────────────────────────────
  // Tracing goes first so its onRequest hook opens the phase context before
  // anything downstream can want to record a span into it.
  // Integration event chain per request (or adopted from an in-process
  // app.inject caller) — the API log row and every write it causes carry it.
  await app.register(chainPlugin)
  await app.register(requestTracePlugin)
  // Before anything reads headers: an in-process MCP tool call's marker becomes a request flag.
  app.addHook('onRequest', markMcpInnerRequest)
  await app.register(rateLimitPlugin)
  // Traffic Map debug windows + temporary caches (#2215 / #2273) — timed rules every replica honours.
  await app.register(trafficActionsPlugin)
  // Ahead of the request log, so the log keeps the answer the caller received.
  app.addHook('onSend', async (req, reply, payload) => {
    const body = scopeRefusalBody(req, reply.statusCode, payload)
    if (body === null) return payload
    void reply.header('content-length', Buffer.byteLength(body))
    return body
  })
  // #2439 — per-viewer ETag + 304 on record / metadata / layout reads; ahead of the request log.
  registerEtags(app)
  await app.register(apiLoggerPlugin)
  // #1088 — Prometheus /api/metrics + per-route request histograms.
  await app.register(metricsPlugin)

  // ─── Sessions ─────────────────────────────────────────────────────────────
  await registerSession(app)

  // ─── Abuse limits that need to know who is signed in (M15 / M20) ──────────
  // After the session plugin: a verified session is known here, a cookie alone is not.
  // A body over the small ceiling needs a credential before it is read at all.
  app.addHook('onRequest', async (req, reply) => {
    if (anonymousBodyTooLarge(req, smallBodyLimit)) {
      return reply.code(413).send({
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Sign in to send a request this large.',
        code: 'FST_ERR_CTP_BODY_TOO_LARGE'
      })
    }
  })
  // A body with no declared size (chunked) from a caller with no credential is counted while
  // it streams and cut off with 413 past the small ceiling.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (!needsStreamingCap(req, smallBodyLimit)) return payload
    const capped = capStream(smallBodyLimit)
    pipeline(payload, capped, () => {})
    return capped
  })
  await app.register(callerRateLimitPlugin)

  // ─── Socket.io ────────────────────────────────────────────────────────────
  const collectedRoutes: string[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue
      collectedRoutes.push(`${m} ${route.url}`)
    }
  })

  await app.register(socketioPlugin)
  // Global io + journal wiring (realtime sprint): services with no app in
  // scope emit through the holder; the event journal (#266) shares the
  // app Redis connection. realtime-server.ts (NIVARO_ROLE=realtime) mirrors the parts the
  // socket handlers need — a new one goes in both.
  {
    const { setAppRef, setIo } = await import('./services/io-holder.js')
    setIo(app.io)
    setAppRef(app)
    const { wireOpsLive } = await import('./services/ops-live.js')
    wireOpsLive()
    const { setJournalRedis } = await import('./services/event-journal.js')
    setJournalRedis(app.redis)
    const { setExtensionRoutes, startTrafficMapEmitter } = await import('./services/traffic-map.js')
    const { extensionRoutes } = await import('./extensions/loader.js')
    setExtensionRoutes(extensionRoutes) // live Map: routes registered later are seen
    // One store per process self-hosted; per tenant in cloud mode, each tenant's frames going to
    // its own room (#1132). Frames carry the process id so pages can merge nodes (#1098).
    {
      const { INSTANCE_ID } = await import('./services/instance-roster.js')
      const stopTrafficMap = startTrafficMapEmitter({ node: INSTANCE_ID })
      app.addHook('onClose', async () => stopTrafficMap())
    }
    const { initItemEvents, closeItemEvents } = await import('./services/item-events.js')
    await initItemEvents(app.redis)
    app.addHook('onClose', async () => {
      await closeItemEvents()
    })
    // Chat channel registry clears reach every replica (a new group is usable at once).
    await (await import('./services/chat.js')).wireChatRegistryRelay()
    // Slim parity: the media worker (a full-image process that ticks crons,
    // or MEDIA_WORKER=on) drains clips, captions, upload extras and replay
    // videos that slim processes handed off (services/media-handoff.ts).
    {
      const { startMediaWorker, stopMediaWorker } = await import('./services/media-handoff.js')
      const { INSTANCE_ID } = await import('./services/instance-roster.js')
      const { NIVARO_VERSION } = await import('./version.js')
      void startMediaWorker({
        redis: app.redis,
        log: app.log,
        instance: INSTANCE_ID,
        name: process.env.NIVARO_INSTANCE?.trim() || null,
        version: NIVARO_VERSION
      }).catch((err) => app.log.warn({ err }, '[media-worker] did not start'))
      app.addHook('onClose', async () => stopMediaWorker())
    }
    // Realtime event pipeline: journaled events cross replicas on a Redis
    // stream (#1737); the durable journal (#1673) keeps the sequence ahead of
    // a Redis that lost its keys. Both fail open — events still flow without.
    {
      const { initEventStream, closeEventStream } = await import('./services/event-stream.js')
      await initEventStream(app.redis)
      const { alignJournalSequence, flushJournal } = await import('./services/event-journal.js')
      void alignJournalSequence()
      // Post-mortem 3.3 — /events/stream hears other replicas' record changes too.
      const { startSseRemoteBridge } = await import('./services/sse-hub.js')
      startSseRemoteBridge()
      const { wireJournalFallback } = await import('./services/event-journal.js')
      const stopFallback = wireJournalFallback(app.redis)
      app.addHook('onClose', async () => stopFallback())
      // Post-mortem 3.3 — the realtime board: what every process's sockets know (viewers, page
      // pings, socket lists), shared once a second process is around (services/realtime-board.ts):
      // replicas that all serve sockets, a realtime tier, SOCKETS=off readers. A lone process
      // only registers itself every 5 s. Self-hosted only (cloud keeps per-process answers).
      if (!process.env.CLOUD_META_DB_URL && app.redis) {
        const { socketsServed } = await import('./services/process-role.js')
        const { startBoard } = await import('./services/realtime-board.js')
        const { localBoardCollector } = await import('./plugins/socketio.js')
        const stopBoard = startBoard(app.redis, {
          serves: socketsServed(),
          collect: localBoardCollector(app.io)
        })
        // Off the board as soon as the drain starts, so nobody trusts this process's viewers.
        app.addHook('preClose', async () => stopBoard())
      }
      const { flushRawWriteQueue } = await import('./services/raw-write-announcer.js')
      app.addHook('onClose', async () => {
        flushRawWriteQueue()
        await flushJournal().catch(() => {})
        await closeEventStream()
      })
    }
    const { setTransitionGuardRedis } = await import('./services/transition-guard.js')
    setTransitionGuardRedis(app.redis)
    // Readiness results are shared by every replica (and refreshed by one).
    const { setReadinessRedis } = await import('./services/readiness.js')
    setReadinessRedis(app.redis)
    // #2441 — configuration reads shared across processes (a fresh replica starts warm).
    const { setMetadataL2Redis } = await import('./db/metadata-l2.js')
    setMetadataL2Redis(app.redis)
    // Compiled permission cache (#2442, PERMISSION_CACHE=on): access versions live in Redis;
    // every pool that writes moves them on an access-table write, a procedure that may
    // touch one, and when a transaction that wrote one settles. Off: nothing is attached.
    {
      const pc = await import('./services/permission-cache.js')
      if (pc.permissionCacheEnabled()) {
        const { _backgroundDb, _staticDb } = await import('./db/index.js')
        pc.setPermissionCacheRedis(app.redis)
        for (const k of [_staticDb, _backgroundDb]) {
          const client = (k as unknown as { client?: object } | null)?.client
          pc.attachPermissionCacheSeam(client as Parameters<typeof pc.attachPermissionCacheSeam>[0])
          pc.attachPermissionCacheCommitHook(client)
        }
        if (config.DB_CLIENT === 'mssql') {
          pc.setPermissionCacheProcLookup(async (name) => {
            const rows = (await _staticDb.raw('SELECT OBJECT_DEFINITION(OBJECT_ID(?)) AS body', [
              name
            ])) as Array<{ body: string | null }>
            return rows?.[0]?.body ?? null
          })
        }
        app.log.info('Permission cache on')
      }
    }
    // Idempotency keys: one store hook for the whole app (no-op without a claim).
    const { registerIdempotencyStore } = await import('./services/idempotency.js')
    registerIdempotencyStore(app)
  }

  // ── Ops observability wiring (batch A) ───────────────────────────────────
  {
    const { startRuntimeMonitor } = await import('./services/runtime-monitor.js')
    startRuntimeMonitor()
    const { registerKnownCaches } = await import('./services/cache-registrations.js')
    registerKnownCaches()
    // Another process wrote configuration: clear what this one holds.
    const { CONFIG_EPOCH, SCHEDULES_EPOCH, onEpoch, startEpochWatch, stopEpochWatch } =
      await import('./db/config-epoch.js')
    const { bustAllCaches } = await import('./services/cache-registry.js')
    onEpoch(CONFIG_EPOCH, (epoch) => {
      const names = bustAllCaches()
      app.log.info(
        { epoch, caches: names.length },
        'Configuration changed elsewhere — caches cleared'
      )
    })
    // A schedule was created, edited or removed by another process.
    onEpoch(SCHEDULES_EPOCH, async () => {
      if (process.env.CLOUD_META_DB_URL || !app.cron) return
      const { resyncAllSchedules } = await import('./services/row-schedules.js')
      await resyncAllSchedules(app)
    })
    // #2441 — a restore underneath this process (the number went backwards, or the database's
    // incarnation changed): every in-process cache came from the old database.
    const { onEpochReset } = await import('./db/config-epoch.js')
    const { onMetadataL2IdentityChange } = await import('./db/metadata-l2.js')
    const restored = (why: string) => {
      const names = bustAllCaches()
      app.log.warn({ caches: names.length, why }, 'Database restored underneath — caches cleared')
    }
    onEpochReset((e) => {
      if (e.backwards) restored('configuration number went backwards')
    })
    onMetadataL2IdentityChange(() => restored('database incarnation changed'))
    startEpochWatch(Number(process.env.CACHE_EPOCH_POLL_MS ?? 5000))
    app.addHook('onClose', async () => stopEpochWatch())
    const { startInstanceRoster } = await import('./services/instance-roster.js')
    startInstanceRoster(app.redis)
    // Post-mortem 2026-10-23 4.3: per-minute lag peaks + route rates for the event-loop and
    // route-rate monitors, published to Redis so the cron process can judge every node.
    const { startOpsSignals } = await import('./services/ops-signals.js')
    // Never holds or fails boot: the monitors answer unknown without it.
    void startOpsSignals(app.redis ?? null).catch(() => {})
    const { startPoolAttribution } = await import('./services/pool-attribution.js')
    startPoolAttribution()
  }

  // ── Resiliency sprint wiring ─────────────────────────────────────────────
  {
    // DB outage posture (#329): probe loop + fast honest 503s while down.
    const { startDbHealthProbe, isDbHealthy } = await import('./services/db-health.js')
    startDbHealthProbe()
    // The render peer (#2789) never reads the database.
    const DB_EXEMPT = /^\/api\/(version|health|changelog|internal\/render\/)/
    app.addHook('onRequest', async (req, reply) => {
      if (!isDbHealthy() && /^\/api([/?]|$)/.test(req.url) && !DB_EXEMPT.test(req.url)) {
        return reply.code(503).send({
          error: 'The database is unreachable — retrying automatically. Nothing was saved.',
          code: 'DB_UNAVAILABLE'
        })
      }
    })

    // Chaos slow-request fault (#333 → registry #2827) — one map lookup unless a drill is armed.
    const { chaosNumber } = await import('./services/chaos/registry.js')
    app.addHook('onRequest', async (req) => {
      const delay = chaosNumber('http.request', 'delay_ms', { route: req.url, key: req.id })
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    })

    // Outbox worker (#326/#335) + the notification redelivery handler.
    const { registerOutboxHandler } = await import('./services/outbox.js')
    const { notifyUser } = await import('./services/notification-channels.js')
    registerOutboxHandler('notification', async (payload) => {
      const p = payload as { userId?: string; opts?: Record<string, unknown> }
      if (!p.userId || !p.opts) return
      await notifyUser(app, p.userId, p.opts as never)
    })

    // Action-journal boot recovery (#327): chains still 'running' from a dead
    // process are REPORTED (actions are not idempotent — never auto-re-run).
    void (async () => {
      try {
        const stuck = (await db('nivaro_action_journal')
          .where({ status: 'running' })
          .where('started_at', '<', new Date(Date.now() - 5 * 60_000))
          .limit(20)) as Array<{
          id: number
          collection: string
          item: string
          transition_label: string | null
          actions_done: number
          actions_total: number
        }>
        for (const row of stuck) {
          await db('nivaro_action_journal')
            .where({ id: row.id })
            .update({ status: 'interrupted', finished_at: new Date() })
          const { trackError } = await import('./services/error-tracking.js')
          void trackError({
            source: 'server',
            route: 'action-journal',
            severity: 'high',
            message: `Transition action chain interrupted mid-run on ${row.collection}/${row.item} ("${row.transition_label ?? '?'}" — ${row.actions_done}/${row.actions_total} actions completed). Verify the record's integrations manually.`
          })
        }
      } catch {
        /* recovery is best-effort */
      }
    })()
  }

  // ─── Cron (self-hosted only) ───────────────────────────────────────────────
  // In cloud mode, background crons use the static DB (no request context).
  // Per-tenant cron scheduling is handled by the cloud provisioning system.
  await app.register(cronPlugin)
  // Schedule overrides hydrate BEFORE anything schedules (core crons below,
  // extensions in loadExtensions) so an admin override binds to every job no
  // matter which code registered it. Pauses hydrate later (checked per tick).
  try {
    const row = (await db('nivaro_settings').orderBy('id', 'asc').first('cron_overrides')) as
      | { cron_overrides?: string | null }
      | undefined
    if (row?.cron_overrides) {
      const parsed = JSON.parse(row.cron_overrides) as Record<
        string,
        { expression?: string; timezone?: string }
      >
      const map: Record<string, string> = {}
      const zones: Record<string, string> = {}
      for (const [id, v] of Object.entries(parsed ?? {})) {
        if (v?.expression) map[id] = String(v.expression)
        if (v?.timezone) zones[id] = String(v.timezone)
      }
      app.cron.setOverrides(map)
      app.cron.setTimezoneOverrides(zones)
    }
  } catch {
    /* column mid-migration or unparseable — no overrides */
  }
  // #831 — schedules are evaluated in the instance time zone (the same
  // nivaro_settings.sla_timezone every other "instance clock" reads, US
  // Eastern when blank), not the container's; hydrated before anything
  // schedules so no job is created on the wrong clock first.
  try {
    const row = (await db('nivaro_settings').orderBy('id', 'asc').first('sla_timezone')) as
      | { sla_timezone?: string | null }
      | undefined
    app.cron.setInstanceTimezone(row?.sla_timezone || 'America/New_York')
  } catch {
    app.cron.setInstanceTimezone('America/New_York')
  }
  // #54 — chains hydrate the same way: a chained job's own ticks are no-ops
  // and it runs right after its parent completes.
  try {
    const row = (await db('nivaro_settings').orderBy('id', 'asc').first('cron_chains')) as
      | { cron_chains?: string | null }
      | undefined
    if (row?.cron_chains) app.cron.setChains(JSON.parse(row.cron_chains) as Record<string, string>)
  } catch {
    /* column mid-migration or unparseable — no chains */
  }
  if (!process.env.CLOUD_META_DB_URL) {
    registerFileCleanup(app.cron)
    // digest-daily/weekly crons retired 2026-09-10 — the notification digest
    // rides the daily action summary (services/daily-digest.ts).
    registerQueueSnapshotCron(app.cron)
    registerStagedImportWorker(app)
  }

  // ─── Workspace context ────────────────────────────────────────────────────
  app.addHook('preHandler', resolveWorkspace)

  // ─── Dev-only response convention checker ─────────────────────────────────
  if (config.NODE_ENV === 'development') {
    const { registerResponseConventions } = await import('./plugins/response-conventions.js')
    registerResponseConventions(app)
  }

  // ─── Response compression (#2437): after every payload-reading onSend hook,
  // before the routes it should cover (route-level hook; see the plugin note).
  const { registerCompression } = await import('./plugins/compression.js')
  await registerCompression(app)

  // ─── Error tracking: 5xx → nivaro_issues (deduped, fire-and-forget) ───────
  const errorContextCounters = new Map<string, number>()
  const DETAIL_KEYS = [
    'rule',
    'field',
    'fields',
    'parents',
    'value',
    'target',
    'existing_id',
    'max',
    'current',
    'nested',
    'first',
    'scope',
    'keys',
    'meta',
    'missing',
    'current_hash'
  ] as const
  const refusalDetails = (err: object): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const k of DETAIL_KEYS) {
      const v = (err as Record<string, unknown>)[k]
      if (v !== undefined && typeof v !== 'function') out[k] = v
    }
    return out
  }
  app.setErrorHandler(
    (
      err: Error & {
        statusCode?: number
        code?: string
        violations?: unknown
        conflicts?: unknown
        latest_revision?: number
      },
      req,
      reply
    ) => {
      // A write the database refused over the caller's data (a link to a
      // record that does not exist, a duplicate) is a 4xx with a reason —
      // not a 500, not an issue, and never the database's own names.
      // No free connection within DB_ACQUIRE_TIMEOUT_MS: busy, not broken. A short
      // honest 503 the client may retry, not an issue and not a 60 s hang.
      if (err.statusCode == null && isPoolBusy(err)) {
        req.log.warn({ url: req.url }, 'request pool busy: no connection within the wait limit')
        return reply.code(503).header('Retry-After', '5').send({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'The server is busy right now. Please try again in a few seconds.',
          code: 'SERVER_BUSY'
        })
      }
      const refusal = err.statusCode == null ? describeDbRefusal(err) : null
      if (refusal) {
        req.log.info({ code: refusal.code, url: req.url }, refusal.message)
        return reply.code(refusal.status).send({
          statusCode: refusal.status,
          error: STATUS_CODES[refusal.status] ?? 'Error',
          message: refusal.message,
          code: refusal.code
        })
      }
      const status = err.statusCode ?? 500
      if (status >= 500 && req.url.startsWith('/api/')) {
        // #300 — every 5th 500 per route also captures a REDACTED request
        // sketch (query keys + body shape, never values) onto the issue, so a
        // recurring 500 carries a reproducible request without leaking data.
        const routeKey = `${req.method} ${req.routeOptions?.url ?? req.url}`
        const n = (errorContextCounters.get(routeKey) ?? 0) + 1
        errorContextCounters.set(routeKey, n)
        let requestContext: string | null = null
        if (n % 5 === 1) {
          const shape = (v: unknown, depth: number): unknown => {
            if (v === null || v === undefined) return null
            if (Array.isArray(v)) return depth > 2 ? '[…]' : [shape(v[0], depth + 1)]
            if (typeof v === 'object') {
              if (depth > 2) return '{…}'
              return Object.fromEntries(
                Object.entries(v as Record<string, unknown>)
                  .slice(0, 25)
                  .map(([k, val]) => [k, shape(val, depth + 1)])
              )
            }
            return typeof v
          }
          try {
            requestContext = JSON.stringify({
              url: req.url.slice(0, 300),
              query_keys: Object.keys((req.query as Record<string, unknown>) ?? {}),
              body_shape: shape(req.body, 0)
            })
          } catch {
            requestContext = null
          }
        }
        trackError({
          source: 'server',
          route: routeKey,
          message: errorText(err, 400),
          stack: err.stack,
          userId: req.user?.id ?? null,
          requestContext
        }).catch(() => {})
      }
      logRouteError(req.log, err, status, req.url)
      // LIST_TIMEOUT is ours, not a driver code: clients show "took too long, Retry" on it.
      const coded =
        !!err.code &&
        /^[A-Z][A-Z0-9_]+$/.test(err.code) &&
        (status < 500 || err.code === 'LIST_TIMEOUT')
      reply.code(status).send({
        statusCode: status,
        error: STATUS_CODES[status] ?? 'Error',
        // A server fault's driver message carries the statement (tables,
        // columns); the body gets the reason only — the log keeps the rest.
        message: status >= 500 ? messageWithoutSql(err) : err.message,
        // A refusal's machine code rides every 4xx; driver codes on a 5xx stay in the log.
        ...(coded ? { code: err.code } : {}),
        ...(err.code && err.violations ? { code: err.code, violations: err.violations } : {}),
        ...(err.code === 'MIDAIR_COLLISION'
          ? { code: err.code, conflicts: err.conflicts, latest_revision: err.latest_revision }
          : {}),
        // The details a coded refusal carries (which rule, which field, the
        // record in the way) — a fixed set, never the error's whole shape.
        ...(coded ? refusalDetails(err) : {})
      })
    }
  )

  // Mission-control pulse — activity broadcasts need the io instance
  setPulseApp(app)

  // ─── Routes ───────────────────────────────────────────────────────────────
  await app.register(presencePublicRoutes, { prefix: '/api/presence' })
  await bootPhase('Routes', async () => {
    await app.register(registerRoutes, { prefix: '/api' })
  })
  await app.register(graphqlPlugin, { prefix: '/api' })
  await app.register(legacyCompatRoutes)
  await app.register(formRendererRoutes)
  await app.register(sharePublicRoutes)
  // OAuth for remote MCP clients — well-known documents must sit at the origin root.
  await app.register(oauthPublicRoutes)
  await app.register(statusPublicRoutes)
  // Routes registered from here on (extensions) keep the large body ceiling.
  coreRoutes = false

  // ─── Serve admin static build (release image) ────────────────────────────
  const adminBuildPath = join(import.meta.dirname, '../../admin/dist')
  if (existsSync(adminBuildPath)) {
    // #2440 — 103 Early Hints + Link for the entry script, stylesheet and fonts (EARLY_HINTS)
    const earlyHints = loadEarlyHints(adminBuildPath)
    if (earlyHints.length) {
      app.addHook('onRequest', async (req, reply) => {
        const path = req.url.split('?')[0]
        if (path === '/' || path === '/index.html') applyEarlyHints(req, reply, earlyHints)
      })
    }
    await app.register(fastifyStatic, {
      root: adminBuildPath,
      prefix: '/',
      // scripts/precompress-dist.mjs writes .br/.gz beside each asset at build
      preCompressed: true,
      // Source maps never leave the server unless ADMIN_SOURCEMAPS=public — checked on the
      // path @fastify/static is about to resolve, whatever encoding the URL used.
      allowedPath: (pathName) => sourceMapsPublic() || !isSourceMapPath(pathName),
      // Cache-Control is ours (#2438): vite's hashed files under /assets never change, so a
      // browser keeps them a year without asking; everything else (index.html, the service
      // worker, icons) is revalidated on every load so a release is picked up at once.
      cacheControl: false,
      // @fastify/static 9 passes the raw ServerResponse; 10 passes a reply-like object with
      // `header` — support both so the major bump cannot break static serving.
      setHeaders: (res, path) => {
        const out = res as unknown as {
          header?: (k: string, v: string) => unknown
          setHeader?: (k: string, v: string) => unknown
        }
        const set = (k: string, v: string) =>
          typeof out.header === 'function' ? out.header(k, v) : out.setHeader?.(k, v)
        // a cache must key the .br/.gz/raw variants apart
        set('Vary', 'Accept-Encoding')
        set('Cache-Control', adminAssetCacheControl(path))
      }
    })
    // Source maps are built 'hidden' (no sourceMappingURL) and never served unless
    // ADMIN_SOURCEMAPS=public — they would hand anyone the admin's full source.
    if (!sourceMapsPublic()) {
      app.addHook('onRequest', async (req, reply) => {
        const path = req.url.split('?')[0] ?? ''
        if (!path.startsWith('/api/') && isSourceMapPath(path)) {
          return reply.code(404).send({ error: 'Not found' })
        }
      })
    }
    app.setNotFoundHandler((req, reply) => {
      // Segment-exact prefix match: '/api/...' is an API miss, but the admin
      // SPA routes /api-analytics, /api-keys and /api-docs also START WITH
      // '/api' — a bare startsWith('/api') served them a JSON 404 on hard
      // reload instead of the app (seen live on /api-analytics).
      if (/^\/api([/?]|$)/.test(req.url) || req.url.startsWith('/socket.io')) {
        return reply.code(404).send({ error: 'Not found' })
      }
      applyEarlyHints(req, reply, earlyHints)
      reply.sendFile('index.html')
    })
  }

  // ─── Extensions + Scheduled flows (self-hosted only) ────────────────────
  // These query the static DB at startup — skipped in cloud mode.
  if (!process.env.CLOUD_META_DB_URL) {
    setApp(app)
    // Core email types must exist before extensions add theirs.
    const { registerCoreMailTypes } = await import('./services/mail-types.js')
    registerCoreMailTypes()
    // Core integration signals (spec 2026-09-23 §3.1) must exist before an
    // extension's own registerIntegrationSignal calls run.
    {
      const { registerCoreIntegrationSignals } = await import(
        './services/integration-signals-core.js'
      )
      registerCoreIntegrationSignals()
    }
    const { connectionHandlerCount, refuseExtensionSocketHandlers } = await import(
      './services/process-role.js'
    )
    const coreSocketHandlers = connectionHandlerCount(app.io as never)
    await bootPhase('Extensions', () =>
      loadExtensions({
        app,
        database: db,
        logger: app.log,
        callExternalApi
      })
    )
    // Post-mortem 3.3 — with SOCKETS=off an extension's socket handler would never run.
    refuseExtensionSocketHandlers(coreSocketHandlers, connectionHandlerCount(app.io as never))
    await bootPhase('Scheduled flows', () => loadScheduledFlows(app))
    // #530 — fingerprint what each extension registered this boot; a changed
    // ledger becomes a new version so "when did this check appear?" has an answer.
    void (async () => {
      const { extensionRegistry, describeExtensionRegistry } = await import(
        './extensions/loader.js'
      )
      const { recordRegistryVersion } = await import('./services/extension-registry-versions.js')
      for (const id of extensionRegistry.keys()) {
        const desc = await describeExtensionRegistry(id, app.cron).catch(() => null)
        if (!desc) continue
        const r = await recordRegistryVersion(id, desc)
        if (r?.changed)
          app.log.info(
            { extension: id, version: r.version },
            '[extension-registry] new registry version'
          )
      }
    })().catch((err) => app.log.warn({ err }, '[extension-registry] versioning failed'))
  }

  // ─── Cloud extensions ─────────────────────────────────────────────────────
  // Loaded AFTER the cron plugin so ctx.app.cron is available.
  if (process.env.CLOUD_META_DB_URL) {
    setApp(app)
    await loadCloudExtensions({
      app,
      database: db,
      logger: app.log,
      callExternalApi,
      cloud: {
        getTenantId,
        getTenantSlug,
        metaDb: getMetaDb()
      }
    })
  }

  // #2445 — the delayed boot cache warm (set in the onReady block below);
  // cleared on close so a short-lived process never starts it.
  let cacheWarmTimer: ReturnType<typeof setTimeout> | null = null
  let readinessWarmTimer: ReturnType<typeof setTimeout> | null = null
  app.addHook('onClose', async () => {
    if (cacheWarmTimer) clearTimeout(cacheWarmTimer)
    cacheWarmTimer = null
    if (readinessWarmTimer) clearTimeout(readinessWarmTimer)
    readinessWarmTimer = null
  })

  // ─── Daily retention purge (self-hosted only) ─────────────────────────────
  // In cloud mode, retention runs per-tenant via the provisioning system.
  if (!process.env.CLOUD_META_DB_URL)
    app.addHook('onReady', async () => {
      // Admin links (replay button, task/approval notifications, record_url
      // fallbacks) all resolve through adminBaseUrl(). When that answer IS the
      // registered portal, every such link lands on the headless frontend's
      // router instead of the admin page — say so once at boot, since no env
      // rule can tell a genuine admin host from a mis-pointed ADMIN_URL.
      void import('./services/app-links.js')
        .then(async ({ portalRegistration }) => {
          const { adminBaseUrl } = await import('./admin-base.js')
          const portal = (await portalRegistration())?.base?.replace(/\/$/, '')
          const admin = adminBaseUrl()
          if (portal && admin && portal === admin)
            app.log.warn(
              { admin_url: admin, portal_url: portal },
              'adminBaseUrl() resolves to the registered portal — set ADMIN_URL to the host that serves the admin build or admin links will open the portal'
            )
        })
        .catch(() => {})

      async function runRetentionPurge() {
        try {
          {
            const { pruneJobRuns } = await import('./services/job-runs.js')
            await pruneJobRuns().catch(() => {})
          }

          const row = await db('nivaro_settings')
            .first('activity_retention_days', 'revision_retention_count')
            .catch(() => null)

          // Per-collection retention overrides (#257): a collection with its own
          // activity_retention_days purges on ITS schedule; the global setting
          // covers the rest. Overridden collections are excluded from the
          // global pass so a longer override actually keeps rows longer.
          const overrides = (await db('nivaro_collections')
            .whereNotNull('activity_retention_days')
            .select('collection', 'activity_retention_days')
            .catch(() => [])) as Array<{ collection: string; activity_retention_days: number }>
          for (const o of overrides) {
            const cutoff = new Date(Date.now() - o.activity_retention_days * 86_400_000)
            await db('nivaro_activity')
              .where('collection', o.collection)
              .where('timestamp', '<', cutoff)
              .whereNull('legacy_id')
              .delete()
              .catch(() => {})
          }
          if (row?.activity_retention_days) {
            const cutoff = new Date(Date.now() - row.activity_retention_days * 86_400_000)
            // Imported legacy history (legacy_id NOT NULL) is permanent — retention applies to organic rows only.
            const q = db('nivaro_activity').where('timestamp', '<', cutoff).whereNull('legacy_id')
            if (overrides.length > 0)
              q.whereNotIn(
                'collection',
                overrides.map((o) => o.collection)
              )
            await q.delete()
          }

          if (row?.revision_retention_count) {
            const n = row.revision_retention_count as number
            // Imported legacy history (legacy_id NOT NULL) is permanent — retention applies to organic rows only.
            const pairs = await (db('nivaro_revisions')
              .select('collection', 'item')
              .whereNull('legacy_id')
              .count({ cnt: '*' })
              .groupBy('collection', 'item')
              .havingRaw('COUNT(*) > ?', [n]) as unknown as Promise<
              Array<{ collection: string; item: string; cnt: string | number }>
            >)
            for (const pair of pairs) {
              const keep = await db('nivaro_revisions')
                .where({ collection: pair.collection, item: pair.item })
                .whereNull('legacy_id')
                .orderBy('id', 'desc')
                .limit(n)
                .pluck('id')
              if (keep.length) {
                await db('nivaro_revisions')
                  .where({ collection: pair.collection, item: pair.item })
                  .whereNull('legacy_id')
                  .whereNotIn('id', keep)
                  .delete()
              }
            }
          }
          await purgeExpiredTrash()
          await purgeExpiredRecordings().catch(() => {})
          await import('./services/help-video-uploads.js')
            .then((m) => m.purgeStaleUploads())
            .catch(() => 0)
          await import('./services/help-video-render.js')
            .then((m) => m.pruneOldRenders())
            .catch(() => 0)
          await import('./services/help-video-package.js')
            .then((m) => m.purgeStaleImports())
            .catch(() => 0)
          // #528 — ERP push payloads/responses past the configured window lose their bytes, never their history.
          await import('./services/erp-retention.js')
            .then((m) => m.pruneErpSubmissionPayloads())
            .then((r) => {
              if (r.blanked)
                app.log.info(
                  { blanked: r.blanked, days: r.days, more: r.more },
                  '[retention] erp submission payloads blanked'
                )
            })
            .catch((err) => app.log.warn({ err }, '[retention] erp payload prune failed'))
          // Landed integration obligations (sent/superseded) are history after
          // 180 days; failed/missing/overdue/pending never expire.
          await import('./services/integration-obligations.js')
            .then((m) => m.pruneObligations())
            .then((n) => {
              if (n) app.log.info({ pruned: n }, '[retention] integration obligations pruned')
            })
            .catch((err) =>
              app.log.warn({ err }, '[retention] integration obligations prune failed')
            )
          await pruneAiCalls().catch(() => 0)
          // #1833 — Ask AI conversations past ai_conversation_retention_days (pinned kept).
          await import('./services/ai-conversations.js')
            .then((m) => m.pruneConversations())
            .catch(() => 0)
          // Edited/deleted chat message history past chat_history_retention_days.
          await import('./services/chat-send.js')
            .then((m) => m.pruneChatMessageHistory())
            .catch(() => 0)
          await db('nivaro_admin_journeys')
            .where('entered_at', '<', new Date(Date.now() - 30 * 86_400_000))
            .del()
            .catch(() => 0)
        } catch (err) {
          app.log.warn({ err }, '[retention] purge failed')
        }
        setTimeout(runRetentionPurge, 24 * 60 * 60 * 1000)
      }
      runRetentionPurge()

      // ── Schedules that live in rows: retention policies, scheduled reports ──
      // Registered here at boot and again whenever a row changes (the routes
      // and the schedules epoch call the same reconcile).
      void import('./services/row-schedules.js').then(async (m) => {
        await m.resyncSchedules(app, 'retention')
        await m.resyncSchedules(app, 'scheduled-reports')
      })

      // ── Report Studio — hourly alert checks + daily/weekly subscription mail ──
      // Auto-transition sweep: date-based transition conditions (within_days etc.)
      // can become true purely by time passing — re-evaluate hourly.
      // SLA escalation ladders: tiered, ack-aware breach escalation.
      app.cron.schedule('sla-escalations', '*/30 * * * *', async () => {
        const { runSlaEscalations } = await import('./services/sla-escalations.js')
        await runSlaEscalations(app)
      })

      // Cumulative flow (#2758): a year of daily state counts per pipeline
      // template + collection, so long ranges read a stored series.
      app.cron.schedule(
        'cumulative-flow-rollup',
        '50 3 * * *',
        async () => {
          const { runCfdRollup } = await import('./services/cumulative-flow.js')
          await runCfdRollup(app.redis)
        },
        {
          description:
            'Stores a year of daily records-per-state counts for the cumulative flow diagram.'
        }
      )

      // Help videos: pick up queued renders after a restart and re-queue any
      // that died mid-render. Request-driven kicks handle the normal case.
      app.cron.schedule('help-video-render-sweep', '*/5 * * * *', async () => {
        const { sweepRenders } = await import('./services/help-video-render.js')
        await sweepRenders()
        // Clips (#1562) whose process died mid-cut are failed so the author
        // can make them again.
        const { failStaleClips } = await import('./services/help-video-clips.js')
        await failStaleClips().catch(() => 0)
      })
      // Help videos: "watched next" (#1530) — which video people in a role
      // started after each one, recomputed nightly from the view rows. The
      // scheduler records every tick as a job run (Background Jobs).
      app.cron.schedule('help-video-next', '20 3 * * *', async () => {
        const { computeNextTable } = await import('./services/help-video-next.js')
        await computeNextTable()
      })
      // Log alert rules over the request log (#1960): count each rule's
      // filter inside its window, across replicas, and raise an issue past
      // the threshold (outside the cooldown).
      app.cron.schedule(
        'log-alert-requests',
        '*/5 * * * *',
        async () => {
          const { evaluateRequestRules } = await import('./services/log-alert-requests.js')
          await evaluateRequestRules()
        },
        {
          idempotent: 'safe',
          description:
            'Checks the log alert rules saved from "Ask the logs": counts the matching API requests in each rule\'s window and raises an issue when one passes its threshold (once per cooldown).'
        }
      )
      // Incident threads (#2016): critical issues open a thread in the ops
      // channel; open threads get new errors / recoveries; quiet alert
      // threads close with a summary.
      app.cron.schedule(
        'ops-incident-updates',
        '*/2 * * * *',
        async () => {
          const { runIncidentUpdates } = await import('./services/ops-incidents.js')
          await runIncidentUpdates(app)
        },
        {
          idempotent: 'unsafe',
          description:
            'Posts incident-thread updates in the ops chat channel: opens a thread for a new critical issue, reports new errors and recoveries under open threads, and closes alert threads after 30 quiet minutes.'
        }
      )
      // Traffic Map chores (#2173/#2177): a snapshot just after each day's busiest minute, one
      // every N hours when an admin set a schedule, and pruning of snapshots / notebooks by the
      // retention settings. Self-hosted only; reads the map's own in-memory peak.
      app.cron.schedule(
        'traffic-map-snapshots',
        '*/5 * * * *',
        async () => {
          const { runSnapshotSchedule } = await import('./services/traffic-snapshot-schedule.js')
          const r = await runSnapshotSchedule()
          if (r.peak || r.schedule) app.log.info({ run: r }, '[traffic-map-snapshots] captured')
        },
        {
          idempotent: 'safe',
          description:
            "Every 5 minutes — takes a Traffic Map snapshot just after the day's busiest minute (and every N hours when a schedule is set on the map), then removes snapshots, scheduled snapshots and investigation notebooks older than the retention set on the map. Self-hosted only."
        }
      )
      // Session replay heatmaps (#1364): fold settled recordings into
      // per-route click / scroll aggregates (no person in them). Bounded per
      // run with a high-water mark, so a backlog drains over several nights.
      app.cron.schedule(
        'session-replay-heat',
        '5 2 * * *',
        async () => {
          const { runHeatFold } = await import('./services/session-replay-heat.js')
          app.log.info({ summary: await runHeatFold() }, '[session-replay-heat] fold')
        },
        {
          heavy: true,
          idempotent: 'safe',
          timezone: 'UTC',
          description:
            'Folds finished session recordings into per-route click and scroll heatmaps (aggregates only — no person, recording or session is kept with them).'
        }
      )
      // Frustration score (#1388): score each journey session of the last two
      // UTC days from rage / dead clicks, client errors, back-and-forth loops,
      // slow calls and abandoned forms. Weights: settings.frustration_weights.
      app.cron.schedule(
        'session-frustration',
        '25 2 * * *',
        async () => {
          const { runFrustrationScoring } = await import('./services/session-frustration.js')
          app.log.info({ summary: await runFrustrationScoring() }, '[session-frustration] scored')
        },
        {
          idempotent: 'safe',
          timezone: 'UTC',
          description:
            'Scores each working session of the last two days for frustration (rage and dead clicks, client errors, back-and-forth loops, slow calls, abandoned forms) for the Worst sessions tab and the People Day view.'
        }
      )
      // Every process clears its own stale render scratch; only a process
      // that owns the render queue (ticks crons or VIDEO_RENDER=on) drains it.
      void import('./services/help-video-render.js')
        .then((m) => {
          void m.cleanRenderScratch()
          m.kickRenderer()
        })
        .catch(() => {})

      // Config health: nightly usage-hygiene + schema-lint sweep.
      // Help videos (#1495): flag published videos whose screen changed since
      // they were published (a layout version, a renamed or removed pipeline
      // step, a click label gone from the page). One notification per flag.
      app.cron.schedule('help-video-stale-check', '30 3 * * *', async () => {
        const { withJobRun } = await import('./services/job-runs.js')
        await withJobRun(
          'cron',
          'help-video-stale-check',
          { label: 'Help videos: may be out of date' },
          async () => {
            const { runStaleCheck } = await import('./services/help-video-stale.js')
            return runStaleCheck()
          }
        )
      })
      // Help videos (#1531): retention removes superseded versions' files
      // after help_video_settings.retention_days (null = keep everything).
      app.cron.schedule('help-video-storage-sweep', '40 3 * * *', async () => {
        const { withJobRun } = await import('./services/job-runs.js')
        await withJobRun(
          'cron',
          'help-video-storage-sweep',
          { label: 'Help videos: storage sweep' },
          async () => {
            const { runStorageSweep } = await import('./services/help-video-storage.js')
            return (await runStorageSweep()).summary
          }
        )
      })

      app.cron.schedule('config-health-sweep', '10 3 * * *', async () => {
        const { runConfigHealthSweep } = await import('./services/config-health.js')
        await runConfigHealthSweep()
      })

      // Form usage per layout (#2597/#2598): keep 180 days.
      app.cron.schedule(
        'layout-usage-prune',
        '25 3 * * *',
        async () => {
          const { pruneLayoutUsage } = await import('./services/layout-usage.js')
          await pruneLayoutUsage()
        },
        { description: 'Deletes form usage counts (per layout and day) older than 180 days.' }
      )

      // Review reminders (#2718): owners of forms left unchanged for their set months.
      app.cron.schedule(
        'layout-review-reminders',
        '30 7 * * 1-5',
        async () => {
          const { withJobRun } = await import('./services/job-runs.js')
          await withJobRun(
            'cron',
            'layout-review-reminders',
            { label: 'Forms: review reminders' },
            async () => {
              const { runReviewReminders } = await import('./services/layout-review.js')
              return runReviewReminders(app)
            }
          )
        },
        {
          description:
            'Reminds the owner of each form that has not changed for its set number of months (default 6) to review it, with its health score and last 30 days of use.'
        }
      )

      // Config review (#1913/#2020/#1999): monthly report of configuration
      // problems, cleanup suggestions and label inconsistencies, with the
      // model re-wording reasons when AI is configured; admins are told.
      app.cron.schedule('config-review-monthly', '20 4 1 * *', async () => {
        const { runMonthlyConfigReview } = await import('./services/config-review/index.js')
        await runMonthlyConfigReview()
      })

      // Idle MCP connections (#2497): flag OAuth connections unused for 60 days to their
      // owner, warn 7 days before 90, then disconnect (services/mcp-idle-review.ts).
      app.cron.schedule(
        'mcp-idle-review',
        '15 5 * * *',
        async () => {
          const { runIdleReview } = await import('./services/mcp-idle-review.js')
          await runIdleReview(app)
        },
        {
          idempotent: 'safe',
          description:
            'Tells people about connected AI apps they have not used for a while, and disconnects ones left unused past the limit after a seven-day notice.'
        }
      )

      // Extension event outbox (#504): deliver pending rows to registered
      // handlers each minute; backoff/dead-letter semantics in the service.
      app.cron.schedule('extension-events-sweep', '* * * * *', async () => {
        const { deliverPendingExtensionEvents } = await import('./services/extension-events.js')
        await deliverPendingExtensionEvents()
      })

      // Ask AI plans scheduled to run later (#1903): each minute, run the due
      // ones (or send them back for approval when their records changed).
      app.cron.schedule(
        'ai-plans-scheduled',
        '* * * * *',
        async () => {
          await import('./services/ai-plan-integrity.js')
          const { runDuePlans } = await import('./services/ai-plan-schedule.js')
          await runDuePlans()
        },
        {
          quiet: true,
          idempotent: 'safe',
          description:
            'Runs Ask AI plans that were approved to run at a set time; re-checks each step first and holds the plan for approval again when its records changed.'
        }
      )

      // Scheduled layout changes (#2590): each minute, apply the due ones
      // through the layout ops service (or fail them and tell who scheduled).
      app.cron.schedule(
        'layout-schedules',
        '* * * * *',
        async () => {
          const { runDueSchedules } = await import('./services/layout-schedules.js')
          await runDueSchedules()
        },
        {
          quiet: true,
          idempotent: 'safe',
          description:
            'Applies layout changes an admin scheduled in the layout editor; a change that no longer fits the layout is not applied and its scheduler is told.'
        }
      )

      // Ops monitors: freshness / deploy-regression / synthetic checks.
      app.cron.schedule('ops-monitors', '*/5 * * * *', async () => {
        // #365 — alert engines pause during maintenance: a planned freeze must
        // not fire threshold/anomaly noise about itself.
        {
          const { maintenanceState } = await import('./services/security.js')
          if ((await maintenanceState()).on) return
        }
        const { evaluateAllMonitors } = await import('./services/ops-monitors.js')
        await evaluateAllMonitors(app)
      })

      // Hourly at :45 — each user gets theirs at their chosen hour (#75);
      // preferences.digest_hour in America/New_York, default 7 (the historic
      // 07:45 send). A manual run (no hour arg) sends to everyone due.
      app.cron.schedule('daily-action-digest', '45 * * * *', async () => {
        const { runDailyActionDigest } = await import('./services/daily-digest.js')
        const etHour = Number(
          new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            hour12: false
          }).format(new Date())
        )
        await runDailyActionDigest(etHour % 24)
      })

      // Channel fallback chain: unread rows climb push → email on the
      // recipient's own per-category schedule; stops when read.
      app.cron.schedule('notification-escalation', '*/5 * * * *', async () => {
        const { runNotificationEscalation } = await import('./services/notification-escalation.js')
        await runNotificationEscalation(app)
      })

      app.cron.schedule('workflow-auto-sweep', '30 * * * *', async () => {
        const { sweepAutoTransitions } = await import('./services/workflow-transitions.js')
        await sweepAutoTransitions()
      })

      // Saved-view subscription digests — "what entered my filtered view".
      // Set-diff per subscription, run as the subscriber; see
      // services/view-subscriptions.ts. 07:35 lands before the 07:45 action digest.
      app.cron.schedule('view-subscriptions-daily', '35 7 * * *', async () => {
        const { runViewSubscriptionDigests } = await import('./services/view-subscriptions.js')
        await runViewSubscriptionDigests('daily', app)
      })
      app.cron.schedule('view-subscriptions-weekly', '35 7 * * 1', async () => {
        const { runViewSubscriptionDigests } = await import('./services/view-subscriptions.js')
        await runViewSubscriptionDigests('weekly', app)
      })

      // Dangling-FK sweep — the relations sibling of rollup drift: business
      // rows whose FK points at a deleted/never-existed parent (blank labels,
      // drill 404s). See services/fk-integrity.ts.
      // Manual: POST /api/cron/fk-integrity-sweep/run.
      // Scheduled out-of-office — flips is_out_of_office ON while inside a
      // user's ooo_start..ooo_end window and OFF (clearing the window) once it
      // passes. Manual toggles carry no window and are never auto-cleared.
      app.cron.schedule('ooo-schedule', '*/15 * * * *', async () => {
        const { db } = await import('./db/index.js')
        const now = new Date()
        const entering = (await db('nivaro_users')
          .where('is_out_of_office', false)
          .whereNotNull('ooo_start')
          .whereNotNull('ooo_end')
          .where('ooo_start', '<=', now)
          .where('ooo_end', '>', now)
          .select('id')) as Array<{ id: string }>
        if (entering.length > 0) {
          await db('nivaro_users')
            .whereIn(
              'id',
              entering.map((u) => u.id)
            )
            .update({ is_out_of_office: true })
          // Their open tasks move to the delegate (#70) — best-effort.
          const { delegateOpenTasks } = await import('./services/task-delegation.js')
          for (const u of entering) await delegateOpenTasks(u.id, app)
        }
        await db('nivaro_users')
          .where('is_out_of_office', true)
          .whereNotNull('ooo_end')
          .where('ooo_end', '<=', now)
          .update({ is_out_of_office: false, ooo_start: null, ooo_end: null })
      })

      // Instant queue-entry notifications (#121/#379): */5 diff pass over
      // instant queue subscriptions.
      app.cron.schedule('queue-entry-notify', '*/5 * * * *', async () => {
        const { runQueueEntryNotifyPass } = await import('./services/queue-entry-notify.js')
        await runQueueEntryNotifyPass(app)
      })

      // A materialized worklist with no cache rows (a database restored or
      // promoted without its regenerated tables) reads empty: rebuild it.
      app.cron.schedule('queue-cache-heal', '*/15 * * * *', async () => {
        const { healEmptyMaterializedQueues } = await import('./services/queue-owner-refresh.js')
        await healEmptyMaterializedQueues()
      })

      // Outbox worker (#326/#335): deliver pending rows every minute.
      app.cron.schedule('outbox-worker', '* * * * *', async () => {
        const { runOutboxPass } = await import('./services/outbox.js')
        await runOutboxPass()
      })

      // Concurrency sampling (#275): sockets + distinct users every 5 min,
      // per instance (multi-replica charts sum by timestamp).
      app.cron.schedule('concurrency-sample', '*/5 * * * *', async () => {
        const { db } = await import('./db/index.js')
        const { getLocalConcurrency } = await import('./plugins/socketio.js')
        // Post-mortem 3.3 — with SOCKETS=off the figures are the realtime processes' (the
        // board); a board nobody refreshed lately would record a false zero, so skip the sample.
        const { boardFresh, boardReaderOn } = await import('./services/realtime-board.js')
        if (boardReaderOn() && !boardFresh()) return
        const { sockets, users } = getLocalConcurrency()
        await db('nivaro_concurrency_samples')
          .insert({
            sampled_at: new Date(),
            instance: process.env.HOSTNAME?.slice(0, 100) ?? null,
            sockets,
            users
          })
          .catch(() => {})
        // 90-day retention, pruned opportunistically on a daily-ish cadence.
        if (new Date().getHours() === 4 && new Date().getMinutes() < 5) {
          await db('nivaro_concurrency_samples')
            .where('sampled_at', '<', new Date(Date.now() - 90 * 86_400_000))
            .del()
            .catch(() => {})
        }
      })

      // Scheduled broadcasts (#94): deliver every due scheduled announcement.
      app.cron.schedule('scheduled-broadcasts', '* * * * *', async () => {
        const { deliverScheduledAnnouncements } = await import('./routes/announcements.js')
        await deliverScheduledAnnouncements(app)
      })

      // Maintenance windows (#214/#303): per-minute sweep flips maintenance
      // mode at window boundaries; the exit smoke-checks and sends the
      // verified all-clear.
      app.cron.schedule(
        'maintenance-windows',
        '* * * * *',
        async () => {
          const { sweepMaintenanceWindows } = await import('./services/maintenance-windows.js')
          await sweepMaintenanceWindows(app)
        },
        // The one job that must tick DURING a freeze — it is what ends a window.
        { duringMaintenance: true }
      )

      // Post-deploy smoke (#299): a version change gets one health verdict at
      // minute one instead of waiting for the first user report.
      setTimeout(() => {
        void import('./services/maintenance-windows.js').then(({ postDeploySmoke }) =>
          postDeploySmoke(app)
        )
      }, 60_000)

      // Session replay storage tiering (#1411): recordings older than
      // replay_cold_after_days move to the storage driver as one object each;
      // rehydrated recordings' 24-hour hot cache is dropped again.
      app.cron.schedule(
        'session-replay-tiering',
        '25 * * * *',
        async () => {
          const { runReplayTiering } = await import('./services/session-replay-storage.js')
          const r = await runReplayTiering()
          if (r.moved || r.evicted || r.failed) app.log.info(`session-replay-tiering: ${r.summary}`)
        },
        {
          idempotent: 'safe',
          heavy: true,
          description:
            'Hourly at :25 — moves session recordings older than replay_cold_after_days (default 3) to the file storage driver as one gzipped object each, marks them cold and deletes their event rows; drops the event rows of cold recordings rehydrated more than 24 hours ago (the object stays). A recording whose upload fails stays hot and is retried next hour.'
        }
      )

      // Storage snapshots (#291/#155): one row per day of DB + uploads size,
      // feeding the runway projection on /db-health.
      app.cron.schedule('storage-snapshot', '45 3 * * *', async () => {
        const { db } = await import('./db/index.js')
        const today = new Date().toISOString().slice(0, 10)
        const exists = await db('nivaro_storage_snapshots')
          .where({ snapshot_date: today })
          .first('id')
          .catch(() => null)
        if (exists) return
        let dbMb: number | null = null
        let topTables: unknown[] = []
        try {
          const size = (await db.raw(`
            SELECT SUM(CAST(FILEPROPERTY(name, 'SpaceUsed') AS bigint)) * 8 / 1024 AS used_mb
            FROM sys.database_files WHERE type = 0
          `)) as Array<{ used_mb: number }>
          dbMb = Number(size[0]?.used_mb) || null
          topTables = (await db.raw(`
            SELECT TOP 20 OBJECT_NAME(object_id) AS table_name,
                   SUM(row_count) AS row_count, SUM(used_page_count) * 8 / 1024 AS mb
            FROM sys.dm_db_partition_stats
            WHERE OBJECTPROPERTY(object_id, 'IsUserTable') = 1
            GROUP BY object_id ORDER BY SUM(used_page_count) DESC
          `)) as unknown[]
        } catch {
          /* no VIEW SERVER STATE — snapshot rows stay null-sized */
        }
        let uploadsMb: number | null = null
        try {
          const { readdir, stat } = await import('node:fs/promises')
          const { join } = await import('node:path')
          const dir = process.env.UPLOAD_DIR || './uploads'
          let total = 0
          const walk = async (d: string, depth: number): Promise<void> => {
            if (depth > 4) return
            for (const e of await readdir(d, { withFileTypes: true })) {
              const p = join(d, e.name)
              if (e.isDirectory()) await walk(p, depth + 1)
              else total += (await stat(p)).size
            }
          }
          await walk(dir, 0)
          uploadsMb = Math.round(total / 1_048_576)
        } catch {
          /* uploads dir absent */
        }
        // #1368 / #1411 — session recordings' stored size (database and
        // storage driver), for the runway.
        const replay = await import('./services/session-replay-cost.js')
          .then((m) => m.replayStorageFigures())
          .catch(() => null)
        await db('nivaro_storage_snapshots')
          .insert({
            snapshot_date: today,
            db_mb: dbMb,
            uploads_mb: uploadsMb,
            top_tables: JSON.stringify(topTables),
            ...(replay
              ? {
                  replay_mb: Math.round(replay.hot_bytes / 1_048_576),
                  replay_cold_mb: Math.round(replay.cold_bytes / 1_048_576)
                }
              : {}),
            created_at: new Date()
          })
          .catch(() => {})
      })

      // Deadlock reporter (#100): hourly sweep of the system_health ring
      // buffer — a fresh deadlock raises ONE deduped issue naming the victim.
      app.cron.schedule('deadlock-sweep', '35 * * * *', async () => {
        const { db } = await import('./db/index.js')
        const { trackError } = await import('./services/error-tracking.js')
        try {
          const rows = (await db.raw(`
            SELECT TOP 3 xed.value('@timestamp', 'datetime2') AS occurred_at,
                   xed.query('.') AS graph
            FROM (
              SELECT CAST(target_data AS XML) AS target_data
              FROM sys.dm_xe_session_targets st
              JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
              WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer'
            ) AS tab
            CROSS APPLY target_data.nodes('RingBufferTarget/event[@name="xml_deadlock_report"]') AS q(xed)
            ORDER BY occurred_at DESC
          `)) as Array<{ occurred_at: Date; graph: string }>
          const fresh = rows.filter(
            (r) => Date.now() - new Date(r.occurred_at).getTime() < 65 * 60_000
          )
          for (const r of fresh) {
            const xml = String(r.graph ?? '')
            const stmt = xml
              .match(/<inputbuf>([\s\S]*?)<\/inputbuf>/)?.[1]
              ?.trim()
              .slice(0, 200)
            await trackError({
              source: 'server',
              route: 'deadlock-sweep',
              severity: 'high',
              message: `SQL deadlock at ${new Date(r.occurred_at).toISOString()}${stmt ? ` — victim statement: ${stmt}` : ''}`,
              stack: xml.slice(0, 8000)
            })
          }
        } catch {
          /* no VIEW SERVER STATE — sweep silently inert */
        }
      })

      // Pool monitor (#114 / #493): saturation reads as "randomly slow"
      // everywhere else. Judged over the last five minutes of acquire waits
      // and pool samples, not a point read that lands between bursts.
      app.cron.schedule('pool-monitor', '*/5 * * * *', async () => {
        const { poolPressure } = await import('./services/pool-attribution.js')
        const { trackError } = await import('./services/error-tracking.js')
        const p = poolPressure()
        if (p.acquires >= 50 && (p.wait_p95_ms >= 500 || p.saturated_pct >= 25)) {
          await trackError({
            source: 'server',
            route: 'pool-monitor',
            severity: 'high',
            message: `DB connection pool under pressure: p95 acquire wait ${p.wait_p95_ms}ms, every connection busy ${p.saturated_pct}% of the last ${p.window_s}s (peak ${p.peak_used}/${p.max} in use, ${p.peak_pending} waiting)`
          })
        }
      })

      // ERP auto-retry (#469): failed pushes on APIs with a retry_policy
      // retry on a backoff schedule instead of waiting for a human.
      app.cron.schedule('erp-auto-retry', '*/10 * * * *', async () => {
        const { runErpAutoRetries } = await import('./routes/erp-submissions.js')
        await runErpAutoRetries()
      })

      // Scheduled DQ runs (#170): every collection's active quality rules,
      // nightly — the runs table becomes a pass-rate trend for free.
      app.cron.schedule('dq-nightly', '50 3 * * *', async () => {
        const { runAllDqRules } = await import('./routes/data-quality.js')
        await runAllDqRules()
      })

      // Subscription integrity (#367): weekly — per-record subscriptions
      // pointing at deleted records, and view subscriptions whose saved view
      // is gone, deactivate with one summary issue.
      app.cron.schedule('subscription-integrity', '10 4 * * 0', async () => {
        const { db } = await import('./db/index.js')
        let cleaned = 0
        try {
          const recSubs = (await db('nivaro_notification_subscriptions')
            .where({ is_active: true, filter_field: 'id' })
            .whereNotNull('collection')
            .select('id', 'collection', 'filter_value')
            .limit(2000)) as Array<{ id: number; collection: string; filter_value: string }>
          const byCol = new Map<string, Array<{ id: number; filter_value: string }>>()
          for (const r of recSubs) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.collection)) continue
            const arr = byCol.get(r.collection) ?? []
            arr.push(r)
            byCol.set(r.collection, arr)
          }
          for (const [col, subs] of byCol) {
            try {
              const ids = subs.map((x) => x.filter_value)
              const existing = new Set(
                ((await db(col).whereIn('id', ids).select('id')) as Array<{ id: unknown }>).map(
                  (x) => String(x.id)
                )
              )
              const dead = subs.filter((x) => !existing.has(String(x.filter_value)))
              if (dead.length > 0) {
                await db('nivaro_notification_subscriptions')
                  .whereIn(
                    'id',
                    dead.map((x) => x.id)
                  )
                  .update({ is_active: false })
                cleaned += dead.length
              }
            } catch {
              /* collection dropped — leave subs, next sweep */
            }
          }
          const viewSubs = (await db('nivaro_view_subscriptions as vs')
            .leftJoin('nivaro_saved_views as v', 'vs.view_id', 'v.id')
            .whereNull('v.id')
            .where('vs.is_active', true)
            .select('vs.id')) as Array<{ id: number }>
          if (viewSubs.length > 0) {
            await db('nivaro_view_subscriptions')
              .whereIn(
                'id',
                viewSubs.map((x) => x.id)
              )
              .update({ is_active: false })
            cleaned += viewSubs.length
          }
          if (cleaned > 0) {
            const { trackError } = await import('./services/error-tracking.js')
            await trackError({
              source: 'server',
              route: 'subscription-integrity',
              message: `Deactivated ${cleaned} subscription(s) pointing at deleted views/records`,
              severity: 'low'
            }).catch(() => {})
          }
        } catch {
          /* sweep is best-effort */
        }
      })

      // Dead-link sweep (#406): nivaro_record_links whose either end no longer
      // exists — found nightly, reported as one deduped issue.
      app.cron.schedule('dead-link-sweep', '55 3 * * *', async () => {
        const { db } = await import('./db/index.js')
        try {
          const links = (await db('nivaro_record_links')
            .select('id', 'from_collection', 'from_item', 'to_collection', 'to_item')
            .limit(5000)) as Array<Record<string, unknown>>
          const dead: number[] = []
          const checked = new Map<string, boolean>()
          const exists = async (col: string, id: string) => {
            const key = `${col}:${id}`
            if (checked.has(key)) return checked.get(key) as boolean
            let ok = false
            try {
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
                ok = !!(await db(col).where({ id }).first('id'))
              }
            } catch {
              ok = true // unreadable table — never call a link dead on an error
            }
            checked.set(key, ok)
            return ok
          }
          for (const l of links) {
            const a = await exists(String(l.from_collection), String(l.from_item))
            const b = await exists(String(l.to_collection), String(l.to_item))
            if (!a || !b) dead.push(Number(l.id))
          }
          if (dead.length > 0) {
            const { trackError } = await import('./services/error-tracking.js')
            await trackError({
              source: 'server',
              route: 'dead-link-sweep',
              message: `${dead.length} record link(s) point at deleted records (ids: ${dead.slice(0, 20).join(', ')}${dead.length > 20 ? '…' : ''})`,
              severity: 'low'
            }).catch(() => {})
          }
        } catch {
          /* sweep is best-effort */
        }
      })

      // Ack chasers (#385): must-ack broadcasts remind non-ackers at 24h,
      // escalate to the sender at 48h — each exactly once.
      app.cron.schedule('broadcast-ack-chasers', '15 * * * *', async () => {
        const { runAckChasers } = await import('./routes/announcements.js')
        await runAckChasers(app)
      })

      // Blocking-session monitor (#88): DB sessions blocked >15s form chains
      // that read as "everything is slow" with no visible cause. Every 5 min,
      // chains land as ONE deduped issue naming the head blocker + statement.
      // Needs VIEW SERVER STATE — absent permission degrades to silence.
      app.cron.schedule('blocking-sessions', '*/5 * * * *', async () => {
        const { db } = await import('./db/index.js')
        let rows: Array<{
          session_id: number
          blocking_session_id: number
          wait_time: number
          wait_type: string | null
          sql_text: string | null
        }> = []
        try {
          rows = (await db.raw(`
            SELECT r.session_id, r.blocking_session_id, r.wait_time, r.wait_type,
                   LEFT(t.text, 300) AS sql_text
            FROM sys.dm_exec_requests r
            OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
            WHERE r.blocking_session_id <> 0 AND r.wait_time > 15000
          `)) as typeof rows
        } catch {
          return // no VIEW SERVER STATE — nothing to report
        }
        if (rows.length === 0) return
        const heads = [...new Set(rows.map((r) => r.blocking_session_id))]
        // The head blocker's own statement, when visible.
        let headText = ''
        try {
          const headRows = (await db.raw(
            `SELECT s.session_id, LEFT(t.text, 300) AS sql_text
             FROM sys.dm_exec_requests r
             JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
             OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
             WHERE s.session_id IN (${heads.map(() => '?').join(',')})`,
            heads
          )) as Array<{ session_id: number; sql_text: string | null }>
          headText = headRows.map((h) => `#${h.session_id}: ${h.sql_text ?? '(idle)'}`).join(' · ')
        } catch {
          headText = heads.map((h) => `#${h}`).join(', ')
        }
        const worst = Math.max(...rows.map((r) => r.wait_time))
        const { trackError } = await import('./services/error-tracking.js')
        await trackError({
          source: 'server',
          route: 'db/blocking-sessions',
          message: `${rows.length} session(s) blocked (worst ${Math.round(worst / 1000)}s) behind ${heads.length} head blocker(s)`,
          stack: `Head blocker statement(s): ${headText}\nBlocked: ${rows
            .slice(0, 10)
            .map(
              (r) =>
                `#${r.session_id} waits ${Math.round(r.wait_time / 1000)}s (${r.wait_type ?? '?'}) on #${r.blocking_session_id}`
            )
            .join('\n')}`,
          severity: worst > 120_000 ? 'critical' : 'high'
        })
      })

      // Reminders (the chat bot's set_reminder + /reminders): every 20 seconds,
      // so "remind me in a minute" lands within the minute. The request that
      // sets a near-term reminder also arms a timer (services/reminders.ts),
      // which is what delivers on a dev laptop where crons do not tick.
      // Raw writers announce changes (#1875): drain the inbox procedures and
      // scripts write to, and broadcast it. One process drains (scheduler
      // lease); the broadcast reaches every replica through the stream.
      app.cron.schedule(
        'raw-write-announcements',
        '*/5 * * * * *',
        async () => {
          const { drainRawWrites } = await import('./services/raw-write-announcer.js')
          await drainRawWrites()
        },
        { quiet: true }
      )
      // Durable event journal (#1673): keep 24 hours.
      app.cron.schedule('event-journal-prune', '17 */1 * * *', async () => {
        const { pruneEventJournal } = await import('./services/event-journal-store.js')
        await pruneEventJournal()
      })

      app.cron.schedule(
        'chat-reminders',
        '*/20 * * * * *',
        async () => {
          const { deliverDueReminders } = await import('./services/reminders.js')
          await deliverDueReminders(app)
        },
        { quiet: true }
      )

      // Scheduled chat messages (#939): every 20 seconds, same claim as the
      // request's own timer (services/chat-scheduled.ts).
      app.cron.schedule(
        'chat-scheduled-send',
        '*/20 * * * * *',
        async () => {
          const { sendDueScheduled } = await import('./services/chat-scheduled.js')
          await sendDueScheduled(app)
        },
        { quiet: true }
      )
      // Scheduled huddles (#2860): reminders five minutes before, rings at the start.
      app.cron.schedule(
        'huddle-schedules',
        '* * * * *',
        async () => {
          const { runDueHuddleSchedules } = await import('./services/huddle-schedule.js')
          await runDueHuddleSchedules(app)
        },
        { quiet: true }
      )
      // Idle channels get an archive suggestion to their owner (#2485); stale composer drafts go (#2474).
      app.cron.schedule('chat-archive-suggestions', '10 4 * * *', async () => {
        const { suggestIdleChannels } = await import('./services/chat-archive.js')
        const n = await suggestIdleChannels(app)
        if (n.length > 0) app.log.info(`chat: ${n.length} archive suggestion(s) sent`)
      })
      app.cron.schedule('chat-drafts-prune', '20 4 * * *', async () => {
        const { pruneDrafts } = await import('./services/chat-drafts.js')
        await pruneDrafts()
      })
      // Close chat polls whose time has passed and post their summary line (#2337).
      app.cron.schedule(
        'chat-polls-close',
        '*/30 * * * * *',
        async () => {
          const { closeDuePolls } = await import('./services/chat-polls.js')
          await closeDuePolls(app)
        },
        { quiet: true }
      )
      // Email fallback for unread DMs (#965) — opt-in per person.
      app.cron.schedule('chat-dm-email-fallback', '*/5 * * * *', async () => {
        const { sweepDmEmailFallback } = await import('./services/chat-send.js')
        const n = await sweepDmEmailFallback(app)
        if (n > 0) app.log.info(`chat: ${n} unread-DM email(s) sent`)
      })
      // Mention digest (#931): unread chat mentions in the daily summary.
      {
        const { registerChatMentionDigest } = await import('./services/chat-digest.js')
        registerChatMentionDigest()
      }

      app.cron.schedule('fk-integrity-sweep', '40 3 * * *', async () => {
        const { detectDanglingFks } = await import('./services/fk-integrity.js')
        const report = await detectDanglingFks()
        if (report.dangling_relations > 0) {
          app.log.warn(
            `dangling FKs: ${report.total_dangling_rows} rows across ${report.dangling_relations} relation(s)`
          )
        }
      })

      // #81 — a job that skipped its expected window raises an issue.
      const missedCrons = async () => {
        const jobs = app.cron.list().filter((j) => !j.paused && !j.after)
        const latest = (await db('nivaro_job_runs')
          .where('kind', 'cron')
          .groupBy('job_id')
          .select('job_id', db.raw('MAX(started_at) as last_at'))) as Array<{
          job_id: string
          last_at: unknown
        }>
        const lastBy = new Map(
          latest.map((r) => [r.job_id, r.last_at ? new Date(r.last_at as string).getTime() : 0])
        )
        const now = Date.now()
        const out: Array<{
          id: string
          expected_at: string
          last_run_at: string | null
          grace_min: number
        }> = []
        for (const j of jobs) {
          // Quiet jobs record only failures — no row is not a miss.
          if (j.quiet) continue
          const expected = app.cron.expectedPreviousRun(j.id)
          if (!expected) continue
          const next = j.nextRun ? new Date(j.nextRun).getTime() : null
          const period = next ? next - expected.getTime() : 0
          const grace = Math.max(5 * 60_000, Math.round(period * 0.1))
          if (expected.getTime() + grace > now) continue // still inside its window
          if (expected.getTime() < bootAt) continue // expected before this process existed
          const last = lastBy.get(j.id) ?? 0
          if (last >= expected.getTime() - 60_000) continue
          // Maintenance held that tick on purpose (nightly rebuild) — not a miss.
          if (await app.cron.heldByMaintenanceAt(j.id, expected)) continue
          out.push({
            id: j.id,
            expected_at: expected.toISOString(),
            last_run_at: last ? new Date(last).toISOString() : null,
            grace_min: Math.round(grace / 60_000)
          })
        }
        return out
      }
      const bootAt = Date.now()
      // #2267: the Traffic Map asks the detector's own question (job nodes show a missed-run badge).
      registerMissedCronProbe(missedCrons)
      app.cron.schedule(
        'cron-miss-detector',
        '*/30 * * * *',
        async () => {
          const { trackError } = await import('./services/error-tracking.js')
          for (const m of await missedCrons()) {
            await trackError({
              source: 'server',
              route: 'cron/miss',
              message: `Cron "${m.id}" missed its expected run at ${m.expected_at}${m.last_run_at ? ` (last ran ${m.last_run_at})` : ' (never recorded)'}`,
              severity: 'medium'
            })
          }
        },
        { dryRun: missedCrons }
      )

      // #41 — pre-run the heavy custom queries flagged warm_daily. Same
      // service (so the same cq: key and {cached_at, rows} value) as the
      // #2445 cache warm below; this used to write a bare row array.
      app.cron.schedule(
        'query-cache-warmers',
        '0 6 * * *',
        async () => {
          const { runCacheWarm } = await import('./services/cache-warm.js')
          await runCacheWarm({
            redis: app.redis,
            only: 'warm_daily',
            log: (summary, line) => app.log.info(summary, line)
          })
        },
        {
          heavy: true,
          dryRun: async () => {
            const { planCacheWarm } = await import('./services/cache-warm.js')
            return planCacheWarm({ only: 'warm_daily' })
          }
        }
      )

      // #2445 — before business hours, pre-run the cached custom queries people
      // actually opened in the last 7 days (default + top recorded param sets)
      // and the warm_daily ones as an unrestricted caller, plus the owner-load
      // report; then widget renders + scoped execute calls as their viewers
      // (one per scope signature), queue first pages read-only (one per queue
      // + access signature) and extension warmers: after the nightly
      // rebuild the first dashboard met a cold buffer pool (>10 s).
      app.cron.schedule(
        'cache-warm',
        '30 6 * * 1-5',
        async () => {
          const m = await import('./services/cache-warm.js')
          if (m.cacheWarmMode() === 'off') return
          await m.runCacheWarm({
            redis: app.redis,
            log: (summary, line) => app.log.info(summary, line)
          })
        },
        {
          heavy: true,
          idempotent: 'safe',
          description:
            'Pre-runs the most-used CACHED custom queries (cache TTL above 0; default + top param sets) and every Warm daily query as an unrestricted caller, filling the cache key the execute route reads, plus the owner-load report; then the most-used custom-query widgets and the queries people with User Scopes run, AS one recent viewer per scope signature (their own access gate and scope values); then the most-used queue worklist first pages, read-only, as one viewer per queue and access signature (nothing stored; warms the database and the read path caches); then extension warmers. It runs exactly what a viewer cache miss would run; a key cached within the hour is left alone. CACHE_WARM=off disables it.',
          dryRun: async () => {
            const { planCacheWarm } = await import('./services/cache-warm.js')
            return planCacheWarm()
          }
        }
      )

      // #74 — endpoint contract tests, nightly: every enabled API endpoint
      // that declares a contract is called and judged; failures raise one
      // deduped issue per endpoint. Dry run lists what would be called.
      app.cron.schedule(
        'external-api-contracts',
        '20 2 * * *',
        async () => {
          const { runContracts } = await import('./services/external-api-contracts.js')
          const results = await runContracts()
          const failed = results.filter((r) => !r.ok && !r.skipped)
          for (const f of failed) {
            void trackError({
              source: 'server',
              route: `external-api-contract/${f.endpoint_id}`,
              message: `Contract failed for endpoint #${f.endpoint_id}: ${f.detail}`,
              severity: 'medium'
            })
          }
          app.log.info(
            { ran: results.length, failed: failed.length },
            'external API contracts checked'
          )
        },
        {
          dryRun: async () => {
            const { contractTargets } = await import('./services/external-api-contracts.js')
            return {
              would_run: (await contractTargets()).map(
                (t) => `${t.api_name} · ${t.name} (${t.method})`
              )
            }
          }
        }
      )

      // #612 / #603 — external API health probes every 5 minutes (token
      // endpoint + health path, side traffic on the flight recorder), then the
      // metric-alert rules that read external-API SLOs, so a "error rate over
      // 5% for 15 minutes" rule reacts within one probe cycle.
      app.cron.schedule(
        'external-api-health-probes',
        '*/5 * * * *',
        async () => {
          const { runHealthProbes } = await import('./services/external-api-health.js')
          const results = await runHealthProbes()
          const { runMetricAlertChecks } = await import('./services/metric-alerts.js')
          const alerts = await runMetricAlertChecks(app, 'all', { sourceType: 'external_api_slo' })
          app.log.info(
            {
              probed: results.length,
              failing: results.filter((r) => !r.ok && !r.skipped).length,
              alerts
            },
            'external API health probed'
          )
        },
        {
          dryRun: async () => {
            const { healthProbeTargets } = await import('./services/external-api-health.js')
            return {
              would_probe: (await healthProbeTargets()).map((t) => `${t.name} ${t.path}`)
            }
          }
        }
      )

      // Headline snapshots (#851): the dashboard's budget headline figures,
      // once for the whole year and once per zone, upserted one row per day
      // into nivaro_dashboard_snapshots. Off until nivaro_settings.dashboard_headline
      // names a query. Heavy: one custom-query run per zone (~7s each on EFP).
      app.cron.schedule(
        'dashboard-headline-snapshot',
        '30 3 * * *',
        async () => {
          const { runHeadlineSnapshot } = await import('./services/headline-snapshots.js')
          await runHeadlineSnapshot(app.log)
        },
        {
          heavy: true,
          dryRun: async () => {
            const { dryRunHeadlineSnapshot } = await import('./services/headline-snapshots.js')
            return dryRunHeadlineSnapshot()
          }
        }
      )

      // Dead-file-link sweep: stat every stored file against the storage
      // provider (oldest verification first) and stamp nivaro_files.missing_at,
      // so file chips and the Files page render dead links honestly.
      // Manual: POST /api/cron/file-integrity-sweep/run.
      app.cron.schedule('file-integrity-sweep', '50 3 * * *', async () => {
        const { fileIntegritySweep } = await import('./services/file-integrity.js')
        const r = await fileIntegritySweep()
        if (r.newly_missing > 0) {
          app.log.warn(
            `file integrity: ${r.newly_missing} file(s) newly missing (${r.missing} missing of ${r.checked} checked)`
          )
        }
      })

      // Warm the compiled integrity checks for every laid-out collection so
      // the FIRST record form after a boot gets a sub-second live check
      // instead of paying the ~6s compile. Best-effort, never awaited.
      // Owner groups for every bound template (#481): the first queue read
      // after a deploy used to fetch ~1.9MB of group filters cold (~3s).
      void bootPhase(
        'Warm owner groups',
        async () => {
          const m = await import('./services/pipeline-engine.js')
          const n = await m.warmOwnerGroupCache()
          app.log.info(`owners: warmed owner groups for ${n} state(s)`)
        },
        { background: true }
      ).catch(() => {})
      void bootPhase(
        'Warm integrity checks',
        async () => {
          const m = await import('./services/config-conformance.js')
          const n = await m.warmCompiledChecks()
          app.log.info(`integrity: warmed checks for ${n} collection(s)`)
        },
        { background: true }
      ).catch(() => {})
      // #2445 — query caches and the buffer pool behind them, once per cluster
      // per version (nvr:warm:<version>), a while after listen so it never
      // competes with the boot's first requests. Never a readiness check.
      // Metadata warms on every process. The query warm holds the cluster's
      // heavy-job slot, like the 06:30 cron.
      cacheWarmTimer = setTimeout(() => {
        cacheWarmTimer = null
        void import('./services/cache-warm.js')
          .then(async (m) => {
            if (!m.cacheWarmAllowed()) return
            await bootPhase('Warm metadata', () => m.warmMetadata(), { background: true })
            const { NIVARO_VERSION } = await import('./version.js')
            const { INSTANCE_ID } = await import('./services/instance-roster.js')
            if (!(await m.takeBootWarm(app.redis, NIVARO_VERSION, INSTANCE_ID))) return
            await app.cron.withHeavySlot('cache-warm (boot)', async () => {
              await bootPhase(
                'Warm query caches',
                () =>
                  m.runCacheWarm({
                    redis: app.redis,
                    log: (summary, line) => app.log.info(summary, line)
                  }),
                { background: true }
              )
            })
          })
          .catch((err) => app.log.warn({ err }, 'cache warm failed'))
      }, 20_000)
      cacheWarmTimer.unref()
      // Readiness results for this version (the cache is keyed by version, so
      // a deploy starts empty): evaluate them once, on one replica, so the
      // first dashboard reads a scorecard instead of 'pending'. Same switch as
      // the cache warm — dev never runs the heavy checks unprompted.
      readinessWarmTimer = setTimeout(() => {
        readinessWarmTimer = null
        void (async () => {
          const { cacheWarmAllowed } = await import('./services/cache-warm.js')
          if (!cacheWarmAllowed()) return
          const { warmReadiness } = await import('./services/readiness.js')
          const n = await warmReadiness()
          if (n > 0) app.log.info(`readiness: evaluated ${n} check(s) for this version`)
        })().catch((err) => app.log.warn({ err }, 'readiness warm failed'))
      }, 15_000)
      readinessWarmTimer.unref()

      // Nightly config-conformance runs for scheduled collections, with a
      // regression note when a collection's issue count grew since last run.
      // NOTE (2026-09-14): this and the two crons after it used to sit INSIDE
      // the file-integrity-sweep callback — registered only when that sweep
      // fired at 03:50, i.e. absent on any process younger than a day.
      app.cron.schedule('conformance-nightly', '40 2 * * *', async () => {
        const { runConformance } = await import('./services/config-conformance.js')
        const schedules = (await db('nivaro_conformance_schedules').where(
          'is_active',
          true
        )) as Array<{
          collection: string
          row_cap: number
          created_by: string | null
        }>
        for (const sch of schedules) {
          const running = await db('nivaro_conformance_runs')
            .where({ collection: sch.collection, status: 'running' })
            .first('id')
          if (running) continue
          const prev = (await db('nivaro_conformance_runs')
            .where({ collection: sch.collection, status: 'completed' })
            .orderBy('id', 'desc')
            .first('violation_count')) as { violation_count: number } | undefined
          const [inserted] = await db('nivaro_conformance_runs')
            .insert({ collection: sch.collection, status: 'running', started_at: new Date() })
            .returning('id')
          const runId = Number(
            typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
          )
          await runConformance(
            runId,
            sch.collection,
            sch.row_cap > 0 ? sch.row_cap : Number.MAX_SAFE_INTEGER
          )
          const done = (await db('nivaro_conformance_runs').where('id', runId).first()) as
            | { status: string; violation_count: number }
            | undefined
          if (
            done?.status === 'completed' &&
            prev &&
            done.violation_count > prev.violation_count &&
            sch.created_by
          ) {
            const { notifyUser } = await import('./services/notification-channels.js')
            await notifyUser(app, sch.created_by, {
              subject: `Data integrity regression: ${sch.collection}`,
              category: 'system',
              message: `${sch.collection} went from ${prev.violation_count} to ${done.violation_count} issue(s) in last night's sweep.`,
              collection: 'nivaro_conformance_runs',
              item: String(runId)
            }).catch(() => {})
          }
        }
      })

      // Daily readiness score snapshot — the trend line toward cutover.
      // Presence janitor — the socket's disconnect bookkeeping is per-process,
      // so restarts strand is_online=true bits; anything raw /items readers see
      // must self-heal even if no client ever beats again.
      app.cron.schedule('presence-janitor', '*/5 * * * *', async () => {
        const has = await db.schema.hasTable('user_presence')
        if (!has) return
        await db('user_presence')
          .where('is_online', true)
          .where('last_seen', '<', new Date(Date.now() - 10 * 60_000))
          .update({ is_online: false, is_idle: true })
          .catch(() => {})
      })

      // #523 — one stored config snapshot a day, so "what drifted since Friday"
      // is a question the compare page can answer without an uploaded file.
      app.cron.schedule('config-snapshot', '40 4 * * *', async () => {
        const { takeConfigSnapshot } = await import('./services/config-snapshots.js')
        const meta = await takeConfigSnapshot('cron')
        app.log.info(
          { tables: meta.tables, rows: meta.rows, same: meta.same_as_previous },
          '[config-snapshot] stored'
        )
      })
      app.cron.schedule('readiness-snapshot', '50 6 * * *', async () => {
        const { runReadinessChecks } = await import('./services/readiness.js')
        const report = await runReadinessChecks()
        if (report.checks.length === 0) return
        const today = new Date().toISOString().slice(0, 10)
        const exists = await db('nivaro_readiness_snapshots')
          .where('snapshot_date', today)
          .first('id')
        if (exists) {
          await db('nivaro_readiness_snapshots')
            .where('snapshot_date', today)
            .update({ score: report.score, counts: JSON.stringify(report.counts) })
        } else {
          await db('nivaro_readiness_snapshots').insert({
            snapshot_date: today,
            score: report.score,
            counts: JSON.stringify(report.counts),
            created_at: new Date()
          })
        }
      })

      // Rollup drift detection — stored rollups can silently go stale (chained
      // rollups don't cascade; recalc failures are swallowed by design), and
      // nothing ever went back to check. Nightly sample-compare, drift lands as
      // deduped nivaro_issues rows. Manual run: POST /api/cron/rollup-drift-sweep/run.
      // Access requests (#19): admins' daily digest carries the pending queue;
      // requests nobody acted on in 14 days expire with a note to the requester.
      {
        const { registerAccessRequestDigest, expireStaleAccessRequests } = await import(
          './routes/access-requests.js'
        )
        registerAccessRequestDigest()
        app.cron.schedule('access-requests-expire', '10 6 * * *', async () => {
          const n = await expireStaleAccessRequests(app)
          if (n > 0) app.log.info(`access-requests: ${n} stale request(s) expired`)
        })
      }

      // Directory sync: is every user still with the company? Registered
      // always so Background Jobs lists it; the body skips itself until the
      // Settings switch is on AND the app token carries User.Read.All.
      {
        const { runDirectorySyncCron } = await import('./services/directory-sync.js')
        app.cron.schedule('directory-sync', '15 4 * * *', async () => {
          const outcome = await runDirectorySyncCron(app)
          app.log.info(`directory-sync: ${outcome}`)
        })
      }

      // Line-level SLA (backlog #16): lines still missing a required id N
      // days after a state — OFF until a grid enables options.line_sla.
      // Notifies owners once a day; the daily digest carries a section.
      {
        const { registerLineSlaDigest, runLineSlaSweep } = await import('./services/line-sla.js')
        registerLineSlaDigest()
        app.cron.schedule('line-sla-sweep', '15 7 * * *', async () => {
          const r = await runLineSlaSweep(app)
          if (r.findings > 0)
            app.log.info(`line-sla: ${r.findings} record(s) overdue, ${r.notified} notified`)
        })
      }

      // Watched numbers (#1892, #1987): re-read each due watch as its owner,
      // alert on a crossing or an unusual move, and list them in the digest.
      {
        const { registerWatchDigest, runWatchChecks } = await import('./services/ai-watches.js')
        registerWatchDigest()
        app.cron.schedule(
          'ai-watch-checks',
          '10 * * * *',
          async () => {
            const r = await runWatchChecks(app)
            if (r.checked) app.log.info(`ai-watches: ${r.checked} checked, ${r.alerts} alert(s)`)
          },
          { dryRun: async () => runWatchChecks(app, { dryRun: true }) }
        )
      }

      // AI spend roll-up + forecast alerts (#2473, #2764) and the model
      // catalogue watch (#2732).
      {
        const { registerAiQualityCrons } = await import('./services/ai-quality-crons.js')
        registerAiQualityCrons(app)
      }

      // Chaos Monkey (#2829): opt-in random small drills inside the configured hours.
      {
        const { registerChaosMonkeyCron } = await import('./services/chaos/monkey.js')
        registerChaosMonkeyCron(app)
      }

      // Huddle TURN probe + session sweep/prune (#2849, #2850).
      {
        const { registerHuddleCrons } = await import('./services/huddle-crons.js')
        registerHuddleCrons(app)
      }

      // Tasks (#1007, #1016): due-tomorrow reminders + overdue escalation
      // once a day, the self-closing check every hour, and a daily-summary
      // section of what is due or overdue.
      {
        const { registerTaskDigest, runTaskReminders, sweepDoneWhen } = await import(
          './services/tasks.js'
        )
        await registerTaskDigest()
        app.cron.schedule(
          'task-reminders',
          '30 7 * * *',
          async () => {
            const r = await runTaskReminders(app)
            if (r.due_tomorrow || r.escalated)
              app.log.info(
                `task-reminders: ${r.due_tomorrow} due tomorrow, ${r.escalated} escalated, ${r.notified} notified`
              )
          },
          { dryRun: async () => runTaskReminders(app, { dryRun: true }) }
        )
        app.cron.schedule('task-done-when-sweep', '40 * * * *', async () => {
          const n = await sweepDoneWhen(app)
          if (n) app.log.info(`task-done-when-sweep: ${n} task(s) closed`)
        })
      }

      // Agents (#3210, #3220): agent-trigger retries that are due (a process that scheduled
      // one may have restarted), and ask_human questions past their expiry.
      app.cron.schedule(
        'agent-trigger-retries',
        '* * * * *',
        async () => {
          const { drainDueDeliveries } = await import('./services/agent-trigger-delivery.js')
          const n = await drainDueDeliveries()
          if (n) app.log.info(`agent-trigger-retries: ${n} delivery attempt(s)`)
        },
        { description: 'Sends agent-trigger wake-ups whose retry is due.' }
      )
      app.cron.schedule(
        'agent-questions-expire',
        '*/15 * * * *',
        async () => {
          const { expireQuestions } = await import('./services/agent-questions.js')
          const n = await expireQuestions()
          if (n) app.log.info(`agent-questions-expire: ${n} question(s) expired`)
        },
        { description: 'Marks agent questions nobody answered in time as expired.' }
      )

      // #1462 — monthly API usage statements, per key that opted in.
      app.cron.schedule(
        'api-key-usage-statements',
        '10 7 1 * *',
        async () => {
          const { runUsageStatements } = await import('./services/api-key-usage-statements.js')
          const r = await runUsageStatements()
          if (r.sent || r.failures.length)
            app.log.info(
              `api-key-usage-statements: ${r.sent} sent for ${r.month}, ${r.failures.length} failed`
            )
        },
        {
          dryRun: async () => {
            const { runUsageStatements } = await import('./services/api-key-usage-statements.js')
            return runUsageStatements({ dryRun: true })
          }
        }
      )

      // Managers (#1034, #1037): the Monday "Your team this week" summary
      // section, and the hourly check of each manager's own team alert lines.
      {
        const { registerTeamDigest, runTeamAlerts } = await import('./services/team.js')
        registerTeamDigest()
        app.cron.schedule(
          'team-alerts',
          '50 * * * *',
          async () => {
            const r = await runTeamAlerts(app)
            if ('sent' in r && r.sent) app.log.info(`team-alerts: ${r.sent} alert(s) sent`)
          },
          { dryRun: async () => runTeamAlerts(app, { dryRun: true }) }
        )
      }

      app.cron.schedule(
        'rollup-drift-sweep',
        '20 3 * * *',
        async () => {
          const { detectRollupDrift } = await import('./services/rollup-drift.js')
          const report = await detectRollupDrift()
          if (report.drifted_rows > 0) {
            app.log.warn(
              `rollup drift: ${report.drifted_rows} stale rows across ${report.fields.length} field(s)`
            )
          }
        },
        {
          // #32 — the same sweep, reported instead of raised.
          dryRun: async () => {
            const { detectRollupDrift } = await import('./services/rollup-drift.js')
            return await detectRollupDrift()
          }
        }
      )

      // #996 — database tuning: nightly observe (proposals + proofs; nothing applies).
      // Registered always; the run returns at once while db_tuning.enabled is off. A killed
      // proof leaves its `<proc>__tune_<hex>` twin behind, so boot sweeps the ones older than any
      // live proof — fire-and-forget: the sweep must never fail or hold up boot.
      void Promise.all([
        import('./services/db-tuning/twin.js'),
        import('./services/db-tuning/settings.js')
      ])
        .then(async ([{ sweepTwinLeftovers }, { readTuningSettings }]) =>
          sweepTwinLeftovers((await readTuningSettings()).proc_timeout_minutes)
        )
        .then((dropped) => {
          if (dropped.length)
            app.log.warn(`db-tuning: dropped leftover twin procedure(s) ${dropped.join(', ')}`)
        })
        .catch((err) => app.log.warn({ err }, 'db-tuning: twin sweep failed'))
      app.cron.schedule(
        'db-tuning-observe',
        '35 3 * * *',
        async () => {
          const { observeSummary, runObserve } = await import('./services/db-tuning/observe-run.js')
          const report = await runObserve({ trigger: 'schedule' })
          app.log.info(`db-tuning-observe: ${observeSummary(report)}`)
        },
        {
          heavy: true,
          idempotent: 'safe',
          description:
            'Nightly 03:35 — reads the workload evidence (missing and unused indexes, slow procedures, rollup and query-cache traffic, extension observers), proves the biggest candidates and writes them to Database Tuning as proposals or proof rejections. Nothing applies. Returns at once while db_tuning.enabled is off. Dry run lists what it would prove.',
          dryRun: async () => {
            const { runObserve } = await import('./services/db-tuning/observe-run.js')
            return runObserve({ dryRun: true })
          }
        }
      )
      // #2562 — nightly SQL checks: every module's definition (plus stored import bodies and
      // custom queries) checked for NULL-unsafe MERGE keys, writes without WHERE, transactions
      // without XACT_ABORT, local-time clocks and more; findings tracked across runs.
      app.cron.schedule(
        'sql-checks',
        '30 3 * * *',
        async () => {
          const { nightlyEnabled, readSqlCheckSettings } = await import(
            './services/sql-checks/settings.js'
          )
          if (!nightlyEnabled(await readSqlCheckSettings())) return
          const { runSqlChecks, runSummary } = await import('./services/sql-checks/run.js')
          app.log.info(`sql-checks: ${runSummary(await runSqlChecks({ trigger: 'cron' }))}`)
        },
        {
          heavy: true,
          idempotent: 'safe',
          description:
            "Nightly 03:30 — reads every procedure, function, view and trigger definition (plus import definitions' stored procedure bodies and custom queries), checks them for NULL-unsafe MERGE keys (with live NULL and duplicate counts), writes without WHERE, transactions without XACT_ABORT, local-time clocks, NOT IN over nullable columns and SELECT * on wide tables, optionally lints them through the SQLFluff sidecar (SQL_LINT_URL), and records findings on SQL checks. Reads only. Runs when SQL checks are turned on (setting, or SQL_CHECKS=on)."
        }
      )
      // #2801 — nightly restore drill: restores the newest database backup into a scratch
      // database, smoke-checks it, records the restore time, drops the copy. Off by default.
      app.cron.schedule(
        'restore-drill',
        '30 2 * * *',
        async () => {
          const [{ restoreDrillTick }, { effectiveRecovery, getRecoverySettings }] =
            await Promise.all([
              import('./services/recovery/drill.js'),
              import('./services/recovery/settings.js')
            ])
          const r = await restoreDrillTick(effectiveRecovery(await getRecoverySettings()))
          if (r) app.log.info(`restore-drill: ${r.verdict} — ${r.reason}`)
        },
        {
          heavy: true,
          idempotent: 'unsafe',
          watchdogMs: 4 * 3_600_000,
          description:
            'Nightly 02:30 — restores the newest full (plus differential) backup of this database from msdb into the scratch database nivaro_restore_drill_…, checks key tables exist and hold rows, records the restore time on Telemetry → Recovery, and always drops the copy. Needs CREATE ANY DATABASE and disk for a full copy. Runs only when the drill is on (setting, or RESTORE_DRILL=on); never on cloud instances. Dry run reads msdb and RESTORE FILELISTONLY only.',
          dryRun: async () => {
            const [{ jobRunLedger, runRestoreDrill }, { effectiveRecovery, getRecoverySettings }] =
              await Promise.all([
                import('./services/recovery/drill.js'),
                import('./services/recovery/settings.js')
              ])
            return runRestoreDrill({
              dryRun: true,
              settings: effectiveRecovery(await getRecoverySettings()),
              ledger: jobRunLedger(null)
            })
          }
        }
      )
      // #2480 — nightly glossary / data-guide conflict check, with an AI read of the definitions
      // when AI is configured. Reads the knowledge tables and writes only its own findings.
      app.cron.schedule(
        'ai-knowledge-check',
        '45 3 * * *',
        async () => {
          const { runKnowledgeCheck } = await import('./services/ai-knowledge-check.js')
          const r = await runKnowledgeCheck({ ai: true })
          app.log.info(`ai-knowledge-check: ${r.open} open, ${r.new} new, ${r.resolved} resolved`)
        },
        {
          idempotent: 'safe',
          description:
            'Nightly 03:45 — checks the AI glossary and data guides for terms that contradict each other, near-duplicate terms with different meanings, and entries naming collections, fields or saved queries that no longer exist (plus an AI read of the definitions when AI is configured). Findings are listed on AI Knowledge; fixed ones resolve by themselves.'
        }
      )
      app.cron.schedule(
        'db-tuning-watch',
        '55 * * * *',
        async () => {
          const { runWatch, watchSummary } = await import('./services/db-tuning/watch.js')
          app.log.info(`db-tuning-watch: ${watchSummary(await runWatch(app))}`)
        },
        {
          idempotent: 'safe',
          description:
            'Hourly at :55 — re-measures every applied database tuning change against its pre-change baseline. Rolls a change back (and tells whoever applied it) when 20 of the last 24 samples run worse by regression_pct, when a stored rollup drifts from the live figure, or when a rewritten procedure differs on its nightly re-diff; finishes changes past their watch window; marks failed an apply or rollback whose run died (no undo). Returns at once while db_tuning.enabled is off. Dry run reports what it would roll back, finish or mark failed.',
          dryRun: async () => {
            const { runWatch } = await import('./services/db-tuning/watch.js')
            return runWatch(app, { dryRun: true })
          }
        }
      )
      {
        const { registerTuningReadiness } = await import('./services/db-tuning/readiness.js')
        registerTuningReadiness()
      }
      // #1412 — session recording health (upload failures, nothing landing,
      // the daily cap, retention behind).
      {
        const { registerReplayReadiness } = await import('./services/session-replay-health.js')
        registerReplayReadiness()
      }

      // Integration obligation notifications: tell the record's owners and
      // the API's owner when a row the sweep below writes (or a writer
      // stamps directly, e.g. `failed`) is still unmet — module-level app
      // reference, same shape as hooks/sla.ts / hooks/alerts.ts, set once
      // here before the cron that could invoke it ever ticks.
      // registerIntegrationDigest() adds "Integrations waiting on a human"
      // to the daily action digest (services/daily-digest.ts).
      {
        const { registerIntegrationDigest, setApp: setIntegrationAlertsApp } = await import(
          './services/integration-alerts.js'
        )
        setIntegrationAlertsApp(app)
        registerIntegrationDigest()
        // Opt-in integration signal alerts (console → Alerts): real-time
        // rides the signals cycle; the daily summary gets its own section
        // and audience (subscribers who would otherwise get no summary).
        const signalAlerts = await import('./services/integration-signal-alerts.js')
        const { registerDigestAudience, registerDigestSection } = await import(
          './services/daily-digest.js'
        )
        signalAlerts.setApp(app)
        registerDigestSection(signalAlerts.integrationSignalsDigest)
        registerDigestAudience(signalAlerts.integrationSignalsDigestAudience)
      }

      // Integration reconciliation: each registered obligation kind says
      // which records the partner is behind on, derived from data alone —
      // this compares that with the ledger and writes what no trigger can
      // see (missing, overdue, superseded). Never sends. Its own tail calls
      // alertUnmetObligations() once outcomes are written.
      app.cron.schedule(
        'integration-reconcile',
        '*/15 * * * *',
        async () => {
          const { runIntegrationReconcileForCron } = await import(
            './services/integration-reconcile.js'
          )
          await runIntegrationReconcileForCron(app)
        },
        {
          heavy: true,
          idempotent: 'safe',
          description:
            'Derives, from the records themselves, which integrations are behind, and writes the outcomes no trigger can see: missing (the send never fired), overdue (unacknowledged, or skipped while the partner still lacks it) and superseded. Never sends.',
          dryRun: async () => {
            const { dryRunIntegrationReconcile } = await import(
              './services/integration-reconcile.js'
            )
            return dryRunIntegrationReconcile()
          }
        }
      )

      // Integrations console (spec 2026-09-23 §3): evaluates every registered
      // signal and writes the snapshot the console reads. Never sends to a
      // partner — this is entirely a read-side sweep, same posture as the
      // reconcile job above.
      app.cron.schedule(
        'integration-signals',
        '*/5 * * * *',
        async () => {
          const { runSignalsCycle } = await import('./services/integration-signals.js')
          await runSignalsCycle()
        },
        {
          // NOT heavy: heavy jobs serialize through one global slot, and
          // queueing behind an unrelated heavy job would make this 5-minute
          // read-only sweep fall stale for a reason the staleness check has
          // no way to explain (integration-signals-fresh would just say the
          // job "may be stopped").
          heavy: false,
          idempotent: 'safe',
          description:
            'Evaluates every integration signal (partners failing, failed pushes, never-sent and overdue obligations, inbound errors, imports, flow failures, extension signals) and writes the snapshot the Integrations console reads. Never sends to a partner.'
        }
      )

      // Alert definitions sweep — anomaly detections and threshold rules whose
      // data changes outside record writes only fire from a periodic pass.
      app.cron.schedule('alert-definitions-sweep', '15 * * * *', async () => {
        // #365 — alert engines pause during maintenance: a planned freeze must
        // not fire threshold/anomaly noise about itself.
        {
          const { maintenanceState } = await import('./services/security.js')
          if ((await maintenanceState()).on) return
        }
        try {
          const { evaluateAlerts } = await import('./hooks/alerts.js')
          const fired = await evaluateAlerts()
          if (fired) app.log.info({ fired }, '[alerts] sweep pass')
        } catch (err) {
          app.log.warn({ err }, '[alerts] sweep failed')
        }
      })

      app.cron.schedule('report-studio-alerts', '0 * * * *', async () => {
        // #365 — alert engines pause during maintenance: a planned freeze must
        // not fire threshold/anomaly noise about itself.
        {
          const { maintenanceState } = await import('./services/security.js')
          if ((await maintenanceState()).on) return
        }
        try {
          const { runReportAlertChecks } = await import('./services/report-studio-jobs.js')
          const r = await runReportAlertChecks(app)
          if (r.fired || r.resolved) app.log.info(r, '[report-studio] alert pass')
        } catch (err) {
          app.log.warn({ err }, '[report-studio] alert cron failed')
        }
      })
      app.cron.schedule('report-studio-daily', '0 7 * * *', async () => {
        try {
          const { runReportSubscriptions } = await import('./services/report-studio-jobs.js')
          await runReportSubscriptions(app, 'daily')
        } catch (err) {
          app.log.warn({ err }, '[report-studio] daily digest failed')
        }
      })
      app.cron.schedule('report-snapshots-weekly', '50 6 * * 1', async () => {
        try {
          const { runScheduledReportSnapshots } = await import('./services/report-studio-jobs.js')
          const r = await runScheduledReportSnapshots(app, 'weekly')
          if (r.taken > 0) app.log.info(r, '[report-studio] weekly snapshots')
        } catch (err) {
          app.log.warn({ err }, '[report-studio] weekly snapshots failed')
        }
      })
      app.cron.schedule('report-snapshots-monthly', '50 6 1 * *', async () => {
        try {
          const { runScheduledReportSnapshots } = await import('./services/report-studio-jobs.js')
          const r = await runScheduledReportSnapshots(app, 'monthly')
          if (r.taken > 0) app.log.info(r, '[report-studio] monthly snapshots')
        } catch (err) {
          app.log.warn({ err }, '[report-studio] monthly snapshots failed')
        }
      })
      app.cron.schedule('report-studio-weekly', '0 7 * * 1', async () => {
        try {
          const { runReportSubscriptions } = await import('./services/report-studio-jobs.js')
          await runReportSubscriptions(app, 'weekly')
        } catch (err) {
          app.log.warn({ err }, '[report-studio] weekly digest failed')
        }
      })

      // ── Metric alert engine ───────────────────────────────────────────────────
      // Rule checks by check_frequency, immediate notifications inside the check;
      // daily/weekly digests bundle firing alerts per subscriber; anomaly
      // detection runs its own daily/weekly passes.
      const metricAlertPass = async (freq: 'hourly' | 'daily' | 'weekly') => {
        try {
          const { runMetricAlertChecks } = await import('./services/metric-alerts.js')
          const r = await runMetricAlertChecks(app, freq)
          if (r.fired || r.resolved) app.log.info({ ...r, freq }, '[metric-alerts] check pass')
        } catch (err) {
          app.log.warn({ err, freq }, '[metric-alerts] check failed')
        }
      }
      app.cron.schedule('metric-alerts-hourly', '5 * * * *', () => metricAlertPass('hourly'))
      app.cron.schedule('metric-alerts-daily', '35 6 * * *', () => metricAlertPass('daily'))
      app.cron.schedule('metric-alerts-weekly', '35 6 * * 1', () => metricAlertPass('weekly'))
      app.cron.schedule('metric-alerts-digest-daily', '0 8 * * *', async () => {
        try {
          const { runMetricAlertDigest } = await import('./services/metric-alerts.js')
          await runMetricAlertDigest(app, 'daily')
        } catch (err) {
          app.log.warn({ err }, '[metric-alerts] daily digest failed')
        }
      })
      app.cron.schedule('metric-alerts-digest-weekly', '0 8 * * 1', async () => {
        try {
          const { runMetricAlertDigest } = await import('./services/metric-alerts.js')
          await runMetricAlertDigest(app, 'weekly')
        } catch (err) {
          app.log.warn({ err }, '[metric-alerts] weekly digest failed')
        }
      })
      const anomalyPass = async (freq: 'daily' | 'weekly') => {
        try {
          const { runAnomalyChecks } = await import('./services/anomaly-detect.js')
          const r = await runAnomalyChecks(app, freq)
          if (r.detected) app.log.info({ ...r, freq }, '[anomaly] detection pass')
        } catch (err) {
          app.log.warn({ err, freq }, '[anomaly] detection failed')
        }
      }
      app.cron.schedule('anomaly-checks-daily', '0 3 * * *', () => anomalyPass('daily'))
      app.cron.schedule('anomaly-checks-weekly', '20 3 * * 1', () => anomalyPass('weekly'))

      // REST API changelog (#315): record this release's route inventory and
      // diff against the previous release (removed routes = breaking).
      setTimeout(() => {
        void (async () => {
          const { recordRestRoutes } = await import('./services/api-changelog.js')
          const { NIVARO_VERSION } = await import('./version.js')
          await recordRestRoutes(NIVARO_VERSION, collectedRoutes)
        })()
      }, 10_000)

      // Missed-cron catch-up (#328): the idempotent nightly detectors run once
      // now if a restart straddled their window. Deliberately NOT flagged:
      // anything that sends mail or mutates business data.
      app.cron.markCatchUp('fk-integrity-sweep', 26)
      app.cron.markCatchUp('rollup-drift-sweep', 26)
      setTimeout(() => void app.cron.runCatchUps(), 30_000)

      // Cron metadata (#136 heavy serialization · #305 re-run safety labels).
      // Heavy = full-table sweeps that would otherwise pile onto the pool in
      // the same 03:00-04:00 band; unsafe = re-running sends mail or mutates.
      for (const id of [
        'rollup-drift-sweep',
        'fk-integrity-sweep',
        'dq-nightly',
        'conformance-nightly',
        'config-health-sweep',
        'config-review-monthly',
        'dead-link-sweep',
        'storage-snapshot',
        'file-integrity-sweep'
      ]) {
        app.cron.annotate(id, { heavy: true, idempotent: 'safe' })
      }
      for (const id of [
        'deadlock-sweep',
        'pool-monitor',
        'blocking-sessions',
        'presence-janitor',
        'ops-monitors',
        'concurrency-sample',
        'readiness-snapshot',
        'workflow-auto-sweep'
      ]) {
        app.cron.annotate(id, { idempotent: 'safe' })
      }
      for (const id of [
        'daily-action-digest',
        'view-subscriptions-daily',
        'view-subscriptions-weekly',
        'report-studio-daily',
        'report-studio-weekly',
        'metric-alerts-digest-daily',
        'metric-alerts-digest-weekly',
        'scheduled-broadcasts',
        'broadcast-ack-chasers',
        'chat-reminders',
        'chat-scheduled-send',
        'huddle-schedules',
        'chat-dm-email-fallback'
      ]) {
        app.cron.annotate(id, { idempotent: 'unsafe' })
      }
      // Plain-language purpose per core job (Background Jobs page). Extensions
      // describe theirs via the schedule option; a job with no description
      // reads as undescribed on the page — the cue to add one.
      for (const [id, description] of Object.entries(CRON_DESCRIPTIONS)) {
        app.cron.annotate(id, { description })
      }

      // #198 — hydrate the paused set from settings so pauses survive restarts.
      try {
        const row = (await db('nivaro_settings').orderBy('id', 'asc').first('paused_crons')) as
          | { paused_crons?: string | null }
          | undefined
        if (row?.paused_crons) {
          const ids = JSON.parse(row.paused_crons)
          if (Array.isArray(ids)) app.cron.setPaused(ids.map(String))
        }
      } catch {
        /* column mid-migration — nothing paused */
      }

      // Restart impact report (#292): job runs still marked 'running' from
      // BEFORE this boot were killed by the restart — mark them interrupted
      // and raise one summary issue with the names.
      try {
        const bootTime = new Date(Date.now() - process.uptime() * 1000)
        // #1051 — only runs of THIS deployment slot whose process is no longer in the roster.
        // The dev laptop shares its database with staging: unscoped, every laptop boot marked
        // staging's in-flight runs interrupted. Rows from before migration 388 carry no
        // instance: only a ticking (deployed) process sweeps those, never a dev laptop.
        const { hasColumn } = await import('./lib/column-probe.js')
        const { listInstances } = await import('./services/instance-roster.js')
        const { instanceKey } = await import('./services/instance-key.js')
        const { cronTicksEnabled } = await import('./services/cron-ticks.js')
        const scoped = await hasColumn('nivaro_job_runs', 'instance_id').catch(() => false)
        const live = scoped ? (await listInstances()).map((i) => String(i.id)).filter(Boolean) : []
        const sweepsLegacy = cronTicksEnabled()
        const stranded = (await db('nivaro_job_runs')
          .where('status', 'running')
          .where('started_at', '<', bootTime)
          .modify((q) => {
            if (!scoped) return
            q.where((w) => {
              w.where((o) => {
                o.where('instance', instanceKey())
                if (live.length) o.whereNotIn('instance_id', live)
              })
              if (sweepsLegacy) w.orWhereNull('instance')
            })
          })
          .limit(50)
          .select('id', 'kind', 'job_id')) as Array<{ id: number; kind: string; job_id: string }>
        if (stranded.length > 0) {
          await db('nivaro_job_runs')
            .whereIn(
              'id',
              stranded.map((r) => r.id)
            )
            .update({ status: 'interrupted', finished_at: new Date() })
          const { trackError } = await import('./services/error-tracking.js')
          await trackError({
            source: 'server',
            route: 'restart-impact',
            severity: 'medium',
            message: `Restart interrupted ${stranded.length} running job(s): ${[...new Set(stranded.map((r) => r.job_id))].slice(0, 10).join(', ')} — re-run the ones that matter from /background-jobs`
          })
        }
      } catch {
        /* job-runs table shape mid-migration — skip */
      }

      // Same for Data Integrity sweeps: a conformance run still 'running'
      // from before this boot died with the process, and its row would
      // 409 every new run for that collection forever.
      try {
        const bootTime = new Date(Date.now() - process.uptime() * 1000)
        await db('nivaro_conformance_runs')
          .where('status', 'running')
          .where('started_at', '<', bootTime)
          .update({
            status: 'error',
            error: 'Interrupted by an API restart — run it again.',
            finished_at: new Date()
          })
      } catch {
        /* table absent mid-migration — skip */
      }
    })

  return app
}
