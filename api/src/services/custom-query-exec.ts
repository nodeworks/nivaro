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
        on(ev: 'row', h: (cols: Array<{ metadata: { colName: string }; value: unknown }>) => void): unknown
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
