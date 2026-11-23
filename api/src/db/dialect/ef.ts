import type { Knex } from 'knex'
import { registerAppKeyed } from '../../services/app-forget.js'
import { collateCiAs, sqlDialect, tryCastNumber } from '../sql-dialect.js'
import { getTenantId } from '../tenant-context.js'

/**
 * Cross-dialect SQL fragments for the workflows / dashboards / communication area (P2 E+F).
 * SQL Server output is exactly the T-SQL the code wrote before.
 */

/**
 * `FORMAT(<col>, 'yyyy-MM')` / `'yyyy-MM-dd'` as a stable sortable label. `col` is SQL text that may
 * hold `??` identifier placeholders (the caller binds them).
 */
export function dateLabel(knex: Knex, col: string, fmt: 'yyyy-MM' | 'yyyy-MM-dd'): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `strftime('${fmt === 'yyyy-MM' ? '%Y-%m' : '%Y-%m-%d'}', ${col})`
  if (d === 'pg') return `to_char(${col}, '${fmt === 'yyyy-MM' ? 'YYYY-MM' : 'YYYY-MM-DD'}')`
  if (d === 'mysql') return `DATE_FORMAT(${col}, '${fmt === 'yyyy-MM' ? '%Y-%m' : '%Y-%m-%d'}')`
  return `FORMAT(${col}, '${fmt}')`
}

/** `2026-W07` label (calendar YEAR + ISO week). `col` appears twice — bind it twice. */
export function isoWeekLabel(knex: Knex, col: string): string {
  const d = sqlDialect(knex)
  // SQLite: %V is the ISO week (3.46+); the year is the calendar year as on the others.
  // concat() skips NULLs as SQL Server's CONCAT does (a missing date is '-W' there too).
  if (d === 'sqlite') return `concat(strftime('%Y', ${col}), '-W', strftime('%V', ${col}))`
  if (d === 'pg')
    return `CONCAT(EXTRACT(YEAR FROM ${col})::int, '-W', LPAD(EXTRACT(WEEK FROM ${col})::int::text, 2, '0'))`
  if (d === 'mysql') return `CONCAT(YEAR(${col}), '-W', LPAD(WEEK(${col}, 3), 2, '0'))`
  return `CONCAT(YEAR(${col}), '-W', RIGHT('0' + CAST(DATEPART(iso_week, ${col}) AS varchar), 2))`
}

/** Sample standard deviation aggregate. */
export function stdevAgg(knex: Knex, expr: string): string {
  // SQLite: STDDEV_SAMP is an aggregate db/sqlite.ts registers on every connection.
  return sqlDialect(knex) === 'mssql' ? `STDEV(${expr})` : `STDDEV_SAMP(${expr})`
}

/** The SQL type to cast to for floating-point math. */
export function floatType(knex: Knex): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return 'REAL'
  if (d === 'pg') return 'DOUBLE PRECISION'
  if (d === 'mysql') return 'DOUBLE'
  return 'FLOAT'
}

/** Columns of a physical table (lower level than metadata: what the database really has). */
export async function physicalColumnNames(knex: Knex, table: string): Promise<string[]> {
  const d = sqlDialect(knex)
  if (d === 'mssql') {
    const r = (await knex.raw('SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)', [
      table
    ])) as Array<{ name: string }>
    return r.map((x) => x.name)
  }
  const rows = await knex('information_schema.columns')
    .select('column_name as name')
    .where('table_name', table)
    .whereRaw(d === 'pg' ? 'table_schema = current_schema()' : 'table_schema = DATABASE()')
  return (rows as Array<{ name: string }>).map((x) => x.name)
}

/** A `?` binding that is an integer in date arithmetic (Postgres needs a type on an untyped parameter). */
export function intBind(knex: Knex): string {
  return sqlDialect(knex) === 'pg' ? '(?::int)' : '?'
}

/**
 * JSON_VALUE(col, ?) — the scalar at a JSON path BINDING as text. The path is bound (`$."a.b".c`);
 * Postgres reads it as a jsonpath, MySQL as a JSON path. NULL when absent.
 */
