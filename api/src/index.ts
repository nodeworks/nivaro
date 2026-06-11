import { config } from './config.js'
import { closeDb, runMigrationsSafely } from './db/index.js'
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
  registerActivityHooks()
  registerFieldWatchHooks()
  registerNotificationSubscriptionHooks()
  registerSlaHooks()
  registerPipelineAutostartHooks()
  registerAlertHooks()
  registerEmbeddingHooks()
  registerCrossTriggerHooks()
  registerAiValidationHooks()

  // Run pending migrations on startup. With MIGRATION_SAFE_MODE=true this is
  // guarded by a DB advisory lock so rolling-deploy instances never race.
  const [batch, migrations] = await runMigrationsSafely()
  if (migrations.length > 0) {
    console.log(`Migrations: ran batch ${batch}: ${migrations.join(', ')}`)
  }

  const app = await buildServer()

  await loadEventFlows(app)
  setFieldWatchApp(app)
  setSubscriptionApp(app)
  setSlaApp(app)
  setAlertApp(app)
  setEmbeddingApp(app)
  setCrossTriggerApp(app)
  setAiValidationApp(app)

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
