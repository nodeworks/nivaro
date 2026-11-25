import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner } from '../services/hub/apps.js'
import { runFleetAlertTick } from '../services/hub/fleet/alerts.js'
import {
  AUDIT_CATEGORIES,
  type AuditFilter,
  auditCsv,
  listAudit
} from '../services/hub/fleet/audit.js'
import { buildFleet, type FleetAnswer } from '../services/hub/fleet/fleet.js'
import {
  ALERTS_LOCK_KEY,
  type CheckState,
  type LockRedis,
  PROBE_LOCK_KEY,
  readCheckState,
  withLock,
  writeCheckState
} from '../services/hub/fleet/lock.js'
import { listSloReports, runSloReport } from '../services/hub/fleet/report.js'
import {
  type FleetSettings,
  loadFleetSettings,
  normalizeFleetSettings,
  saveFleetSettings
} from '../services/hub/fleet/settings.js'
import {
  ALERTS,
  forgetGoneEnvironments,
  pruneSamples,
  recentFailures,
  rollupHours,
  uptimeHourSeries
} from '../services/hub/fleet/store.js'
import { runFleetProbeTick } from '../services/hub/fleet/tick.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import type { StatusCache } from '../services/hub/status.js'

/**
 * Nivaro Hub fleet view, uptime + SLO, drift alerts and the audit timeline — mounted at /api/hub
 * beside routes/hub.ts, only with HUB=on (never in cloud mode).
 *
 *   GET  /fleet                               every app × environment the caller may see (admins:
 *                                             all; owners: their apps) from the Hub's own tables;
 *                                             each answer kept 30 s per viewer (nvr:hub:fleet-page)
 *   GET  /fleet/environments/:envId/uptime    hourly uptime (≤ 30 days), recent failed probes,
 *                                             stored monthly reports
 *   GET  /fleet/alerts?state=open|all         drift alerts (owners: their apps)
 *   GET  /fleet/reports                       stored monthly SLO rows (owners: their apps)
 *   GET  /fleet/settings                      rules, SLO targets, report switch (admin)
 *   PUT  /fleet/settings                      the same, validated (admin, logged)
 *   POST /fleet/check                         starts one probe tick + one alert pass (admin,
 *                                             logged): 202 {status: running}; 409 CHECK_RUNNING
 *                                             while one runs; never runs beside the cron tick
 *   GET  /fleet/check                         the last check's state (poll after the POST)
 *   GET  /audit                               the Hub audit timeline (admin): filters app,
 *                                             environment, user, action (category or exact),
 *                                             from, to; offset + limit
 *   GET  /audit.csv                           the same rows as CSV (admin, logged)
 *
 * Jobs (Hub only, one leader through the cron lease, crons tick only where cronTicksEnabled()):
 * hub-fleet-probe (every minute), hub-fleet-rollup (every 5 minutes), hub-fleet-alerts (every 15
 * minutes), hub-fleet-prune (04:20 daily), hub-slo-report (07:00 UTC on the 1st, 72 h catch-up).
 * The probe tick and the alert pass each hold a Redis lock (services/hub/fleet/lock.ts), shared
 * with Check now.
 */

type Q = Record<string, string | undefined>

export const PAGE_CACHE_PREFIX = 'nvr:hub:fleet-page:'
export const PAGE_CACHE_TTL_S = 30
/** How long Check now waits for a running cron tick to free its lock. */
const CHECK_WAIT_MS = 70_000

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')
const query = (req: FastifyRequest) => (req.query ?? {}) as Q

type FleetRedis = StatusCache & LockRedis & { del?: (...keys: string[]) => Promise<unknown> }

function redisOf(app: FastifyInstance): FleetRedis | null {
  return (app as unknown as { redis?: FleetRedis }).redis ?? null
}

/** App ids the caller may read (null = all, for an admin). */
async function visibleApps(req: FastifyRequest): Promise<number[] | null> {
  if (req.isAdmin) return null
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: userId(req) })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

function dateParam(v: string | undefined): Date | null | 'bad' {
  if (!v) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v)
  return Number.isFinite(d.getTime()) ? d : 'bad'
}

