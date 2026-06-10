import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
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

    const status = dbOk && redisOk ? 'ok' : 'degraded'
    const code = status === 'ok' ? 200 : 503

    return reply.code(code).send({
      status,
      version: '0.1.0',
      environment: config.NODE_ENV,
      db: {
        status: dbOk ? 'connected' : 'disconnected',
        database: config.DB_DATABASE,
        host: config.DB_HOST
      },
      redis: {
        status: redisOk ? 'connected' : 'disconnected',
        url: config.REDIS_URL
      },
      ts: new Date().toISOString()
    })
  })

  // GET /health/detailed — admin-only subsystem diagnostics
  app.get('/health/detailed', { preHandler: requireAdmin }, async (_req, reply) => {
    // DB latency
    const dbStart = Date.now()
    const dbOk = await db
      .raw('SELECT 1')
      .then(() => true)
      .catch(() => false)
    const dbLatency = Date.now() - dbStart

    // Redis latency
    const redisStart = Date.now()
    const redisOk = await app.redis
      .ping()
      .then((r) => r === 'PONG')
      .catch(() => false)
    const redisLatency = Date.now() - redisStart

    // Inngest — no health URL is exposed via config; in development the dev
    // server runs on localhost:8288, so probe it there. Otherwise 'unknown'.
    let inngestStatus: boolean | 'unknown' = 'unknown'
    if (config.NODE_ENV === 'development') {
      try {
        const res = await fetch('http://localhost:8288/health', {
          signal: AbortSignal.timeout(1500)
        })
        inngestStatus = res.ok
      } catch {
        inngestStatus = false
      }
    }

    // Migrations
    let migrations: { latest: string | null; count: number } = { latest: null, count: 0 }
    try {
      const [latestRow, countRow] = await Promise.all([
        db('cms_knex_migrations').orderBy('id', 'desc').first('name'),
        db('cms_knex_migrations').count('* as c').first()
      ])
      migrations = {
        latest: latestRow?.name ?? null,
        count: Number(countRow?.c ?? 0)
      }
    } catch {
      // table missing or unreadable — leave defaults
    }

    // Socket.io connections
    let connections: number | null = null
    try {
      connections = app.io?.engine?.clientsCount ?? null
    } catch {
      connections = null
    }

    return reply.send({
      data: {
        db: { ok: dbOk, latency_ms: dbLatency },
        redis: { ok: redisOk, latency_ms: redisLatency },
        inngest: { ok: inngestStatus },
        migrations,
        sockets: { connections },
        uptime_s: Math.round(process.uptime()),
        node_version: process.version,
        memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024))
      }
    })
  })
}
