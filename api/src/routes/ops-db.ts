import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * DB observability (Ops batch A): DMV-backed panels for the /db-health admin
 * page. Every endpoint degrades HONESTLY — a login without VIEW SERVER STATE
 * returns { unavailable: reason } instead of a 500, because these are
 * diagnostics, not features the app depends on.
 *
 * Covers: #100 deadlocks, #105 unused indexes, #106 expensive SQL, #114 pool,
 * #289 long transactions, #290 kill session, #291/#155 storage runway,
 * #295 table heat, #298 redis health.
 */

async function dmv<T>(fn: () => Promise<T>): Promise<{ data: T } | { unavailable: string }> {
  try {
    return { data: await fn() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      unavailable: /permission|VIEW SERVER STATE|denied/i.test(msg)
        ? 'The database login lacks VIEW SERVER STATE — grant it to enable this panel.'
        : msg.slice(0, 300)
    }
  }
}

/** knex/tarn pool stats — used by /health/detailed and the pool monitor cron too. */
export function poolStats(): {
  used: number
  free: number
  pending_acquires: number
  pending_creates: number
  max: number
} {
  const pool = (
    db.client as unknown as {
      pool?: {
        numUsed: () => number
        numFree: () => number
        numPendingAcquires: () => number
        numPendingCreates: () => number
        max: number
      }
    }
  ).pool
  if (!pool) return { used: 0, free: 0, pending_acquires: 0, pending_creates: 0, max: 0 }
  return {
    used: pool.numUsed(),
    free: pool.numFree(),
    pending_acquires: pool.numPendingAcquires(),
    pending_creates: pool.numPendingCreates(),
    max: pool.max
  }
}

