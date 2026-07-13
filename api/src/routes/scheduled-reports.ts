import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { runScheduledReport, type ScheduledReport } from '../services/scheduled-reports.js'

function toJson(v: unknown): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function parse(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function format(row: ScheduledReport) {
  return {
    ...row,
    filters: parse(row.filters),
    fields: parse(row.fields),
    recipients: parse(row.recipients) ?? [],
    is_active: !!row.is_active
  }
}

const CRON_RE = /^(\S+\s+){4}\S+$/

export async function scheduledReportsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (_req, reply) => {
    const rows = (await db<ScheduledReport>('nivaro_scheduled_reports').orderBy(
      'name'
    )) as ScheduledReport[]
    return reply.send({ data: rows.map(format) })
  })

  app.post('/', async (req, reply) => {
    const b = req.body as Record<string, unknown>
    if (!b.name || !b.cron_schedule || !Array.isArray(b.recipients) || b.recipients.length === 0) {
      return reply.code(400).send({ error: 'name, cron_schedule and recipients are required' })
    }
    if (!CRON_RE.test(String(b.cron_schedule))) {
      return reply.code(400).send({ error: 'cron_schedule must be a 5-part cron expression' })
    }
    const type = b.report_type === 'queue' ? 'queue' : 'collection'
    if (type === 'collection' && !b.collection) {
      return reply.code(400).send({ error: 'collection is required for collection reports' })
    }
    if (type === 'queue' && !b.queue_id) {
      return reply.code(400).send({ error: 'queue_id is required for queue reports' })
    }
    const [idRow] = await db('nivaro_scheduled_reports')
      .insert({
        name: b.name,
        report_type: type,
        collection: (b.collection as string) ?? null,
        queue_id: (b.queue_id as string) ?? null,
        filters: toJson(b.filters),
        fields: toJson(b.fields),
        recipients: JSON.stringify(b.recipients),
        cron_schedule: b.cron_schedule,
        orientation: b.orientation === 'landscape' ? 'landscape' : 'portrait',
        row_limit: Math.min(500, Math.max(1, Number(b.row_limit) || 100)),
        is_active: b.is_active !== false,
        created_by: req.user?.id ?? null,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')
    const id = typeof idRow === 'object' ? (idRow as { id: number }).id : idRow
    const row = (await db<ScheduledReport>('nivaro_scheduled_reports')
      .where({ id })
      .first()) as ScheduledReport
    await logActivity({
      action: 'create',
      collection: 'nivaro_scheduled_reports',
      item: String(id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: format(row) })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const b = req.body as Record<string, unknown>
    const u: Record<string, unknown> = { updated_at: new Date() }
    for (const k of ['name', 'collection', 'queue_id', 'cron_schedule', 'orientation'] as const) {
      if (b[k] !== undefined) u[k] = b[k]
    }
    if (b.cron_schedule !== undefined && !CRON_RE.test(String(b.cron_schedule))) {
      return reply.code(400).send({ error: 'cron_schedule must be a 5-part cron expression' })
    }
    if (b.report_type !== undefined) u.report_type = b.report_type === 'queue' ? 'queue' : 'collection'
    if (b.filters !== undefined) u.filters = toJson(b.filters)
    if (b.fields !== undefined) u.fields = toJson(b.fields)
    if (b.recipients !== undefined) u.recipients = JSON.stringify(b.recipients)
    if (b.row_limit !== undefined) u.row_limit = Math.min(500, Math.max(1, Number(b.row_limit) || 100))
    if (b.is_active !== undefined) u.is_active = !!b.is_active
    await db('nivaro_scheduled_reports').where({ id }).update(u)
    const row = (await db<ScheduledReport>('nivaro_scheduled_reports')
      .where({ id })
      .first()) as ScheduledReport | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'update',
      collection: 'nivaro_scheduled_reports',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.send({ data: format(row) })
  })

  app.delete('/:id', async (req, reply) => {
    await db('nivaro_scheduled_reports').where({ id: (req.params as { id: string }).id }).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_scheduled_reports',
      item: (req.params as { id: string }).id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // Send now — same path the cron takes
  app.post('/:id/run', async (req, reply) => {
    const row = (await db<ScheduledReport>('nivaro_scheduled_reports')
      .where({ id: (req.params as { id: string }).id })
      .first()) as ScheduledReport | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    try {
      const result = await runScheduledReport(row)
      await logActivity({
        action: 'scheduled-report-run',
        collection: 'nivaro_scheduled_reports',
        item: String(row.id),
        user: req.user?.id,
        comment: result.error ?? `sent to ${result.sent}`,
        req
      })
      if (result.error) return reply.code(400).send({ error: result.error })
      return reply.send({ data: result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Run failed'
      await db('nivaro_scheduled_reports')
        .where({ id: row.id })
        .update({ last_run_at: new Date(), last_run_status: `error: ${msg.slice(0, 400)}` })
      return reply.code(500).send({ error: msg })
    }
  })
}
