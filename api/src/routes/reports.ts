import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import {
  mergeUserNames,
  parseReportDate,
  SUMMARY_DEFAULT_DAYS,
  summaryQueries,
  summaryWindow
} from '../services/activity-report.js'
import { selectInChunks } from '../services/db-batch.js'

function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
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
    const win = summaryWindow(q)
    if ('error' in win) return reply.status(400).send({ error: win.error })

    const queries = summaryQueries(db, win)
    const [byAction, byCollection, byUser, totalRows] = await Promise.all([
      queries.byAction,
      queries.byCollection,
      queries.byUser,
      queries.total
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
        from: q.from ? q.from : win.from.toISOString(),
        to: q.to ? q.to : null,
        default_days: win.defaulted ? SUMMARY_DEFAULT_DAYS : null
      }
    })
  })
}
