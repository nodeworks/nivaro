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
import { buildFleet } from '../services/hub/fleet/fleet.js'
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
  uptimeSeries
} from '../services/hub/fleet/store.js'
import { runFleetProbeTick } from '../services/hub/fleet/tick.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import type { StatusCache } from '../services/hub/status.js'

/**
 * Nivaro Hub fleet view, uptime + SLO, drift alerts and the audit timeline — mounted at /api/hub
 * beside routes/hub.ts, only with HUB=on (never in cloud mode).
 *
 *   GET  /fleet                               every app × environment the caller may see (admins:
 *                                             all; owners: their apps) from the Hub's own tables
 *   GET  /fleet/environments/:envId/uptime    probe samples (≤ 30 days) + stored monthly reports
 *   GET  /fleet/alerts?state=open|all         drift alerts (owners: their apps)
 *   GET  /fleet/reports                       stored monthly SLO rows (owners: their apps)
 *   GET  /fleet/settings                      rules, SLO targets, report switch (admin)
 *   PUT  /fleet/settings                      the same, validated (admin, logged)
 *   POST /fleet/check                         one probe tick + one alert pass now (admin, logged)
 *   GET  /audit                               the Hub audit timeline (admin): filters app,
 *                                             environment, user, action (category or exact),
 *                                             from, to; offset + limit
 *   GET  /audit.csv                           the same rows as CSV (admin, logged)
 *
 * Jobs (Hub only, one leader through the cron lease, crons tick only where cronTicksEnabled()):
 * hub-fleet-probe (every minute), hub-fleet-alerts (every 15 minutes), hub-fleet-prune (04:20
 * daily), hub-slo-report (07:00 UTC on the 1st).
 */

type Q = Record<string, string | undefined>

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')
const query = (req: FastifyRequest) => (req.query ?? {}) as Q

function redisOf(app: FastifyInstance): StatusCache | null {
  return (app as unknown as { redis?: StatusCache }).redis ?? null
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

/** Drops targets for environments that no longer exist (ids are the keys). */
async function keepKnownTargets(s: FleetSettings): Promise<FleetSettings> {
  const ids = Object.keys(s.slo.targets).map(Number)
  if (!ids.length) return s
  const rows = (await db('nivaro_hub_environments').whereIn('id', ids).select('id')) as Array<{
    id: number
  }>
  const live = new Set(rows.map((r) => String(r.id)))
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

export async function hubFleetRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  app.get('/fleet', { preHandler: requireAuth }, async (req) => {
    return { data: await buildFleet({ userId: userId(req), isAdmin: !!req.isAdmin }) }
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
    const [samples, reports] = await Promise.all([uptimeSeries(id, from), listSloReports([id], 24)])
    // Hourly buckets keep the answer small (≤ 720 points for 30 days).
    const buckets = new Map<string, { samples: number; up: number; ms: number[] }>()
    for (const s of samples) {
      const hour = `${s.at.slice(0, 13)}:00:00.000Z`
      const b = buckets.get(hour) ?? { samples: 0, up: 0, ms: [] }
      b.samples++
      if (s.up) b.up++
      if (s.ms != null) b.ms.push(s.ms)
      buckets.set(hour, b)
    }
    const hours = [...buckets].map(([at, b]) => ({
      at,
      samples: b.samples,
      up: b.up,
      ms: b.ms.length ? Math.round(b.ms.reduce((x, y) => x + y, 0) / b.ms.length) : null
    }))
    const incidents = samples.filter((s) => !s.up).slice(-50)
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

  app.post('/fleet/check', { preHandler: requireAdmin }, async (req) => {
    const probe = await runFleetProbeTick({ redis: redisOf(app) })
    const alerts = await runFleetAlertTick()
    await logActivity({
      action: 'hub-fleet-check',
      user: userId(req),
      comment: JSON.stringify({ probed: probe.probed, down: probe.down, opened: alerts.opened }),
      req
    })
    return { data: { probe, alerts } }
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
        await runFleetProbeTick({ redis: redisOf(app) })
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every minute (Hub only) — probes every active environment’s public /api/version and /api/ready (one uptime sample each, nivaro_hub_uptime_samples) and, every 5 minutes per environment, reads its status through the Hub status reader (hub link, public or shared link). Keeps nivaro_hub_fleet_status, which the Apps → Fleet page reads. At most 8 at once, 8 s per request; touches only the Hub’s own tables.'
      }
    )
    app.cron.schedule(
      'hub-fleet-alerts',
      '*/15 * * * *',
      async () => {
        await runFleetAlertTick()
      },
      {
        idempotent: 'safe',
        description:
          'Every 15 minutes (Hub only) — evaluates the version drift rules (Apps → Fleet → Alert rules) over the fleet status: opens an alert per new finding and tells the app’s owners and the Hub administrators once (one notification per person per run), resolves alerts whose finding is gone.'
      }
    )
    app.cron.schedule(
      'hub-fleet-prune',
      '20 4 * * *',
      async () => {
        const n = await pruneSamples(new Date())
        const live = (await db('nivaro_hub_environments').select('id')) as Array<{ id: number }>
        await forgetGoneEnvironments(live.map((r) => Number(r.id)))
        app.log.info(`hub-fleet-prune: ${n} uptime samples older than 45 days removed`)
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Daily 04:20 (Hub only) — deletes uptime samples older than 45 days and resolved fleet alerts older than 180 days, in batches, and the status rows of environments that no longer exist. Monthly SLO rows are kept.'
      }
    )
    app.cron.schedule(
      'hub-slo-report',
      '0 7 1 * *',
      async () => {
        const out = await runSloReport()
        app.log.info(
          `hub-slo-report: ${out.month}, ${out.environments} environments, ${out.missed} missed, ${out.notified} told`
        )
      },
      {
        idempotent: 'safe',
        timezone: 'UTC',
        description:
          '07:00 UTC on the 1st (Hub only) — stores last month’s uptime per environment against its target (nivaro_hub_slo_reports) and, unless switched off in the fleet settings, sends each app’s owners their app’s report and the Hub administrators a fleet summary (in-app + email). A month already sent is never sent again.'
      }
    )
  }
}
