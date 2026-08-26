import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

// ─── Per-key usage analytics (#605) ──────────────────────────────────────────
// Registered at the same /api-keys prefix as the CRUD routes (second-plugin
// precedent: mailLogRoutes + mailLogReadRoutes). Reads nivaro_api_logs rows
// stamped with api_key_id by the api-logger plugin.

const WINDOW_DAYS = 30
const TOP_ROUTES = 10

export async function apiKeyUsageRoutes(app: FastifyInstance) {
  // GET /api-keys/:id/usage — last-30d daily request/error series + top routes
  app.get('/:id/usage', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'Invalid API key id' })
    }
    const key = (await db('nivaro_api_keys').where({ id }).first('id', 'name', 'is_active')) as
      | { id: number; name: string; is_active: boolean }
      | undefined
    if (!key) return reply.code(404).send({ error: 'API key not found' })

    const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000)

    const [dailyRows, routeRows, totalRow] = await Promise.all([
      db.raw(
        `SELECT CONVERT(date, created_at) AS day,
                COUNT(*) AS count,
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
         FROM nivaro_api_logs
         WHERE api_key_id = ? AND created_at >= ?
         GROUP BY CONVERT(date, created_at)
         ORDER BY day`,
        [id, from]
      ) as Promise<{ day: string | Date; count: number; errors: number }[]>,
      db('nivaro_api_logs')
        .where('api_key_id', id)
        .where('created_at', '>=', from)
        .select(
          'method',
          'path',
          db.raw('COUNT(*) as count'),
          db.raw('AVG(CAST(latency_ms AS FLOAT)) as avg_latency'),
          db.raw('SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors')
        )
        .groupBy('method', 'path')
        .orderBy('count', 'desc')
        .limit(TOP_ROUTES) as unknown as Promise<
        {
          method: string
          path: string
          count: number
          avg_latency: number | null
          errors: number | null
        }[]
      >,
      db('nivaro_api_logs')
        .where('api_key_id', id)
        .where('created_at', '>=', from)
        .select(
          db.raw('COUNT(*) as total'),
          db.raw('SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors'),
          db.raw('MAX(created_at) as last_seen')
        )
        .first() as unknown as Promise<
        { total: number; errors: number | null; last_seen: string | Date | null } | undefined
      >
    ])

    // Dense day axis — a gap day renders as zero instead of vanishing.
    const byDay = new Map<string, { count: number; errors: number }>()
    for (const r of dailyRows) {
      const key = new Date(r.day).toISOString().slice(0, 10)
      byDay.set(key, { count: Number(r.count), errors: Number(r.errors ?? 0) })
    }
    const days: { day: string; count: number; errors: number }[] = []
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
      const row = byDay.get(day)
      days.push({ day, count: row?.count ?? 0, errors: row?.errors ?? 0 })
    }

    return reply.send({
      data: {
        key: { id: key.id, name: key.name, is_active: !!key.is_active },
        window_days: WINDOW_DAYS,
        total: Number(totalRow?.total ?? 0),
        errors: Number(totalRow?.errors ?? 0),
        last_seen: totalRow?.last_seen ?? null,
        days,
        top_routes: routeRows.map((r) => ({
          method: r.method,
          path: r.path,
          count: Number(r.count),
          avg_latency: r.avg_latency != null ? Math.round(Number(r.avg_latency) * 10) / 10 : 0,
          errors: Number(r.errors ?? 0)
        }))
      }
    })
  })
}
