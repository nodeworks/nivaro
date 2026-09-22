import { db } from '../db/index.js'

/**
 * Custom-query execution core, shared by the /custom-queries/:slug/execute
 * route and server-side consumers (report-studio alert/digest resolution for
 * 'query' widgets). Auth/access checks stay in the route — callers of
 * runCustomQueryBySlug are trusted server paths.
 */

export interface CustomQueryRowRec {
  id: number
  slug: string
  sql_text: string
  params: string | null
  cache_ttl: number
  enabled: boolean
  access: string
}

export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'date'
export interface ParamDef {
  name: string
  type: ParamType
  required?: boolean
  default?: unknown
  default_value?: unknown
}

function castParam(value: unknown, type: ParamType): unknown {
  if (value == null) return value
  switch (type) {
    case 'number':
    case 'integer': {
      const n = Number(value)
      return Number.isNaN(n) ? value : type === 'integer' ? Math.trunc(n) : n
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1 || value === '1'
    case 'date': {
      if (value === '') return null
      const d = value instanceof Date ? value : new Date(String(value))
      return Number.isNaN(d.getTime()) ? null : d
    }
    default:
      return String(value)
  }
}

/** Merge incoming params with defs (defaults + type casts). Throws on missing required. */
export function buildFinalParams(
  defs: ParamDef[],
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const finalParams: Record<string, unknown> = {}
  for (const def of defs) {
    const provided = Object.hasOwn(incoming, def.name)
    let value = provided ? incoming[def.name] : (def.default ?? def.default_value)
    if ((value == null || value === '') && def.required) {
      throw Object.assign(new Error(`Missing required parameter: ${def.name}`), {
        statusCode: 400
      })
    }
    if (value != null && value !== '') value = castParam(value, def.type)
    else value = null
    finalParams[def.name] = value
  }
  return finalParams
}

/**
 * Substitute :tokens as safe literals and run the SQL as a raw tedious batch
 * (sp_executesql swallows stored-proc result sets — see the route comment).
 */
export async function execCustomQuerySql(
  sqlText: string,
  finalParams: Record<string, unknown>
): Promise<Array<Record<string, unknown>>> {
  const resolvedSql = sqlText.replace(/:(\w+)/g, (_, k: string) => {
    const v = finalParams[k]
    if (v == null || v === '') return 'NULL'
    if (typeof v === 'boolean') return v ? '1' : '0'
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) return 'NULL'
      return `'${v.toISOString().slice(0, 23).replace('T', ' ')}'`
    }
    return `'${String(v).replace(/'/g, "''")}'`
  })

  // biome-ignore lint/suspicious/noExplicitAny: internal Knex/tedious plumbing
  const knexClient = (db as any).client
  const Driver = knexClient._driver() as {
    Request: new (sql: string, cb: (err: Error | null, count: number) => void) => unknown
  }
  const conn = (await knexClient.acquireConnection()) as { execSqlBatch(r: unknown): void }
  try {
    return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      const req = new Driver.Request(resolvedSql, (err: Error | null) => {
        if (err) done(() => reject(err))
      }) as {
        on(
          ev: 'row',
          h: (cols: Array<{ metadata: { colName: string }; value: unknown }>) => void
        ): unknown
        on(ev: 'error', h: (e: Error) => void): unknown
        once(ev: 'requestCompleted', h: () => void): unknown
        setTimeout?: (ms: number) => void
      }
      // Heavy report procs outlive the connection-level 15s requestTimeout.
      req.setTimeout?.(120_000)
      const collected: Array<Record<string, unknown>> = []
      req.on('row', (cols) => {
        const row: Record<string, unknown> = {}
        for (const col of cols) row[col.metadata.colName] = col.value
        collected.push(row)
      })
      req.once('requestCompleted', () => done(() => resolve(collected)))
      req.on('error', (e) => done(() => reject(e)))
      conn.execSqlBatch(req)
    })
  } finally {
    await knexClient.releaseConnection(conn)
  }
}

