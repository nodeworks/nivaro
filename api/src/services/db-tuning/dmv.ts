import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { IDENT } from './types.js'

/**
 * The SQL Server catalog and DMV reads the tuning observers stand on. SQL Server only; every
 * reader answers empty (or null) on another dialect and on any error, so one missing
 * permission costs one observer its evidence, never the run. Names returned here come from
 * sys.* and are what apply / undo SQL is built from.
 */

export function isMssqlDb(): boolean {
  return isMssql(db)
}

const bracket = (s: string) => `[${s}]`
const rowsOf = (r: unknown) => (Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [])

/** When SQL Server last started: index usage stats count from here. */
export async function serverStartTime(): Promise<Date | null> {
  if (!isMssqlDb()) return null
  const rows = rowsOf(
    await db.raw('SELECT sqlserver_start_time AS t FROM sys.dm_os_sys_info').catch(() => [])
  )
  const t = rows[0]?.t
  if (!t) return null
  const d = new Date(t as Date)
  return Number.isFinite(d.getTime()) ? d : null
}

export async function serverUptimeDays(): Promise<number | null> {
  const t = await serverStartTime()
  return t ? (Date.now() - t.getTime()) / 86_400_000 : null
}

/** The database and default schema unqualified names resolve in. */
export async function currentDbAndSchema(): Promise<{ database: string; schema: string } | null> {
  if (!isMssqlDb()) return null
  const rows = rowsOf(await db.raw('SELECT DB_NAME() AS db, SCHEMA_NAME() AS sch').catch(() => []))
  const r = rows[0]
  return r?.db && r?.sch ? { database: String(r.db), schema: String(r.sch) } : null
}

/** `[name]` → `name` when the inside is one IDENT; anything else (`[a]]b]`, `a`, …) → null. */
export function unbracket(token: string): string | null {
  const m = token.trim().match(/^\[([A-Za-z_][A-Za-z0-9_]*)\]$/)
  return m ? m[1] : null
}

/** A DMV column list `[a], [b]` → names; null when any token is not a plain bracketed IDENT. */
export function bracketedList(s: string | null): string[] | null {
  if (!s) return []
  const out: string[] = []
  for (const token of s.split(',')) {
    const name = unbracket(token)
    if (!name) return null
    out.push(name)
  }
  return out
}

export interface MissingIndex {
  table: string
  equality: string[]
  inequality: string[]
  /** INCLUDE columns the optimizer asked for — evidence only; INCLUDE-widening is not proposed. */
  include?: string[]
  seeks: number
  scans: number
  avg_impact: number
  avg_cost: number
}

export async function missingIndexGroups(): Promise<MissingIndex[]> {
  if (!isMssqlDb()) return []
  const rows = rowsOf(
    await db
      .raw(`
    SELECT OBJECT_NAME(d.object_id) AS table_name, d.equality_columns, d.inequality_columns,
           d.included_columns, s.user_seeks, s.user_scans, s.avg_total_user_cost, s.avg_user_impact
    FROM sys.dm_db_missing_index_details d
    JOIN sys.dm_db_missing_index_groups g ON g.index_handle = d.index_handle
    JOIN sys.dm_db_missing_index_group_stats s ON s.group_handle = g.index_group_handle
    WHERE d.database_id = DB_ID() AND OBJECT_SCHEMA_NAME(d.object_id) = SCHEMA_NAME()`)
      .catch(() => [])
  )
  const out: MissingIndex[] = []
  for (const r of rows) {
    const equality = bracketedList(r.equality_columns as string | null)
    const inequality = bracketedList(r.inequality_columns as string | null)
    const include = bracketedList(r.included_columns as string | null)
    // A column we cannot name exactly is a suggestion we cannot build.
    if (!equality || !inequality || !include) continue
    out.push({
      table: String(r.table_name ?? ''),
      equality,
      inequality,
      include,
      seeks: Number(r.user_seeks ?? 0),
      scans: Number(r.user_scans ?? 0),
      avg_impact: Number(r.avg_user_impact ?? 0),
      avg_cost: Number(r.avg_total_user_cost ?? 0)
    })
  }
  return out
}

