// api/src/routes/traffic-map-extras/ops.ts
/**
 * Traffic Map — ops, health and capacity (group E):
 *   GET  /screens               calls, loads and fan-out per originating screen (#1113 / #1116)
 *   GET  /screens/of            screens one caller or entity was called from (#1113)
 *   GET  /health                event loop, GC, journal and watch rooms of this node (#1142 / #1101)
 *   GET  /capacity              headroom against the measured ceiling + 15-min projection (#1123 / #1153)
 *   GET  /caller-cost           a caller's cost per hour: DB time, rows, AI spend (#1122)
 *   GET  /markers               restarts, deploys, config writes, maintenance in a range (#1093)
 *   GET  /inflight              unfinished requests and the SQL they run (#1147)
 *   POST /inflight/:id/kill-sql KILL the session running that SQL — reason required (#1156)
 *   GET|POST|DELETE /breakers   circuit breakers on an entity or caller (#1157)
 * Mounted under /api/traffic-map by traffic-map-extras/index.ts (admin only, 404 in cloud).
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { logActivity } from '../../services/activity.js'
import { currentTraceMeta } from '../../services/request-trace.js'
import {
  activeBreakers,
  type Breaker,
  type BreakerKind,
  type BreakerMode,
  breakersAvailable,
  clearBreaker,
  MAX_MINUTES,
  setBreaker,
  validTarget
} from '../../services/traffic-breaker.js'
import {
  listInflight,
  oldestRunning,
  pickSession,
  processIdentity,
  type SessionCandidate
} from '../../services/traffic-inflight.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import { callerCost, validCallerKey } from '../../services/traffic-taps/caller-cost.js'
import { capacityReport, startCapacitySampling } from '../../services/traffic-taps/capacity.js'
import {
  changeMarkers,
  recordBootVersion,
  startEpochMarkers
} from '../../services/traffic-taps/change-markers.js'
import { nodeHealth, startNodeHealth } from '../../services/traffic-taps/node-health.js'
import { screensFor, screensReport } from '../../services/traffic-taps/screens.js'

const WINDOWS = new Set([60, 300, 900])
const LANE_ENTITY = /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/
const MAX_RANGE_MS = 25 * 3600_000

function windowOf(raw: unknown): 60 | 300 | 900 | null {
  const w = Number(raw ?? 60)
  return WINDOWS.has(w) ? (w as 60 | 300 | 900) : null
}

export async function trafficOpsRoutes(app: FastifyInstance): Promise<void> {
  if (!process.env.CLOUD_META_DB_URL) {
    startNodeHealth()
    startCapacitySampling()
    startEpochMarkers()
    // Which version this boot ran (for deploy markers) — once the app reference is set.
    setTimeout(() => void recordBootVersion(), 10_000).unref?.()
  }

  const badWindow = { error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' }

  app.get<{ Querystring: { window?: string } }>('/screens', async (req, reply) => {
    const w = windowOf(req.query.window)
    if (!w) return reply.code(400).send(badWindow)
    return { data: screensReport(w) }
  })

  app.get<{ Querystring: { kind?: string; key?: string; window?: string } }>(
    '/screens/of',
    async (req, reply) => {
      const w = windowOf(req.query.window)
      const kind = req.query.kind
      const key = String(req.query.key ?? '')
      const ok =
        (kind === 'caller' && validCallerKey(key)) || (kind === 'entity' && LANE_ENTITY.test(key))
      if (!w || !ok)
        return reply
          .code(400)
          .send({ error: 'kind, key or window is not valid', code: 'SCREENS_PARAMS_INVALID' })
      return { data: screensFor(kind as 'caller' | 'entity', key, w) }
    }
  )

  app.get<{ Querystring: { window?: string } }>('/health', async (req, reply) => {
    const w = windowOf(req.query.window)
    if (!w) return reply.code(400).send(badWindow)
    return { data: nodeHealth(w, Math.floor(Date.now() / 1000)) }
  })

  app.get('/capacity', async () => ({ data: capacityReport() }))

  app.get<{ Querystring: { key?: string } }>('/caller-cost', async (req, reply) => {
    const key = String(req.query.key ?? '')
    if (!validCallerKey(key))
      return reply.code(400).send({ error: 'key is not a caller key', code: 'CALLER_KEY_INVALID' })
    return { data: await callerCost(key, currentTrafficSec()) }
  })

  app.get<{ Querystring: { from?: string; to?: string } }>('/markers', async (req, reply) => {
    const to = Number(req.query.to ?? Date.now())
    const from = Number(req.query.from ?? to - 3600_000)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > MAX_RANGE_MS)
      return reply.code(400).send({
        error: 'from/to must be epoch ms, at most 25 h apart',
        code: 'MARKERS_RANGE_INVALID'
      })
    return { data: await changeMarkers(from, to) }
  })

  // ── #1147 in flight ──────────────────────────────────────────────────────
  app.get('/inflight', async () => {
    const { rows, total } = listInflight({ exclude: currentTraceMeta()?.id ?? null })
    return { data: { rows, total, at: new Date().toISOString() } }
  })

  // ── #1156 kill the SQL session of an in-flight request ──────────────────
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/inflight/:id/kill-sql',
    async (req, reply) => {
      const id = String(req.params.id ?? '')
      const reason = String(req.body?.reason ?? '').trim()
      if (!reason)
        return reply.code(400).send({ error: 'A reason is required', code: 'REASON_REQUIRED' })
      if (!/^[0-9a-f-]{36}$/i.test(id))
        return reply.code(400).send({ error: 'Not a request id', code: 'INFLIGHT_ID_INVALID' })
      if (id === currentTraceMeta()?.id)
        return reply
          .code(400)
          .send({ error: 'Refusing to cancel this request', code: 'INFLIGHT_SELF' })
      const stmt = oldestRunning(id)
      if (!stmt) {
        const still = listInflight({ limit: 5000 }).rows.some((r) => r.id === id)
        return still
          ? reply.code(409).send({
              error: 'That request is not running a statement right now',
              code: 'INFLIGHT_NO_SQL'
            })
          : reply
              .code(404)
              .send({ error: 'That request has already finished', code: 'INFLIGHT_NOT_FOUND' })
      }
      const me = processIdentity()
      let candidates: SessionCandidate[]
      try {
        candidates = (await db.raw(
          `SELECT r.session_id AS session_id,
                  DATEDIFF(millisecond, r.start_time, GETDATE()) AS age_ms,
                  SUBSTRING(t.text, 1, 4000) AS text
             FROM sys.dm_exec_requests r
             JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
            CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
            WHERE s.host_process_id = ? AND s.is_user_process = 1
              AND r.session_id <> @@SPID AND r.session_id > 50`,
          [me.pid]
        )) as SessionCandidate[]
      } catch (err) {
        req.log.warn({ err }, 'traffic-map kill-sql: session lookup failed')
        return reply.code(503).send({
          error: 'The database sessions could not be read (VIEW SERVER STATE?)',
          code: 'SESSION_LOOKUP_FAILED'
        })
      }
      const pick = pickSession(candidates ?? [], stmt.sql, stmt.age_ms)
      if (pick.status === 'none')
        return reply.code(409).send({
          error: 'No database session is running that statement now (it may have just finished)',
          code: 'INFLIGHT_SQL_NOT_FOUND'
        })
      if (pick.status === 'ambiguous')
        return reply.code(409).send({
          error: `More than one session runs that statement (${pick.sessions.join(', ')}) — not guessing`,
          code: 'INFLIGHT_SQL_AMBIGUOUS'
        })
      const sid = pick.session_id
      if (!Number.isInteger(sid) || sid <= 50)
        return reply
          .code(400)
          .send({ error: 'Refusing a system session', code: 'SESSION_NOT_KILLABLE' })
      await db.raw(`KILL ${sid}`)
      await logActivity({
        action: 'traffic-map-kill-sql',
        user: req.user?.id,
        comment: `KILL ${sid} (${stmt.route}, running ${Math.round(stmt.age_ms / 1000)}s): ${reason.slice(0, 300)}`,
        req
      })
      return { data: { killed: sid, route: stmt.route } }
    }
  )

  // ── #1157 circuit breakers ───────────────────────────────────────────────
  app.get('/breakers', async () => ({
    data: { breakers: activeBreakers(), available: breakersAvailable() }
  }))

  app.post<{
    Body: {
      kind?: string
      target?: string
      mode?: string
      limit?: number
      minutes?: number
      reason?: string
    }
  }>('/breakers', async (req, reply) => {
    const b = req.body ?? {}
    const kind = b.kind as BreakerKind
    const target = String(b.target ?? '')
    const mode = b.mode as BreakerMode
    const minutes = Number(b.minutes)
    const limit = mode === 'limit' ? Number(b.limit) : null
    const reason = String(b.reason ?? '').trim()
    if (kind !== 'entity' && kind !== 'caller')
      return reply
        .code(400)
        .send({ error: 'kind must be entity or caller', code: 'BREAKER_INVALID' })
    if (!validTarget(kind, target))
      return reply.code(400).send({ error: 'target is not valid', code: 'BREAKER_INVALID' })
    if (mode !== 'refuse' && mode !== 'limit')
      return reply
        .code(400)
        .send({ error: 'mode must be refuse or limit', code: 'BREAKER_INVALID' })
    if (
      mode === 'limit' &&
      (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100_000)
    )
      return reply
        .code(400)
        .send({ error: 'limit must be 1–100000 a minute', code: 'BREAKER_INVALID' })
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES)
      return reply
        .code(400)
        .send({ error: `minutes must be 1–${MAX_MINUTES}`, code: 'BREAKER_INVALID' })
    if (!reason)
      return reply.code(400).send({ error: 'A reason is required', code: 'REASON_REQUIRED' })
    if (kind === 'caller' && target === `u${String(req.user?.id ?? '').toUpperCase()}`)
      return reply
        .code(400)
        .send({ error: 'Refusing to break your own account', code: 'BREAKER_SELF' })
    if (!breakersAvailable())
      return reply
        .code(503)
        .send({ error: 'Breakers need Redis, which is not connected', code: 'BREAKER_UNAVAILABLE' })
    const u = req.user as { id?: string; first_name?: string; last_name?: string; email?: string }
    const now = Date.now()
    const breaker: Breaker = {
      kind,
      target,
      mode,
      limit,
      until: now + Math.round(minutes) * 60_000,
      reason: reason.slice(0, 300),
      by: u?.id ?? null,
      by_name: `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim() || u?.email || null,
      at: now
    }
    await setBreaker(breaker)
    await logActivity({
      action: 'traffic-map-breaker-set',
      user: req.user?.id,
      comment: `${mode === 'refuse' ? 'Refuse' : `Limit ${limit}/min`} ${kind} ${target} for ${Math.round(minutes)} min: ${breaker.reason}`,
      req
    })
    return { data: breaker }
  })

  app.delete<{ Querystring: { kind?: string; target?: string } }>(
    '/breakers',
    async (req, reply) => {
      const kind = req.query.kind as BreakerKind
      const target = String(req.query.target ?? '')
      if ((kind !== 'entity' && kind !== 'caller') || !validTarget(kind, target))
        return reply
          .code(400)
          .send({ error: 'kind or target is not valid', code: 'BREAKER_INVALID' })
      if (!breakersAvailable())
        return reply.code(503).send({
          error: 'Breakers need Redis, which is not connected',
          code: 'BREAKER_UNAVAILABLE'
        })
      const had = await clearBreaker(kind, target)
      if (had)
        await logActivity({
          action: 'traffic-map-breaker-clear',
          user: req.user?.id,
          comment: `Closed the breaker on ${kind} ${target}`,
          req
        })
      return { data: { cleared: had } }
    }
  )
}
