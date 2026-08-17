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
import { purgeExpiredTrash } from './services/trash.js'
import { purgeExpiredRecordings } from './routes/session-recordings.js'
import { getTenantId, getTenantSlug } from './db/tenant-context.js'
import { loadCloudExtensions, loadExtensions, setApp } from './extensions/loader.js'
import { registerFileCleanup } from './hooks/file-cleanup.js'
import { setPulseApp } from './services/activity.js'
import { trackError } from './services/error-tracking.js'
import { getMetaDb, tenantHook } from './middleware/tenant.js'
import { resolveWorkspace } from './middleware/workspace.js'
import { apiLoggerPlugin } from './plugins/api-logger.js'
import { requestTracePlugin } from './plugins/request-trace.js'
import { cronPlugin } from './plugins/cron.js'
import { graphqlPlugin } from './plugins/graphql.js'
import { legacyCompatRoutes } from './plugins/legacy-compat.js'
import { inngestPlugin } from './plugins/inngest.js'
import { rateLimitPlugin } from './plugins/rate-limit.js'
import { redisPlugin } from './plugins/redis.js'
import { socketioPlugin } from './plugins/socketio.js'
import { adminProvisionRoutes } from './routes/admin/provision.js'
import { loadScheduledFlows } from './routes/flows.js'
import { formRendererRoutes } from './routes/form-renderer.js'
import { sharePublicRoutes } from './routes/share-links.js'
import { registerRoutes } from './routes/index.js'
import { presencePublicRoutes } from './routes/presence.js'
import { registerDigestCrons } from './services/digest.js'
import { registerStagedImportWorker } from './services/staged-import-worker.js'
import { registerQueueSnapshotCron } from './services/queue-snapshots.js'
import { callExternalApi } from './services/external-apis.js'
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
    : await db('nivaro_settings').first('file_max_size_mb').catch(() => null)
  const _fileSizeMb = (_fsMb?.file_max_size_mb as number | null) ?? 50

  const app = fastify({
    bodyLimit: (_fileSizeMb + 8) * 1024 * 1024,
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
    if (!body || (body as string).trim() === '') { done(null, undefined); return }
    try { done(null, JSON.parse(body as string)) } catch (err) { done(err as Error, undefined) }
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
  await app.register(socketioPlugin)

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
  app.setErrorHandler(
    (err: Error & { statusCode?: number; code?: string; violations?: unknown }, req, reply) => {
      const status = err.statusCode ?? 500
      if (status >= 500 && req.url.startsWith('/api/')) {
        trackError({
          source: 'server',
          route: `${req.method} ${req.routeOptions?.url ?? req.url}`,
          message: err.message,
          stack: err.stack,
          userId: req.user?.id ?? null
        }).catch(() => {})
      }
      req.log.error(err)
      reply.code(status).send({
        statusCode: status,
        error: STATUS_CODES[status] ?? 'Error',
        message: err.message,
        ...(err.code && err.violations ? { code: err.code, violations: err.violations } : {})
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
  if (!process.env.CLOUD_META_DB_URL) app.addHook('onReady', async () => {
    async function runRetentionPurge() {
      try {
        const row = await db('nivaro_settings')
          .first('activity_retention_days', 'revision_retention_count')
          .catch(() => null)

        if (row?.activity_retention_days) {
          const cutoff = new Date(Date.now() - row.activity_retention_days * 86_400_000)
          // Imported legacy history (legacy_id NOT NULL) is permanent — retention applies to organic rows only.
          await db('nivaro_activity').where('timestamp', '<', cutoff).whereNull('legacy_id').delete()
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
    app.cron.schedule('daily-action-digest', '45 7 * * *', async () => {
      const { runDailyActionDigest } = await import('./services/daily-digest.js')
      await runDailyActionDigest()
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
    app.cron.schedule('fk-integrity-sweep', '40 3 * * *', async () => {
      const { detectDanglingFks } = await import('./services/fk-integrity.js')
      const report = await detectDanglingFks()
      if (report.dangling_relations > 0) {
        app.log.warn(
          `dangling FKs: ${report.total_dangling_rows} rows across ${report.dangling_relations} relation(s)`
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
      try {
        const { evaluateAlerts } = await import('./hooks/alerts.js')
        const fired = await evaluateAlerts()
        if (fired) app.log.info({ fired }, '[alerts] sweep pass')
      } catch (err) {
        app.log.warn({ err }, '[alerts] sweep failed')
      }
    })

    app.cron.schedule('report-studio-alerts', '0 * * * *', async () => {
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
  })

  return app
}