export interface IndexKeys {
  table: string
  index: string
  keys: string[]
}

/** Every live index's key columns in key order (default schema, user tables). Null on error,
 *  so a caller that must not duplicate an index can refuse to propose instead of guessing. */
export async function indexKeyLists(): Promise<IndexKeys[] | null> {
  if (!isMssqlDb()) return null
  const res = await db
    .raw(`
    SELECT OBJECT_NAME(i.object_id) AS table_name, i.name AS index_name, c.name AS column_name
    FROM sys.indexes i
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.index_id > 0 AND i.is_hypothetical = 0 AND i.is_disabled = 0
      AND OBJECTPROPERTY(i.object_id,'IsUserTable') = 1 AND OBJECT_SCHEMA_NAME(i.object_id) = SCHEMA_NAME()
    ORDER BY i.object_id, i.index_id, ic.key_ordinal`)
    .then((r: unknown) => (Array.isArray(r) ? rowsOf(r) : null))
    .catch(() => null)
  if (!res) return null
  const byIndex = new Map<string, IndexKeys>()
  for (const r of res) {
    const k = `${r.table_name}.${r.index_name}`
    const cur = byIndex.get(k) ?? {
      table: String(r.table_name),
      index: String(r.index_name),
      keys: []
    }
    cur.keys.push(String(r.column_name))
    byIndex.set(k, cur)
  }
  return [...byIndex.values()]
}

/** Which of `names` appear (case-insensitively) anywhere in a module definition — a hint such
 *  as WITH (INDEX(name)) would fail with error 308 once the index is gone. Deliberately loose:
 *  a mention is enough to decline. Null on error. */
export async function indexNamesInModules(names: string[]): Promise<Set<string> | null> {
  if (!isMssqlDb()) return null
  const valid = [...new Set(names.filter((n) => IDENT.test(n)).map((n) => n.toLowerCase()))]
  const out = new Set<string>()
  // A table value constructor takes at most 1000 rows.
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500)
    const res = await db
      .raw(
        `SELECT n.name FROM (VALUES ${chunk.map(() => '(?)').join(', ')}) AS n(name)
         WHERE EXISTS (SELECT 1 FROM sys.sql_modules m
                        WHERE CHARINDEX(LOWER(n.name), LOWER(m.definition)) > 0)`,
        chunk
      )
      .then((r: unknown) => (Array.isArray(r) ? rowsOf(r) : null))
      .catch(() => null)
    if (!res) return null
    for (const r of res) out.add(String(r.name).toLowerCase())
  }
  return out
}

export interface UsageRow {
  table: string
  index: string
  reads: number
  writes: number
  size_mb: number
  unique: boolean
  pk: boolean
  type: string
}

/** Every live (not hypothetical, not disabled) index on a user table in the default schema
 *  (the one unqualified names resolve to). */
export async function indexUsage(): Promise<UsageRow[]> {
  if (!isMssqlDb()) return []
  const rows = rowsOf(
    await db
      .raw(`
    SELECT OBJECT_NAME(i.object_id) AS table_name, i.name AS index_name, i.type_desc,
           i.is_unique, i.is_primary_key, i.is_unique_constraint,
           ISNULL(us.user_seeks,0)+ISNULL(us.user_scans,0)+ISNULL(us.user_lookups,0) AS reads,
           ISNULL(us.user_updates,0) AS writes,
           (SELECT SUM(ps.used_page_count)*8/1024 FROM sys.dm_db_partition_stats ps WHERE ps.object_id=i.object_id AND ps.index_id=i.index_id) AS size_mb
    FROM sys.indexes i
    LEFT JOIN sys.dm_db_index_usage_stats us ON us.object_id=i.object_id AND us.index_id=i.index_id AND us.database_id=DB_ID()
    WHERE i.index_id > 0 AND OBJECTPROPERTY(i.object_id,'IsUserTable')=1 AND i.name IS NOT NULL
      AND i.is_hypothetical = 0 AND i.is_disabled = 0
      AND OBJECT_SCHEMA_NAME(i.object_id) = SCHEMA_NAME()`)
      .catch(() => [])
  )
  return rows.map((r) => ({
    table: String(r.table_name),
    index: String(r.index_name),
    type: String(r.type_desc),
    unique: Boolean(r.is_unique) || Boolean(r.is_unique_constraint),
    pk: Boolean(r.is_primary_key),
    reads: Number(r.reads ?? 0),
    writes: Number(r.writes ?? 0),
    size_mb: Number(r.size_mb ?? 0)
  }))
}