/** Drops targets for environments that no longer exist (ids are the keys), in chunks. */
async function keepKnownTargets(s: FleetSettings): Promise<FleetSettings> {
  const ids = Object.keys(s.slo.targets).map(Number)
  if (!ids.length) return s
  const live = new Set<string>()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await db('nivaro_hub_environments')
      .whereIn('id', ids.slice(i, i + 500))
      .select('id')) as Array<{ id: number }>
    for (const r of rows) live.add(String(r.id))
  }
  const targets = Object.fromEntries(Object.entries(s.slo.targets).filter(([k]) => live.has(k)))
  return { ...s, slo: { ...s.slo, targets } }
}

function auditFilter(q: Q): AuditFilter | string {
  const from = dateParam(q.from)
  const to = dateParam(q.to)
  if (from === 'bad' || to === 'bad') return 'from and to must be dates'
  const action = q.action?.trim() || null
  if (
    action &&
    !(AUDIT_CATEGORIES as readonly string[]).includes(action) &&
    !/^[a-z][a-z0-9-]{1,63}$/.test(action)
  )
    return 'action must be a category or an action id'
  const user = q.user?.trim() || null
  if (user && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user))
    return 'user must be a user id'
  return {
    app_id: q.app ? idParam(q.app) : null,
    environment_id: q.environment ? idParam(q.environment) : null,
    user_id: user,
    action,
    from,
    // A date-only `to` includes that whole day.
    to: to && q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? new Date(to.getTime() + 86_400_000) : to
  }
}

/** Admins share one cached answer; an owner's is their own (it depends on what they own). */
const pageKey = (req: FastifyRequest) =>
  `${PAGE_CACHE_PREFIX}${req.isAdmin ? 'admin' : userId(req).toLowerCase()}`

async function cachedPage(redis: FleetRedis | null, k: string): Promise<FleetAnswer | null> {
  if (!redis) return null
  try {
    const raw = await redis.get(k)
    return raw ? (JSON.parse(raw) as FleetAnswer) : null
  } catch {
    return null
  }
}