/**
 * Estimated execution plan for a statement (#74) — SET SHOWPLAN_XML needs its
 * own batch on the SAME connection, so this runs three batches: plan mode on,
 * the statement (NOT executed — SQL Server returns the plan instead), plan
 * mode off. Params substituted the same way execCustomQuerySql does.
 */
export async function explainSqlPlan(
  sqlText: string,
  finalParams: Record<string, unknown>,
  opts: { raw?: boolean } = {}
): Promise<string | null> {
  const resolvedSql = opts.raw
    ? sqlText
    : sqlText.replace(/:(\w+)/g, (_, k: string) => {
        const v = finalParams[k]
        if (v == null || v === '') return 'NULL'
        if (typeof v === 'boolean') return v ? '1' : '0'
        if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
        return `'${String(v).replace(/'/g, "''")}'`
      })

  // biome-ignore lint/suspicious/noExplicitAny: internal Knex/tedious plumbing
  const knexClient = (db as any).client
  const Driver = knexClient._driver() as {
    Request: new (sql: string, cb: (err: Error | null, count: number) => void) => unknown
  }
  const conn = (await knexClient.acquireConnection()) as { execSqlBatch(r: unknown): void }

  const runBatch = (sql: string): Promise<Array<Record<string, unknown>>> =>
    new Promise((resolve, reject) => {
      let settled = false
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      const req = new Driver.Request(sql, (err: Error | null) => {
        if (err) done(() => reject(err))
      }) as {
        on(
          ev: 'row',
          h: (cols: Array<{ metadata: { colName: string }; value: unknown }>) => void
        ): unknown
        on(ev: 'error', h: (e: Error) => void): unknown
        once(ev: 'requestCompleted', h: () => void): unknown
        setTimeout?: (ms: number) => void
      }
      req.setTimeout?.(60_000)
      const collected: Array<Record<string, unknown>> = []
      req.on('row', (cols) => {
        const row: Record<string, unknown> = {}
        for (const col of cols) row[col.metadata.colName] = col.value
        collected.push(row)
      })
      req.once('requestCompleted', () => done(() => resolve(collected)))
      req.on('error', (e) => done(() => reject(e)))
      conn.execSqlBatch(req)
    })

  try {
    await runBatch('SET SHOWPLAN_XML ON')
    try {
      const rows = await runBatch(resolvedSql)
      const first = rows[0]
      if (!first) return null
      const xml = Object.values(first)[0]
      return typeof xml === 'string' ? xml : null
    } finally {
      // ALWAYS turn plan mode off — a pooled connection left in SHOWPLAN mode
      // would return plans instead of data to the next unrelated query.
      await runBatch('SET SHOWPLAN_XML OFF').catch(() => {})
    }
  } finally {
    await knexClient.releaseConnection(conn)
  }
}

/**
 * Server-side execution by slug (no auth/access check — trusted callers only;
 * disabled queries refuse). Used by report-studio 'query' widget resolution.
 */
export async function runCustomQueryBySlug(
  slug: string,
  incoming: Record<string, unknown>
): Promise<Array<Record<string, unknown>>> {
  const query = (await db('nivaro_custom_queries').where({ slug }).first()) as
    | CustomQueryRowRec
    | undefined
  if (!query || !query.enabled) {
    throw Object.assign(new Error(`Custom query not found: ${slug}`), { statusCode: 404 })
  }
  let defs: ParamDef[] = []
  try {
    defs = query.params ? (JSON.parse(query.params) as ParamDef[]) : []
  } catch {
    defs = []
  }
  const finalParams = buildFinalParams(defs, incoming)
  return execCustomQuerySql(query.sql_text, finalParams)
}

/**
 * The plan for a statement AS THE ROUTE RAN IT (#509).
 *
 * A hand-rebuilt query with literals gets a different plan from the
 * parameterized statement knex sends through sp_executesql — the 16.4s
 * project-360 hub ran 133ms with literals, which sent that investigation the
 * wrong way twice. So the first source is the PLAN CACHE: the exact statement
 * text (knex's `@p0…` form, which the trace recorded) looked up in
 * sys.dm_exec_query_stats, returning the cached plan plus its real execution
 * counts and times. Only when the plan has been evicted does this fall back to
 * an estimated plan over declared variables — labelled as such, because a
 * variable is not a parameter (no sniffing) and its plan is a third shape.
 *
 * SHOWPLAN over `EXEC sp_executesql` is not an option: it returns the EXEC
 * stub, never the inner statement.
 */
