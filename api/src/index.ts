import { config } from './config.js'
import { closeDb, migrationSource, runMigrationsSafely } from './db/index.js'
import { registerCoreTriggers } from './flows/core-triggers.js'
import { registerActivityHooks } from './hooks/activity.js'
import { registerAggregateCapHooks, setApp as setAggregateCapApp } from './hooks/aggregate-caps.js'
import { registerAiValidationHooks, setApp as setAiValidationApp } from './hooks/ai-validation.js'
import { registerAlertHooks, setApp as setAlertApp } from './hooks/alerts.js'
import { registerCrossTriggerHooks, setApp as setCrossTriggerApp } from './hooks/cross-triggers.js'
import { registerEmbeddingHooks, setApp as setEmbeddingApp } from './hooks/embeddings.js'
import { registerFieldWatchHooks, setApp as setFieldWatchApp } from './hooks/field-watches.js'
import { registerSnoozeWakeHooks } from './hooks/notification-snooze.js'
import {
  registerNotificationSubscriptionHooks,
  setApp as setSubscriptionApp
} from './hooks/notification-subscriptions.js'
import { registerPipelineAutostartHooks } from './hooks/pipeline-autostart.js'
import { registerQueueMaterializationHooks } from './hooks/queue-materialization.js'
import { registerRecordIntegrityHooks } from './hooks/record-integrity.js'
import { registerTaskDoneWhenHooks } from './hooks/task-done-when.js'
import { registerWorkflowAutoHooks } from './hooks/workflow-auto.js'
import { loadEventFlows } from './routes/flows.js'
import { buildServer } from './server.js'
import {
  bootPhase,
  bootReport,
  markBootPhase,
  markBootReady,
  markShuttingDown,
  storeBoot
} from './services/boot-phases.js'
import { startDevExtensionWatch } from './services/dev-extension-watch.js'
import { NIVARO_VERSION } from './version.js'