export function jsonScalar(knex: Knex, col: string): string {
  const d = sqlDialect(knex)
  // SQLite: SQL Server's JSON_VALUE answers (booleans 'true'/'false', objects/arrays NULL); the
  // subquery keeps the one path binding.
  if (d === 'sqlite')
    return `(SELECT CASE WHEN json_valid(j) THEN (CASE json_type(j, p) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'object' THEN NULL WHEN 'array' THEN NULL ELSE CAST(json_extract(j, p) AS TEXT) END) END FROM (SELECT ${col} AS j, ? AS p))`
  if (d === 'pg') return `(jsonb_path_query_first((${col})::jsonb, (?)::jsonpath) #>> '{}')`
  // JSON text compares binary (case-sensitive) in MySQL: give it the case-insensitive collation
  // SQL Server's JSON_VALUE result has, so searches, filters and sorts agree (collateCiAs: MySQL
  // utf8mb4_0900_as_ci, MariaDB utf8mb4_uca1400_as_ci — 10.11 has no 0900 collations).
  if (d === 'mysql') return collateCiAs(knex, `JSON_UNQUOTE(JSON_EXTRACT(${col}, ?))`)
  return `JSON_VALUE(${col}, ?)`
}

/** True when the JSON text `col` has an object at path `$."key"` (SQL Server: JSON_QUERY(...) IS NOT NULL). */
export function jsonHasObject(knex: Knex, col: string, key: string): string {
  if (!/^\w+$/.test(key)) throw new Error('ef: unsupported JSON key')
  const d = sqlDialect(knex)
  if (d === 'sqlite')
    return `(CASE WHEN json_valid(${col}) THEN json_type(${col}, '$."${key}"') END) IN ('object', 'array')`
  if (d === 'pg') return `((${col})::jsonb -> '${key}') IS NOT NULL`
  if (d === 'mysql') return `JSON_EXTRACT(${col}, '$."${key}"') IS NOT NULL`
  return `JSON_QUERY(${col}, '$."${key}"') IS NOT NULL`
}

/**
 * TRY_CONVERT(float, expr): the number or NULL. `binds` = the bindings `expr` holds; the returned
 * bindings repeat them wherever the dialect's form repeats the expression.
 */
export function tryFloat(
  knex: Knex,
  expr: string,
  binds: unknown[]
): { sql: string; bindings: unknown[] } {
  const d = sqlDialect(knex)
  if (d === 'mssql') return { sql: `TRY_CONVERT(float, ${expr})`, bindings: binds }
  const re = '^\\s*-{0,1}([0-9]+\\.{0,1}[0-9]*|\\.[0-9]+)([eE][-+]{0,1}[0-9]+){0,1}\\s*$'
  // tryCastNumber's SQLite form names `expr` twice, like the other two below.
  if (d === 'sqlite') return { sql: tryCastNumber(knex, expr), bindings: [...binds, ...binds] }
  if (d === 'pg')
    return {
      sql: `(CASE WHEN (${expr})::text ~ '${re}' THEN trim((${expr})::text)::double precision END)`,
      bindings: [...binds, ...binds]
    }
  return {
    sql: `(CASE WHEN CAST(${expr} AS CHAR) REGEXP '^[[:space:]]*-{0,1}([0-9]+[.]{0,1}[0-9]*|[.][0-9]+)([eE][-+]{0,1}[0-9]+){0,1}[[:space:]]*$' THEN CAST(${expr} AS DOUBLE) END)`,
    bindings: [...binds, ...binds]
  }
}

/** TRY_CONVERT(date, expr, 23): an ISO `YYYY-MM-DD` text as a date, else NULL (bindings as tryFloat). */
export function tryIsoDate(
  knex: Knex,
  expr: string,
  binds: unknown[]
): { sql: string; bindings: unknown[] } {
  const d = sqlDialect(knex)
  if (d === 'mssql') return { sql: `TRY_CONVERT(date, ${expr}, 23)`, bindings: binds }
  // SQLite keeps a date as 'YYYY-MM-DD' text: the text itself is the date.
  if (d === 'sqlite')
    return {
      sql: `(CASE WHEN CAST(${expr} AS TEXT) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN CAST(${expr} AS TEXT) END)`,
      bindings: [...binds, ...binds]
    }
  if (d === 'pg')
    return {
      sql: `(CASE WHEN (${expr})::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (${expr})::date END)`,
      bindings: [...binds, ...binds]
    }
  return {
    sql: `(CASE WHEN CAST(${expr} AS CHAR) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN CAST(${expr} AS DATE) END)`,
    bindings: [...binds, ...binds]
  }
}

/** CONVERT(date, ?, 23): one bound ISO date text as a date. */
export function isoDateParam(knex: Knex): string {
  const d = sqlDialect(knex)
  // SQLite: CAST(... AS DATE) is a numeric cast ('2026-01-05' → 2026); date() keeps the text date.
  if (d === 'sqlite') return 'date(?)'
  return d === 'mssql' ? 'CONVERT(date, ?, 23)' : 'CAST(? AS DATE)'
}

