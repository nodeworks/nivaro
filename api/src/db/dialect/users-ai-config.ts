import type { Knex } from 'knex'
import { fastLike } from '../../services/search-like.js'
import { rawRows } from '../raw-rows.js'
import { likeCi, likeEscape, sqlDialect } from '../sql-dialect.js'

/**
 * Cross-dialect SQL fragments for the users / auth / AI / config area (phase 2, bucket G).
 * SQL Server output is the text the code wrote before.
 */

/** CAST(expr AS BIGINT) on SQL Server and Postgres; MySQL has no BIGINT cast target (SIGNED is 64-bit). */
export function castBigint(knex: Knex, expr: string): string {
  return sqlDialect(knex) === 'mysql' ? `CAST(${expr} AS SIGNED)` : `CAST(${expr} AS BIGINT)`
}

/** CAST(expr AS FLOAT) — MySQL spells the 64-bit float DOUBLE (FLOAT casts need 8.0.17+; DOUBLE is safe). */
export function castFloat(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  if (d === 'mysql') return `CAST(${expr} AS DOUBLE)`
  if (d === 'pg') return `CAST(${expr} AS DOUBLE PRECISION)`
  return `CAST(${expr} AS FLOAT)`
}

/**
 * The bracket-quoted identifier text SQL Server code writes (`[x]`) in the dialect's quoting.
 * Only for trusted identifiers (table/column names from the registry, validated elsewhere).
 */
export function quoteIdent(knex: Knex, name: string): string {
  const d = sqlDialect(knex)
  if (d === 'pg' || d === 'sqlite') return `"${name.replace(/"/g, '""')}"`
  if (d === 'mysql') return `\`${name.replace(/`/g, '``')}\``
  return `[${name.replace(/]/g, ']]')}]`
}

/**
 * Case-insensitive "contains" LIKE for a value escaped with a backslash (`ai-call-log`
 * `likeContains`). SQL Server keeps the fast binary-collation form (`fastLike`); Postgres uses
 * ILIKE, MySQL LIKE, each with its own ESCAPE spelling.
 */
export function likeContainsSql(
  knex: Knex,
  colSql: string,
  pattern: string,
  kind: 'unicode' | 'ansi'
): { sql: string; bindings: unknown[] } {
  if (sqlDialect(knex) === 'mssql') return fastLike(colSql, pattern, kind, { escape: '\\' })
  return { sql: `${colSql} ${likeCi(knex)} ? ${likeEscape(knex)}`, bindings: [pattern] }
}

/**
 * Time bucket label for charts: `yyyy-MM-ddTHH` (hour) or `yyyy-MM-dd` (day) of a datetime
 * expression, the same text on all three databases.
 */
export function bucketLabel(knex: Knex, expr: string, unit: 'hour' | 'day'): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite')
    return unit === 'hour' ? `strftime('%Y-%m-%dT%H', ${expr})` : `strftime('%Y-%m-%d', ${expr})`
  if (d === 'pg')
    return unit === 'hour'
      ? `to_char(${expr}, 'YYYY-MM-DD"T"HH24')`
      : `to_char(${expr}, 'YYYY-MM-DD')`
  if (d === 'mysql')
    return unit === 'hour'
      ? `DATE_FORMAT(${expr}, '%Y-%m-%dT%H')`
      : `DATE_FORMAT(${expr}, '%Y-%m-%d')`
  return unit === 'hour' ? `FORMAT(${expr}, 'yyyy-MM-dd''T''HH')` : `FORMAT(${expr}, 'yyyy-MM-dd')`
}

/**
 * PERCENTILE_CONT(p) over a numeric column of a base query, interpolated like SQL Server's
 * windowed PERCENTILE_CONT. Reads the count, then the one or two neighbouring rows — works on
 * Postgres and MySQL (MySQL has no percentile function). `make()` must return a FRESH builder
 * with the filter already applied.
 */