async function main() {
  // Hook registrations query the DB immediately at startup — skip in cloud mode.
  // In cloud mode, per-tenant hooks fire per-request via the tenant middleware.
  if (!process.env.CLOUD_META_DB_URL) {
    registerActivityHooks()
    registerFieldWatchHooks()
    registerNotificationSubscriptionHooks()
    registerPipelineAutostartHooks()
    registerAlertHooks()
    registerEmbeddingHooks()
    registerCrossTriggerHooks()
    registerAiValidationHooks()
    registerAggregateCapHooks()
    registerQueueMaterializationHooks()
    registerRecordIntegrityHooks()
    registerSnoozeWakeHooks()
    registerTaskDoneWhenHooks()
    registerWorkflowAutoHooks()
    registerCoreTriggers()
  }

  // Run pending migrations on startup (self-hosted only).
  // In cloud mode, tenant migrations are run by the provisioning system.
  // SKIP_BOOT_MIGRATIONS=1 boots against a database WITHOUT migrating it (a
  // throwaway API pointed at a database it must only inspect — pnpm dev:db);
  // /api/ready still reports any pending files.
  if (process.env.SKIP_BOOT_MIGRATIONS === '1') {
    console.log('Migrations: skipped (SKIP_BOOT_MIGRATIONS=1)')
  } else if (!process.env.CLOUD_META_DB_URL) {
    const [batch, migrations] = await bootPhase('Migrations', () => runMigrationsSafely())
    if (migrations.length > 0) {
      console.log(`Migrations: ran batch ${batch}: ${migrations.join(', ')}`)
    }
  }

  // Cloud mode: keep the template DB up to date on every deploy.
  // This means adding a migration file + deploying is enough to update the template.
  // Existing tenants still need pnpm migrate-all from nivaro-cloud.
  if (process.env.CLOUD_META_DB_URL) {
    const { default: knex } = await import('knex')
    const metaUrl = process.env.CLOUD_META_DB_URL
    const templateUrl = metaUrl.replace(/\/[^/?]+(\?|$)/, '/nivaro_template$1')
    const templateDb = knex({
      client: 'pg',
      connection: templateUrl,
      pool: { min: 1, max: 2 },
      migrations: { migrationSource, tableName: 'nivaro_migrations' }
    })
    try {
      const [batch, migrations] = await templateDb.migrate.latest()
      if (migrations.length > 0) {
        console.log(`Template DB: batch ${batch} — ${migrations.join(', ')}`)
      }
    } catch (err: any) {
      // Non-fatal: log and continue. Template may not exist yet.
      console.warn(`Template DB migration skipped: ${err.message}`)
    } finally {
      await templateDb.destroy()
    }
  }

  const app = await bootPhase('Server: plugins, routes, extensions', () => buildServer())

  // These all query the static DB at startup — skip in cloud mode.
  if (!process.env.CLOUD_META_DB_URL) {
    await bootPhase('Event flows', () => loadEventFlows(app))
    setFieldWatchApp(app)
    setSubscriptionApp(app)
    setAlertApp(app)
    setEmbeddingApp(app)
    setCrossTriggerApp(app)
    setAiValidationApp(app)
    setAggregateCapApp(app)
  }

  // A development restart can race the previous child still releasing the
  // port (tsx watch starts the new process while the old one drains), and tsx
  // does not retry a child that exits at boot — an EADDRINUSE here would sit
  // as a silent "hang" until the next save. Retry briefly in development.
  const attempts = config.NODE_ENV === 'development' ? 20 : 1
  const listenBegan = Date.now()
  for (let i = 1; ; i++) {
    try {
      await app.listen({ port: config.PORT, host: '0.0.0.0' })
      break
    } catch (err) {
      if ((err as { code?: string }).code !== 'EADDRINUSE' || i >= attempts) throw err
      if (i === 1)
        app.log.warn(
          `port ${config.PORT} still in use — waiting for the previous process to release it`
        )
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  markBootPhase('Listen (ready hooks run here)', Date.now() - listenBegan)
  markBootReady()
  app.log.info(`Nivaro API v${NIVARO_VERSION} listening on port ${config.PORT}`)
  {
    const report = bootReport()
    app.log.info(
      { total_ms: report.total_ms, phases: report.phases.map((p) => `${p.name} ${p.ms}ms`) },
      'Boot phases'
    )
    const redis = (app as unknown as { redis?: Parameters<typeof storeBoot>[0] }).redis
    if (redis) {
      const { instanceKey } = await import('./services/settings-overrides.js')
      const key = instanceKey()
      void storeBoot(redis, key)
      // Background phases (cache warms, the schema build) land a little later.
      const later = setTimeout(() => void storeBoot(redis, key), 90_000)
      later.unref()
    }
  }
  // Development: an edit under a loaded extension restarts this process (tsx
  // watch never sees those files — they are loaded by dynamic import).
  startDevExtensionWatch(config.NODE_ENV, (m) => app.log.info(m))

  // Graceful shutdown — stop accepting connections, let in-flight requests
  // drain (fastify close), then release DB pools.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    // /ready answers 503 from here, so the proxy routes new requests elsewhere.
    markShuttingDown()
    app.log.info(`${signal} received — draining in-flight requests`)
    // A drain that never finishes (a pool that will not release, a socket
    // that will not close) must not keep the old process alive: tsx watch
    // waits for it before starting the new one, so in development a hung
    // drain read as "the API hangs after every save". Production gets a
    // longer budget for genuinely in-flight requests.
    const deadlineMs = config.NODE_ENV === 'development' ? 3_000 : 15_000
    const deadline = setTimeout(() => {
      app.log.warn(`Shutdown did not finish within ${deadlineMs}ms — exiting`)
      process.exit(0)
    }, deadlineMs)
    deadline.unref()
    try {
      // #313 — report what the shutdown cuts: running job runs are marked
      // interrupted NOW (with a shutdown note) rather than discovered as
      // stranded rows by the next boot's restart-impact sweep.
      try {
        const { db } = await import('./db/index.js')
        // #1051 — only THIS process's runs. The dev laptop shares its database with staging:
        // unscoped, a laptop shutdown listed (and marked interrupted) staging's in-flight runs.
        const { hasColumn } = await import('./lib/column-probe.js')
        const { INSTANCE_ID } = await import('./services/instance-roster.js')
        const own = await hasColumn('nivaro_job_runs', 'instance_id').catch(() => false)
        const running = (await db('nivaro_job_runs')
          .where('status', 'running')
          .modify((q) => {
            if (own) q.where('instance_id', INSTANCE_ID)
          })
          .limit(50)
          .select('id', 'job_id')) as Array<{ id: number; job_id: string }>
        if (running.length > 0) {
          app.log.warn(
            `Shutdown is cutting ${running.length} running job(s): ${running.map((r) => r.job_id).join(', ')}`
          )
          await db('nivaro_job_runs')
            .whereIn(
              'id',
              running.map((r) => r.id)
            )
            .update({ status: 'interrupted', finished_at: new Date() })
        }
      } catch {
        /* best-effort bookkeeping — never delay the drain */
      }
      await app.close()
      await closeDb()
      process.exit(0)
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown')
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
