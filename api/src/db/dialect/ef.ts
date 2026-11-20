import type { Knex } from 'knex'
import { collateCiAs, sqlDialect } from '../sql-dialect.js'

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
  if (d === 'pg') return `to_char(${col}, '${fmt === 'yyyy-MM' ? 'YYYY-MM' : 'YYYY-MM-DD'}')`
  if (d === 'mysql') return `DATE_FORMAT(${col}, '${fmt === 'yyyy-MM' ? '%Y-%m' : '%Y-%m-%d'}')`
  return `FORMAT(${col}, '${fmt}')`
}

/** `2026-W07` label (calendar YEAR + ISO week). `col` appears twice — bind it twice. */
export function isoWeekLabel(knex: Knex, col: string): string {
  const d = sqlDialect(knex)
  if (d === 'pg')
    return `CONCAT(EXTRACT(YEAR FROM ${col})::int, '-W', LPAD(EXTRACT(WEEK FROM ${col})::int::text, 2, '0'))`
  if (d === 'mysql') return `CONCAT(YEAR(${col}), '-W', LPAD(WEEK(${col}, 3), 2, '0'))`
  return `CONCAT(YEAR(${col}), '-W', RIGHT('0' + CAST(DATEPART(iso_week, ${col}) AS varchar), 2))`
}

/** Sample standard deviation aggregate. */
export function stdevAgg(knex: Knex, expr: string): string {
  return sqlDialect(knex) === 'mssql' ? `STDEV(${expr})` : `STDDEV_SAMP(${expr})`
}

/** The SQL type to cast to for floating-point math. */
export function floatType(knex: Knex): string {
  const d = sqlDialect(knex)
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
  return sqlDialect(knex) === 'mssql' ? 'CONVERT(date, ?, 23)' : 'CAST(? AS DATE)'
}

/** `ABS(DATEDIFF(ms, col, ?)) < 1000` — `col` is within a second of the one bound datetime. */
export function withinSecond(knex: Knex, col: string): string {
  const d = sqlDialect(knex)
  if (d === 'pg') return `ABS(EXTRACT(EPOCH FROM ((${col})::timestamp - CAST(? AS TIMESTAMP)))) < 1`
  if (d === 'mysql')
    return `ABS(TIMESTAMPDIFF(MICROSECOND, ${col}, CAST(? AS DATETIME(6)))) < 1000000`
  return `ABS(DATEDIFF(ms, ${col}, ?)) < 1000`
}

/** Start of the day (Monday-based week / month) of a datetime expression, as a date. */
export function dateBucket(knex: Knex, bucket: 'day' | 'week' | 'month', ts: string): string {
  const d = sqlDialect(knex)
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

const idKinds = new Map<string, Promise<'auto' | 'text'>>()

/**
 * `insert(row).returning('*')` on every database. MySQL has no RETURNING: the row is inserted and
 * read back by its key — the auto-increment id the driver reports, or (a text/uuid key with a
 * database default) an id generated here and written with the row.
 */
export async function insertReturningRow<T = Record<string, unknown>>(
  knex: Knex,
  table: string,
  row: Record<string, unknown>,
  idCol = 'id'
): Promise<T> {
  if (sqlDialect(knex) !== 'mysql') {
    const [r] = (await knex(table).insert(row).returning('*')) as unknown as T[]
    return r
  }
  let id = row[idCol]
  if (id == null) {
    let kind = idKinds.get(table)
    if (!kind) {
      kind = knex(table)
        .columnInfo(idCol)
        .then((info) => {
          const t = String((info as { type?: string })?.type ?? '').toLowerCase()
          return /char|text/.test(t) ? ('text' as const) : ('auto' as const)
        })
      idKinds.set(table, kind)
    }
    if ((await kind) === 'text') {
      id = (await import('node:crypto')).randomUUID()
      await knex(table).insert({ ...row, [idCol]: id })
    } else {
      const res = (await knex(table).insert(row)) as unknown as number[]
      id = res[0]
    }
  } else {
    await knex(table).insert(row)
  }
  return (await knex(table)
    .where(idCol, id as string | number)
    .first()) as T
}

/** The case-insensitive LIKE operator for knex builder calls (`where(col, likeOp(db), pattern)`). */
export function likeOp(knex: Knex): 'like' | 'ilike' {
  return sqlDialect(knex) === 'pg' ? 'ilike' : 'like'
}

/** `NOT LIKE` operator for knex builder calls. */
export function notLikeOp(knex: Knex): 'not like' | 'not ilike' {
  return sqlDialect(knex) === 'pg' ? 'not ilike' : 'not like'
}