export interface RedundantRow {
  table: string
  index: string
  covered_by: string
}

/** Indexes whose key list is a strict prefix of another's (the GET /ops-db/redundant-indexes
 *  query, restricted to live coverers in the default schema), one row per redundant index
 *  naming its widest covering index. */
export async function redundantIndexes(): Promise<RedundantRow[]> {
  if (!isMssqlDb()) return []
  const rows = rowsOf(
    await db
      .raw(`
        WITH keys AS (
          SELECT i.object_id, i.index_id, i.name, i.is_unique, i.is_primary_key, i.type_desc, i.has_filter,
                 STUFF((SELECT ',' + c.name
                          FROM sys.index_columns ic
                          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
                         ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 1, '') AS key_list,
                 (SELECT COUNT(*) FROM sys.index_columns ic
                   WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1) AS includes
            FROM sys.indexes i
           WHERE i.index_id > 0 AND i.type_desc = 'NONCLUSTERED'
             -- a leftover hypothetical (DTA) or a disabled index serves no query: never a coverer
             AND i.is_hypothetical = 0 AND i.is_disabled = 0
        )
        SELECT t.name AS table_name, a.name AS index_name, a.key_list AS keys,
               b.name AS covered_by, b.key_list AS covered_keys,
               ISNULL(us.user_updates, 0) AS writes, ISNULL(us.user_seeks + us.user_scans + us.user_lookups, 0) AS reads,
               CAST(SUM(ps.used_page_count) * 8.0 / 1024 AS decimal(10,2)) AS size_mb
          FROM keys a
          JOIN keys b ON b.object_id = a.object_id AND b.index_id <> a.index_id
                     AND LEN(b.key_list) > LEN(a.key_list)
                     AND LEFT(b.key_list, LEN(a.key_list) + 1) = a.key_list + ','
                     -- a FILTERED index covers only the rows its predicate keeps
                     AND b.has_filter = 0
          JOIN sys.tables t ON t.object_id = a.object_id
          LEFT JOIN sys.dm_db_index_usage_stats us ON us.object_id = a.object_id AND us.index_id = a.index_id AND us.database_id = DB_ID()
          LEFT JOIN sys.dm_db_partition_stats ps ON ps.object_id = a.object_id AND ps.index_id = a.index_id
         WHERE a.is_unique = 0 AND a.is_primary_key = 0 AND a.includes = 0 AND a.has_filter = 0
           AND SCHEMA_NAME(t.schema_id) = SCHEMA_NAME()
         GROUP BY t.name, a.name, a.key_list, b.name, b.key_list, us.user_updates, us.user_seeks, us.user_scans, us.user_lookups
         ORDER BY ISNULL(us.user_updates, 0) DESC
      `)
      .catch(() => [])
  )
  // One row per redundant index — the widest covering index is enough to name.
  const seen = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    const k = `${r.table_name}.${r.index_name}`
    const prev = seen.get(k)
    if (!prev || String(r.covered_keys).length > String(prev.covered_keys).length) seen.set(k, r)
  }
  return [...seen.values()].map((r) => ({
    table: String(r.table_name),
    index: String(r.index_name),
    covered_by: String(r.covered_by)
  }))
}

/** Indexes a foreign key relies on: `table.index` keys, lower-cased. */
export async function fkBackedIndexes(): Promise<Set<string>> {
  if (!isMssqlDb()) return new Set()
  const rows = rowsOf(
    await db
      .raw(`
    SELECT OBJECT_NAME(fk.parent_object_id) AS table_name, i.name AS index_name
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.index_columns ic ON ic.object_id = fkc.parent_object_id AND ic.column_id = fkc.parent_column_id AND ic.key_ordinal = 1
    JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    UNION
    SELECT OBJECT_NAME(fk.referenced_object_id), i.name
    FROM sys.foreign_keys fk JOIN sys.indexes i ON i.object_id = fk.referenced_object_id AND i.index_id = fk.key_index_id`)
      .catch(() => [])
  )
  return new Set(rows.map((r) => `${r.table_name}.${r.index_name}`.toLowerCase()))
}

