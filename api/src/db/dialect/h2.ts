import type { Knex } from 'knex'
import { rawRows } from '../raw-rows.js'
import { qi, sqlDialect } from '../sql-dialect.js'

/**
 * Cross-dialect helpers for the "remaining services and routes" area (P2 / H2):
 * catalog reads (foreign keys, column types, indexes, row counts) and a small translator for
 * SQL text that was written in T-SQL form (`[ident]`, `OPENJSON(?)` id lists, `nvarchar(n)` casts).
 *
 * SQL Server output is always exactly what the caller wrote.
 */

/** The current schema/database name filter for information_schema reads. */
function schemaFilter(knex: Knex): string {
  return sqlDialect(knex) === 'pg' ? 'current_schema()' : 'DATABASE()'
}

/**
 * Tables with a FOREIGN KEY into `referenced` (every column of the key): `{ table_name,
 * column_name }`. SQL Server reads sys.foreign_keys; Postgres pg_constraint; MySQL
 * information_schema.key_column_usage.
 */
export async function foreignKeyColumnsTo(
  knex: Knex,
  referenced: string
): Promise<Array<{ table_name: string; column_name: string }>> {
  const d = sqlDialect(knex)
  if (d === 'mssql') {
    const res = await knex.raw(
      `SELECT t.name AS table_name, c.name AS column_name
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.tables t ON t.object_id = fk.parent_object_id
         JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
        WHERE fk.referenced_object_id = OBJECT_ID(?)`,
      [referenced]
    )
    return rawRows(res)
  }
  if (d === 'pg') {
    const res = await knex.raw(
      `SELECT cl.relname AS table_name, a.attname AS column_name
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_class rcl ON rcl.oid = con.confrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE con.contype = 'f' AND rcl.relname = ? AND ns.nspname = current_schema()`,
      [referenced]
    )
    return rawRows(res)
  }
  const res = await knex.raw(
    `SELECT table_name AS table_name, column_name AS column_name
       FROM information_schema.key_column_usage
      WHERE referenced_table_name = ? AND table_schema = DATABASE()`,
    [referenced]
  )
  return rawRows(res)
}

/** A SQL type name normalised to the SQL Server spelling the planning code reads. */
export function normalizeSqlType(knex: Knex, raw: string): string {
  const t = String(raw ?? '').toLowerCase()
  const d = sqlDialect(knex)
  if (d === 'mssql') return t
  const map: Record<string, string> = {
    integer: 'int',
    int: 'int',
    mediumint: 'int',
    'character varying': 'nvarchar',
    varchar: 'nvarchar',
    character: 'nchar',
    char: 'nchar',
    text: 'nvarchar',
    tinytext: 'nvarchar',
    mediumtext: 'nvarchar',
    longtext: 'nvarchar',
    numeric: 'decimal',
    'double precision': 'float',
    double: 'float',
    'timestamp without time zone': 'datetime2',
    'timestamp with time zone': 'datetimeoffset',
    timestamp: 'datetime2',
    datetime: 'datetime2',
    boolean: 'bit',
    uuid: 'uniqueidentifier'
  }
  return map[t] ?? t
}

/** One table's columns with their (normalised) SQL type names. Empty when the table is absent. */
export async function columnTypes(
  knex: Knex,
  table: string
): Promise<Array<{ column_name: string; data_type: string }>> {
  const d = sqlDialect(knex)
  if (d === 'mssql') {
    const res = await knex.raw(
      `SELECT c.name AS column_name, ty.name AS data_type
         FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID(?)`,
      [table]
    )
    return rawRows(res)
  }
  const res = await knex.raw(
    `SELECT column_name AS column_name, data_type AS data_type
       FROM information_schema.columns
      WHERE table_schema = ${schemaFilter(knex)} AND table_name = ?
      ORDER BY ordinal_position`,
    [table]
  )
  return rawRows<{ column_name: string; data_type: string }>(res).map((r) => ({
    column_name: r.column_name,
    data_type: normalizeSqlType(knex, r.data_type)
  }))
}

