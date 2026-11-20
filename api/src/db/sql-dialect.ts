import type { Knex } from 'knex'
import { isMariaDb, mariaDbColumnDefault, pgColumnDefault } from './mysql-flavor.js'
import { SQLITE_NOW } from './sqlite.js'

/**
 * SQL fragments that differ between SQL Server, Postgres and MySQL, for raw SQL the app builds.
 *
 * Rules:
 *  - Every helper takes the knex the statement runs on (`db`, a transaction, a tenant pool) and
 *    returns SQL TEXT for that dialect. Values still go in as bindings (`?`); a helper never
 *    inlines a value a person supplied. Numbers a helper inlines must be trusted integers.
 *  - SQL Server output is exactly what the code wrote before (a call site that used
 *    `GETUTCDATE()` gets `GETUTCDATE()` back), so moving a query onto a helper never changes it
 *    on SQL Server.
 *  - Never put a literal `?` in returned SQL: knex.raw reads it as a binding placeholder (regexes
 *    here use `{0,1}`).
 *  - Prefer knex's builder when it already covers the case (`.limit()`, `.whereILike()`,
 *    `.onConflict().merge()`, `.returning()`); these are for raw text.
 */

export type SqlDialect = 'mssql' | 'pg' | 'mysql' | 'sqlite'

export function sqlDialect(knex: Knex | Knex.Transaction): SqlDialect {
  const c = String((knex as any)?.client?.config?.client ?? '')
  if (c === 'mssql') return 'mssql'
  if (c === 'pg' || c === 'postgres' || c === 'postgresql') return 'pg'
  if (c === 'mysql' || c === 'mysql2') return 'mysql'
  if (c === 'better-sqlite3' || c === 'sqlite3' || c === 'sqlite') return 'sqlite'
  return 'mssql'
}

const int = (n: number) => {
  if (!Number.isSafeInteger(n)) throw new Error(`sql-dialect: expected an integer, got ${n}`)
  return n
}

/** Quote an identifier. */
export function qi(knex: Knex, name: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `"${name.replace(/"/g, '""')}"`
  if (d === 'pg') return `"${name.replace(/"/g, '""')}"`
  if (d === 'mysql') return `\`${name.replace(/`/g, '``')}\``
  return `[${name.replace(/]/g, ']]')}]`
}

/** The database's current UTC time. */
export function nowUtc(knex: Knex): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return SQLITE_NOW
  if (d === 'pg') return "(now() at time zone 'utc')"
  if (d === 'mysql') return 'UTC_TIMESTAMP()'
  return 'GETUTCDATE()'
}

/** The database server's LOCAL time (GETDATE() on SQL Server). Prefer nowUtc. */
export function nowLocal(knex: Knex): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return "strftime('%Y-%m-%dT%H:%M:%f', 'now', 'localtime')"
  if (d === 'pg') return 'LOCALTIMESTAMP'
  if (d === 'mysql') return 'NOW()'
  return 'GETDATE()'
}

export type DateUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
const MSSQL_UNIT: Record<DateUnit, string> = {
  second: 'SECOND',
  minute: 'MINUTE',
  hour: 'HOUR',
  day: 'DAY',
  week: 'WEEK',
  month: 'MONTH',
  year: 'YEAR'
}

/**
 * `dateExpr` plus `amount` units. `amount` is SQL text: a trusted integer (`String(-7)`) or an
 * expression / `?` binding.
 */
export function dateAdd(
  knex: Knex,
  unit: DateUnit,
  amount: string | number,
  dateExpr: string
): string {
  const d = sqlDialect(knex)
  const n = typeof amount === 'number' ? String(int(amount)) : amount
  if (d === 'sqlite') {
    const by = unit === 'week' ? `((${n}) * 7) || ' days'` : `(${n}) || ' ${unit}s'`
    return `strftime('%Y-%m-%dT%H:%M:%fZ', ${dateExpr}, ${by})`
  }
  if (d === 'pg') return `(${dateExpr} + (${n}) * interval '1 ${unit}')`
  if (d === 'mysql') return `DATE_ADD(${dateExpr}, INTERVAL (${n}) ${MSSQL_UNIT[unit]})`
  return `DATEADD(${unit}, ${n}, ${dateExpr})`
}