/**
 * The CREATE statement that recreates an existing nonclustered rowstore index exactly: key
 * columns in key order with DESC, INCLUDE columns, the filter predicate, UNIQUE, the
 * filegroup, and the options a plain CREATE would otherwise reset (fill factor, padding,
 * IGNORE_DUP_KEY, statistics recompute, row/page locks, compression). Null whenever any piece
 * cannot be read or reproduced (a partitioned, disabled, hypothetical or constraint-owned
 * index, a name outside IDENT) — no rebuildable undo, no drop proposal.
 */
export async function indexDefinition(table: string, index: string): Promise<string | null> {
  if (!isMssqlDb() || !IDENT.test(table) || !IDENT.test(index)) return null
  const rows = rowsOf(
    await db
      .raw(
        `
    SELECT c.name, ic.key_ordinal, ic.is_included_column, ic.is_descending_key,
           i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.is_disabled,
           i.is_hypothetical, i.has_filter, i.filter_definition, i.fill_factor, i.is_padded,
           i.ignore_dup_key, i.allow_row_locks, i.allow_page_locks,
           ds.name AS data_space, ds.type AS data_space_type, ds.is_default AS data_space_default,
           (SELECT MAX(p.data_compression_desc) FROM sys.partitions p
             WHERE p.object_id = i.object_id AND p.index_id = i.index_id) AS compression,
           (SELECT s.no_recompute FROM sys.stats s
             WHERE s.object_id = i.object_id AND s.stats_id = i.index_id) AS no_recompute
    FROM sys.indexes i
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    LEFT JOIN sys.data_spaces ds ON ds.data_space_id = i.data_space_id
    WHERE i.object_id = OBJECT_ID(?) AND i.name = ?
    ORDER BY ic.is_included_column, ic.key_ordinal, ic.index_column_id`,
        [table, index]
      )
      .catch(() => [])
  )
  if (!rows.length) return null
  const i = rows[0]
  if (i.type_desc !== 'NONCLUSTERED') return null
  if (i.is_primary_key || i.is_unique_constraint || i.is_disabled || i.is_hypothetical) return null
  if (i.data_space_type !== 'FG') return null
  if (rows.some((r) => !IDENT.test(String(r.name ?? '')))) return null
  // A key column, an INCLUDE column, or neither (a partitioning column): the last means a
  // partition scheme this CREATE would not reproduce.
  const keyRows = rows
    .filter((r) => !r.is_included_column && Number(r.key_ordinal) > 0)
    .sort((a, z) => Number(a.key_ordinal) - Number(z.key_ordinal))
  const inclRows = rows.filter((r) => r.is_included_column)
  if (keyRows.length + inclRows.length !== rows.length || keyRows.length === 0) return null
  if (i.has_filter && !i.filter_definition) return null

  const keys = keyRows.map((r) => `${bracket(String(r.name))}${r.is_descending_key ? ' DESC' : ''}`)
  const incl = inclRows.map((r) => bracket(String(r.name)))
  const uniq = i.is_unique ? 'UNIQUE ' : ''
  const filter = i.has_filter ? ` WHERE ${i.filter_definition}` : ''
  const opts: string[] = []
  const fill = Number(i.fill_factor ?? 0)
  if (fill > 0 && fill < 100) opts.push(`FILLFACTOR = ${fill}`)
  if (i.is_padded) opts.push('PAD_INDEX = ON')
  if (i.is_unique && i.ignore_dup_key) opts.push('IGNORE_DUP_KEY = ON')
  if (i.no_recompute) opts.push('STATISTICS_NORECOMPUTE = ON')
  if (i.allow_row_locks === false || i.allow_row_locks === 0) opts.push('ALLOW_ROW_LOCKS = OFF')
  if (i.allow_page_locks === false || i.allow_page_locks === 0) opts.push('ALLOW_PAGE_LOCKS = OFF')
  const compression = String(i.compression ?? 'NONE')
  if (compression === 'ROW' || compression === 'PAGE')
    opts.push(`DATA_COMPRESSION = ${compression}`)
  else if (compression !== 'NONE') return null
  const dataSpace = String(i.data_space ?? '')
  if (!i.data_space_default && !IDENT.test(dataSpace)) return null
  const on = i.data_space_default ? '' : ` ON ${bracket(dataSpace)}`
  return `CREATE ${uniq}NONCLUSTERED INDEX ${bracket(index)} ON ${bracket(table)} (${keys.join(', ')})${incl.length ? ` INCLUDE (${incl.join(', ')})` : ''}${filter}${opts.length ? ` WITH (${opts.join(', ')})` : ''}${on}`
}