/** Columns that lead (are first in) an enabled index of the table. */
export async function leadingIndexColumns(knex: Knex, table: string): Promise<Set<string>> {
  const d = sqlDialect(knex)
  let rows: Array<{ column_name: string }>
  if (d === 'mssql') {
    rows = rawRows(
      await knex.raw(
        `SELECT DISTINCT c.name AS column_name
           FROM sys.index_columns ic
           JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE ic.object_id = OBJECT_ID(?) AND ic.key_ordinal = 1
            AND i.is_disabled = 0 AND i.is_hypothetical = 0`,
        [table]
      )
    )
  } else if (d === 'pg') {
    rows = rawRows(
      await knex.raw(
        `SELECT DISTINCT a.attname AS column_name
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
          WHERE c.relname = ? AND ns.nspname = current_schema() AND i.indisvalid`,
        [table]
      )
    )
  } else if (d === 'sqlite') {
    // Index heads plus the rowid primary key (an INTEGER PRIMARY KEY has no index row).
    rows = rawRows(
      await knex.raw(
        `SELECT DISTINCT ii.name AS column_name
           FROM pragma_index_list(?) il JOIN pragma_index_info(il.name) ii
          WHERE ii.seqno = 0 AND ii.name IS NOT NULL
         UNION
         SELECT p.name FROM pragma_table_info(?) p WHERE p.pk = 1`,
        [table, table]
      )
    )
  } else {
    rows = rawRows(
      await knex.raw(
        `SELECT DISTINCT column_name AS column_name
           FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = ? AND seq_in_index = 1`,
        [table]
      )
    )
  }
  return new Set(rows.map((r) => String(r.column_name)))
}

