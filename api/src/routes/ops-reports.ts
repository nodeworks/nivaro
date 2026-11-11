/**
 * /api/ops-reports — the daily operations report (Health → Daily report). Administrators only.
 * Contract: api/src/services/ops-report/types.ts (twin of packages/shared lib/ops-report-types.ts).
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { DrillError, drill } from '../services/ops-report/drill.js'
import { kpiMeta } from '../services/ops-report/kpis.js'
import { emailOptedIn, startOpsReport } from '../services/ops-report/run.js'
import {
  getOpsReportSettings,
  OpsReportSettingsError,
  saveOpsReportSettings
} from '../services/ops-report/settings.js'
import {
  getReport,
  latestPerDay,
  listReports,
  listRow,
  OpsReportUnavailable,
  reportsTableReady,
  trendPoint
} from '../services/ops-report/store.js'
import { OPS_KPI_META, type OpsDrillMetric, type OpsReport } from '../services/ops-report/types.js'
import { isDay } from '../services/ops-report/window.js'

const NOT_READY = {
  error: 'The daily report is not set up on this server yet',
  hint: 'It arrives with the next update (database migration 525).'
}

export async function opsReportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { limit?: string } }>('/', async (req, reply) => {
    if (!(await reportsTableReady())) return reply.send({ data: [] })
    const rows = await listReports(Number(req.query.limit) || 60)
    return reply.send({ data: rows.map(listRow) })
  })

  app.get<{ Querystring: { days?: string } }>('/trends', async (req, reply) => {
    if (!(await reportsTableReady())) return reply.send({ data: [] })
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 366)
    const rows = await latestPerDay(days)
    return reply.send({ data: rows.reverse().map(trendPoint) })
  })

  app.get('/settings', async (req, reply) => {
    const me = (await db('nivaro_users')
      .where({ id: req.user!.id })
      .first('preferences')
      .catch(() => null)) as { preferences?: unknown } | null
    return reply.send({
      data: { ...(await getOpsReportSettings()), email_me: emailOptedIn(me?.preferences) }
    })
  })

  app.patch<{ Body: unknown }>('/settings', async (req, reply) => {
    try {
      return reply.send({ data: await saveOpsReportSettings(req.body ?? {}) })
    } catch (err) {
      if (err instanceof OpsReportSettingsError)
        return reply.code(400).send({ error: err.message, fields: err.fields })
      throw err
    }
  })

  app.post<{ Body: { day?: string } | null }>('/run', async (req, reply) => {
    const day = req.body?.day
    if (day != null && !isDay(day)) return reply.code(400).send({ error: 'day must be YYYY-MM-DD' })
    try {
      const { id } = await startOpsReport(app, {
        day,
        trigger: 'manual',
        userId: req.user?.id ?? null
      })
      return reply.code(202).send({ data: { id } })
    } catch (err) {
      if (err instanceof OpsReportUnavailable) return reply.code(409).send({ error: err.message })
      throw err
    }
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!(await reportsTableReady())) return reply.code(404).send(NOT_READY)
    const r = await getReport(Number(req.params.id))
    if (!r) return reply.code(404).send({ error: 'That report is not here' })
    const window = r.digest?.window ?? {
      day: r.day,
      start: new Date(r.window_start).toISOString(),
      end: new Date(r.window_end).toISOString(),
      tz: r.tz,
      label: r.day
    }
    const data: OpsReport = {
      ...listRow(r),
      window,
      digest: r.digest as OpsReport['digest'],
      analysis: r.analysis,
      tracker: r.tracker,
      comparison: r.comparison,
      kpi_meta: r.digest ? kpiMeta(r.digest) : OPS_KPI_META,
      tools: r.tools,
      error: r.error
    }
    return reply.send({ data })
  })

  app.get<{
    Params: { id: string }
    Querystring: { metric?: string; key?: string; limit?: string }
  }>('/:id/drill', async (req, reply) => {
    if (!(await reportsTableReady())) return reply.code(404).send(NOT_READY)
    const r = await getReport(Number(req.params.id))
    if (!r) return reply.code(404).send({ error: 'That report is not here' })
    const metric = String(req.query.metric ?? '') as OpsDrillMetric
    if (!metric) return reply.code(400).send({ error: 'Name the metric' })
    try {
      const data = await drill(
        { start: new Date(r.window_start), end: new Date(r.window_end), tz: r.tz, day: r.day },
        metric,
        req.query.key ? String(req.query.key).slice(0, 400) : null,
        Number(req.query.limit) || 200,
        { digest: r.digest, tracker: r.tracker }
      )
      return reply.send({ data })
    } catch (err) {
      if (err instanceof DrillError) return reply.code(err.status).send({ error: err.message })
      throw err
    }
  })
}