/**
 * Whole `unit`s from `from` to `to`, like SQL Server's DATEDIFF. DATEDIFF counts boundaries
 * crossed; Postgres/MySQL here count whole elapsed units (floor), which is what every Nivaro
 * call site means ("minutes since", "days old").
 */
export function dateDiff(knex: Knex, unit: DateUnit, from: string, to: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') {
    if (unit === 'month' || unit === 'year') {
      const ym = (e: string) =>
        `(CAST(strftime('%Y', ${e}) AS INTEGER) * 12 + CAST(strftime('%m', ${e}) AS INTEGER))`
      const months = `(${ym(to)} - ${ym(from)} - (CASE WHEN strftime('%d%H%M%f', ${to}) < strftime('%d%H%M%f', ${from}) THEN 1 ELSE 0 END))`
      return unit === 'month' ? months : `(${months} / 12)`
    }
    const ms: Record<string, number> = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000
    }
    const epochMs = (e: string) => `ROUND(unixepoch(${e}, 'subsec') * 1000)`
    return `CAST(FLOOR((-${epochMs(from)} + ${epochMs(to)}) / ${ms[unit]}.0) AS INTEGER)`
  }
  if (d === 'mysql') return `TIMESTAMPDIFF(${MSSQL_UNIT[unit]}, ${from}, ${to})`
  if (d === 'pg') {
    if (unit === 'month')
      return `((DATE_PART('year', AGE(${to}, ${from})) * 12) + DATE_PART('month', AGE(${to}, ${from})))::int`
    if (unit === 'year') return `DATE_PART('year', AGE(${to}, ${from}))::int`
    const secs: Record<string, number> = {
      second: 1,
      minute: 60,
      hour: 3600,
      day: 86400,
      week: 604800
    }
    return `FLOOR(EXTRACT(EPOCH FROM ((${to})::timestamp - (${from})::timestamp)) / ${secs[unit]})::int`
  }
  return `DATEDIFF(${unit}, ${from}, ${to})`
}

export type DatePart =
  | 'year'
  | 'month'
  | 'day'
  | 'hour'
  | 'minute'
  | 'second'
  | 'weekday'
  | 'quarter'
/** One part of a date as an integer. weekday: 1 = Sunday … 7 = Saturday on all three. */
export function datePart(knex: Knex, part: DatePart, expr: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') {
    if (part === 'weekday') return `(CAST(strftime('%w', ${expr}) AS INTEGER) + 1)`
    if (part === 'quarter') return `((CAST(strftime('%m', ${expr}) AS INTEGER) + 2) / 3)`
    const f = { year: '%Y', month: '%m', day: '%d', hour: '%H', minute: '%M', second: '%S' }[part]
    return `CAST(strftime('${f}', ${expr}) AS INTEGER)`
  }
  if (d === 'pg') {
    if (part === 'weekday') return `(EXTRACT(DOW FROM ${expr})::int + 1)`
    return `EXTRACT(${part.toUpperCase()} FROM ${expr})::int`
  }
  if (d === 'mysql') {
    if (part === 'weekday') return `DAYOFWEEK(${expr})`
    return `${part.toUpperCase()}(${expr})`
  }
  return `DATEPART(${part}, ${expr})`
}

/** Just the date (no time) of a datetime expression. */
export function dateOnly(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `date(${expr})`
  if (d === 'pg') return `(${expr})::date`
  if (d === 'mysql') return `DATE(${expr})`
  return `CAST(${expr} AS DATE)`
}