/** `ABS(DATEDIFF(ms, col, ?)) < 1000` — `col` is within a second of the one bound datetime. */
export function withinSecond(knex: Knex, col: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `ABS(unixepoch(${col}, 'subsec') - unixepoch(?, 'subsec')) < 1`
  if (d === 'pg') return `ABS(EXTRACT(EPOCH FROM ((${col})::timestamp - CAST(? AS TIMESTAMP)))) < 1`
  if (d === 'mysql')
    return `ABS(TIMESTAMPDIFF(MICROSECOND, ${col}, CAST(? AS DATETIME(6)))) < 1000000`
  return `ABS(DATEDIFF(ms, ${col}, ?)) < 1000`
}

/** Start of the day (Monday-based week / month) of a datetime expression, as a date. */
export function dateBucket(knex: Knex, bucket: 'day' | 'week' | 'month', ts: string): string {
  const d = sqlDialect(knex)
  // SQLite: the date as 'YYYY-MM-DD' text (its date shape); week = the Monday on or before.
  if (d === 'sqlite') {
    if (bucket === 'day') return `date(${ts})`
    if (bucket === 'week')
      return `date(${ts}, '-' || ((CAST(strftime('%w', ${ts}) AS INTEGER) + 6) % 7) || ' days')`
    return `strftime('%Y-%m-01', ${ts})`
  }
  if (d === 'pg') {
    if (bucket === 'day') return `(${ts})::date`
    return `date_trunc('${bucket}', ${ts})::date`
  }
  if (d === 'mysql') {
    if (bucket === 'day') return `DATE(${ts})`
    if (bucket === 'week') return `DATE_SUB(DATE(${ts}), INTERVAL WEEKDAY(${ts}) DAY)`
    return `CAST(DATE_FORMAT(${ts}, '%Y-%m-01') AS DATE)`
  }
  if (bucket === 'day') return `CONVERT(date, ${ts})`
  if (bucket === 'week')
    return `DATEADD(day, -(DATEDIFF(day, '1900-01-01', ${ts}) % 7), CONVERT(date, ${ts}))`
  return `DATEFROMPARTS(YEAR(${ts}), MONTH(${ts}), 1)`
}

/** `expr` cut down to its hour (a datetime). */
export function hourBucket(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `strftime('%Y-%m-%dT%H:00:00.000Z', ${expr})`
  if (d === 'pg') return `date_trunc('hour', ${expr})`
  if (d === 'mysql') return `CAST(DATE_FORMAT(${expr}, '%Y-%m-%d %H:00:00') AS DATETIME)`
  return `DATEADD(hour, DATEDIFF(hour, 0, ${expr}), 0)`
}

/**
 * Escape `%`, `_` and the escape character itself in text meant to match literally inside a LIKE.
 * SQL Server: bracket form (`[%]`, no ESCAPE clause needed). Postgres / MySQL: backslash form
 * (their default escape character, so no ESCAPE clause is needed either).
 */