async function forgetAdminPage(redis: FleetRedis | null): Promise<void> {
  await Promise.resolve(redis?.del?.(`${PAGE_CACHE_PREFIX}admin`)).catch(() => {})
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Takes `key` within `waitMs` (polling), then runs `work`; `{ran:false}` if it never freed. */
async function withLockWaiting<T>(
  redis: FleetRedis | null,
  key: string,
  waitMs: number,
  work: () => Promise<T>
) {
  const until = Date.now() + waitMs
  for (;;) {
    const out = await withLock(redis, key, work)
    if (out.ran || Date.now() >= until) return out
    await sleep(1000)
  }
}

export async function hubFleetRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  app.get('/fleet', { preHandler: requireAuth }, async (req) => {
    const redis = redisOf(app)
    const k = pageKey(req)
    const hit = await cachedPage(redis, k)
    if (hit) return { data: hit }
    const data = await buildFleet({ userId: userId(req), isAdmin: !!req.isAdmin })
    if (redis)
      await Promise.resolve(redis.set(k, JSON.stringify(data), 'EX', PAGE_CACHE_TTL_S)).catch(
        () => {}
      )
    return { data }
  })

  app.get('/fleet/environments/:envId/uptime', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { envId: string }).envId)
    if (id === null) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const env = (await db('nivaro_hub_environments').where({ id }).first('id', 'app_id')) as
      | { id: number; app_id: number }
      | undefined
    if (!env) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    if (!req.isAdmin && !(await isAppOwner(Number(env.app_id), userId(req))))
      return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const days = Math.max(1, Math.min(30, Number(query(req).days) || 7))
    const from = new Date(Date.now() - days * 86_400_000)
    const [hours, incidents, reports] = await Promise.all([
      uptimeHourSeries(id, from),
      recentFailures(id),
      listSloReports([id], 24)
    ])
    return { data: { environment_id: id, days, hours, incidents, reports } }
  })

  app.get('/fleet/alerts', { preHandler: requireAuth }, async (req) => {
    const allowed = await visibleApps(req)
    const q = db(ALERTS).orderBy('opened_at', 'desc').limit(500).select('*')
    if (query(req).state !== 'all') q.whereNull('resolved_at')
    if (allowed) {
      if (!allowed.length) return { data: [] }
      q.whereIn('app_id', allowed)
    }
    const rows = (await q) as Array<Record<string, unknown>>
    return {
      data: rows.map((r) => ({
        id: Number(r.id),
        rule_id: String(r.rule_id),
        kind: String(r.kind),
        app_id: Number(r.app_id),
        environment_id: r.environment_id == null ? null : Number(r.environment_id),
        message: String(r.message),
        opened_at: r.opened_at,
        last_seen_at: r.last_seen_at,
        resolved_at: r.resolved_at ?? null,
        notified: r.notified_at != null
      }))
    }
  })

  app.get('/fleet/reports', { preHandler: requireAuth }, async (req) => {
    const allowed = await visibleApps(req)
    let envIds: number[] | null = null
    if (allowed) {
      if (!allowed.length) return { data: [] }
      const rows = (await db('nivaro_hub_environments')
        .whereIn('app_id', allowed)
        .select('id')) as Array<{ id: number }>
      envIds = rows.map((r) => Number(r.id))
    }
    return { data: await listSloReports(envIds) }
  })

  app.get('/fleet/settings', { preHandler: requireAdmin }, async () => ({
    data: await loadFleetSettings()
  }))

  app.put('/fleet/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const out = normalizeFleetSettings(req.body)
    if (!out.ok) return fail(reply, 400, 'BAD_FLEET_SETTINGS', out.error)
    const settings = await keepKnownTargets(out.settings)
    await saveFleetSettings(settings)
    await forgetAdminPage(redisOf(app))
    await logActivity({
      action: 'hub-fleet-settings',
      user: userId(req),
      item: 'hub_fleet',
      comment: JSON.stringify({
        rules:
          settings.rules
            .filter((r) => r.enabled)
            .map((r) => r.id)
            .join(', ') || 'none',
        default_target: settings.slo.default_target,
        targets: Object.keys(settings.slo.targets).length,
        report: settings.report_enabled ? 'on' : 'off'
      }),
      req
    })
    return { data: settings }
  })

  app.get('/fleet/check', { preHandler: requireAdmin }, async () => ({
    data: await readCheckState(redisOf(app))
  }))

  app.post('/fleet/check', { preHandler: requireAdmin }, async (req, reply) => {
    const redis = redisOf(app)
    const last = await readCheckState(redis)
    const fresh =
      last?.status === 'running' && Date.now() - Date.parse(last.started_at) < 5 * 60_000
    if (fresh)
      return reply
        .code(409)
        .send({ error: 'A check is already running', code: 'CHECK_RUNNING', data: last })
    const started: CheckState = {
      status: 'running',
      started_at: new Date().toISOString(),
      by: userId(req)
    }
    await writeCheckState(redis, started)
    await logActivity({ action: 'hub-fleet-check', user: userId(req), req })
    // In the background (the answer never holds a minute): wait for the cron tick if it runs.
    void (async () => {
      try {
        const probe = await withLockWaiting(redis, PROBE_LOCK_KEY, CHECK_WAIT_MS, () =>
          runFleetProbeTick({ redis, forceStatus: true })
        )
        const alerts = await withLockWaiting(redis, ALERTS_LOCK_KEY, CHECK_WAIT_MS, () =>
          runFleetAlertTick()
        )
        await forgetAdminPage(redis)
        await writeCheckState(redis, {
          ...started,
          status: probe.ran && alerts.ran ? 'done' : 'failed',
          finished_at: new Date().toISOString(),
          result: {
            probe: probe.ran ? probe.value : null,
            alerts: alerts.ran ? alerts.value : null
          }
        })
      } catch (err) {
        req.log.warn({ err: (err as Error)?.name ?? 'Error' }, 'hub fleet check failed')
        await writeCheckState(redis, {
          ...started,
          status: 'failed',
          finished_at: new Date().toISOString()
        })
      }
    })()
    return reply.code(202).send({ data: started })
  })

  app.get('/audit', { preHandler: requireAdmin }, async (req, reply) => {
    const q = query(req)
    const filter = auditFilter(q)
    if (typeof filter === 'string') return fail(reply, 400, 'BAD_FILTER', filter)
    const limit = Math.max(1, Math.min(200, Number(q.limit) || 50))
    const offset = Math.max(0, Number(q.offset) || 0)
    const out = await listAudit(filter)
    // The people in this answer (the person filter's choices).
    const people = new Map<string, string>()
    for (const r of out.rows) if (r.user_id) people.set(r.user_id, r.user_name ?? r.user_id)
    return {
      data: out.rows.slice(offset, offset + limit),
      meta: {
        total: out.total,
        offset,
        limit,
        truncated: out.truncated,
        people: [...people].map(([id, name]) => ({ id, name }))
      }
    }
  })

  app.get('/audit.csv', { preHandler: requireAdmin }, async (req, reply) => {
    const filter = auditFilter(query(req))
    if (typeof filter === 'string') return fail(reply, 400, 'BAD_FILTER', filter)
    const out = await listAudit(filter)
    await logActivity({
      action: 'hub-audit-export',
      user: userId(req),
      comment: JSON.stringify({ rows: out.rows.length }),
      req
    })
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', 'attachment; filename="hub-audit.csv"')
      .send(auditCsv(out.rows))
  })

  if (app.cron) {
    app.cron.schedule(
      'hub-fleet-probe',
      '* * * * *',
      async () => {
        await withLock(redisOf(app), PROBE_LOCK_KEY, () =>
          runFleetProbeTick({ redis: redisOf(app) })
        )
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every minute (Hub only) — probes every active environment’s public /api/version and /api/ready (one uptime sample each, at most one a minute; none while a Hub promotion or move is running on it) and, every 5 minutes per environment, reads its status through the Hub status reader. Keeps nivaro_hub_fleet_status, which the Apps → Fleet page reads. At most 8 at once, 8 s per request, one run at a time (shared with Check now).'
      }
    )
    app.cron.schedule(
      'hub-fleet-rollup',
      '*/5 * * * *',
      async () => {
        await rollupHours(new Date())
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every 5 minutes (Hub only) — folds the last 3 hours of uptime samples into hourly rows (nivaro_hub_uptime_hours: samples, answered, p95 response time), which every uptime figure reads.'
      }
    )
    app.cron.schedule(
      'hub-fleet-alerts',
      '*/15 * * * *',
      async () => {
        await withLock(redisOf(app), ALERTS_LOCK_KEY, () => runFleetAlertTick())
      },
      {
        idempotent: 'safe',
        description:
          'Every 15 minutes (Hub only) — refreshes the cached release list at most hourly, evaluates the version drift rules (Apps → Fleet → Rules and targets; all off until turned on) over the fleet status: opens one alert per rule + environment and tells the app’s owners and the Hub administrators once (one notification per person per run), resolves alerts whose finding is gone.'
      }
    )
    app.cron.schedule(
      'hub-fleet-prune',
      '20 4 * * *',
      async () => {
        const n = await pruneSamples(new Date())
        const live = (await db('nivaro_hub_environments').select('id')) as Array<{ id: number }>
        await forgetGoneEnvironments(live.map((r) => Number(r.id)))
        app.log.info(`hub-fleet-prune: ${n} uptime samples older than 48 hours removed`)
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Daily 04:20 (Hub only) — deletes raw uptime samples older than 48 hours, hourly uptime rows older than 400 days and resolved fleet alerts older than 180 days, in batches, and the status rows of environments that no longer exist. Monthly SLO rows are kept.'
      }
    )
    app.cron.schedule(
      'hub-slo-report',
      '0 7 1 * *',
      async () => {
        const out = await runSloReport()
        app.log.info(
          `hub-slo-report: ${out.months.join(', ')}, ${out.environments} environments, ${out.missed} missed, ${out.notified} told`
        )
      },
      {
        idempotent: 'safe',
        timezone: 'UTC',
        catchUpHours: 72,
        description:
          '07:00 UTC on the 1st (Hub only; a missed run is caught up within 72 hours, and any ended month not reported yet is reported) — stores each month’s uptime per environment against its target (nivaro_hub_slo_reports) and, unless switched off in the fleet settings, sends each app’s owners their app’s report and the Hub administrators a fleet summary (in-app + email). Never sends a month twice.'
      }
    )
  }
}