/**
 * CAST(expr AS DATE) as a value to group, order or compare with another castDate: the call
 * site's own spelling (`type`, 'DATE' or 'date') everywhere but SQLite, where CAST(… AS DATE) is
 * a numeric cast ('2026-11-20…' → 2026): there it is the day's UTC midnight in the stored
 * timestamp shape, which reads back as a Date like the other databases' date values. To compare
 * with a bound 'YYYY-MM-DD' text use dateOnly().
 */
export function castDate(knex: Knex, expr: string, type: 'DATE' | 'date' = 'DATE'): string {
  if (sqlDialect(knex) === 'sqlite') return `strftime('%Y-%m-%dT00:00:00.000Z', ${expr})`
  return `CAST(${expr} AS ${type})`
}

/** Text cast. `len` caps it on SQL Server / MySQL (NVARCHAR(len) / CHAR(len)); 'max' = unbounded. */
export function castText(knex: Knex, expr: string, len: number | 'max' = 'max'): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite')
    return len === 'max' ? `CAST(${expr} AS TEXT)` : `substr(CAST(${expr} AS TEXT), 1, ${int(len)})`
  if (d === 'pg') return `CAST(${expr} AS TEXT)`
  if (d === 'mysql')
    return len === 'max' ? `CAST(${expr} AS CHAR)` : `CAST(${expr} AS CHAR(${int(len)}))`
  return `CAST(${expr} AS NVARCHAR(${len === 'max' ? 'MAX' : int(len)}))`
}

/** TRY_CAST(expr AS INT/BIGINT): the integer, or NULL when the text is not one. */
export function tryCastInt(knex: Knex, expr: string, big = false): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite')
    return `(CASE WHEN CAST(${expr} AS TEXT) REGEXP '^\\s*-{0,1}[0-9]+\\s*$' THEN CAST(trim(CAST(${expr} AS TEXT)) AS INTEGER) END)`
  if (d === 'pg')
    return `(CASE WHEN (${expr})::text ~ '^\\s*-{0,1}[0-9]+\\s*$' THEN trim((${expr})::text)::${big ? 'bigint' : 'int'} END)`
  if (d === 'mysql')
    return `(CASE WHEN CAST(${expr} AS CHAR) REGEXP '^[[:space:]]*-{0,1}[0-9]+[[:space:]]*$' THEN CAST(${expr} AS SIGNED) END)`
  return `TRY_CAST(${expr} AS ${big ? 'BIGINT' : 'INT'})`
}

/** TRY_CAST(expr AS DECIMAL/FLOAT): the number, or NULL when the text is not one. */
export function tryCastNumber(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  const re = '^\\s*-{0,1}([0-9]+\\.{0,1}[0-9]*|\\.[0-9]+)([eE][-+]{0,1}[0-9]+){0,1}\\s*$'
  if (d === 'sqlite')
    return `(CASE WHEN CAST(${expr} AS TEXT) REGEXP '${re}' THEN CAST(trim(CAST(${expr} AS TEXT)) AS REAL) END)`
  if (d === 'pg')
    return `(CASE WHEN (${expr})::text ~ '${re}' THEN trim((${expr})::text)::double precision END)`
  if (d === 'mysql')
    return `(CASE WHEN CAST(${expr} AS CHAR) REGEXP '^[[:space:]]*-{0,1}([0-9]+[.]{0,1}[0-9]*|[.][0-9]+)([eE][-+]{0,1}[0-9]+){0,1}[[:space:]]*$' THEN CAST(${expr} AS DOUBLE) END)`
  return `TRY_CAST(${expr} AS FLOAT)`
}

