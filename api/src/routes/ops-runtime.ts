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

  // #294 — clock skew sentinel: DB clock vs app clock, plus a DST audit of
  // crons scheduled in the 01:00-03:59 band (the hours DST transitions eat or
  // repeat).
  app.get('/clock', async (_req, reply) => {
    let skewMs: number | null = null
    try {
      const t0 = Date.now()
      const r = (await db.raw('SELECT GETUTCDATE() AS db_utc')) as Array<{ db_utc: Date }>
      const t1 = Date.now()
      const mid = (t0 + t1) / 2
      skewMs = new Date(r[0].db_utc).getTime() - mid
    } catch {
      /* db unreachable */
    }
    const dstBand = app.cron
      .list()
      .filter((j) => {
        const hour = j.expression.split(/\s+/)[1]
        return /^[0-3]$/.test(hour ?? '')
      })
      .map((j) => ({ id: j.id, expression: j.expression }))
    return reply.send({ data: { db_skew_ms: skewMs === null ? null : Math.round(skewMs), dst_band_crons: dstBand } })
  })

  // #301 — heap snapshot before a restart destroys the evidence. Written to
  // the scratch of the process; downloaded through the guarded route below.
  app.post('/heap-snapshot', async (req, reply) => {
    const { writeHeapSnapshot } = await import('node:v8')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const name = `nivaro-heap-${Date.now()}.heapsnapshot`
    const path = join(tmpdir(), name)
    writeHeapSnapshot(path)
    await logActivity({ action: 'heap-snapshot', user: req.user?.id, comment: name, req })
    return reply.send({ data: { name } })
  })
  app.get<{ Params: { name: string } }>('/heap-snapshot/:name', async (req, reply) => {
    const name = req.params.name
    if (!/^nivaro-heap-\d+\.heapsnapshot$/.test(name)) {
      return reply.code(400).send({ error: 'Invalid snapshot name' })
    }
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createReadStream, existsSync } = await import('node:fs')
    const path = join(tmpdir(), name)
    if (!existsSync(path)) return reply.code(404).send({ error: 'Snapshot not found (restarted?)' })
    reply.header('Content-Disposition', `attachment; filename="${name}"`)
    return reply.send(createReadStream(path))
  })

  // #235/#314 — rolling restart with safety gating: refuses while imports or
  // heavy jobs are mid-run (force=1 overrides), logs reason, exits AFTER the
  // reply flushes so the restart policy (docker / tsx watch) revives us.
  app.post<{ Body: { reason?: string; force?: boolean } }>('/restart', async (req, reply) => {
    const reason = String(req.body?.reason ?? '').trim()
    if (!reason) return reply.code(400).send({ error: 'A reason is required' })
    if (req.body?.force !== true) {
      const busy: string[] = []
      const runningJobs = (await db('nivaro_job_runs')
        .where('status', 'running')
        .limit(10)
        .select('job_id')
        .catch(() => [])) as Array<{ job_id: string }>
      if (runningJobs.length > 0) busy.push(`jobs running: ${runningJobs.map((r) => r.job_id).join(', ')}`)
      const imports = (await db('nivaro_import_queue')
        .where('status', 'running')
        .count('* as n')
        .first()
        .catch(() => ({ n: 0 }))) as { n: number }
      if (Number(imports?.n) > 0) busy.push(`${imports.n} staged import(s) running`)
      const csvImports = (await db('nivaro_import_jobs')
        .where('status', 'processing')
        .count('* as n')
        .first()
        .catch(() => ({ n: 0 }))) as { n: number }
      if (Number(csvImports?.n) > 0) busy.push(`${csvImports.n} collection import(s) processing`)
      if (busy.length > 0) {
        return reply.code(409).send({
          error: `Restart refused — work is mid-run: ${busy.join(' · ')}. Wait, or pass force.`
        })
      }
    }
    await logActivity({
      action: 'api-restart',
      user: req.user?.id,
      comment: `${reason}${req.body?.force ? ' (forced)' : ''}`,
      req
    })
    reply.raw.once('finish', () => {
      setTimeout(() => process.exit(0), 200)
    })
    return reply.send({ data: { restarting: true } })
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