export async function planForStatement(
  sql: string,
  bindings: unknown[]
): Promise<{
  source: 'cache' | 'estimated'
  plan: string | null
  stats: {
    execution_count: number
    avg_elapsed_ms: number
    last_elapsed_ms: number
    max_elapsed_ms: number
    avg_logical_reads: number
    last_execution_time: string | null
  } | null
}> {
  const cached = await cachedPlanFor(sql).catch(() => null)
  if (cached) return { source: 'cache', ...cached }
  const decls = bindings.map((v, i) => {
    const { type, literal } = sqlParam(v)
    return `DECLARE @p${i} ${type} = ${literal};`
  })
  const plan = await explainSqlPlan(`${decls.join('\n')}\n${sql}`, {}, { raw: true })
  return { source: 'estimated', plan, stats: null }
}

async function cachedPlanFor(sql: string): Promise<{
  plan: string | null
  stats: NonNullable<Awaited<ReturnType<typeof planForStatement>>['stats']>
} | null> {
  const rows = (await db.raw(
    `SELECT TOP 1
        qp.query_plan AS plan_xml,
        qs.execution_count,
        qs.total_elapsed_time / 1000.0 / qs.execution_count AS avg_elapsed_ms,
        qs.last_elapsed_time / 1000.0 AS last_elapsed_ms,
        qs.max_elapsed_time / 1000.0 AS max_elapsed_ms,
        qs.total_logical_reads / qs.execution_count AS avg_logical_reads,
        qs.last_execution_time
     FROM sys.dm_exec_query_stats qs
     CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
     CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
     WHERE SUBSTRING(st.text, (qs.statement_start_offset / 2) + 1,
             ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
               ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2) + 1) = ?
     ORDER BY qs.last_execution_time DESC`,
    [sql]
  )) as Array<Record<string, unknown>>
  const r = rows?.[0]
  if (!r) return null
  return {
    plan: typeof r.plan_xml === 'string' ? r.plan_xml : null,
    stats: {
      execution_count: Number(r.execution_count),
      avg_elapsed_ms: Math.round(Number(r.avg_elapsed_ms) * 10) / 10,
      last_elapsed_ms: Math.round(Number(r.last_elapsed_ms) * 10) / 10,
      max_elapsed_ms: Math.round(Number(r.max_elapsed_ms) * 10) / 10,
      avg_logical_reads: Math.round(Number(r.avg_logical_reads)),
      last_execution_time:
        r.last_execution_time instanceof Date ? r.last_execution_time.toISOString() : null
    }
  }
}

/** The SQL type + literal tedious would send for a binding, for the plan replay. */
function sqlParam(v: unknown): { type: string; literal: string } {
  if (v == null) return { type: 'nvarchar(4000)', literal: 'NULL' }
  if (typeof v === 'boolean') return { type: 'bit', literal: v ? '1' : '0' }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { type: 'float', literal: 'NULL' }
    if (Number.isInteger(v)) {
      return Math.abs(v) <= 2_147_483_647
        ? { type: 'int', literal: String(v) }
        : { type: 'bigint', literal: String(v) }
    }
    return { type: 'float', literal: String(v) }
  }
  if (typeof v === 'bigint') return { type: 'bigint', literal: v.toString() }
  if (v instanceof Date) {
    return { type: 'datetime2', literal: `'${v.toISOString().slice(0, 23).replace('T', ' ')}'` }
  }
  if (Buffer.isBuffer(v)) return { type: 'varbinary(max)', literal: `0x${v.toString('hex')}` }
  const str = String(v)
  return {
    type: str.length > 4000 ? 'nvarchar(max)' : 'nvarchar(4000)',
    literal: `N'${str.replace(/'/g, "''")}'`
  }
}