/** TRY_CAST(expr AS DATETIME2): the timestamp, or NULL when the text is not an ISO date/datetime. */
export function tryCastDate(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  const re =
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+){0,1}){0,1}){0,1}Z{0,1}$'
  if (d === 'sqlite')
    return `(CASE WHEN CAST(${expr} AS TEXT) REGEXP '${re}' THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(${expr} AS TEXT)) END)`
  if (d === 'pg') return `(CASE WHEN (${expr})::text ~ '${re}' THEN (${expr})::text::timestamp END)`
  if (d === 'mysql')
    return `(CASE WHEN CAST(${expr} AS CHAR) REGEXP '${re.replace(/\\\\/g, '\\\\\\\\')}' THEN CAST(REPLACE(REPLACE(CAST(${expr} AS CHAR), 'T', ' '), 'Z', '') AS DATETIME(3)) END)`
  return `TRY_CAST(${expr} AS DATETIME2)`
}

/** ISNULL(a, b) — COALESCE is the same on all three; use it directly in new SQL. */
export function ifNull(_knex: Knex, a: string, b: string): string {
  return `COALESCE(${a}, ${b})`
}

/** Character length (LEN trims trailing spaces on SQL Server; the others keep them). */
export function textLength(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `LENGTH(${expr})`
  if (d === 'pg') return `CHAR_LENGTH(${expr})`
  if (d === 'mysql') return `CHAR_LENGTH(${expr})`
  return `LEN(${expr})`
}

/** 1-based position of `needle` in `hay`, 0 when absent (CHARINDEX). */
export function textPosition(knex: Knex, needle: string, hay: string): string {
  const d = sqlDialect(knex)
  // INSTR takes the haystack first; the subquery keeps `needle` first like the others, so `?`
  // bindings stay in order.
  if (d === 'sqlite') return `(SELECT INSTR(h, n) FROM (SELECT ${needle} AS n, ${hay} AS h))`
  if (d === 'pg') return `POSITION(${needle} IN ${hay})`
  if (d === 'mysql') return `LOCATE(${needle}, ${hay})`
  return `CHARINDEX(${needle}, ${hay})`
}

/** String concatenation of SQL expressions ('+' on SQL Server, '||' on Postgres, CONCAT on MySQL). */
export function concat(knex: Knex, ...parts: string[]): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `(${parts.join(' || ')})`
  if (d === 'mysql') return `CONCAT(${parts.join(', ')})`
  if (d === 'pg') return `(${parts.join(' || ')})`
  return `(${parts.join(' + ')})`
}

/** STRING_AGG(expr, sep) (ordered by `orderBy` when given). `sep` is trusted literal text. */
export function stringAgg(knex: Knex, expr: string, sep: string, orderBy?: string): string {
  const s = `'${sep.replace(/'/g, "''")}'`
  const d = sqlDialect(knex)
  if (d === 'sqlite')
    return `STRING_AGG(CAST(${expr} AS TEXT), ${s}${orderBy ? ` ORDER BY ${orderBy}` : ''})`
  if (d === 'mysql')
    return `GROUP_CONCAT(${expr}${orderBy ? ` ORDER BY ${orderBy}` : ''} SEPARATOR ${s})`
  if (d === 'pg')
    return `STRING_AGG(CAST(${expr} AS TEXT), ${s}${orderBy ? ` ORDER BY ${orderBy}` : ''})`
  return `STRING_AGG(${expr}, ${s})${orderBy ? ` WITHIN GROUP (ORDER BY ${orderBy})` : ''}`
}

/**
 * JSON_VALUE(col, '$.a.b') — the scalar at a simple dotted path as text. `path` must be a
 * trusted `$.x.y` / `$[0]` path (never request input).
 */
export function jsonValue(knex: Knex, colExpr: string, path: string): string {
  if (!/^\$(\.[A-Za-z_][\w]*|\[\d+\])*$/.test(path))
    throw new Error(`sql-dialect: unsupported JSON path ${path}`)
  const d = sqlDialect(knex)
  if (d === 'sqlite') {
    const p = `${colExpr}, '${path}'`
    return `(CASE WHEN json_valid(${colExpr}) THEN (CASE json_type(${p}) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'object' THEN NULL WHEN 'array' THEN NULL ELSE CAST(json_extract(${p}) AS TEXT) END) END)`
  }
  if (d === 'pg') {
    const parts = path
      .slice(1)
      .split(/\.|\[|\]/)
      .filter(Boolean)
    return `((${colExpr})::jsonb #>> '{${parts.join(',')}}')`
  }
  if (d === 'mysql') return `JSON_UNQUOTE(JSON_EXTRACT(${colExpr}, '${path}'))`
  return `JSON_VALUE(${colExpr}, '${path}')`
}

