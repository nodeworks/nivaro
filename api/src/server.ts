import { existsSync } from 'node:fs'
import { STATUS_CODES } from 'node:http'
import { join } from 'node:path'
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
import { getMetaDb, tenantHook } from './middleware/tenant.js'
import { resolveWorkspace } from './middleware/workspace.js'
import { apiLoggerPlugin } from './plugins/api-logger.js'
import { cronPlugin } from './plugins/cron.js'
import { graphqlPlugin } from './plugins/graphql.js'
import { inngestPlugin } from './plugins/inngest.js'
import { legacyCompatRoutes } from './plugins/legacy-compat.js'
import { rateLimitPlugin } from './plugins/rate-limit.js'
import { redisPlugin } from './plugins/redis.js'
import { requestTracePlugin } from './plugins/request-trace.js'
import { socketioPlugin } from './plugins/socketio.js'
import { adminProvisionRoutes } from './routes/admin/provision.js'
import { loadScheduledFlows } from './routes/flows.js'
import { formRendererRoutes } from './routes/form-renderer.js'
import { registerRoutes } from './routes/index.js'
import { presencePublicRoutes } from './routes/presence.js'
import { purgeExpiredRecordings } from './routes/session-recordings.js'
import { sharePublicRoutes } from './routes/share-links.js'
import { setPulseApp } from './services/activity.js'
import { registerDigestCrons } from './services/digest.js'
import { trackError } from './services/error-tracking.js'
import { callExternalApi } from './services/external-apis.js'
import { registerQueueSnapshotCron } from './services/queue-snapshots.js'
import { registerStagedImportWorker } from './services/staged-import-worker.js'
import { purgeExpiredTrash } from './services/trash.js'
import { NIVARO_VERSION } from './version.js'

