import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { NIVARO_VERSION } from '../version.js'

let changelogCache: { generated_at?: string | null; releases: unknown[] } | null = null

export async function healthRoutes(app: FastifyInstance) {
  // GET /version — the cheapest possible "what build is running" probe: no DB,
  // no Redis, no auth. Clients poll this to notice a deploy (see the shared
  // api-version watcher); /health does I/O on every call and must not be used
  // for that. `environment` lets a client name which environment moved.
  app.get('/version', async (_req, reply) => {
    return reply.send({
      version: NIVARO_VERSION,
      environment: config.NODE_ENV,
      cloud: !!process.env.CLOUD_META_DB_URL
    })
  })

  /**
   * GET /changelog — what shipped in each release.
   *
   * Read from changelog.json, generated from git TAGS at build time and copied
   * into the image: the running container has no git repository, and asking it
   * to grow one to answer a page would be absurd. Cached after the first read
   * since the file cannot change while the process lives.
   *
   * Public, like /version: it lists release notes for the software itself, and
   * gating it would only stop people knowing what they are running.
   */
  app.get('/changelog', async (_req, reply) => {
    if (!changelogCache) {
      const here = dirname(fileURLToPath(import.meta.url))
      // dev: api/src/routes → repo root. image: /app/api/dist/routes → /app.
      const candidates = [
        resolve(here, '../../../changelog.json'),
        resolve(here, '../../changelog.json'),
        resolve(process.cwd(), 'changelog.json')
      ]
      changelogCache = { generated_at: null, releases: [] }
      for (const file of candidates) {
        try {
          changelogCache = JSON.parse(readFileSync(file, 'utf8'))
          break
        } catch {
          // try the next location
        }
      }
    }
    return reply.send({
      data: { ...changelogCache, running: NIVARO_VERSION }
    })
  })

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
      version: NIVARO_VERSION,
      environment: config.NODE_ENV,
      cloud: !!process.env.CLOUD_META_DB_URL,
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

    // Inngest — INNGEST_HEALTH_URL when configured (compose/stack service
    // address); development falls back to the local dev server. Else 'unknown'.
    let inngestStatus: boolean | 'unknown' = 'unknown'
    const inngestHealthUrl =
      config.INNGEST_HEALTH_URL ??
      (config.NODE_ENV === 'development' ? 'http://localhost:8288/health' : null)
    if (inngestHealthUrl) {
      try {
        const res = await fetch(inngestHealthUrl, { signal: AbortSignal.timeout(1500) })
        inngestStatus = res.ok
      } catch {
        inngestStatus = false
      }
    }

    // Migrations
    let migrations: { latest: string | null; count: number } = { latest: null, count: 0 }
    try {
      const [latestRow, countRow] = await Promise.all([
        db('nivaro_migrations').orderBy('id', 'desc').first('name'),
        db('nivaro_migrations').count('* as c').first()
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
        version: NIVARO_VERSION,
        node_version: process.version,
        memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024))
      }
    })
  })
}