export function escapeLikeFor(knex: Knex, v: string): string {
  if (sqlDialect(knex) === 'mssql') return v.replace(/[[%_]/g, (c) => `[${c}]`)
  return v.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Per app + table + key column (final review M6): the app names the database (each app on a
 *  shared deployment has its own; self-hosted the app is ''), so the answer holds for every handle
 *  on it — the `db` proxy, a pinned connection, every transaction (a new handle each time, which a
 *  cache per handle re-read for every insert). An app that leaves the process forgets its answers
 *  (registerAppKeyed). */
const idKinds = registerAppKeyed(new Map<string, Promise<'auto' | 'text'>>())

/** MySQL: whether `table`'s key is an auto-increment number or text (a uuid with a default). */
function mysqlIdKind(knex: Knex, table: string, idCol: string): Promise<'auto' | 'text'> {
  const key = `${getTenantId() ?? ''}\u0000${table}\u0000${idCol}`
  let kind = idKinds.get(key)
  if (!kind) {
    kind = knex(table)
      .columnInfo(idCol)
      .then((info) => {
        const t = String((info as { type?: string })?.type ?? '').toLowerCase()
        return /char|text/.test(t) ? ('text' as const) : ('auto' as const)
      })
    // A failed read is not an answer: the next insert asks again.
    kind.catch(() => {
      if (idKinds.get(key) === kind) idKinds.delete(key)
    })
    idKinds.set(key, kind)
  }
  return kind
}

/**
 * MySQL: insert `row` and answer its key — the auto-increment id the driver reports, or (a
 * text/uuid key with a database default, where the driver reports 0) an id generated here and
 * written with the row.
 */
async function mysqlInsertId(
  knex: Knex,
  table: string,
  row: Record<string, unknown>,
  idCol: string
): Promise<string | number> {
  const given = row[idCol]
  if (given != null) {
    await knex(table).insert(row)
    return given as string | number
  }
  if ((await mysqlIdKind(knex, table, idCol)) === 'text') {
    const id = (await import('node:crypto')).randomUUID()
    await knex(table).insert({ ...row, [idCol]: id })
    return id
  }
  const res = (await knex(table).insert(row)) as unknown as number[]
  return res[0]
}

/** The id one `.returning('id')` entry carries: a row `{ id }` or a bare id. */
export function returnedId(entry: unknown, idCol = 'id'): string | number | null {
  if (entry == null) return null
  if (typeof entry === 'object') {
    const v = (entry as Record<string, unknown>)[idCol]
    return v == null ? null : (v as string | number)
  }
  return entry as string | number
}

/**
 * `insert(row).returning('*')` on every database. MySQL has no RETURNING: the row is inserted and
 * read back by its key — the auto-increment id the driver reports, or (a text/uuid key with a
 * database default) an id generated here and written with the row.
 */
export async function insertReturningRow<T = Record<string, unknown>>(
  knex: Knex,
  table: string,
  row: Record<string, unknown>,
  idCol = 'id',
  options?: { includeTriggerModifications?: boolean }
): Promise<T> {
  if (sqlDialect(knex) !== 'mysql') {
    const [r] = (await (options
      ? knex(table).insert(row).returning('*', options)
      : knex(table).insert(row).returning('*'))) as unknown as T[]
    return r
  }
  const id = await mysqlInsertId(knex, table, row, idCol)
  return (await knex(table)
    .where(idCol, id as string | number)
    .first()) as T
}

/**
 * `insert(row).returning(idCol, options)` on every database, as the new row's id. Elsewhere the
 * statement is exactly that one (`options` = the trigger-safe form SQL Server may need); MySQL has
 * no RETURNING and reports 0 for a uuid key its default fills, so the key is found as
 * insertReturningRow finds it.
 */
export async function insertReturningId(
  knex: Knex,
  table: string,
  row: Record<string, unknown>,
  idCol = 'id',
  options?: { includeTriggerModifications?: boolean }
): Promise<string | number | null> {
  if (sqlDialect(knex) === 'mysql') return mysqlInsertId(knex, table, row, idCol)
  const out = (await (options
    ? knex(table).insert(row).returning(idCol, options)
    : knex(table).insert(row).returning(idCol))) as unknown[]
  return returnedId(out[0], idCol)
}

/**
 * Several rows' `insert(rows).returning([idCol, ...cols], options)` on every database: one entry
 * per row with its id and those columns. MySQL answers no rows and only the FIRST auto-increment
 * id of a multi-row insert (not reliably consecutive under concurrent inserts), so there each row
 * is inserted on its own (in one transaction) and the columns come from the row as written.
 */
export async function insertReturningRows(
  knex: Knex,
  table: string,
  rows: Array<Record<string, unknown>>,
  cols: string[] = [],
  idCol = 'id',
  options?: { includeTriggerModifications?: boolean }
): Promise<Array<Record<string, unknown>>> {
  if (sqlDialect(knex) !== 'mysql') {
    const returning = [idCol, ...cols]
    return (await (options
      ? knex(table).insert(rows).returning(returning, options)
      : knex(table).insert(rows).returning(returning))) as Array<Record<string, unknown>>
  }
  // All or none, like the one statement it stands for (a caller may retry a refused batch).
  return knex.transaction(async (trx) => {
    const out: Array<Record<string, unknown>> = []
    for (const r of rows) {
      const id = await mysqlInsertId(trx, table, r, idCol)
      const entry: Record<string, unknown> = { [idCol]: id }
      for (const c of cols) entry[c] = r[c]
      out.push(entry)
    }
    return out
  })
}

/** The case-insensitive LIKE operator for knex builder calls (`where(col, likeOp(db), pattern)`). */
export function likeOp(knex: Knex): 'like' | 'ilike' {
  return sqlDialect(knex) === 'pg' ? 'ilike' : 'like'
}

/** `NOT LIKE` operator for knex builder calls. */
export function notLikeOp(knex: Knex): 'not like' | 'not ilike' {
  return sqlDialect(knex) === 'pg' ? 'not ilike' : 'not like'
}