/** True-ish when the text is valid JSON (ISJSON). */
export function isJson(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `json_valid(${expr})`
  if (d === 'pg') return `(${expr} IS JSON)`
  if (d === 'mysql') return `JSON_VALID(${expr})`
  return `ISJSON(${expr})`
}

/**
 * The LIKE escape clause for patterns escaped with a backslash. SQL Server and Postgres read
 * `ESCAPE '\'`; MySQL treats a backslash inside a string literal as an escape itself, so it
 * needs `ESCAPE '\\'`.
 */
export function likeEscape(knex: Knex): string {
  return sqlDialect(knex) === 'mysql' ? "ESCAPE '\\\\'" : "ESCAPE '\\'"
}

/**
 * The case-insensitive LIKE operator. SQL Server and MySQL compare text case-insensitively under
 * their default collations; Postgres does not, so it uses ILIKE. Text search (contains, starts
 * with, search boxes) must use this so the same words find the same rows on every database.
 */
export function likeCi(knex: Knex): string {
  return sqlDialect(knex) === 'pg' ? 'ILIKE' : 'LIKE'
}

/** `NOT` + likeCi. */
export function notLikeCi(knex: Knex): string {
  return sqlDialect(knex) === 'pg' ? 'NOT ILIKE' : 'NOT LIKE'
}

/** Case-insensitive equality on text (SQL Server's default collation behaviour). */
export function equalsCi(knex: Knex, a: string, b: string): string {
  // SQLite compares text case-sensitively (BINARY); LOWER folds ASCII only, like its LIKE.
  if (sqlDialect(knex) === 'sqlite') return `LOWER(${a}) = LOWER(${b})`
  return sqlDialect(knex) === 'pg' ? `LOWER(${a}) = LOWER(${b})` : `${a} = ${b}`
}

/** ` WITH (NOLOCK)` table hint on SQL Server, nothing elsewhere (both read committed data without blocking writers). */
export function noLock(knex: Knex): string {
  return sqlDialect(knex) === 'mssql' ? ' WITH (NOLOCK)' : ''
}

/** A SQL Server table hint (`READPAST`, `UPDLOCK, ROWLOCK`, …) — nothing elsewhere; pair with lockForUpdate(). */
export function tableHint(knex: Knex, hint: string): string {
  return sqlDialect(knex) === 'mssql' ? ` WITH (${hint})` : ''
}

/**
 * Row-lock suffix for "claim rows nobody else holds" reads on Postgres/MySQL (`FOR UPDATE SKIP
 * LOCKED`), the equivalent of SQL Server's `WITH (UPDLOCK, READPAST)` hint. Empty on SQL Server.
 */
export function lockForUpdate(knex: Knex, opts: { skipLocked?: boolean } = {}): string {
  // SQLite has no row locks: one writer at a time (db/sqlite.ts write lock).
  if (sqlDialect(knex) === 'sqlite') return ''
  if (sqlDialect(knex) === 'mssql') return ''
  return opts.skipLocked ? ' FOR UPDATE SKIP LOCKED' : ' FOR UPDATE'
}

/** `TOP (n) ` right after SELECT on SQL Server; empty elsewhere — pair with limitN(). */
export function topN(knex: Knex, n: number): string {
  return sqlDialect(knex) === 'mssql' ? `TOP (${int(n)}) ` : ''
}

/** ` LIMIT n` at the end of a statement on Postgres/MySQL; empty on SQL Server — pair with topN(). */
export function limitN(knex: Knex, n: number): string {
  return sqlDialect(knex) === 'mssql' ? '' : ` LIMIT ${int(n)}`
}

