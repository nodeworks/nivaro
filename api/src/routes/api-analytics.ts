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

  // GET /api-analytics/by-key?hours=24 — per-API-key traffic (#67). Rows with
  // api_key_id NULL are session/static-token traffic and are excluded; a key
  // deleted since logging shows as its raw id rather than vanishing.
  app.get('/by-key', { preHandler: requireAdmin }, async (req, reply) => {
    const { hours: hoursRaw } = req.query as { hours?: string }
    const from = since(parseHours(hoursRaw))

    const rows = (await db('nivaro_api_logs as l')
      .leftJoin('nivaro_api_keys as k', 'k.id', 'l.api_key_id')
      .where('l.created_at', '>=', from)
      .whereNotNull('l.api_key_id')
      .select(
        'l.api_key_id',
        'k.name',
        db.raw('COUNT(*) as count'),
        db.raw('AVG(CAST(l.latency_ms AS FLOAT)) as avg_latency'),
        db.raw('SUM(CASE WHEN l.status >= 400 THEN 1 ELSE 0 END) as errors'),
        db.raw('MAX(l.created_at) as last_seen')
      )
      .groupBy('l.api_key_id', 'k.name')
      .orderBy('count', 'desc')
      .limit(50)) as unknown as {
      api_key_id: number
      name: string | null
      count: number
      avg_latency: number | null
      errors: number | null
      last_seen: string | Date | null
    }[]

    return reply.send({
      data: rows.map((r) => ({
        api_key_id: r.api_key_id,
        name: r.name ?? `key #${r.api_key_id} (deleted)`,
        count: Number(r.count),
        avg_latency: r.avg_latency != null ? Math.round(Number(r.avg_latency) * 10) / 10 : 0,
        errors: Number(r.errors ?? 0),
        last_seen: r.last_seen
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

  // GET /api-analytics/requests — the per-request list behind the aggregates.
  // Filters: hours, path (contains), method, status (exact or '4xx'/'5xx'),
  // user (id), api_key (id), auth (comma list of session|token|api_key|
  // masquerade|none), inbound=1 (= auth in token,api_key — every caller that
  // is not a person's browser session), page/limit (cap 200).
  app.get('/requests', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const hours = parseHours(q.hours)
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))
    const page = Math.max(1, Number(q.page) || 1)
    const base = db('nivaro_api_logs as l').where('l.created_at', '>=', since(hours))
    if (q.path) {
      const esc = q.path.replace(/[%_[]/g, (m) => `[${m}]`)
      void base.where('l.path', 'like', `%${esc}%`)
    }
    if (q.method) void base.where('l.method', q.method.toUpperCase())
    if (q.status) {
      const m = /^([1-5])xx$/i.exec(q.status)
      if (m) {
        const lo = Number(m[1]) * 100
        void base.where('l.status', '>=', lo).andWhere('l.status', '<', lo + 100)
      } else if (/^\d{3}$/.test(q.status)) void base.where('l.status', Number(q.status))
    }
    if (q.user) void base.where('l.user', q.user)
    if (q.api_key) void base.where('l.api_key_id', Number(q.api_key))
    if (q.inbound === '1' || q.inbound === 'true') {
      void base.whereIn('l.auth', ['token', 'api_key'])
    } else if (q.auth) {
      const kinds = q.auth
        .split(',')
        .map((v) => v.trim())
        .filter((v) => ['session', 'token', 'api_key', 'masquerade', 'none'].includes(v))
      if (kinds.length) void base.whereIn('l.auth', kinds)
    }
    if (q.errors === '1') void base.where('l.status', '>=', 400)

    const totalRow = (await base.clone().count('* as c').first()) as { c: number } | undefined
    const rows = (await base
      .clone()
      .leftJoin('nivaro_users as u', 'u.id', 'l.user')
      .leftJoin('nivaro_api_keys as k', 'k.id', 'l.api_key_id')
      .select(
        'l.id',
        'l.method',
        'l.path',
        'l.status',
        'l.latency_ms',
        'l.user',
        'l.collection',
        'l.api_key_id',
        'l.auth',
        'l.ip',
        'l.user_agent',
        'l.error',
        'l.created_at',
        'u.first_name',
        'u.last_name',
        'u.email',
        'k.name as api_key_name'
      )
      .orderBy('l.created_at', 'desc')
      .offset((page - 1) * limit)
      .limit(limit)) as Array<Record<string, unknown>>

    return reply.send({
      data: rows.map((r) => ({
        id: Number(r.id),
        method: r.method,
        path: r.path,
        status: r.status,
        latency_ms: r.latency_ms,
        user: r.user,
        user_name:
          r.first_name || r.last_name ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() : null,
        user_email: r.email ?? null,
        collection: r.collection,
        api_key_id: r.api_key_id,
        api_key_name: r.api_key_name ?? null,
        auth: r.auth,
        ip: r.ip,
        user_agent: r.user_agent,
        error: r.error,
        created_at: r.created_at
      })),
      total: Number(totalRow?.c ?? 0),
      page,
      limit
    })
  })

  // GET /api-analytics/callers?hours=24 — inbound integrations roll-up: one
  // row per non-session caller (static-token user or named API key): calls,
  // errors, latency, last call, last error (status/path/body), top paths.
  // "Inbound integration" needs no per-user flag — a token caller IS one.
  app.get('/callers', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const hours = parseHours(q.hours)
    const from = since(hours)
    const inbound = () =>
      db('nivaro_api_logs as l')
        .where('l.created_at', '>=', from)
        .whereIn('l.auth', ['token', 'api_key'])

    const [agg, paths, errs] = await Promise.all([
      inbound()
        .select('l.auth', 'l.user', 'l.api_key_id')
        .count('* as calls')
        .sum({ errors: db.raw('CASE WHEN l.status >= 400 THEN 1 ELSE 0 END') })
        .avg({ avg_ms: 'l.latency_ms' })
        .max({ max_ms: 'l.latency_ms' })
        .max({ last_at: 'l.created_at' })
        .groupBy('l.auth', 'l.user', 'l.api_key_id') as Promise<Array<Record<string, unknown>>>,
      inbound()
        .select('l.auth', 'l.user', 'l.api_key_id', 'l.method', 'l.path')
        .count('* as calls')
        .sum({ errors: db.raw('CASE WHEN l.status >= 400 THEN 1 ELSE 0 END') })
        .groupBy('l.auth', 'l.user', 'l.api_key_id', 'l.method', 'l.path')
        .orderBy('calls', 'desc')
        .limit(2000) as Promise<Array<Record<string, unknown>>>,
      inbound()
        .where('l.status', '>=', 400)
        .select(
          'l.auth',
          'l.user',
          'l.api_key_id',
          'l.status',
          'l.method',
          'l.path',
          'l.error',
          'l.created_at'
        )
        .orderBy('l.created_at', 'desc')
        .limit(500) as Promise<Array<Record<string, unknown>>>
    ])

    const keyOf = (r: Record<string, unknown>) =>
      r.auth === 'api_key' ? `key:${r.api_key_id}` : `user:${String(r.user ?? '').toUpperCase()}`

    const userIds = [
      ...new Set(agg.filter((r) => r.auth !== 'api_key' && r.user).map((r) => String(r.user)))
    ]
    const keyIds = [
      ...new Set(
        agg
          .filter((r) => r.auth === 'api_key' && r.api_key_id != null)
          .map((r) => Number(r.api_key_id))
      )
    ]
    const [users, keys] = await Promise.all([
      userIds.length
        ? (db('nivaro_users')
            .whereIn('id', userIds)
            .select('id', 'first_name', 'last_name', 'email', 'status') as Promise<
            Array<Record<string, unknown>>
          >)
        : Promise.resolve([] as Array<Record<string, unknown>>),
      keyIds.length
        ? (db('nivaro_api_keys')
            .whereIn('id', keyIds)
            .select('id', 'name', 'expires_at', 'last_used_at') as Promise<
            Array<Record<string, unknown>>
          >)
        : Promise.resolve([] as Array<Record<string, unknown>>)
    ])
    const userById = new Map(users.map((u) => [String(u.id).toUpperCase(), u]))
    const keyById = new Map(keys.map((k) => [Number(k.id), k]))

    const topPaths = new Map<
      string,
      Array<{ method: string; path: string; calls: number; errors: number }>
    >()
    for (const r of paths) {
      const k = keyOf(r)
      const list = topPaths.get(k) ?? []
      if (list.length < 5)
        list.push({
          method: String(r.method),
          path: String(r.path),
          calls: Number(r.calls),
          errors: Number(r.errors ?? 0)
        })
      topPaths.set(k, list)
    }
    const lastErr = new Map<string, Record<string, unknown>>()
    for (const r of errs) {
      const k = keyOf(r)
      if (!lastErr.has(k)) lastErr.set(k, r)
    }

    const data = agg
      .map((r) => {
        const k = keyOf(r)
        const isKey = r.auth === 'api_key'
        const u = isKey ? null : userById.get(String(r.user ?? '').toUpperCase())
        const key = isKey ? keyById.get(Number(r.api_key_id)) : null
        const label = isKey
          ? String(key?.name ?? `API key #${r.api_key_id}`)
          : u
            ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? r.user)
            : String(r.user ?? 'unknown')
        const e = lastErr.get(k)
        return {
          key: k,
          kind: isKey ? 'api_key' : 'token',
          label,
          email: u?.email ?? null,
          user: isKey ? null : r.user,
          api_key_id: isKey ? Number(r.api_key_id) : null,
          user_status: u?.status ?? null,
          key_expires_at: key?.expires_at ?? null,
          calls: Number(r.calls),
          errors: Number(r.errors ?? 0),
          avg_ms: Math.round(Number(r.avg_ms ?? 0)),
          max_ms: Number(r.max_ms ?? 0),
          last_at: r.last_at,
          last_error: e
            ? { at: e.created_at, status: e.status, method: e.method, path: e.path, error: e.error }
            : null,
          top_paths: topPaths.get(k) ?? []
        }
      })
      .sort((a, b) => b.calls - a.calls)

    return reply.send({ data, hours })
  })
}
