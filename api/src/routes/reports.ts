import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { applyActivityFilters, normalizeActivityFilters } from '../services/activity-filters.js'
import { activityLabelsFor, optionalActivityColumns } from '../services/activity-readable.js'
import {
  largestBurstOf,
  mergeUserNames,
  parseReportDate,
  SUMMARY_DEFAULT_DAYS,
  summaryQueries,
  summaryWindow
} from '../services/activity-report.js'
import {
  csvTimeZone,
  READABLE_CSV_CHUNK,
  READABLE_CSV_COLUMNS,
  READABLE_CSV_MAX,
  type ReadableCsvRow,
  readableCsvRow
} from '../services/activity-report-csv.js'
import {
  applyReportFilters,
  hasReportFilterParams,
  reportFilters
} from '../services/activity-report-filters.js'
import { activityLabelRefs } from '../services/activity-sentence.js'
import { selectInChunks } from '../services/db-batch.js'
import {
  backgroundRefusal,
  decideBackground,
  type ExportContext,
  type ExportFile,
  ExportRunError,
  noteExportDuration,
  parseBackgroundMode,
  startExportRun
} from '../services/export-runs.js'
import type { User } from '../types.js'
import { pageRows } from './activity.js'

function toCSV(rows: Record<string, unknown>[], columns?: readonly string[]): string {
  if (rows.length === 0 && !columns) return ''
  const headers = columns ? [...columns] : Object.keys(rows[0])
  const escapeCell = (v: unknown): string => {
    let s = v == null ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))
  ]
  return lines.join('\r\n')
}

export async function reportsRoutes(app: FastifyInstance) {
  // GET /api/reports/activity
  app.get('/activity', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string>
    // The Audit report's export: GET /api/activity's filters, sentences + raw columns.
    if (q.format === 'csv' && (q.readable === '1' || q.readable === 'true')) {
      return readableCsv(app, req, reply, q)
    }
    const page = Math.max(1, q.page ? Number(q.page) : 1)
    const limit = Math.min(q.limit ? Number(q.limit) : 50, 500)
    const offset = (page - 1) * limit
    const format = q.format === 'csv' ? 'csv' : 'json'

    const base = () => db('nivaro_activity as a').leftJoin('nivaro_users as u', 'a.user', 'u.id')

    const query = base()
      .select(
        'a.id',
        'a.action',
        'a.collection',
        'a.item',
        'a.timestamp',
        db.raw('a.[user] as user_id'),
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )
      .orderBy('a.timestamp', 'desc')

    const countQuery = base().count('a.id as count')

    if (q.collection) {
      query.where('a.collection', q.collection)
      countQuery.where('a.collection', q.collection)
    }
    if (q.user) {
      query.where('a.user', q.user)
      countQuery.where('a.user', q.user)
    }
    if (q.action) {
      query.where('a.action', q.action)
      countQuery.where('a.action', q.action)
    }
    const from = parseReportDate(q.from, 'start')
    const to = parseReportDate(q.to, 'end')
    if (from === 'invalid' || to === 'invalid') {
      return reply.status(400).send({ error: '`from` / `to` must be valid dates' })
    }
    if (from) {
      query.where('a.timestamp', '>=', from)
      countQuery.where('a.timestamp', '>=', from)
    }
    if (to) {
      query.where('a.timestamp', '<=', to)
      countQuery.where('a.timestamp', '<=', to)
    }

    if (format === 'csv') {
      // No pagination for CSV export — fetch all matching rows
      const rows = (await query) as Record<string, unknown>[]
      const csv = toCSV(rows)
      reply.header('Content-Type', 'text/csv')
      reply.header('Content-Disposition', 'attachment; filename="activity-report.csv"')
      return reply.send(csv)
    }

    query.limit(limit).offset(offset)
    const [data, countRows] = await Promise.all([query, countQuery])
    const total = Number((countRows[0] as { count: string | number }).count)
    return reply.send({ data, total, page, limit })
  })

  // GET /api/reports/summary
  // Always windowed (last SUMMARY_DEFAULT_DAYS days when no `from`); aggregates read
  // nivaro_activity alone and names are joined after grouping (services/activity-report.ts).
  app.get('/summary', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string>
    // The Audit report sends GET /api/activity's filters (user, action, exclude_actions,
    // collection, item, range, q): every aggregate then counts what the report lists.
    const filtered = hasReportFilterParams(q)
    const rf = filtered ? reportFilters(q) : null
    if (rf && 'error' in rf) return reply.status(400).send({ error: rf.error })
    const win = rf ? rf.win : summaryWindow(q)
    if ('error' in win) return reply.status(400).send({ error: win.error })

    const mssql = isMssql(db)
    const groupKey = (await optionalActivityColumns().catch(() => new Set<string>())).has(
      'group_key'
    )
    const queries = summaryQueries(db, win, {
      apply: rf ? (qb) => void applyReportFilters(qb, rf, { mssql }) : undefined,
      groupKey
    })
    const [byAction, byCollection, byUser, totalRows, burstRows] = await Promise.all([
      queries.byAction,
      queries.byCollection,
      queries.byUser,
      queries.total,
      queries.largestBurst ? queries.largestBurst.catch(() => null) : Promise.resolve(null)
    ])

    const grouped = byUser as unknown as { user_id: string | null; count: string | number }[]
    const ids = grouped.map((r) => r.user_id).filter((id): id is string => id != null)
    const users = await selectInChunks(ids, 1000, (chunk) =>
      db('nivaro_users').select('id', 'first_name', 'last_name', 'email').whereIn('id', chunk)
    )

    const totalEvents = Number((totalRows[0] as { count: string | number }).count)

    return reply.send({
      by_action: byAction.map((r) => ({
        action: (r as { action: string }).action,
        count: Number((r as { count: string | number }).count)
      })),
      by_collection: byCollection.map((r) => ({
        collection: (r as { collection: string }).collection,
        count: Number((r as { count: string | number }).count)
      })),
      by_user: mergeUserNames(grouped, users),
      total_events: totalEvents,
      // The window actually counted: `from` is filled in when the default applied.
      date_range: {
        from: rf?.range ? win.from.toISOString() : q.from ? q.from : win.from.toISOString(),
        to: rf?.range ? (win.to?.toISOString() ?? null) : q.to ? q.to : null,
        default_days: win.defaulted ? SUMMARY_DEFAULT_DAYS : null,
        range: rf?.range ?? null
      },
      // The most rows one bulk action / import / flow run / job wrote (null before 516).
      largest_burst: largestBurstOf(burstRows as unknown[] | null),
      filtered
    })
  })
}

