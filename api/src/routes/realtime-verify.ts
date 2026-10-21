import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Realtime verification (admin, under /api/realtime): the tooling that proves the realtime
 * claims rather than asserting them.
 *
 *   GET  /chaos                      #2463 drills (newest first, every replica's counters)
 *   POST /chaos                      start one {target, fault, seconds}
 *   POST /chaos/:id/stop             end it early
 *   GET  /delivery-slo               #2477 delivery SLO (probe + client acks, per replica)
 *   GET  /leak-audit                 #2760 findings + this process's sampler figures
 *   POST /leak-audit                 timed audit {rate (0 = stop), minutes}
 *   GET  /replay/capture?minutes=    #2478 capture of the event stream (ids only)
 *   GET  /replay/runs                runs on this server + whether it accepts replays
 *   POST /replay/runs                create a run {capture, speed} (target side, staging only)
 *   POST /replay/runs/:id/go         start emitting {secret}
 *   POST /replay/runs/:id/stop       stop + server-side report {secret}
 */

function fail(reply: FastifyReply, err: unknown) {
  const e = err as { statusCode?: number; message?: string }
  if (e?.statusCode && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: e.message ?? 'Refused' })
  throw err
}

function userName(u: { first_name?: string | null; last_name?: string | null; email?: string }) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null
}

async function sloTargets() {
  const { parseSloTargets } = await import('../services/slo.js')
  const row = await db('nivaro_settings')
    .first('slo_targets')
    .catch(() => null)
  return parseSloTargets((row as { slo_targets?: unknown } | null)?.slo_targets)
}