export async function buildServer() {
  // File-size ceiling from settings, read BEFORE the server exists because it
  // feeds fastify's GLOBAL bodyLimit too. Fastify's default bodyLimit is 1MB
  // and it 413s on Content-Length BEFORE any content parser runs — so a
  // multipart upload over 1MB died with "Content Too Large" no matter what
  // the multipart plugin's own fileSize limit said (found live on staging:
  // a BID template re-import). Global limit = file ceiling + headroom for
  // the multipart envelope and large JSON bodies.
  const _fsMb = process.env.CLOUD_META_DB_URL
    ? null
    : await db('nivaro_settings')
        .first('file_max_size_mb')
        .catch(() => null)
  const _fileSizeMb = (_fsMb?.file_max_size_mb as number | null) ?? 50

  const app = fastify({
    bodyLimit: (_fileSizeMb + 8) * 1024 * 1024,
    trustProxy: config.TRUST_PROXY,
    logger: {
      level: config.LOG_LEVEL,
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

  // Every response names the running build — the fastest way to tell which
  // release a deployed instance is actually serving (no auth, no /health call).
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Nivaro-Version', NIVARO_VERSION)
    return payload
  })

  // ─── Cloud multi-tenant: resolve tenant DB per request ────────────────────
  // Only active when CLOUD_META_DB_URL is set. Self-hosted: this hook is never
  // registered — behaviour is identical to before for self-hosted users.
  if (process.env.CLOUD_META_DB_URL) {
    app.addHook('onRequest', tenantHook)
    // Internal provisioning endpoint — not tenant-scoped, no tenant hook needed
    await app.register(adminProvisionRoutes)
  }

  // Allow DELETE/PUT/PATCH requests with Content-Type: application/json but no body
  // (SDK sends the header even on bodyless requests; Fastify v5 rejects empty JSON by default)
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
  await app.register(requestTracePlugin)
  await app.register(rateLimitPlugin)
  await app.register(apiLoggerPlugin)

  // ─── Sessions ─────────────────────────────────────────────────────────────
  await registerSession(app)

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
  // app Redis connection.
  {
    const { setIo } = await import('./services/io-holder.js')
    setIo(app.io)
    const { setJournalRedis } = await import('./services/event-journal.js')
    setJournalRedis(app.redis)
  }

  // ── Ops observability wiring (batch A) ───────────────────────────────────
  {
    const { startRuntimeMonitor } = await import('./services/runtime-monitor.js')
    startRuntimeMonitor()
    const { registerKnownCaches } = await import('./services/cache-registrations.js')
    registerKnownCaches()
    const { startInstanceRoster } = await import('./services/instance-roster.js')
    startInstanceRoster(app.redis)
    const { startPoolAttribution } = await import('./services/pool-attribution.js')
    startPoolAttribution()
  }

  // ── Resiliency sprint wiring ─────────────────────────────────────────────
  {
    // DB outage posture (#329): probe loop + fast honest 503s while down.
    const { startDbHealthProbe, isDbHealthy } = await import('./services/db-health.js')
    startDbHealthProbe()
    const DB_EXEMPT = /^\/api\/(version|health|changelog)/
    app.addHook('onRequest', async (req, reply) => {
      if (!isDbHealthy() && req.url.startsWith('/api') && !DB_EXEMPT.test(req.url)) {
        return reply.code(503).send({
          error: 'The database is unreachable — retrying automatically. Nothing was saved.',
          code: 'DB_UNAVAILABLE'
        })
      }
    })

    // Chaos slow-request fault (#333) — zero cost unless a drill is active.
    const { chaosSlowDelayMs } = await import('./routes/chaos.js')
    app.addHook('onRequest', async () => {
      const delay = chaosSlowDelayMs()
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

  // ─── Inngest ──────────────────────────────────────────────────────────────
  await app.register(inngestPlugin)

  // ─── Cron (self-hosted only) ───────────────────────────────────────────────
  // In cloud mode, background crons use the static DB (no request context).
  // Per-tenant cron scheduling is handled by the cloud provisioning system.
  await app.register(cronPlugin)
  if (!process.env.CLOUD_META_DB_URL) {
    registerFileCleanup(app.cron)
    registerDigestCrons(app.cron)
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

  // ─── Error tracking: 5xx → nivaro_issues (deduped, fire-and-forget) ───────
  const errorContextCounters = new Map<string, number>()
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
          message: err.message,
          stack: err.stack,
          userId: req.user?.id ?? null,
          requestContext
        }).catch(() => {})
      }
      req.log.error(err)
      reply.code(status).send({
        statusCode: status,
        error: STATUS_CODES[status] ?? 'Error',
        message: err.message,
        ...(err.code && err.violations ? { code: err.code, violations: err.violations } : {}),
        ...(err.code === 'MIDAIR_COLLISION'
          ? { code: err.code, conflicts: err.conflicts, latest_revision: err.latest_revision }
          : {})
      })
    }
  )

  // Mission-control pulse — activity broadcasts need the io instance
  setPulseApp(app)

  // ─── Routes ───────────────────────────────────────────────────────────────
  await app.register(presencePublicRoutes, { prefix: '/api/presence' })
  await app.register(registerRoutes, { prefix: '/api' })
  await app.register(graphqlPlugin, { prefix: '/api' })
  await app.register(legacyCompatRoutes)
  await app.register(formRendererRoutes)
  await app.register(sharePublicRoutes)

  // ─── Serve admin static build (release image) ────────────────────────────
  const adminBuildPath = join(import.meta.dirname, '../../admin/dist')
  if (existsSync(adminBuildPath)) {
    await app.register(fastifyStatic, { root: adminBuildPath, prefix: '/' })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
        return reply.code(404).send({ error: 'Not found' })
      }
      reply.sendFile('index.html')
    })
  }

  // ─── Extensions + Scheduled flows (self-hosted only) ────────────────────
  // These query the static DB at startup — skipped in cloud mode.
  if (!process.env.CLOUD_META_DB_URL) {
    setApp(app)
    await loadExtensions({
      app,
      database: db,
      inngest: app.inngest,
      logger: app.log,
      callExternalApi
    })
    await loadScheduledFlows(app)
  }

  // ─── Cloud extensions ─────────────────────────────────────────────────────
  // Loaded AFTER cron + inngest plugins so ctx.app.cron and app.inngest are available.
  if (process.env.CLOUD_META_DB_URL) {
    setApp(app)
    await loadCloudExtensions({
      app,
      database: db,
      inngest: app.inngest,
      logger: app.log,
      callExternalApi,
      cloud: {
        getTenantId,
        getTenantSlug,
        metaDb: getMetaDb()
      }
    })
  }

  // ─── Daily retention purge (self-hosted only) ─────────────────────────────
  // In cloud mode, retention runs per-tenant via the provisioning system.
  if (!process.env.CLOUD_META_DB_URL)
    app.addHook('onReady', async () => {
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
            const q = db('nivaro_activity')
              .where('timestamp', '<', cutoff)
              .whereNull('legacy_id')
            if (overrides.length > 0) q.whereNotIn('collection', overrides.map((o) => o.collection))
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

      // ── User retention policies — schedule active crons ──────────────────────
      async function scheduleRetentionPolicies() {
        try {
          const policies = await db('nivaro_retention_policies')
            .where({ is_active: true })
            .whereNotNull('cron_schedule')
          for (const p of policies) {
            const cronId = `retention-policy-${p.id}`
            app.cron.schedule(cronId, p.cron_schedule, async () => {
              try {
                const fresh = await db('nivaro_retention_policies').where({ id: p.id }).first()
                if (!fresh?.is_active) return
                const { executeRetentionPolicy } = await import('./services/retention.js')
                await executeRetentionPolicy(fresh, undefined, false)
              } catch (err) {
                app.log.error({ err }, `[retention] policy ${p.id} cron failed`)
              }
            })
          }
        } catch (err) {
          app.log.warn({ err }, '[retention] failed to schedule cron policies')
        }
      }
      scheduleRetentionPolicies()

      // ── Scheduled reports — email PDF snapshots on their cron ────────────────
      async function scheduleReports() {
        try {
          const reports = await db('nivaro_scheduled_reports').where({ is_active: true })
          for (const r of reports) {
            app.cron.schedule(`scheduled-report-${r.id}`, r.cron_schedule, async () => {
              try {
                const fresh = await db('nivaro_scheduled_reports').where({ id: r.id }).first()
                if (!fresh?.is_active) return
                const { runScheduledReport } = await import('./services/scheduled-reports.js')
                await runScheduledReport(fresh)
              } catch (err) {
                app.log.error({ err }, `[scheduled-reports] report ${r.id} cron failed`)
              }
            })
          }
        } catch (err) {
          app.log.warn({ err }, '[scheduled-reports] failed to schedule crons')
        }
      }
      scheduleReports()

      // ── Report Studio — hourly alert checks + daily/weekly subscription mail ──
      // Auto-transition sweep: date-based transition conditions (within_days etc.)
      // can become true purely by time passing — re-evaluate hourly.
      // SLA escalation ladders: tiered, ack-aware breach escalation.
      app.cron.schedule('sla-escalations', '*/30 * * * *', async () => {
        const { runSlaEscalations } = await import('./services/sla-escalations.js')
        await runSlaEscalations(app)
      })

      // Config health: nightly usage-hygiene + schema-lint sweep.
      app.cron.schedule('config-health-sweep', '10 3 * * *', async () => {
        const { runConfigHealthSweep } = await import('./services/config-health.js')
        await runConfigHealthSweep()
      })

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
      app.cron.schedule('maintenance-windows', '* * * * *', async () => {
        const { sweepMaintenanceWindows } = await import('./services/maintenance-windows.js')
        await sweepMaintenanceWindows(app)
      })

      // Post-deploy smoke (#299): a version change gets one health verdict at
      // minute one instead of waiting for the first user report.
      setTimeout(() => {
        void import('./services/maintenance-windows.js').then(({ postDeploySmoke }) =>
          postDeploySmoke(app)
        )
      }, 60_000)

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
        await db('nivaro_storage_snapshots')
          .insert({
            snapshot_date: today,
            db_mb: dbMb,
            uploads_mb: uploadsMb,
            top_tables: JSON.stringify(topTables),
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
            const stmt = xml.match(/<inputbuf>([\s\S]*?)<\/inputbuf>/)?.[1]?.trim().slice(0, 200)
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

      // Pool monitor (#114): sustained pending acquires = saturation, which
      // reads as "randomly slow" everywhere else.
      app.cron.schedule('pool-monitor', '*/5 * * * *', async () => {
        const { poolStats } = await import('./routes/ops-db.js')
        const { trackError } = await import('./services/error-tracking.js')
        const p = poolStats()
        if (p.pending_acquires >= 5 && p.free === 0) {
          await trackError({
            source: 'server',
            route: 'pool-monitor',
            severity: 'high',
            message: `DB connection pool saturated: ${p.used}/${p.max} in use, ${p.pending_acquires} requests waiting`
          })
        }
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
                ((await db(col).whereIn('id', ids).select('id')) as Array<{ id: unknown }>).map((x) =>
                  String(x.id)
                )
              )
              const dead = subs.filter((x) => !existing.has(String(x.filter_value)))
              if (dead.length > 0) {
                await db('nivaro_notification_subscriptions')
                  .whereIn('id', dead.map((x) => x.id))
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
              .whereIn('id', viewSubs.map((x) => x.id))
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
            .map((r) => `#${r.session_id} waits ${Math.round(r.wait_time / 1000)}s (${r.wait_type ?? '?'}) on #${r.blocking_session_id}`)
            .join('\n')}`,
          severity: worst > 120_000 ? 'critical' : 'high'
        })
      })

      // Chat-bot reminders — "@efp remind me Friday about X". Due rows deliver
      // via notifyUser (in-app + web push) and mark sent; failures retry next tick.
      app.cron.schedule('chat-reminders', '*/5 * * * *', async () => {
        const { db } = await import('./db/index.js')
        const due = (await db('nivaro_reminders')
          .where('sent', false)
          .where('remind_at', '<=', new Date())
          .limit(50)) as Array<{ id: number; user: string; note: string; room: string | null }>
        if (due.length === 0) return
        const { notifyUser } = await import('./services/notification-channels.js')
        for (const r of due) {
          try {
            await notifyUser(app, String(r.user), {
              subject: 'Reminder',
              message: r.note,
              sender: null,
              collection: r.room ? '__chat__' : null,
              item: r.room ? String(r.room) : null
            })
            await db('nivaro_reminders').where('id', r.id).update({ sent: true })
          } catch (err) {
            app.log.warn({ err, reminder: r.id }, 'reminder delivery failed')
          }
        }
      })

      app.cron.schedule('fk-integrity-sweep', '40 3 * * *', async () => {
        const { detectDanglingFks } = await import('./services/fk-integrity.js')
        const report = await detectDanglingFks()
        if (report.dangling_relations > 0) {
          app.log.warn(
            `dangling FKs: ${report.total_dangling_rows} rows across ${report.dangling_relations} relation(s)`
          )
        }
      })

      // Dead-file-link sweep: stat every stored file against the storage
      // provider (oldest verification first) and stamp nivaro_files.missing_at,
      // so file chips and the Files page render dead links honestly.
      // Manual: POST /api/cron/file-integrity-sweep/run.
      app.cron.schedule('file-integrity-sweep', '50 3 * * *', async () => {

    // Nightly config-conformance runs for scheduled collections, with a
    // regression note when a collection's issue count grew since last run.
    app.cron.schedule('conformance-nightly', '40 2 * * *', async () => {
      const { runConformance } = await import('./services/config-conformance.js')
      const schedules = (await db('nivaro_conformance_schedules').where('is_active', true)) as Array<{
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
        const runId = Number(typeof inserted === 'object' ? (inserted as { id: number }).id : inserted)
        await runConformance(runId, sch.collection, sch.row_cap > 0 ? sch.row_cap : Number.MAX_SAFE_INTEGER)
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

    app.cron.schedule('readiness-snapshot', '50 6 * * *', async () => {
      const { runReadinessChecks } = await import('./services/readiness.js')
      const report = await runReadinessChecks()
      if (report.checks.length === 0) return
      const today = new Date().toISOString().slice(0, 10)
      const exists = await db('nivaro_readiness_snapshots').where('snapshot_date', today).first('id')
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
        const { fileIntegritySweep } = await import('./services/file-integrity.js')
        const r = await fileIntegritySweep()
        if (r.newly_missing > 0) {
          app.log.warn(
            `file integrity: ${r.newly_missing} file(s) newly missing (${r.missing} missing of ${r.checked} checked)`
          )
        }
      })

      // Rollup drift detection — stored rollups can silently go stale (chained
      // rollups don't cascade; recalc failures are swallowed by design), and
      // nothing ever went back to check. Nightly sample-compare, drift lands as
      // deduped nivaro_issues rows. Manual run: POST /api/cron/rollup-drift-sweep/run.
      app.cron.schedule('rollup-drift-sweep', '20 3 * * *', async () => {
        const { detectRollupDrift } = await import('./services/rollup-drift.js')
        const report = await detectRollupDrift()
        if (report.drifted_rows > 0) {
          app.log.warn(
            `rollup drift: ${report.drifted_rows} stale rows across ${report.fields.length} field(s)`
          )
        }
      })

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

      // ── Metric alert engine (EFP Alert Manager parity) ────────────────────────
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
        'chat-reminders'
      ]) {
        app.cron.annotate(id, { idempotent: 'unsafe' })
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
        const stranded = (await db('nivaro_job_runs')
          .where('status', 'running')
          .where('started_at', '<', bootTime)
          .limit(50)
          .select('id', 'kind', 'job_id')) as Array<{ id: number; kind: string; job_id: string }>
        if (stranded.length > 0) {
          await db('nivaro_job_runs')
            .whereIn('id', stranded.map((r) => r.id))
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
    })

  return app
}