/**
 * The readable CSV: the newest READABLE_CSV_MAX matching entries, each with its sentence (read
 * as the exporting administrator) and the raw columns. Past the cap the answer says so in
 * X-Export-Truncated and X-Export-Rows; the page tells the reader to narrow the dates.
 *
 * `background=auto|1` (#2122 follow-up): a big one (more than EXPORT_BACKGROUND_ROWS entries,
 * or one that usually takes long) answers 202 and runs the same build as a job — progress and
 * Cancel in the Jobs tray, the file saved privately for the administrator.
 */
async function readableCsv(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  q: Record<string, string>
) {
  const parsed = normalizeActivityFilters(q)
  if (parsed.errors.length) return reply.status(400).send({ error: parsed.errors.join('; ') })
  const mode = parseBackgroundMode(q.background)
  const refusal = mode === 'off' ? null : backgroundRefusal(req)
  if (mode === 'always' && refusal)
    return reply.status(403).send({ error: refusal, code: 'BACKGROUND_EXPORT_REFUSED' })
  const user = req.user!
  const isAdmin = !!req.isAdmin
  if (mode !== 'off' && !refusal) {
    const ids = await readableCsvIds(parsed.filters)
    const rows = Math.min(ids.length, READABLE_CSV_MAX)
    if (
      await decideBackground(mode, {
        rows,
        kind: 'audit',
        subject: 'audit',
        redis: app.redis ?? null
      })
    ) {
      try {
        const started = await startExportRun(app, {
          user,
          kind: 'audit',
          subject: 'audit',
          label: 'the audit report',
          total: rows,
          build: (ctx) => buildReadableCsv(user, isAdmin, parsed.filters, q.tz, ctx)
        })
        return reply.code(202).send({ data: { mode: 'background', ...started } })
      } catch (err) {
        if (err instanceof ExportRunError)
          return reply.code(err.statusCode).send({ error: err.message, code: err.code })
        throw err
      }
    }
  }
  const startedAt = Date.now()
  const file = await buildReadableCsv(user, isAdmin, parsed.filters, q.tz)
  noteExportDuration('audit', 'audit', Date.now() - startedAt, app.redis ?? null)
  reply.header('Content-Type', file.contentType)
  reply.header('Content-Disposition', 'attachment; filename="audit-report.csv"')
  reply.header('X-Export-Rows', String(file.rows))
  reply.header('X-Export-Truncated', file.truncated ? '1' : '0')
  reply.header('Access-Control-Expose-Headers', 'X-Export-Rows, X-Export-Truncated')
  return reply.send(file.buffer)
}

type ActivityFilters = ReturnType<typeof normalizeActivityFilters>['filters']

/** The matching entry ids, newest first, one past the cap (so the cap can be told). */
async function readableCsvIds(filters: ActivityFilters): Promise<number[]> {
  const idQuery = db('nivaro_activity as a')
    .select('a.id')
    .orderBy([
      { column: 'a.timestamp', order: 'desc' },
      { column: 'a.id', order: 'desc' }
    ])
    .limit(READABLE_CSV_MAX + 1)
  applyActivityFilters(idQuery, filters, { mssql: isMssql(db) })
  return ((await idQuery) as Array<{ id: number | string }>).map((r) => Number(r.id))
}

/** The audit CSV — the synchronous answer and the background job build exactly this. */
export async function buildReadableCsv(
  user: User,
  isAdmin: boolean,
  filters: ActivityFilters,
  tz: string | undefined,
  ctx?: ExportContext
): Promise<ExportFile> {
  const all = await readableCsvIds(filters)
  const truncated = all.length > READABLE_CSV_MAX
  const ids = truncated ? all.slice(0, READABLE_CSV_MAX) : all
  const timeZone = csvTimeZone(tz)

  const out: ReadableCsvRow[] = []
  for (let i = 0; i < ids.length; i += READABLE_CSV_CHUNK) {
    await ctx?.throwIfCancelled()
    const rows = await pageRows(ids.slice(i, i + READABLE_CSV_CHUNK))
    const labels = await activityLabelsFor(user, activityLabelRefs(rows as never), {
      isAdmin
    }).catch(() => ({}))
    for (const r of rows) out.push(readableCsvRow(r as never, { ...labels, timeZone }))
    ctx?.progress({ done: out.length, total: ids.length, phase: 'Reading entries' })
  }
  // A BOM so Excel reads the sentences' quotes and dashes as UTF-8.
  return {
    buffer: Buffer.from(`﻿${toCSV(out, READABLE_CSV_COLUMNS)}`, 'utf8'),
    filename: `audit-report-${new Date().toISOString().slice(0, 10)}.csv`,
    contentType: 'text/csv; charset=utf-8',
    rows: out.length,
    truncated
  }
}
