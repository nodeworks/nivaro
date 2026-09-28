import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { recordReplayRoot } from '../services/chain-roots.js'
import { queryIsReplayable } from '../services/secret-mask.js'

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

  // GET /api-analytics/graphql?hours=24 — per-operation view of /graphql
  // traffic (#607): latency percentiles, error rate, measured cost, callers,
  // the slowest calls, and which @deprecated fields are still selected and by
  // whom. Newest 20,000 GraphQL rows in the window, aggregated here.
  app.get('/graphql', { preHandler: requireAdmin }, async (req, reply) => {
    const { hours: hoursRaw } = req.query as { hours?: string }
    const from = since(parseHours(hoursRaw))
    if (!(await hasColumn('nivaro_api_logs', 'graphql_operation'))) {
      return reply.send({ data: { operations: [], deprecated: [], total: 0, unavailable: true } })
    }
    type Row = {
      id: number | string
      created_at: Date | string
      latency_ms: number
      status: number
      user: string | null
      api_key_id: number | null
      auth: string | null
      graphql_operation: string | null
      graphql_kind: string | null
      graphql_depth: number | null
      graphql_selections: number | null
      graphql_errors: number | null
      graphql_deprecated: string | null
    }
    const rows = (await db('nivaro_api_logs')
      .where('created_at', '>=', from)
      .whereNotNull('graphql_operation')
      .orderBy('id', 'desc')
      .limit(20000)
      .select(
        'id',
        'created_at',
        'latency_ms',
        'status',
        'user',
        'api_key_id',
        'auth',
        'graphql_operation',
        'graphql_kind',
        'graphql_depth',
        'graphql_selections',
        'graphql_errors',
        'graphql_deprecated'
      )) as Row[]

    const userIds = [...new Set(rows.map((r) => r.user).filter((u): u is string => !!u))]
    const keyIds = [...new Set(rows.map((r) => r.api_key_id).filter((k): k is number => k != null))]
    const [users, keys] = await Promise.all([
      userIds.length
        ? (db('nivaro_users')
            .whereIn('id', userIds)
            .select('id', 'first_name', 'last_name', 'email') as Promise<
            Array<{
              id: string
              first_name: string | null
              last_name: string | null
              email: string
            }>
          >)
        : Promise.resolve([]),
      keyIds.length
        ? (db('nivaro_api_keys').whereIn('id', keyIds).select('id', 'name') as Promise<
            Array<{ id: number; name: string }>
          >)
        : Promise.resolve([])
    ])
    const userName = new Map(
      users.map((u) => [
        String(u.id).toUpperCase(),
        `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email
      ])
    )
    const keyName = new Map(keys.map((k) => [Number(k.id), k.name]))
    const callerOf = (r: Row): string =>
      r.api_key_id != null
        ? `key · ${keyName.get(Number(r.api_key_id)) ?? `#${r.api_key_id}`}`
        : r.user
          ? (userName.get(String(r.user).toUpperCase()) ?? 'a person')
          : r.auth === 'key_sim'
            ? 'run-as-key session'
            : 'anonymous'
    const failed = (r: Row) => r.status >= 400 || Number(r.graphql_errors ?? 0) > 0

    type Agg = {
      operation: string
      kind: string | null
      count: number
      errors: number
      latencies: number[]
      depth: number
      depthN: number
      selections: number
      selectionsN: number
      callers: Map<string, number>
      slow: Array<{
        id: number | string
        at: string
        latency_ms: number
        caller: string
        failed: boolean
      }>
      deprecated: Set<string>
      last_seen: string
    }
    const byOp = new Map<string, Agg>()
    const depUse = new Map<
      string,
      { count: number; operations: Set<string>; callers: Map<string, number>; last_seen: string }
    >()
    for (const r of rows) {
      const name = r.graphql_operation ?? '(unnamed)'
      const at = new Date(r.created_at).toISOString()
      let a = byOp.get(name)
      if (!a) {
        a = {
          operation: name,
          kind: r.graphql_kind,
          count: 0,
          errors: 0,
          latencies: [],
          depth: 0,
          depthN: 0,
          selections: 0,
          selectionsN: 0,
          callers: new Map(),
          slow: [],
          deprecated: new Set(),
          last_seen: at
        }
        byOp.set(name, a)
      }
      a.count++
      if (failed(r)) a.errors++
      a.latencies.push(Number(r.latency_ms) || 0)
      if (r.graphql_depth != null) {
        a.depth += Number(r.graphql_depth)
        a.depthN++
      }
      if (r.graphql_selections != null) {
        a.selections += Number(r.graphql_selections)
        a.selectionsN++
      }
      const caller = callerOf(r)
      a.callers.set(caller, (a.callers.get(caller) ?? 0) + 1)
      a.slow.push({
        id: r.id,
        at,
        latency_ms: Number(r.latency_ms) || 0,
        caller,
        failed: failed(r)
      })
      if (a.slow.length > 40) {
        a.slow.sort((x, y) => y.latency_ms - x.latency_ms)
        a.slow.length = 5
      }
      if (at > a.last_seen) a.last_seen = at
      for (const f of (r.graphql_deprecated ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        a.deprecated.add(f)
        let d = depUse.get(f)
        if (!d) {
          d = { count: 0, operations: new Set(), callers: new Map(), last_seen: at }
          depUse.set(f, d)
        }
        d.count++
        d.operations.add(name)
        d.callers.set(caller, (d.callers.get(caller) ?? 0) + 1)
        if (at > d.last_seen) d.last_seen = at
      }
    }
    const topCallers = (m: Map<string, number>) =>
      [...m.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([caller, count]) => ({ caller, count }))
    const operations = [...byOp.values()]
      .map((a) => {
        const sorted = [...a.latencies].sort((x, y) => x - y)
        return {
          operation: a.operation,
          kind: a.kind,
          count: a.count,
          errors: a.errors,
          error_rate: a.count ? Math.round((a.errors / a.count) * 1000) / 10 : 0,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          max: sorted[sorted.length - 1] ?? 0,
          avg_depth: a.depthN ? Math.round((a.depth / a.depthN) * 10) / 10 : null,
          avg_selections: a.selectionsN ? Math.round(a.selections / a.selectionsN) : null,
          callers: topCallers(a.callers),
          slowest: a.slow.sort((x, y) => y.latency_ms - x.latency_ms).slice(0, 5),
          deprecated_fields: [...a.deprecated],
          last_seen: a.last_seen
        }
      })
      .sort((x, y) => y.count - x.count)
    const deprecated = [...depUse.entries()]
      .map(([field, d]) => ({
        field,
        count: d.count,
        operations: [...d.operations].slice(0, 10),
        callers: topCallers(d.callers),
        last_seen: d.last_seen
      }))
      .sort((x, y) => y.count - x.count)
    return reply.send({ data: { operations, deprecated, total: rows.length, unavailable: false } })
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
    const withQuery = await hasColumn('nivaro_api_logs', 'query')
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
        'l.request_body',
        ...(withQuery ? ['l.query'] : []),
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
        request_body: r.request_body ?? null,
        query: (r.query as string | null | undefined) ?? null,
        created_at: r.created_at
      })),
      total: Number(totalRow?.c ?? 0),
      page,
      limit
    })
  })

  // #67 — replay an inbound request from the log: same method + path, the
  // stored body (or an edited one), dispatched in-process AS THE ADMIN who
  // clicked (the caller's credential is never stored). The new request logs
  // normally and carries x-nivaro-replay-of so the two rows can be paired.
  app.post<{ Params: { id: string }; Body: { body?: unknown; query?: string } }>(
    '/requests/:id/replay',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = (await db('nivaro_api_logs')
        .where({ id: Number(req.params.id) })
        .first()) as
        | {
            id: number
            method: string
            path: string
            request_body: string | null
            query?: string | null
          }
        | undefined
      if (!row) return reply.code(404).send({ error: 'Request not found' })
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method))
        return reply.code(400).send({ error: 'Only write requests can be replayed' })
      if (!row.path.startsWith('/api/') && row.path !== '/graphql' && row.path !== '/files')
        return reply.code(400).send({ error: 'Path is not an API route' })
      const hasEdited = req.body && 'body' in req.body
      let payload: unknown
      if (hasEdited) payload = req.body.body
      else if (row.request_body) {
        if (row.request_body.endsWith('…'))
          return reply
            .code(400)
            .send({ error: 'Stored body was truncated — supply the body to replay' })
        try {
          payload = JSON.parse(row.request_body)
        } catch {
          return reply.code(400).send({ error: 'Stored body is not valid JSON' })
        }
      } else return reply.code(400).send({ error: 'No request body was stored for this request' })
      // The query string goes along. One that was cut short, or that held a
      // masked value, cannot be sent as stored — the caller supplies it.
      const given = req.body && typeof req.body.query === 'string' ? req.body.query : null
      if (given === null && !queryIsReplayable(row.query))
        return reply.code(400).send({
          error:
            'The stored query string was cut short or holds a masked value — supply the query to replay',
          code: 'REPLAY_QUERY_NEEDED',
          query: row.query
        })
      const query = (given ?? row.query ?? '').replace(/^\?/, '')
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-nivaro-replay-of': String(row.id)
      }
      // The injected request adopts this route's chain, so the replayed
      // writes land under it; point it at the original request's chain.
      // `.first()` reads every column, so chain_id is present once 351 ran.
      await recordReplayRoot({
        source: 'core:inbound',
        ref: `replay:${row.id}`,
        replayOf: (row as { chain_id?: string | null }).chain_id ?? null
      })
      const auth = req.headers.authorization
      if (typeof auth === 'string') headers.authorization = auth
      const cookie = req.headers.cookie
      if (typeof cookie === 'string') headers.cookie = cookie
      const t0 = Date.now()
      const res = await app.inject({
        method: row.method as 'POST',
        url: query ? `${row.path}?${query}` : row.path,
        headers,
        payload: JSON.stringify(payload)
      })
      let body: unknown = res.body
      try {
        body = JSON.parse(res.body)
      } catch {
        /* text */
      }
      await logActivity({
        action: 'api-request-replay',
        user: req.user?.id,
        req,
        comment: `${row.method} ${row.path}${query ? '?…' : ''} (log #${row.id}) → ${res.statusCode}${hasEdited ? ' · edited body' : ''}${given !== null ? ' · edited query' : ''}`
      })
      return reply.send({
        data: {
          status: res.statusCode,
          ok: res.statusCode < 400,
          duration_ms: Date.now() - t0,
          body: typeof body === 'string' ? body.slice(0, 64 * 1024) : body,
          replay_of: Number(row.id)
        }
      })
    }
  )

  // GET /api-analytics/callers?hours=24 — inbound integrations roll-up: one
  // row per non-session caller (static-token user or named API key): calls,
  // errors, latency, last call, last error (status/path/body), top paths.
  // "Inbound integration" needs no per-user flag — a token caller IS one.
  app.get('/callers', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const hours = parseHours(q.hours)
    const from = since(hours)
    // A refused credential that matched nobody is logged as token / api_key
    // with no caller — those belong to /auth-failures, not to a caller card.
    const inbound = () =>
      db('nivaro_api_logs as l')
        .where('l.created_at', '>=', from)
        .whereIn('l.auth', ['token', 'api_key'])
        .where((w) => w.whereNotNull('l.user').orWhereNotNull('l.api_key_id'))

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

    // A refused call by a known key carries the key and no account, so one
    // key can arrive as two grouped rows. One caller, one card.
    const fold = (
      rows: Array<Record<string, unknown>>,
      extra: (r: Record<string, unknown>) => string
    ) => {
      const out = new Map<string, Record<string, unknown>>()
      for (const r of rows) {
        const k = `${keyOf(r)}|${extra(r)}`
        const prev = out.get(k)
        if (!prev) {
          out.set(k, { ...r })
          continue
        }
        const calls = Number(prev.calls) + Number(r.calls)
        if (r.avg_ms != null || prev.avg_ms != null) {
          prev.avg_ms =
            (Number(prev.avg_ms ?? 0) * Number(prev.calls) +
              Number(r.avg_ms ?? 0) * Number(r.calls)) /
            Math.max(1, calls)
        }
        prev.calls = calls
        prev.errors = Number(prev.errors ?? 0) + Number(r.errors ?? 0)
        if (r.max_ms != null) prev.max_ms = Math.max(Number(prev.max_ms ?? 0), Number(r.max_ms))
        if (
          r.last_at != null &&
          (prev.last_at == null || new Date(r.last_at as string) > new Date(prev.last_at as string))
        )
          prev.last_at = r.last_at
        if (prev.user == null && r.user != null) prev.user = r.user
      }
      return [...out.values()]
    }
    const aggFolded = fold(agg, () => '')
    const pathsFolded = fold(paths, (r) => `${r.method} ${r.path}`).sort(
      (x, y) => Number(y.calls) - Number(x.calls)
    )

    const userIds = [
      ...new Set(aggFolded.filter((r) => r.auth !== 'api_key' && r.user).map((r) => String(r.user)))
    ]
    const keyIds = [
      ...new Set(
        aggFolded
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
    for (const r of pathsFolded) {
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

    const data = aggFolded
      .map((r) => {
        const k = keyOf(r)
        const isKey = r.auth === 'api_key'
        const u = isKey ? null : userById.get(String(r.user ?? '').toUpperCase())
        const key = isKey ? keyById.get(Number(r.api_key_id)) : null
        const label = isKey
          ? String(key?.name ?? `API key #${r.api_key_id} (deleted)`)
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

  // ── Refused credentials ──────────────────────────────────────────────────
  // 401 / 403 / 429 answers given to non-session callers, grouped by who asked
  // (API key, account, or address when the credential matched nobody) and by
  // the machine code of the refusal.
  app.get('/auth-failures', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const hours = parseHours(q.hours)
    const from = since(hours)
    const SCAN = 5000
    const rows = (await db('nivaro_api_logs as l')
      .where('l.created_at', '>=', from)
      .whereIn('l.status', [401, 403, 429])
      .whereIn('l.auth', ['token', 'api_key', 'masquerade'])
      .select(
        'l.auth',
        'l.user',
        'l.api_key_id',
        'l.status',
        'l.method',
        'l.path',
        'l.error',
        'l.ip',
        'l.user_agent',
        'l.created_at'
      )
      .orderBy('l.created_at', 'desc')
      .limit(SCAN + 1)) as Array<Record<string, unknown>>
    const truncated = rows.length > SCAN
    if (truncated) rows.length = SCAN

    type Group = {
      key: string
      kind: 'api_key' | 'token' | 'masquerade' | 'unknown'
      credential: string
      api_key_id: number | null
      user: string | null
      ip: string | null
      code: string
      status: number
      message: string | null
      count: number
      first_at: unknown
      last_at: unknown
      sample: { method: string; path: string }
      ips: string[]
      user_agent: string | null
    }
    const groups = new Map<string, Group>()
    for (const r of rows) {
      const parsed = parseRefusal(r.error, Number(r.status))
      const known = r.api_key_id != null || r.user != null
      const who =
        r.api_key_id != null
          ? `key:${r.api_key_id}`
          : r.user != null
            ? `user:${String(r.user).toUpperCase()}`
            : `ip:${r.ip ?? 'unknown'}`
      const k = `${who}|${parsed.code}`
      const g = groups.get(k)
      const ip = r.ip ? String(r.ip) : null
      if (g) {
        g.count += 1
        g.first_at = r.created_at
        if (ip && g.ips.length < 5 && !g.ips.includes(ip)) g.ips.push(ip)
        continue
      }
      groups.set(k, {
        key: k,
        kind: known ? (String(r.auth) as Group['kind']) : 'unknown',
        credential: String(r.auth),
        api_key_id: r.api_key_id != null ? Number(r.api_key_id) : null,
        user: r.user != null ? String(r.user) : null,
        ip,
        code: parsed.code,
        status: Number(r.status),
        message: parsed.message,
        count: 1,
        first_at: r.created_at,
        last_at: r.created_at,
        sample: { method: String(r.method), path: String(r.path) },
        ips: ip ? [ip] : [],
        user_agent: r.user_agent ? String(r.user_agent) : null
      })
    }

    const list = [...groups.values()]
    const userIds = [...new Set(list.map((g) => g.user).filter((v): v is string => !!v))]
    const keyIds = [...new Set(list.map((g) => g.api_key_id).filter((v): v is number => v != null))]
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
            .select('id', 'name', 'is_active', 'expires_at', 'rate_limit_per_minute') as Promise<
            Array<Record<string, unknown>>
          >)
        : Promise.resolve([] as Array<Record<string, unknown>>)
    ])
    const userById = new Map(users.map((u) => [String(u.id).toUpperCase(), u]))
    const keyById = new Map(keys.map((k) => [Number(k.id), k]))

    const data = list
      .map((g) => {
        const key = g.api_key_id != null ? keyById.get(g.api_key_id) : null
        const u = g.user ? userById.get(g.user.toUpperCase()) : null
        const label = key
          ? String(key.name ?? `API key #${g.api_key_id}`)
          : g.api_key_id != null
            ? `API key #${g.api_key_id} (deleted)`
            : u
              ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? g.user)
              : g.ip
                ? `Unrecognised caller at ${g.ip}`
                : 'Unrecognised caller'
        return {
          ...g,
          label,
          email: u?.email ?? null,
          user_status: u?.status ?? null,
          key_active: key ? key.is_active === true || key.is_active === 1 : null,
          key_expires_at: key?.expires_at ?? null,
          key_rate_limit: key?.rate_limit_per_minute ?? null
        }
      })
      .sort((a, b) => b.count - a.count)

    return reply.send({
      data,
      hours,
      truncated,
      totals: {
        failures: rows.length,
        callers: new Set(data.map((d) => d.key.split('|')[0])).size,
        by_code: Object.entries(
          data.reduce<Record<string, number>>((acc, d) => {
            acc[d.code] = (acc[d.code] ?? 0) + d.count
            return acc
          }, {})
        )
          .map(([code, count]) => ({ code, count }))
          .sort((a, b) => b.count - a.count)
      }
    })
  })
}

/**
 * The refusal as the caller received it. The log keeps the first part of the
 * response body; a body cut mid-JSON still yields its code by pattern.
 */
export function parseRefusal(
  raw: unknown,
  status: number
): { code: string; message: string | null } {
  const fallback = status === 429 ? 'RATE_LIMITED' : status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED'
  if (typeof raw !== 'string' || !raw) return { code: fallback, message: null }
  try {
    const body = JSON.parse(raw) as Record<string, unknown>
    const first = Array.isArray(body.errors)
      ? (body.errors[0] as Record<string, unknown> | undefined)
      : undefined
    const ext = (first?.extensions ?? {}) as Record<string, unknown>
    const code = body.code ?? ext.code
    const message = body.message ?? first?.message ?? body.error
    return {
      code: typeof code === 'string' && code ? code : fallback,
      message: typeof message === 'string' ? message.slice(0, 300) : null
    }
  } catch {
    const code = raw.match(/"code"\s*:\s*"([A-Z0-9_]+)"/)?.[1]
    const message = raw.match(/"message"\s*:\s*"([^"]{1,300})/)?.[1]
    return { code: code ?? fallback, message: message ?? null }
  }
}
