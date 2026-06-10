import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

const LATENCY_SAMPLE_CAP = 50000

function parseHours(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 24
  return Math.min(Math.floor(n), 24 * 30) // cap at 30 days
}

function since(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000)
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))
  return sorted[idx]
}

export async function apiAnalyticsRoutes(app: FastifyInstance) {
  // GET /api-analytics/summary?hours=24
  app.get('/summary', { preHandler: requireAdmin }, async (req, reply) => {
    const { hours: hoursRaw } = req.query as { hours?: string }
    const hours = parseHours(hoursRaw)
    const from = since(hours)

    const [totalRow, errorRow, latRows] = await Promise.all([
      db('nivaro_api_logs').where('created_at', '>=', from).count('* as c').first(),
      db('nivaro_api_logs')
        .where('created_at', '>=', from)
        .andWhere('status', '>=', 400)
        .count('* as c')
        .first(),
      db('nivaro_api_logs')
        .where('created_at', '>=', from)
        .select('latency_ms')
        .limit(LATENCY_SAMPLE_CAP) as Promise<{ latency_ms: number }[]>
    ])

    const total = Number(totalRow?.c ?? 0)
    const errors = Number(errorRow?.c ?? 0)
    const latencies = latRows.map((r) => r.latency_ms).sort((a, b) => a - b)
    const avg = latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0

    return reply.send({
      data: {
        total,
        error_rate: total > 0 ? Math.round((errors / total) * 10000) / 100 : 0,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        avg_latency: Math.round(avg * 10) / 10
      }
    })
  })

  // GET /api-analytics/timeseries?hours=24 — hourly buckets
  app.get('/timeseries', { preHandler: requireAdmin }, async (req, reply) => {
    const { hours: hoursRaw } = req.query as { hours?: string }
    const hours = parseHours(hoursRaw)
    const from = since(hours)

    const rows = (await db.raw(
      `SELECT DATEADD(hour, DATEDIFF(hour, 0, created_at), 0) AS bucket,
              COUNT(*) AS count,
              AVG(CAST(latency_ms AS FLOAT)) AS avg_latency,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
       FROM nivaro_api_logs
       WHERE created_at >= ?
       GROUP BY DATEADD(hour, DATEDIFF(hour, 0, created_at), 0)
       ORDER BY bucket`,
      [from]
    )) as { bucket: Date; count: number; avg_latency: number | null; errors: number }[]

    return reply.send({
      data: rows.map((r) => ({
        bucket: r.bucket,
        count: Number(r.count),
        avg_latency: r.avg_latency != null ? Math.round(Number(r.avg_latency) * 10) / 10 : 0,
        errors: Number(r.errors)
      }))
    })
  })

  // GET /api-analytics/top-paths?hours=24
  app.get('/top-paths', { preHandler: requireAdmin }, async (req, reply) => {
    const { hours: hoursRaw } = req.query as { hours?: string }
    const from = since(parseHours(hoursRaw))

    const rows = (await db('nivaro_api_logs')
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
      .limit(20)) as unknown as {
      method: string
      path: string
      count: number
      avg_latency: number | null
      errors: number | null
    }[]

    return reply.send({
      data: rows.map((r) => ({
        method: r.method,
        path: r.path,
        count: Number(r.count),
        avg_latency: r.avg_latency != null ? Math.round(Number(r.avg_latency) * 10) / 10 : 0,
        errors: Number(r.errors ?? 0)
      }))
    })
  })

  // GET /api-analytics/top-collections?hours=24
  app.get('/top-collections', { preHandler: requireAdmin }, async (req, reply) => {
    const { hours: hoursRaw } = req.query as { hours?: string }
    const from = since(parseHours(hoursRaw))

    const rows = (await db('nivaro_api_logs')
      .where('created_at', '>=', from)
      .whereNotNull('collection')
      .select(
        'collection',
        db.raw('COUNT(*) as count'),
        db.raw('AVG(CAST(latency_ms AS FLOAT)) as avg_latency')
      )
      .groupBy('collection')
      .orderBy('count', 'desc')
      .limit(20)) as unknown as {
      collection: string
      count: number
      avg_latency: number | null
    }[]

    return reply.send({
      data: rows.map((r) => ({
        collection: r.collection,
        count: Number(r.count),
        avg_latency: r.avg_latency != null ? Math.round(Number(r.avg_latency) * 10) / 10 : 0
      }))
    })
  })

  // GET /api-analytics/errors — latest 50 error responses
  app.get('/errors', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await db('nivaro_api_logs')
      .where('status', '>=', 400)
      .orderBy('created_at', 'desc')
      .limit(50)
    return reply.send({ data: rows })
  })
}
