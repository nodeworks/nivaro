import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'

function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const escape = (v: unknown): string => {
    let s = v == null ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))]
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
    if (q.from) {
      query.where('a.timestamp', '>=', new Date(q.from))
      countQuery.where('a.timestamp', '>=', new Date(q.from))
    }
    if (q.to) {
      query.where('a.timestamp', '<=', new Date(q.to))
      countQuery.where('a.timestamp', '<=', new Date(q.to))
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
  app.get('/summary', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string>

    const base = () => {
      const b = db('nivaro_activity as a')
      if (q.from) b.where('a.timestamp', '>=', new Date(q.from))
      if (q.to) b.where('a.timestamp', '<=', new Date(q.to))
      return b
    }

    const [byAction, byCollection, byUser, totalRows] = await Promise.all([
      base().select('a.action').count('a.id as count').groupBy('a.action').orderBy('count', 'desc'),
      base()
        .select('a.collection')
        .count('a.id as count')
        .groupBy('a.collection')
        .orderBy('count', 'desc')
        .whereNotNull('a.collection'),
      db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .select(db.raw('a.[user] as user_id'), 'u.first_name', 'u.last_name', 'u.email')
        .count('a.id as count')
        .groupBy('a.user', 'u.first_name', 'u.last_name', 'u.email')
        .orderBy('count', 'desc')
        .modify((qb) => {
          if (q.from) qb.where('a.timestamp', '>=', new Date(q.from))
          if (q.to) qb.where('a.timestamp', '<=', new Date(q.to))
        }),
      base().count('a.id as count')
    ])

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
      by_user: (
        byUser as {
          user_id: string
          first_name: string | null
          last_name: string | null
          email: string
          count: string | number
        }[]
      ).map((r) => ({
        user_id: r.user_id,
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
        count: Number(r.count)
      })),
      total_events: totalEvents,
      date_range: { from: q.from ?? null, to: q.to ?? null }
    })
  })
}
