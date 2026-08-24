import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { config } from '../config.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { bustAllCaches, bustCache, listCaches } from '../services/cache-registry.js'
import { listInstances } from '../services/instance-roster.js'
import { runtimeStats } from '../services/runtime-monitor.js'
import { poolStats } from './ops-db.js'

/**
 * Runtime observability (Ops batch A): #234 runtime stats, #297 instance
 * roster, #236 cache console, #252 degradation map, #312 DB identity check.
 */

export async function opsRuntimeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // #234 — this process, right now.
  app.get('/runtime', async (_req, reply) => {
    return reply.send({ data: { ...runtimeStats(), pool: poolStats() } })
  })

  // #297 — every registered API process (Redis-backed, 90s TTL).
  app.get('/roster', async (_req, reply) => {
    return reply.send({ data: await listInstances() })
  })

  // #236 — in-process caches (PER REPLICA — the UI says so).
  app.get('/caches', async (_req, reply) => {
    return reply.send({ data: listCaches() })
  })
  app.post<{ Params: { name: string } }>('/caches/:name/bust', async (req, reply) => {
    const name = req.params.name
    const ok = name === '__all__' ? bustAllCaches().length > 0 : bustCache(name)
    if (!ok) return reply.code(404).send({ error: 'Unknown cache' })
    await logActivity({
      action: 'cache-bust',
      user: req.user?.id,
      comment: name === '__all__' ? 'all caches' : name,
      req
    })
    return reply.send({ data: { busted: name } })
  })

  // #252 — subsystem status → which FEATURES are impacted, in plain language.
  // The map is static knowledge; the status column is probed live.
  app.get('/degradation', async (_req, reply) => {
    const probe = async (fn: () => Promise<unknown>): Promise<'ok' | 'down'> => {
      try {
        await fn()
        return 'ok'
      } catch {
        return 'down'
      }
    }
    const redis = (app as unknown as { redis?: { ping: () => Promise<string> } }).redis
    const [dbStatus, redisStatus] = await Promise.all([
      probe(() => db.raw('SELECT 1')),
      redis ? probe(() => redis.ping()) : Promise.resolve('down' as const)
    ])
    const rows = [
      {
        subsystem: 'Database',
        status: dbStatus,
        impact_when_down:
          'Everything — reads, writes, auth lookups. The API stays up but every data request fails.'
      },
      {
        subsystem: 'Redis',
        status: redisStatus,
        impact_when_down:
          'Sessions require re-login; rate limiting fails OPEN; WS tokens, masquerade tokens and the event journal stop; custom-query result caching off; instance roster empty. Core reads/writes keep working.'
      },
      {
        subsystem: 'Inngest',
        status: 'unprobed' as const,
        impact_when_down:
          'Queue materialization backfills, scheduled flows and scheduled changes stop executing; everything interactive is unaffected.'
      },
      {
        subsystem: 'SMTP',
        status: 'unprobed' as const,
        impact_when_down:
          'Outgoing email silently no-ops (documented behavior); in-app notifications continue.'
      }
    ]
    return reply.send({ data: rows })
  })

  // #312 — per-environment expected database name; a mismatch is the
  // staging-pointed-at-dev incident waiting to repeat.
  app.get('/db-identity', async (_req, reply) => {
    const expected = process.env.NIVARO_EXPECTED_DB?.trim() || null
    return reply.send({
      data: {
        expected,
        actual: config.DB_DATABASE,
        mismatch: !!expected && expected !== config.DB_DATABASE
      }
    })
  })
}