export async function realtimeVerifyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)
  app.addHook('onReady', async () => {
    const [{ ensureChaosListener }, { getIo }] = await Promise.all([
      import('../services/socket-chaos.js'),
      import('../services/io-holder.js')
    ])
    ensureChaosListener(getIo())
  })

  // ── #2463 socket chaos ──────────────────────────────────────────────────────
  app.get('/chaos', async () => {
    const { chaosRefusal, listChaosRuns } = await import('../services/socket-chaos.js')
    return { data: { refusal: chaosRefusal(), runs: await listChaosRuns(10) } }
  })

  app.post('/chaos', async (req, reply) => {
    const { startChaos } = await import('../services/socket-chaos.js')
    try {
      const u = req.user!
      const spec = await startChaos(req.body, { id: u?.id ?? null, name: u ? userName(u) : null })
      const t = spec.target
      const who =
        t.kind === 'room'
          ? `room ${t.room}`
          : t.kind === 'user'
            ? `one person`
            : `${t.share_pct}% of sockets`
      const f = spec.fault
      const faults = [
        f.latency_ms ? `${f.latency_ms} ms latency` : null,
        f.drop_pct ? `${f.drop_pct}% dropped` : null,
        f.disconnect === 'once'
          ? 'disconnected once'
          : f.disconnect === 'every'
            ? `disconnected every ${f.disconnect_every_s}s`
            : null
      ]
        .filter(Boolean)
        .join(', ')
      await logActivity({
        action: 'realtime-chaos',
        user: u?.id,
        comment: `Socket drill on ${who}: ${faults} for ${spec.seconds}s`,
        req
      })
      return { data: spec }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { id: string } }>('/chaos/:id/stop', async (req, reply) => {
    const { stopChaos } = await import('../services/socket-chaos.js')
    const ok = await stopChaos(String(req.params.id))
    if (!ok) return reply.code(404).send({ error: 'No such drill' })
    return { data: { stopped: true } }
  })

  // ── #2477 delivery SLO ──────────────────────────────────────────────────────
  app.get('/delivery-slo', async () => {
    const { computeDeliverySlo } = await import('../services/realtime-delivery-slo.js')
    return { data: await computeDeliverySlo(await sloTargets()) }
  })

  // ── #2760 leak auditor ─────────────────────────────────────────────────────
  // Findings and the timed switch are instance-wide, so the auditor never runs in cloud mode.
  const leakRefused = (reply: FastifyReply) =>
    process.env.CLOUD_META_DB_URL
      ? reply.code(403).send({ error: 'The leak audit never runs in cloud mode' })
      : null
  app.get('/leak-audit', async (_req, reply) => {
    const refused = leakRefused(reply)
    if (refused) return refused
    const { envAuditRate, leakAuditStats, recentLeakFindings } = await import(
      '../services/realtime-leak-audit.js'
    )
    const recent = await recentLeakFindings(100)
    // Names for the people in the findings (administrators read the directory anyway).
    const ids = [...new Set(recent.findings.map((f) => f.user_id))].slice(0, 100)
    const people = ids.length
      ? ((await db('nivaro_users')
          .whereIn('id', ids)
          .select('id', 'first_name', 'last_name', 'email')
          .catch(() => [])) as Array<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string
        }>)
      : []
    const names = new Map(people.map((p) => [String(p.id).toLowerCase(), userName(p)]))
    return {
      data: {
        env_rate: envAuditRate(),
        timed: recent.timed,
        total_findings: recent.total,
        process: leakAuditStats(),
        findings: recent.findings.map((f) => ({
          ...f,
          user_name: names.get(f.user_id.toLowerCase()) ?? null
        }))
      }
    }
  })

  app.post<{ Body: { rate?: number; minutes?: number } }>('/leak-audit', async (req, reply) => {
    const refused = leakRefused(reply)
    if (refused) return refused
    const rate = Number(req.body?.rate)
    const minutes = Number(req.body?.minutes ?? 60)
    if (!Number.isFinite(rate) || rate < 0 || rate > 1)
      return reply.code(400).send({ error: 'rate must be between 0 (stop) and 1' })
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440)
      return reply.code(400).send({ error: 'minutes must be between 1 and 1440' })
    const { setTimedAudit } = await import('../services/realtime-leak-audit.js')
    const r = await setTimedAudit(rate, minutes)
    await logActivity({
      action: 'realtime-leak-audit',
      user: req.user?.id,
      comment: rate > 0 ? `Leak audit at ${rate * 100}% for ${minutes} min` : 'Leak audit stopped',
      req
    })
    return { data: { rate, until: new Date(r.until).toISOString() } }
  })

  // ── #2478 socket replay ─────────────────────────────────────────────────────
  app.get<{ Querystring: { minutes?: string } }>('/replay/capture', async (req, reply) => {
    if (process.env.CLOUD_META_DB_URL)
      return reply.code(403).send({ error: 'Socket capture never runs in cloud mode' })
    const redis = app.redis
    if (!redis) return reply.code(503).send({ error: 'Redis is not available' })
    const minutes = Math.max(1, Math.min(15, Number(req.query.minutes) || 15))
    const [{ captureSocketTraffic }, { getRealtimeStats }] = await Promise.all([
      import('../services/socket-replay.js'),
      import('../plugins/socketio.js')
    ])
    const stats = getRealtimeStats()
    const since = new Date(Date.now() - 15 * 60_000)
    const samples = (await db('nivaro_concurrency_samples')
      .where('sampled_at', '>=', since)
      .orderBy('sampled_at', 'desc')
      .select('instance', 'sockets', 'users')
      .limit(500)
      .catch(() => [])) as Array<{ instance: string; sockets: number; users: number }>
    const newest = new Map<string, { instance: string; sockets: number; users: number }>()
    for (const s of samples) if (!newest.has(s.instance)) newest.set(s.instance, s)
    const capture = await captureSocketTraffic(redis, minutes, {
      rooms: stats.rooms,
      localSockets: stats.sockets.length,
      instances: [...newest.values()].map((s) => ({
        instance: String(s.instance),
        sockets: Number(s.sockets) || 0,
        users: Number(s.users) || 0
      })),
      origin: config.PUBLIC_URL
    })
    await logActivity({
      action: 'realtime-capture',
      user: req.user?.id,
      comment: `Socket traffic captured: ${capture.events.length} events over ${minutes} min`,
      req
    })
    return { data: capture }
  })

  const serverRefusal = async (captureOrigin: string | null) => {
    const { replayServerRefusal } = await import('../services/socket-replay.js')
    return replayServerRefusal(process.env, {
      captureOrigin,
      selfHosts: [config.PUBLIC_URL, config.ADMIN_URL]
    })
  }

  app.get('/replay/runs', async () => {
    const { replayRunsView } = await import('../services/socket-replay.js')
    return { data: { refusal: await serverRefusal(null), runs: replayRunsView() } }
  })

  app.post<{ Body: { capture?: { origin?: string | null }; speed?: number } }>(
    '/replay/runs',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req, reply) => {
      const refusal = await serverRefusal(req.body?.capture?.origin ?? null)
      if (refusal) return reply.code(403).send({ error: refusal })
      const { createReplayRun } = await import('../services/socket-replay.js')
      try {
        const run = createReplayRun(req.body, req.user?.id ?? null)
        await logActivity({
          action: 'realtime-replay',
          user: req.user?.id,
          comment: `Socket replay prepared: ${run.emits} events at ×${Number(req.body?.speed ?? 1)}`,
          req
        })
        return { data: run }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { secret?: string } }>(
    '/replay/runs/:id/go',
    async (req, reply) => {
      const refusal = await serverRefusal(null)
      if (refusal) return reply.code(403).send({ error: refusal })
      const { goReplayRun } = await import('../services/socket-replay.js')
      try {
        return { data: await goReplayRun(String(req.params.id), req.body?.secret, app.redis) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { secret?: string } }>(
    '/replay/runs/:id/stop',
    async (req, reply) => {
      const { stopReplayRun } = await import('../services/socket-replay.js')
      try {
        return {
          data: await stopReplayRun(String(req.params.id), req.body?.secret ?? '', app.redis)
        }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )
}