export interface ProcStat {
  name: string
  execution_count: number
  avg_elapsed_ms: number
  total_elapsed_ms: number
  cached_days: number
}

export async function procedureStats(): Promise<ProcStat[]> {
  if (!isMssqlDb()) return []
  const rows = rowsOf(
    await db
      .raw(`
    SELECT p.name AS name, ps.execution_count,
           ps.total_elapsed_time/1000 AS total_ms, ps.cached_time
    FROM sys.dm_exec_procedure_stats ps
    JOIN sys.procedures p ON p.object_id = ps.object_id
    WHERE ps.database_id = DB_ID() AND p.is_ms_shipped = 0
      AND SCHEMA_NAME(p.schema_id) = SCHEMA_NAME()`)
      .catch(() => [])
  )
  return rows
    .filter((r) => r.name)
    .map((r) => {
      const n = Number(r.execution_count ?? 0)
      const total = Number(r.total_ms ?? 0)
      const age = (Date.now() - new Date(r.cached_time as Date).getTime()) / 86_400_000
      return {
        name: String(r.name),
        execution_count: n,
        total_elapsed_ms: total,
        avg_elapsed_ms: n ? total / n : 0,
        cached_days: Math.max(1 / 24, Number.isFinite(age) ? age : 0)
      }
    })
}

export async function procedureBody(name: string): Promise<string | null> {
  if (!isMssqlDb() || !IDENT.test(name)) return null
  const rows = rowsOf(
    await db
      .raw(
        'SELECT m.definition FROM sys.procedures p JOIN sys.sql_modules m ON m.object_id = p.object_id WHERE p.name = ? AND p.is_ms_shipped = 0 AND SCHEMA_NAME(p.schema_id) = SCHEMA_NAME()',
        [name]
      )
      .catch(() => [])
  )
  return (rows[0]?.definition as string | undefined) ?? null
}

export interface StatementStat {
  text: string
  execution_count: number
  avg_elapsed_ms: number
  total_elapsed_ms: number
}

/** Plan-cache statements that read `table` and name `column` (knex quotes both in brackets).
 *  Proof-twin statements (`…__tune`) are left out. */
export async function statementsTouching(
  table: string,
  column: string,
  top = 5
): Promise<StatementStat[]> {
  if (!isMssqlDb() || !IDENT.test(table) || !IDENT.test(column)) return []
  // `_` is a LIKE wildcard: '%__tune%' would also drop any statement containing e.g. `retune`.
  const rows = rowsOf(
    await db
      .raw(
        `
    SELECT TOP (${Math.min(20, Math.max(1, Math.floor(top)))}) qs.execution_count, qs.total_elapsed_time/1000 AS total_ms,
      SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS statement_text
    FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE st.dbid = DB_ID() AND st.text LIKE ? ESCAPE '\\' AND st.text LIKE ? ESCAPE '\\'
      AND st.text NOT LIKE '%[_][_]tune%'
    ORDER BY qs.total_elapsed_time DESC`,
        [`%\\[${table}\\]%`, `%\\[${column}\\]%`]
      )
      .catch(() => [])
  )
  return rows.map((r) => {
    const n = Number(r.execution_count ?? 0)
    const total = Number(r.total_ms ?? 0)
    return {
      text: String(r.statement_text ?? '').slice(0, 8000),
      execution_count: n,
      total_elapsed_ms: total,
      avg_elapsed_ms: n ? total / n : 0
    }
  })
}
