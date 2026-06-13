import { config } from './config.js'
import { closeDb, runMigrationsSafely, migrationSource } from './db/index.js'
import { registerActivityHooks } from './hooks/activity.js'
import { registerAiValidationHooks, setApp as setAiValidationApp } from './hooks/ai-validation.js'
import { registerAlertHooks, setApp as setAlertApp } from './hooks/alerts.js'
import { registerCrossTriggerHooks, setApp as setCrossTriggerApp } from './hooks/cross-triggers.js'
import { registerEmbeddingHooks, setApp as setEmbeddingApp } from './hooks/embeddings.js'
import { registerFieldWatchHooks, setApp as setFieldWatchApp } from './hooks/field-watches.js'
import {
  registerNotificationSubscriptionHooks,
  setApp as setSubscriptionApp
} from './hooks/notification-subscriptions.js'
import { registerPipelineAutostartHooks } from './hooks/pipeline-autostart.js'
import { registerSlaHooks, setApp as setSlaApp } from './hooks/sla.js'
import { loadEventFlows } from './routes/flows.js'
import { buildServer } from './server.js'

async function main() {
  // Hook registrations query the DB immediately at startup — skip in cloud mode.
  // In cloud mode, per-tenant hooks fire per-request via the tenant middleware.
  if (!process.env.CLOUD_META_DB_URL) {
    registerActivityHooks()
    registerFieldWatchHooks()
    registerNotificationSubscriptionHooks()
    registerSlaHooks()
    registerPipelineAutostartHooks()
    registerAlertHooks()
    registerEmbeddingHooks()
    registerCrossTriggerHooks()
    registerAiValidationHooks()
  }

  // Run pending migrations on startup (self-hosted only).
  // In cloud mode, tenant migrations are run by the provisioning system.
  if (!process.env.CLOUD_META_DB_URL) {
    const [batch, migrations] = await runMigrationsSafely()
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

  const app = await buildServer()

  // These all query the static DB at startup — skip in cloud mode.
  if (!process.env.CLOUD_META_DB_URL) {
    await loadEventFlows(app)
    setFieldWatchApp(app)
    setSubscriptionApp(app)
    setSlaApp(app)
    setAlertApp(app)
    setEmbeddingApp(app)
    setCrossTriggerApp(app)
    setAiValidationApp(app)
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' })
  app.log.info(`Nivaro API listening on port ${config.PORT}`)

  // Graceful shutdown — stop accepting connections, let in-flight requests
  // drain (fastify close), then release DB pools.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`${signal} received — draining in-flight requests`)
    try {
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