/** The table's approximate row count (catalog statistics; never a table scan, except a never-analysed Postgres table). */
export async function approxRowCount(knex: Knex, table: string): Promise<number> {
  const d = sqlDialect(knex)
  if (d === 'mssql') {
    const res = rawRows<{ n: number | string | null }>(
      await knex.raw(
        `SELECT SUM(p.rows) AS n FROM sys.partitions p
          WHERE p.object_id = OBJECT_ID(?) AND p.index_id IN (0, 1)`,
        [table]
      )
    )
    return Number(res[0]?.n ?? 0)
  }
  if (d === 'pg') {
    const res = rawRows<{ n: number | string | null }>(
      await knex.raw(
        `SELECT c.reltuples::bigint AS n FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE c.relname = ? AND ns.nspname = current_schema() AND c.relkind = 'r'`,
        [table]
      )
    )
    const n = Number(res[0]?.n ?? -1)
    if (n >= 0) return n
    const c = await knex(table).count({ n: '*' }).first()
    return Number((c as { n?: number | string } | undefined)?.n ?? 0)
  }
  // SQLite keeps no row statistics: an exact count (0 when the table is absent).
  if (d === 'sqlite') {
    if (!(await tableExists(knex, table))) return 0
    const c = await knex(table).count({ n: '*' }).first()
    return Number((c as { n?: number | string } | undefined)?.n ?? 0)
  }
  const res = rawRows<{ n: number | string | null }>(
    await knex.raw(
      `SELECT table_rows AS n FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    )
  )
  return Number(res[0]?.n ?? 0)
}

/** The table's primary-key columns with their (normalised) types. */
export async function primaryKeyColumns(
  knex: Knex,
  table: string
): Promise<Array<{ col: string; type: string }>> {
  const d = sqlDialect(knex)
  if (d === 'mssql') {
    return rawRows(
      await knex.raw(
        `SELECT c.name AS col, ty.name AS type
           FROM sys.indexes i
           JOIN sys.tables t ON t.object_id = i.object_id
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           JOIN sys.types ty ON ty.user_type_id = c.user_type_id
          WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(?)`,
        [table]
      )
    )
  }
  const rows = rawRows<{ col: string; type: string }>(
    await knex.raw(
      `SELECT kcu.column_name AS col, c.data_type AS type
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
         JOIN information_schema.columns c
           ON c.table_schema = kcu.table_schema AND c.table_name = kcu.table_name
          AND c.column_name = kcu.column_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = ${schemaFilter(knex)} AND tc.table_name = ?`,
      [table]
    )
  )
  return rows.map((r) => ({ col: r.col, type: normalizeSqlType(knex, r.type) }))
}

/** Is there a base table with this name in the current schema/database? */
export async function tableExists(knex: Knex, table: string): Promise<boolean> {
  try {
    return await knex.schema.hasTable(table)
  } catch {
    return false
  }
}

/** The `yyyy-mm-dd` text of a datetime expression (SQL Server: CONVERT style 23). */
export function dayText(knex: Knex, expr: string): string {
  const d = sqlDialect(knex)
  if (d === 'sqlite') return `strftime('%Y-%m-%d', ${expr})`
  if (d === 'pg') return `to_char(${expr}, 'YYYY-MM-DD')`
  if (d === 'mysql') return `DATE_FORMAT(${expr}, '%Y-%m-%d')`
  return `CONVERT(char(10), ${expr}, 23)`
}

/**
 * SQL text written in T-SQL form, made runnable on `knex`'s dialect. Identity on SQL Server.
 * Covers what the duplicate-check / typo statement builders emit: `[ident]` quoting,
 * `(SELECT [value] FROM OPENJSON(?))` id lists (one JSON-array binding), `nvarchar(n)` casts,
 * `N'…'` literals, `COLLATE Latin1_General_100_BIN2`, `CHAR(9)`, `ESCAPE '\'`, and LIKE (made
 * case-insensitive on Postgres, as SQL Server's collation is).
 * Never feed it SQL that carries a person's text inline.
 */
export function portableSql(knex: Knex, sql: string): string {
  const d = sqlDialect(knex)
  if (d === 'mssql') return sql
  let s = sql.replace(/\s+COLLATE\s+Latin1_General_100_BIN2/g, '')
  const list =
    d === 'sqlite'
      ? '(SELECT value FROM json_each(?))'
      : d === 'pg'
        ? '(SELECT jsonb_array_elements_text(?::jsonb))'
        : "(SELECT j.value FROM JSON_TABLE(?, '$[*]' COLUMNS (value VARCHAR(4000) PATH '$')) AS j)"
  // A function replacer: a `$'` in the replacement string would be read as a pattern.
  s = s.replace(/\(SELECT \[value\] FROM OPENJSON\(\?\)\)/g, () => list)
  s = s.replace(/\bN'/g, "'")
  s = s.replace(/\bnvarchar\((\d+|max)\)/gi, (_m, n: string) =>
    d === 'pg'
      ? n.toLowerCase() === 'max'
        ? 'text'
        : `varchar(${n})`
      : n.toLowerCase() === 'max'
        ? 'char'
        : `char(${n})`
  )
  if (d === 'pg') s = s.replace(/\bCHAR\(9\)/g, 'chr(9)').replace(/\bLIKE\b/g, 'ILIKE')
  if (d === 'mysql')
    s = s.replace(/'\\'/g, "'\\\\'").replace(/\bCHAR\(9\)/g, 'CHAR(9 USING utf8mb4)')
  s = s.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, (_m, id: string) => qi(knex, id))
  return s
}

/**
 * `col LIKE pattern`, case-insensitive on every database (Postgres: ILIKE). `col` is a column
 * reference the builder quotes (`f.title`); `pattern` is bound. Use inside a `.where(function)`.
 */
export function whereLikeCi(
  qb: Knex.QueryBuilder,
  knex: Knex,
  col: string,
  pattern: string,
  opts: { or?: boolean; not?: boolean } = {}
): Knex.QueryBuilder {
  // SQL Server and MySQL compare text case-insensitively already: the plain builder LIKE.
  if (sqlDialect(knex) !== 'pg') {
    const op = opts.not ? 'not like' : 'like'
    return opts.or ? qb.orWhere(col, op, pattern) : qb.where(col, op, pattern)
  }
  const sql = `?? ${opts.not ? 'NOT ILIKE' : 'ILIKE'} ?`
  return opts.or ? qb.orWhereRaw(sql, [col, pattern]) : qb.whereRaw(sql, [col, pattern])
}

/**
 * `col = value`, case-insensitive on every database, as SQL Server's default collation compares
 * text (an email typed in another case finds the same person). SQL Server and MySQL: the plain
 * builder `where`; Postgres and SQLite: `LOWER(col) = LOWER(?)`.
 */
export function whereEqualsCi<Q extends Knex.QueryBuilder>(
  qb: Q,
  knex: Knex,
  col: string,
  value: string
): Q {
  const d = sqlDialect(knex)
  if (d !== 'pg' && d !== 'sqlite') return qb.where(col, value) as Q
  return qb.whereRaw('LOWER(??) = LOWER(?)', [col, value]) as Q
}

/** The body of the 501 a SQL Server-only route answers on Postgres / MySQL. */
export const NOT_SUPPORTED_ON_DATABASE = {
  error: 'This needs a SQL Server database.',
  code: 'NOT_SUPPORTED_ON_DATABASE'
} as const

/**
 * Columns holding a uuid (SQL Server uniqueidentifier, Postgres uuid, MySQL char(36)) whose
 * name is one of `names`, across every table: `{ table_name, column_name }`.
 */
export async function uuidColumnsNamed(
  knex: Knex,
  names: string[]
): Promise<Array<{ table_name: string; column_name: string }>> {
  const d = sqlDialect(knex)
  const marks = names.map(() => '?').join(',')
  if (d === 'mssql')
    return rawRows(
      await knex.raw(
        `SELECT table_name AS table_name, column_name AS column_name
           FROM information_schema.columns
          WHERE column_name IN (${marks}) AND data_type = 'uniqueidentifier'`,
        names
      )
    )
  return rawRows(
    await knex.raw(
      `SELECT table_name AS table_name, column_name AS column_name
         FROM information_schema.columns
        WHERE table_schema = ${schemaFilter(knex)} AND column_name IN (${marks})
          AND ${d === 'pg' ? "data_type = 'uuid'" : "column_type = 'char(36)'"}`,
      names
    )
  )
}

/**
 * `portableSql` plus its bindings. MySQL has no cheap JSON list and a JSON_TABLE column would
 * clash with the table's collation, so there each `(SELECT [value] FROM OPENJSON(?))` id list
 * becomes `(?, ?, …)` with the array's values bound one by one. Identity on SQL Server.
 */
export function portableStatement(
  knex: Knex,
  sql: string,
  bindings: readonly unknown[]
): { sql: string; bindings: unknown[] } {
  const d = sqlDialect(knex)
  if (d !== 'mysql') return { sql: portableSql(knex, sql), bindings: [...bindings] }
  const out: unknown[] = []
  let i = 0
  const expanded = sql
    .replace(/\s+COLLATE\s+Latin1_General_100_BIN2/g, '')
    .replace(/\(SELECT \[value\] FROM OPENJSON\(\?\)\)|\?/g, (m) => {
      const b = bindings[i++]
      if (m === '?') {
        out.push(b)
        return '?'
      }
      let list: unknown[] = []
      try {
        const parsed = JSON.parse(String(b))
        if (Array.isArray(parsed)) list = parsed
      } catch {
        list = []
      }
      if (list.length === 0) return '(NULL)'
      out.push(...list)
      return `(${list.map(() => '?').join(', ')})`
    })
  return { sql: portableSql(knex, expanded), bindings: out }
}
