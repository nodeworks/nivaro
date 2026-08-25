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

  // #214 — maintenance windows: schedule start/end; the per-minute sweep flips
  // maintenance mode, the banner pre-announces (#218), the exit smoke-checks
  // and auto-sends the all-clear (#303).
  app.get('/maintenance-windows', async (_req, reply) => {
    const rows = await db('nivaro_maintenance_windows')
      .orderBy('starts_at', 'desc')
      .limit(50)
      .catch(() => [])
    return reply.send({ data: rows })
  })
  app.post<{
    Body: { title?: string; message?: string; starts_at?: string; ends_at?: string; send_all_clear?: boolean }
  }>('/maintenance-windows', async (req, reply) => {
    const title = String(req.body?.title ?? '').trim()
    const starts = req.body?.starts_at ? new Date(req.body.starts_at) : null
    const ends = req.body?.ends_at ? new Date(req.body.ends_at) : null
    if (!title) return reply.code(400).send({ error: 'title is required' })
    if (!starts || !ends || Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      return reply.code(400).send({ error: 'starts_at and ends_at must be valid datetimes' })
    }
    if (ends <= starts) return reply.code(400).send({ error: 'ends_at must be after starts_at' })
    await db('nivaro_maintenance_windows').insert({
      title: title.slice(0, 300),
      message: req.body?.message ? String(req.body.message).slice(0, 2000) : null,
      starts_at: starts,
      ends_at: ends,
      status: 'scheduled',
      send_all_clear: req.body?.send_all_clear !== false,
      created_by: req.user?.id ?? null,
      created_at: new Date()
    })
    await logActivity({ action: 'maintenance-window-create', user: req.user?.id, comment: title, req })
    const row = await db('nivaro_maintenance_windows').orderBy('id', 'desc').first()
    return reply.code(201).send({ data: row })
  })
  app.delete<{ Params: { id: string } }>('/maintenance-windows/:id', async (req, reply) => {
    // Cancelling an ACTIVE window also lifts maintenance mode.
    const row = (await db('nivaro_maintenance_windows')
      .where({ id: Number(req.params.id) })
      .first()) as { id: number; status: string; title: string } | undefined
    if (!row) return reply.code(404).send({ error: 'Window not found' })
    await db('nivaro_maintenance_windows').where({ id: row.id }).update({ status: 'cancelled' })
    if (row.status === 'active') {
      await db('nivaro_settings')
        .orderBy('id', 'asc')
        .first('id')
        .then((s) =>
          s ? db('nivaro_settings').where({ id: s.id }).update({ maintenance_mode: 0 }) : null
        )
      const { bustMaintenanceCache } = await import('../services/security.js')
      bustMaintenanceCache()
    }
    await logActivity({ action: 'maintenance-window-cancel', user: req.user?.id, comment: row.title, req })
    return reply.code(204).send()
  })

  // #299 — run the smoke suite on demand.
  app.post('/smoke', async (_req, reply) => {
    const { runSmokeCheck } = await import('../services/maintenance-windows.js')
    return reply.send({ data: await runSmokeCheck(app) })
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

  // #309 — follow-this-user tracing: their next N requests fully trace
  // regardless of speed. In-process (like the trace buffer itself).
  app.post<{ Body: { user_id?: string; requests?: number } }>('/trace-user', async (req, reply) => {
    const userId = String(req.body?.user_id ?? '').trim()
    if (!userId) return reply.code(400).send({ error: 'user_id is required' })
    const { followUser } = await import('../services/request-trace.js')
    followUser(userId, Math.min(200, Math.max(1, Number(req.body?.requests) || 50)))
    await logActivity({ action: 'trace-user', user: req.user?.id, comment: userId, req })
    return reply.send({ data: { following: userId } })
  })
  app.get('/trace-user', async (_req, reply) => {
    const { followedUsers } = await import('../services/request-trace.js')
    return reply.send({ data: followedUsers() })
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
