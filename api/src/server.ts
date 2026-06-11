import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyCors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import fastify from 'fastify'
import { registerSession } from './auth/session.js'
import { config } from './config.js'
import { db } from './db/index.js'
import { loadExtensions, setApp } from './extensions/loader.js'
import { registerFileCleanup } from './hooks/file-cleanup.js'
import { resolveWorkspace } from './middleware/workspace.js'
import { apiLoggerPlugin } from './plugins/api-logger.js'
import { cronPlugin } from './plugins/cron.js'
import { graphqlPlugin } from './plugins/graphql.js'
import { inngestPlugin } from './plugins/inngest.js'
import { rateLimitPlugin } from './plugins/rate-limit.js'
import { redisPlugin } from './plugins/redis.js'
import { socketioPlugin } from './plugins/socketio.js'
import { loadScheduledFlows } from './routes/flows.js'
import { formRendererRoutes } from './routes/form-renderer.js'
import { registerRoutes } from './routes/index.js'
import { presencePublicRoutes } from './routes/presence.js'
import { registerDigestCrons } from './services/digest.js'
import { callExternalApi } from './services/external-apis.js'

export async function buildServer() {
  const app = fastify({
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

  // ─── CORS ──────────────────────────────────────────────────────────────────
  // Open to all origins, no credentials — tracker runs on external sites.
  // Admin UI is same-origin in prod; Vite proxy makes it same-origin in dev.
  await app.register(fastifyCors, { origin: '*', credentials: false })

  // ─── Multipart (file uploads) ──────────────────────────────────────────────
  const _fsMb = await db('nivaro_settings')
    .first('file_max_size_mb')
    .catch(() => null)
  const _fileSizeMb = (_fsMb?.file_max_size_mb as number | null) ?? 50
  await app.register(fastifyMultipart, {
    limits: { fileSize: _fileSizeMb * 1024 * 1024 }
  })

  // ─── Redis ─────────────────────────────────────────────────────────────────
  await app.register(redisPlugin)

  // ─── Rate limiting + API analytics logging ────────────────────────────────
  await app.register(rateLimitPlugin)
  await app.register(apiLoggerPlugin)

  // ─── Sessions ─────────────────────────────────────────────────────────────
  await registerSession(app)

  // ─── Socket.io ────────────────────────────────────────────────────────────
  await app.register(socketioPlugin)

  // ─── Inngest ──────────────────────────────────────────────────────────────
  await app.register(inngestPlugin)

  // ─── Cron ─────────────────────────────────────────────────────────────────
  await app.register(cronPlugin)
  registerFileCleanup(app.cron)
  registerDigestCrons(app.cron)

  // ─── Workspace context ────────────────────────────────────────────────────
  app.addHook('preHandler', resolveWorkspace)

  // ─── Routes ───────────────────────────────────────────────────────────────
  await app.register(presencePublicRoutes, { prefix: '/api/presence' })
  await app.register(registerRoutes, { prefix: '/api' })
  await app.register(graphqlPlugin, { prefix: '/api' })
  await app.register(formRendererRoutes)

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

  // ─── Extensions ───────────────────────────────────────────────────────────
  setApp(app)
  await loadExtensions({
    app,
    database: db,
    inngest: app.inngest,
    logger: app.log,
    callExternalApi
  })

  // ─── Scheduled flows ──────────────────────────────────────────────────────
  await loadScheduledFlows(app)

  // ─── Daily retention purge ─────────────────────────────────────────────────
  app.addHook('onReady', async () => {
    async function runRetentionPurge() {
      try {
        const row = await db('nivaro_settings')
          .first('activity_retention_days', 'revision_retention_count')
          .catch(() => null)

        if (row?.activity_retention_days) {
          const cutoff = new Date(Date.now() - row.activity_retention_days * 86_400_000)
          await db('nivaro_activity').where('timestamp', '<', cutoff).delete()
        }

        if (row?.revision_retention_count) {
          const n = row.revision_retention_count as number
          const pairs = await (db('nivaro_revisions')
            .select('collection', 'item')
            .count({ cnt: '*' })
            .groupBy('collection', 'item')
            .havingRaw('COUNT(*) > ?', [n]) as unknown as Promise<
            Array<{ collection: string; item: string; cnt: string | number }>
          >)
          for (const pair of pairs) {
            const keep = await db('nivaro_revisions')
              .where({ collection: pair.collection, item: pair.item })
              .orderBy('id', 'desc')
              .limit(n)
              .pluck('id')
            if (keep.length) {
              await db('nivaro_revisions')
                .where({ collection: pair.collection, item: pair.item })
                .whereNotIn('id', keep)
                .delete()
            }
          }
        }
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
  })

  return app
}