export async function opsDbRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // #100 — deadlock graphs mined from the system_health XE ring buffer.
  app.get('/deadlocks', async (_req, reply) => {
    const result = await dmv(async () => {
      const rows = (await db.raw(`
        SELECT TOP 20
          xed.value('@timestamp', 'datetime2') AS occurred_at,
          xed.query('.') AS graph
        FROM (
          SELECT CAST(target_data AS XML) AS target_data
          FROM sys.dm_xe_session_targets st
          JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
          WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer'
        ) AS tab
        CROSS APPLY target_data.nodes('RingBufferTarget/event[@name="xml_deadlock_report"]') AS q(xed)
        ORDER BY occurred_at DESC
      `)) as Array<{ occurred_at: Date; graph: string }>
      return rows.map((r) => {
        const xml = String(r.graph ?? '')
        // Mine the two statements + victim out of the graph — the full XML is
        // returned too for anyone who wants the whole picture.
        const stmts = [...xml.matchAll(/<inputbuf>([\s\S]*?)<\/inputbuf>/g)]
          .map((m) => m[1].trim().slice(0, 500))
          .slice(0, 4)
        const victim = xml.match(/victim[^>]*id="([^"]+)"/)?.[1] ?? null
        return { occurred_at: r.occurred_at, victim, statements: stmts, xml: xml.slice(0, 20_000) }
      })
    })
    return reply.send(result)
  })

  // #106 — highest total-CPU statements (catches legacy Directus load too).
  app.get('/expensive-sql', async (_req, reply) => {
    const result = await dmv(async () => {
      const rows = (await db.raw(`
        SELECT TOP 15
          qs.total_worker_time / 1000 AS total_cpu_ms,
          qs.execution_count,
          qs.total_worker_time / NULLIF(qs.execution_count, 0) / 1000 AS avg_cpu_ms,
          qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000 AS avg_elapsed_ms,
          qs.last_execution_time,
          SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
            ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
              ELSE qs.statement_end_offset END - qs.statement_start_offset)/2) + 1) AS statement_text
        FROM sys.dm_exec_query_stats qs
        CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
        ORDER BY qs.total_worker_time DESC
      `)) as Array<Record<string, unknown>>
      return rows.map((r) => ({
        ...r,
        statement_text: String(r.statement_text ?? '').slice(0, 800)
      }))
    })
    return reply.send(result)
  })

  // #105 — indexes never read but constantly written: drop candidates.
  app.get('/unused-indexes', async (_req, reply) => {
    const result = await dmv(async () => {
      return (await db.raw(`
        SELECT TOP 30
          OBJECT_NAME(i.object_id) AS table_name,
          i.name AS index_name,
          ISNULL(us.user_seeks, 0) + ISNULL(us.user_scans, 0) + ISNULL(us.user_lookups, 0) AS reads,
          ISNULL(us.user_updates, 0) AS writes,
          (SELECT SUM(ps.used_page_count) * 8 / 1024 FROM sys.dm_db_partition_stats ps
            WHERE ps.object_id = i.object_id AND ps.index_id = i.index_id) AS size_mb
        FROM sys.indexes i
        LEFT JOIN sys.dm_db_index_usage_stats us
          ON us.object_id = i.object_id AND us.index_id = i.index_id AND us.database_id = DB_ID()
        WHERE i.type_desc = 'NONCLUSTERED'
          AND i.is_primary_key = 0 AND i.is_unique = 0 AND i.is_unique_constraint = 0
          AND OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1
          AND ISNULL(us.user_seeks, 0) + ISNULL(us.user_scans, 0) + ISNULL(us.user_lookups, 0) = 0
          AND ISNULL(us.user_updates, 0) > 100
        ORDER BY us.user_updates DESC
      `)) as Array<Record<string, unknown>>
    })
    return reply.send(result)
  })

  // #105 — one-click drop, guarded to plain nonclustered non-unique indexes.
  app.post<{ Body: { table?: string; index?: string } }>(
    '/unused-indexes/drop',
    async (req, reply) => {
      const table = String(req.body?.table ?? '')
      const index = String(req.body?.index ?? '')
      if (!/^[A-Za-z0-9_]+$/.test(table) || !/^[A-Za-z0-9_]+$/.test(index)) {
        return reply.code(400).send({ error: 'Invalid identifier' })
      }
      // Re-verify server-side that this is a droppable plain index — the
      // client list is advisory, the guard is here.
      const check = (await db.raw(
        `SELECT i.type_desc, i.is_primary_key, i.is_unique, i.is_unique_constraint
         FROM sys.indexes i WHERE OBJECT_NAME(i.object_id) = ? AND i.name = ?`,
        [table, index]
      )) as Array<{
        type_desc: string
        is_primary_key: boolean
        is_unique: boolean
        is_unique_constraint: boolean
      }>
      const row = check[0]
      if (!row) return reply.code(404).send({ error: 'Index not found' })
      if (
        row.type_desc !== 'NONCLUSTERED' ||
        row.is_primary_key ||
        row.is_unique ||
        row.is_unique_constraint
      ) {
        return reply.code(400).send({ error: 'Only plain nonclustered indexes can be dropped here' })
      }
      await db.raw(`DROP INDEX ${'[' + index + ']'} ON ${'[' + table + ']'}`)
      await logActivity({
        action: 'index-drop',
        user: req.user?.id,
        collection: table,
        comment: `dropped unused index ${index}`,
        req
      })
      return reply.send({ data: { dropped: `${table}.${index}` } })
    }
  )

  // #289 — sessions holding open transactions while idle.
  app.get('/long-transactions', async (_req, reply) => {
    const result = await dmv(async () => {
      return (await db.raw(`
        SELECT s.session_id, s.login_name, s.host_name, s.program_name, s.status,
               s.last_request_end_time, s.open_transaction_count,
               DATEDIFF(minute, s.last_request_end_time, GETDATE()) AS idle_minutes
        FROM sys.dm_exec_sessions s
        WHERE s.open_transaction_count > 0 AND s.is_user_process = 1
          AND s.status = 'sleeping'
          AND DATEDIFF(minute, s.last_request_end_time, GETDATE()) >= 5
        ORDER BY idle_minutes DESC
      `)) as Array<Record<string, unknown>>
    })
    return reply.send(result)
  })

  // #290 — KILL a blocking/long-transaction session, with reason + audit.
  app.post<{ Body: { session_id?: number; reason?: string } }>('/kill', async (req, reply) => {
    const sid = Number(req.body?.session_id)
    const reason = String(req.body?.reason ?? '').trim()
    if (!Number.isInteger(sid) || sid <= 50) {
      // spids <= 50 are system sessions — never killable from here.
      return reply.code(400).send({ error: 'session_id must be a user session id (> 50)' })
    }
    if (!reason) return reply.code(400).send({ error: 'A reason is required' })
    const own = (await db.raw('SELECT @@SPID AS spid')) as Array<{ spid: number }>
    if (own[0]?.spid === sid) {
      return reply.code(400).send({ error: 'Refusing to kill our own connection' })
    }
    const exists = (await db.raw(
      'SELECT session_id FROM sys.dm_exec_sessions WHERE session_id = ? AND is_user_process = 1',
      [sid]
    )) as Array<{ session_id: number }>
    if (!exists[0]) return reply.code(404).send({ error: 'Session not found (already gone?)' })
    await db.raw(`KILL ${sid}`)
    await logActivity({
      action: 'db-session-kill',
      user: req.user?.id,
      comment: `KILL ${sid}: ${reason.slice(0, 300)}`,
      req
    })
    return reply.send({ data: { killed: sid } })
  })

  // #295 — IO by table: reads vs writes, biggest first.
  app.get('/table-heat', async (_req, reply) => {
    const result = await dmv(async () => {
      return (await db.raw(`
        SELECT TOP 30
          OBJECT_NAME(us.object_id) AS table_name,
          SUM(us.user_seeks + us.user_scans + us.user_lookups) AS reads,
          SUM(us.user_updates) AS writes,
          MAX(ps.row_count) AS row_count
        FROM sys.dm_db_index_usage_stats us
        JOIN (
          SELECT object_id, SUM(row_count) AS row_count
          FROM sys.dm_db_partition_stats WHERE index_id IN (0, 1) GROUP BY object_id
        ) ps ON ps.object_id = us.object_id
        WHERE us.database_id = DB_ID() AND OBJECTPROPERTY(us.object_id, 'IsUserTable') = 1
        GROUP BY us.object_id
        ORDER BY SUM(us.user_seeks + us.user_scans + us.user_lookups + us.user_updates) DESC
      `)) as Array<Record<string, unknown>>
    })
    return reply.send(result)
  })

  // #114 — connection pool right now, with #304 leak attribution: which
  // requests are holding connections and for how long.
  app.get('/pool', async (_req, reply) => {
    const { heldConnections } = await import('../services/pool-attribution.js')
    return reply.send({ data: { ...poolStats(), held: heldConnections() } })
  })

  // #213 — data velocity: rows created/changed per day per collection.
  app.get<{ Querystring: { days?: string } }>('/velocity', async (req, reply) => {
    const days = Math.min(90, Number(req.query.days) || 14)
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = (await db('nivaro_activity')
      .where('timestamp', '>', since)
      .whereIn('action', ['create', 'update'])
      .whereNot('collection', 'like', 'nivaro\\_%')
      .groupBy('collection', 'action', db.raw('CAST(timestamp AS date)'))
      .select('collection', 'action', db.raw('CAST(timestamp AS date) as day'))
      .count('* as n')
      .catch(() => [])) as Array<{ collection: string; action: string; day: Date; n: number }>
    return reply.send({ data: rows })
  })

  // #306 — latency by hour: hour-of-day x route p50-ish heat from the api log.
  app.get('/latency-heat', async (_req, reply) => {
    const since = new Date(Date.now() - 7 * 86_400_000)
    const rows = (await db('nivaro_api_logs')
      .where('created_at', '>', since)
      .groupBy(db.raw('DATEPART(hour, created_at)'), 'path')
      .havingRaw('COUNT(*) >= 20')
      .select(
        db.raw('DATEPART(hour, created_at) as hour'),
        'path',
        db.raw('AVG(CAST(latency_ms AS float)) as avg_ms'),
        db.raw('COUNT(*) as n')
      )
      .orderByRaw('AVG(CAST(latency_ms AS float)) DESC')
      .limit(400)
      .catch(() => [])) as Array<Record<string, unknown>>
    return reply.send({ data: rows })
  })

  // #307 — estimated plan for a statement off the expensive-SQL panel. SELECT
  // only, same posture as the scratchpad's plan mode.
  app.post<{ Body: { sql?: string } }>('/explain', async (req, reply) => {
    const sql = String(req.body?.sql ?? '').trim()
    if (!sql) return reply.code(400).send({ error: 'sql is required' })
    const stripped = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()
    if (!/^(select|with)\b/i.test(stripped)) {
      return reply.code(400).send({ error: 'Only SELECT statements can be explained here' })
    }
    try {
      const { explainSqlPlan } = await import('../services/custom-query-exec.js')
      const plan = await explainSqlPlan(sql, {})
      return reply.send({ data: { plan } })
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message.slice(0, 300) : 'Explain failed' })
    }
  })

  // #311 — Inngest panel: best-effort read of the self-hosted Inngest API.
  app.get('/inngest', async (_req, reply) => {
    const base = process.env.INNGEST_API_URL || 'http://localhost:8288'
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 4000)
      const res = await fetch(`${base}/v1/events?limit=20`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!res.ok) return reply.send({ unavailable: `Inngest answered ${res.status}` })
      const body = (await res.json()) as { data?: unknown[] }
      return reply.send({ data: { base, recent_events: (body.data ?? []).slice(0, 20) } })
    } catch {
      return reply.send({ unavailable: `Inngest unreachable at ${base} (set INNGEST_API_URL)` })
    }
  })

  // #457 — dangling-FK repair wizard: the nightly sweep detects; these routes
  // list live and FIX in bulk. Repoint is deliberately NOT offered — picking a
  // new parent is a data decision, not a repair.
  app.get('/dangling-fks', async (_req, reply) => {
    const { detectDanglingFks } = await import('../services/fk-integrity.js')
    return reply.send({ data: await detectDanglingFks() })
  })
  app.post<{
    Body: { many_collection?: string; many_field?: string; one_collection?: string; action?: string }
  }>('/dangling-fks/repair', async (req, reply) => {
    const manyCollection = String(req.body?.many_collection ?? '')
    const manyField = String(req.body?.many_field ?? '')
    const oneCollection = String(req.body?.one_collection ?? '')
    const action = String(req.body?.action ?? '')
    const ident = /^[A-Za-z0-9_]+$/
    if (!ident.test(manyCollection) || !ident.test(manyField) || !ident.test(oneCollection)) {
      return reply.code(400).send({ error: 'Invalid identifiers' })
    }
    if (/^nivaro_/i.test(manyCollection) && manyCollection !== 'nivaro_users') {
      return reply.code(400).send({ error: 'System tables are not repairable here' })
    }
    if (action !== 'null_out' && action !== 'trash_delete') {
      return reply.code(400).send({ error: "action must be 'null_out' or 'trash_delete'" })
    }
    // Verify this IS a registered relation — the identifiers must come from
    // the sweep's own list, never free-typed table names.
    const rel = await db('nivaro_relations')
      .where({ many_collection: manyCollection, many_field: manyField, one_collection: oneCollection })
      .first('id')
    if (!rel) return reply.code(404).send({ error: 'No such registered relation' })

    // The dangling set, re-derived NOW (the wizard's list may be stale).
    const danglingIds = (await db.raw(
      `SELECT TOP 2000 m.id FROM [${manyCollection}] m
       LEFT JOIN [${oneCollection}] o ON o.id = m.[${manyField}]
       WHERE m.[${manyField}] IS NOT NULL AND o.id IS NULL`
    )) as Array<{ id: unknown }>
    if (danglingIds.length === 0) return reply.send({ data: { repaired: 0 } })
    const ids = danglingIds.map((r) => String(r.id))

    let repaired = 0
    if (action === 'null_out') {
      // Nullability check first — nulling a NOT NULL column would just error
      // per row; refuse with the reason instead.
      const colInfo = (await db.raw(
        `SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [manyCollection, manyField]
      )) as Array<{ IS_NULLABLE: string }>
      if (colInfo[0]?.IS_NULLABLE !== 'YES') {
        return reply.code(400).send({ error: `${manyCollection}.${manyField} is NOT NULL — null-out is impossible; use trash-delete or fix the parent` })
      }
      const { selectInChunks } = await import('../services/db-batch.js')
      await selectInChunks(ids, 1000, async (chunk) => {
        await db(manyCollection).whereIn('id', chunk).update({ [manyField]: null })
        return []
      })
      repaired = ids.length
    } else {
      // Deletes go THROUGH the items service so trash/guards/hooks apply.
      const { deleteOne } = await import('../services/items.js')
      for (const id of ids.slice(0, 500)) {
        try {
          await deleteOne(req.user!, manyCollection, id)
          repaired++
        } catch {
          /* guard/permission blocked this row — count stays honest */
        }
      }
    }
    await logActivity({
      action: 'fk-repair',
      user: req.user?.id,
      collection: manyCollection,
      comment: `${action} ${repaired} row(s) with dangling ${manyField} → ${oneCollection}`,
      req
    })
    return reply.send({ data: { repaired, action } })
  })

  // #298 — Redis health: memory, evictions, keyspace, slowlog.
  app.get('/redis', async (_req, reply) => {
    try {
      const redis = (app as unknown as { redis?: { info: () => Promise<string>; slowlog: (cmd: string, n: number) => Promise<unknown[]> } }).redis
      if (!redis) return reply.send({ unavailable: 'Redis is not connected' })
      const info = await redis.info()
      const pick = (key: string) => info.match(new RegExp(`^${key}:(.+)$`, 'm'))?.[1]?.trim() ?? null
      let slowlog: unknown[] = []
      try {
        slowlog = await redis.slowlog('GET', 10)
      } catch {
        /* slowlog may be disabled */
      }
      return reply.send({
        data: {
          used_memory_human: pick('used_memory_human'),
          maxmemory_human: pick('maxmemory_human'),
          evicted_keys: pick('evicted_keys'),
          connected_clients: pick('connected_clients'),
          keyspace_hits: pick('keyspace_hits'),
          keyspace_misses: pick('keyspace_misses'),
          total_keys: (info.match(/^db\d+:keys=(\d+)/m)?.[1] ?? null),
          uptime_in_days: pick('uptime_in_days'),
          slowlog
        }
      })
    } catch (err) {
      return reply.send({ unavailable: err instanceof Error ? err.message : 'Redis info failed' })
    }
  })

  // #291/#155 — storage snapshots + a linear runway projection.
  app.get('/storage', async (_req, reply) => {
    const snapshots = (await db('nivaro_storage_snapshots')
      .orderBy('snapshot_date', 'desc')
      .limit(90)
      .catch(() => [])) as Array<{
      snapshot_date: string
      db_mb: number | null
      uploads_mb: number | null
      top_tables: string | null
    }>
    const current = await dmv(async () => {
      const size = (await db.raw(`
        SELECT SUM(CAST(size AS bigint)) * 8 / 1024 AS total_mb,
               SUM(CAST(FILEPROPERTY(name, 'SpaceUsed') AS bigint)) * 8 / 1024 AS used_mb
        FROM sys.database_files WHERE type = 0
      `)) as Array<{ total_mb: number; used_mb: number }>
      const top = (await db.raw(`
        SELECT TOP 20 OBJECT_NAME(object_id) AS table_name,
               SUM(row_count) AS row_count,
               SUM(used_page_count) * 8 / 1024 AS mb
        FROM sys.dm_db_partition_stats
        WHERE OBJECTPROPERTY(object_id, 'IsUserTable') = 1
        GROUP BY object_id ORDER BY SUM(used_page_count) DESC
      `)) as Array<Record<string, unknown>>
      return { ...size[0], top_tables: top }
    })
    // Runway: least-squares over the snapshots' used MB per day.
    let runway: { mb_per_day: number; days_history: number } | null = null
    const pts = snapshots
      .filter((s) => s.db_mb != null)
      .map((s) => ({ x: new Date(s.snapshot_date).getTime() / 86_400_000, y: Number(s.db_mb) }))
      .reverse()
    if (pts.length >= 7) {
      const n = pts.length
      const sx = pts.reduce((a, p) => a + p.x, 0)
      const sy = pts.reduce((a, p) => a + p.y, 0)
      const sxy = pts.reduce((a, p) => a + p.x * p.y, 0)
      const sxx = pts.reduce((a, p) => a + p.x * p.x, 0)
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1)
      runway = { mb_per_day: Math.round(slope * 100) / 100, days_history: n }
    }
    return reply.send({ data: { current, snapshots: snapshots.slice(0, 30), runway } })
  })
}