/**
 * ` OFFSET o ROWS FETCH NEXT n ROWS ONLY` on SQL Server (needs an ORDER BY), ` LIMIT n OFFSET o`
 * elsewhere.
 */
export function offsetFetch(knex: Knex, offset: number, n: number): string {
  if (sqlDialect(knex) === 'mssql')
    return ` OFFSET ${int(offset)} ROWS FETCH NEXT ${int(n)} ROWS ONLY`
  return ` LIMIT ${int(n)} OFFSET ${int(offset)}`
}

/** Boolean literal (SQL Server bit 1/0, Postgres true/false, MySQL 1/0). */
export function boolLit(knex: Knex, v: boolean): string {
  if (sqlDialect(knex) === 'pg') return v ? 'true' : 'false'
  return v ? '1' : '0'
}

// ─── MySQL-family helpers that differ on MariaDB (isMariaDb, db/mysql-flavor.ts) ────────────────

/**
 * `expr` compared case-insensitively but accent-sensitively (SQL Server's default collation) on
 * MySQL / MariaDB, whose JSON functions return binary (case-sensitive) text: MySQL 8
 * utf8mb4_0900_as_ci, MariaDB utf8mb4_uca1400_as_ci (10.10+; 10.11 has no 0900 names). Unchanged on
 * SQL Server and Postgres.
 */
export function collateCiAs(knex: Knex, expr: string): string {
  // SQLite compares text in binary: NOCASE folds ASCII letters (its only built-in fold).
  if (sqlDialect(knex) === 'sqlite') return `(${expr} COLLATE NOCASE)`
  if (sqlDialect(knex) !== 'mysql') return expr
  return `(${expr} COLLATE ${isMariaDb(knex) ? 'utf8mb4_uca1400_as_ci' : 'utf8mb4_0900_as_ci'})`
}

/**
 * The session statement to cap each following statement at `ms` milliseconds (0 = no cap):
 * Postgres `statement_timeout`, MySQL `max_execution_time` (SELECTs only), MariaDB
 * `max_statement_time` (seconds; every statement). Empty on SQL Server (the driver's request
 * timeout does it). Pair with statementTimeoutResetSql().
 */
export function statementTimeoutSql(knex: Knex, ms: number): string {
  const n = Math.max(0, int(Math.trunc(ms)))
  const d = sqlDialect(knex)
  if (d === 'pg') return `SET statement_timeout = ${n}`
  if (d === 'mysql')
    return isMariaDb(knex)
      ? `SET SESSION max_statement_time = ${n / 1000}`
      : `SET SESSION max_execution_time = ${n}`
  return ''
}

/** Put the session statement cap back to the server default (empty on SQL Server). */
export function statementTimeoutResetSql(knex: Knex): string {
  const d = sqlDialect(knex)
  if (d === 'pg') return 'RESET statement_timeout'
  if (d === 'mysql')
    return isMariaDb(knex)
      ? 'SET SESSION max_statement_time = DEFAULT'
      : 'SET SESSION max_execution_time = DEFAULT'
  return ''
}

/**
 * A catalog column default (information_schema COLUMN_DEFAULT / knex columnInfo defaultValue) as
 * MySQL words it, for display and comparison: Postgres casts and identity sequences, MariaDB's and
 * SQLite's quoting are taken off (pgColumnDefault / mariaDbColumnDefault). MySQL and SQL Server
 * values are returned as they are (SQL Server keeps its own `('abc')` text).
 */
export function catalogColumnDefault(knex: Knex, value: unknown): string | null {
  if (value == null) return null
  const v = String(value)
  const d = sqlDialect(knex)
  if (d === 'pg') return pgColumnDefault(v)
  if (d === 'sqlite' || (d === 'mysql' && isMariaDb(knex))) return mariaDbColumnDefault(v)
  return v
}