export async function percentilesOf(
  make: () => Knex.QueryBuilder,
  column: string,
  ps: number[]
): Promise<Array<number | null>> {
  const row = (await make().whereNotNull(column).count({ n: '*' }).first()) as
    | { n?: unknown }
    | undefined
  const n = Number(row?.n ?? 0)
  if (!n) return ps.map(() => null)
  const out: Array<number | null> = []
  for (const p of ps) {
    const pos = p * (n - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    const rows = (await make()
      .whereNotNull(column)
      .orderBy(column, 'asc')
      .offset(lo)
      .limit(hi > lo ? 2 : 1)
      .select({ v: column })) as Array<{ v: unknown }>
    const a = Number(rows[0]?.v)
    const b = Number(rows[rows.length - 1]?.v)
    out.push(Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * (pos - lo) : null)
  }
  return out
}

/** Like bucketLabel but the hour form reads `yyyy-MM-dd HH:00` (the AI analytics chart). */
export function bucketLabelSpaced(knex: Knex, expr: string, unit: 'hour' | 'day'): string {
  const d = sqlDialect(knex)
  if (unit === 'day') return bucketLabel(knex, expr, 'day')
  if (d === 'sqlite') return `strftime('%Y-%m-%d %H:00', ${expr})`
  if (d === 'pg') return `(to_char(${expr}, 'YYYY-MM-DD HH24') || ':00')`
  if (d === 'mysql') return `DATE_FORMAT(${expr}, '%Y-%m-%d %H:00')`
  return `FORMAT(${expr}, 'yyyy-MM-dd HH:00')`
}

/** Names of the `nivaro_*` base tables in the connected database. */
export async function listNivaroTables(knex: Knex): Promise<string[]> {
  const d = sqlDialect(knex)
  if (d === 'mssql') {
    const rows = rawRows<{ name: string }>(
      await knex.raw(`SELECT name FROM sys.tables WHERE name LIKE 'nivaro[_]%'`)
    )
    return rows.map((r) => r.name)
  }
  const schema = d === 'pg' ? 'current_schema()' : 'DATABASE()'
  const rows = rawRows<{ name: string }>(
    await knex.raw(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = ${schema} AND table_type = 'BASE TABLE' AND table_name LIKE ?`,
      ['nivaro\\_%']
    )
  )
  return rows.map((r) => r.name)
}

/**
 * Approximate row counts per `nivaro_*` table from the engine's own statistics (SQL Server
 * partition stats, Postgres `reltuples`, MySQL `table_rows`) — cheap, may lag a recent write.
 */
export async function approxNivaroCounts(
  knex: Knex
): Promise<Array<{ name: string; row_count: number }>> {
  return approxTableCounts(knex, 'nivaro')
}

/** approxNivaroCounts for every base table (`prefix` null) or those starting `<prefix>_`. */
export async function approxTableCounts(
  knex: Knex,
  prefix: string | null
): Promise<Array<{ name: string; row_count: number }>> {
  const d = sqlDialect(knex)
  const mssqlWhere = prefix ? `AND t.name LIKE '${prefix}[_]%'` : ''
  const likeBind = prefix ? [`${prefix}\\_%`] : []
  const likeWhere = prefix ? 'AND {c} LIKE ?' : ''

  if (d === 'mssql') {
    return rawRows<{ name: string; row_count: number | string }>(
      await knex.raw(
        `SELECT t.name AS name, SUM(p.row_count) AS row_count
           FROM sys.tables t
           JOIN sys.dm_db_partition_stats p
             ON p.object_id = t.object_id
          WHERE p.index_id IN (0, 1) ${mssqlWhere}
          GROUP BY t.name`
      )
    ).map((r) => ({ name: r.name, row_count: Number(r.row_count ?? 0) }))
  }
  if (d === 'sqlite') {
    // SQLite keeps no row statistics: exact counts (its databases are small), 40 tables a statement.
    const names = rawRows<{ name: string }>(
      await knex.raw(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'${prefix ? " AND name LIKE ? ESCAPE '\\'" : ''}`,
        likeBind
      )
    ).map((r) => String(r.name))
    const out: Array<{ name: string; row_count: number }> = []
    for (let i = 0; i < names.length; i += 40) {
      const sql = names
        .slice(i, i + 40)
        .map(
          (t) =>
            `SELECT '${t.replace(/'/g, "''")}' AS name, COUNT(*) AS row_count FROM "${t.replace(/"/g, '""')}"`
        )
        .join(' UNION ALL ')
      for (const r of rawRows<{ name: string; row_count: number | string }>(await knex.raw(sql)))
        out.push({ name: r.name, row_count: Number(r.row_count ?? 0) })
    }
    return out
  }
  const sql =
    d === 'pg'
      ? `SELECT relname AS name, GREATEST(reltuples, 0) AS row_count FROM pg_class
          WHERE relkind = 'r' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
            ${likeWhere.replace('{c}', 'relname')}`
      : `SELECT table_name AS name, COALESCE(table_rows, 0) AS row_count FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ${likeWhere.replace('{c}', 'table_name')}`
  return rawRows<{ name: string; row_count: number | string }>(await knex.raw(sql, likeBind)).map(
    (r) => ({ name: r.name, row_count: Math.round(Number(r.row_count ?? 0)) })
  )
}

/**
 * `information_schema.columns` of the connected database/schema as a query builder: Postgres
 * and MySQL scope it to the current schema/database (the catalogue spans every database on a
 * MySQL server), SQL Server stays unscoped like before. Select columns through `infoCols()` so
 * MySQL (which upper-cases information_schema column names) returns lower-case keys.
 */
export function infoColumns(knex: Knex): Knex.QueryBuilder {
  const q = knex('information_schema.columns')
  const d = sqlDialect(knex)
  if (d === 'pg') q.whereRaw('table_schema = current_schema()')
  else if (d === 'mysql') q.whereRaw('table_schema = DATABASE()')
  return q
}

/** `information_schema.tables` of the connected database/schema, scoped like infoColumns(). */
export function infoTables(knex: Knex): Knex.QueryBuilder {
  const q = knex('information_schema.tables')
  const d = sqlDialect(knex)
  if (d === 'pg') q.whereRaw('table_schema = current_schema()')
  else if (d === 'mysql') q.whereRaw('table_schema = DATABASE()')
  return q
}

/** `col as col` for each name — lower-case result keys on every dialect. */
export function infoCols(...names: string[]): string[] {
  return names.map((n) => `${n} as ${n}`)
}

/**
 * infoCols() off SQL Server, the bare names on SQL Server (its statement text stays as it was;
 * SQL Server already answers with the names as written). MySQL and SQLite's emulation answer an
 * unaliased information_schema column in upper case.
 */
export function infoSelect(knex: Knex, ...names: string[]): string[] {
  return sqlDialect(knex) === 'mssql' ? names : infoCols(...names)
}

/** Octets the value occupies (DATALENGTH / octet_length / LENGTH). */
export function byteLength(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `length(CAST(${expr} AS BLOB))`
  if (d === 'pg') return `octet_length(${expr})`
  if (d === 'mysql') return `LENGTH(${expr})`
  return `DATALENGTH(${expr})`
}
