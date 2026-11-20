import type { Knex } from 'knex'
import { db } from '../index.js'
import { isMariaDb } from '../mysql-flavor.js'
import { rawRows } from '../raw-rows.js'
import { castText, type SqlDialect, sqlDialect } from '../sql-dialect.js'

/**
 * Cross-dialect pieces for the items / query engine (filters, list search, global search).
 * SQL Server output of every helper is what the call sites wrote before.
 */

/** The dialect of `knex`, or of the knex this request queries on (a cloud tenant pool, else the
 *  process client) when none is given. SQL Server when it cannot be told (unit-test stubs). */
export function dialectOf(knex?: Knex | Knex.Transaction): SqlDialect {
  try {
    return sqlDialect((knex ?? db) as Knex)
  } catch {
    return 'mssql'
  }
}

/**
 * Extra WHERE text that keeps an `information_schema` read to this database's own tables.
 * SQL Server scopes information_schema to the current database already (unchanged: empty);
 * MySQL's lists every database the login can see, so a same-named table elsewhere mixed its
 * columns in; Postgres lists every schema of the database (pg_catalog, other apps' schemas), so
 * it is kept to the search path's first schema. `alias` is the information_schema table's alias.
 */
export function catalogScope(knex: Knex | undefined, alias = ''): string {
  const d = dialectOf(knex)
  const col = `${alias ? `${alias}.` : ''}table_schema`
  if (d === 'mysql') return ` AND ${col} = DATABASE()`
  if (d === 'pg') return ` AND ${col} = current_schema()`
  return ''
}

/** information_schema DATA_TYPE values of plain text columns, per dialect. */
export function textDataTypes(knex?: Knex): string[] {
  const d = dialectOf(knex)
  if (d === 'pg') return ['character', 'character varying', 'text']
  // SQLite: the declared base type db/sqlite.ts's INFORMATION_SCHEMA reports (knex: varchar, text).
  if (d === 'sqlite') return ['char', 'varchar', 'nchar', 'nvarchar', 'character', 'text', 'clob']
  if (d === 'mysql') return ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']
  return ['char', 'nchar', 'varchar', 'nvarchar', 'text', 'ntext']
}

/** information_schema DATA_TYPE values of numeric columns a footer can sum, per dialect. */
export function numericDataTypes(knex?: Knex): string[] {
  const d = dialectOf(knex)
  if (d === 'pg') return ['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision']
  // SQLite: knex declares integer / bigint / float / decimal (booleans are 'boolean').
  if (d === 'sqlite')
    return ['integer', 'int', 'bigint', 'smallint', 'decimal', 'numeric', 'float', 'real', 'double']
  // MySQL booleans are tinyint(1) (bit on SQL Server, never summed): tinyint is left out.
  if (d === 'mysql') return ['int', 'bigint', 'smallint', 'mediumint', 'decimal', 'float', 'double']
  return ['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money']
}

/** `IN ('a','b')` list of trusted literal type names. */
export function sqlInList(values: string[]): string {
  return `(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')})`
}

/**
 * A LIKE operand as SQL text. Postgres has no LIKE for numbers, dates or uuids (SQL Server and
 * MySQL convert them to text themselves), so it compares their text form.
 */
export function likeOperand(knex: Knex | undefined, sql: string): string {
  return dialectOf(knex) === 'pg' ? `CAST(${sql} AS TEXT)` : sql
}

/** The case-insensitive LIKE keyword (SQL Server and MySQL compare case-insensitively under
 *  their default collations; Postgres needs ILIKE). */
export function likeKeyword(knex?: Knex, negate = false): string {
  const pg = dialectOf(knex) === 'pg'
  if (negate) return pg ? 'NOT ILIKE' : 'NOT LIKE'
  return pg ? 'ILIKE' : 'LIKE'
}

/**
 * `ref LIKE pattern` on a query builder, case-insensitive on every database. On SQL Server and
 * MySQL this is exactly `q.where(ref, 'like', pattern)` (or `not like` / `orWhere`), as before.
 * `ref` is a column name (quoted like `??`) or a Raw expression.
 */
export function whereLikeCi<Q extends Knex.QueryBuilder>(
  q: Q,
  ref: string | Knex.Raw,
  pattern: string,
  opts: { not?: boolean; or?: boolean; knex?: Knex } = {}
): Q {
  if (dialectOf(opts.knex) !== 'pg') {
    const r = typeof ref === 'string' ? ref : (ref as never)
    if (opts.or) return q.orWhere(r, opts.not ? 'not like' : 'like', pattern) as Q
    return q.where(r, opts.not ? 'not like' : 'like', pattern) as Q
  }
  const sql = `CAST(${typeof ref === 'string' ? '??' : '?'} AS TEXT) ${opts.not ? 'NOT ILIKE' : 'ILIKE'} ?`
  const bindings = [ref as Knex.RawBinding, pattern]
  if (opts.or) return q.orWhereRaw(sql, bindings) as Q
  return q.whereRaw(sql, bindings) as Q
}

/**
 * The `email not like …` clauses that leave legacy-import, redacted and invalid placeholder
 * accounts out of a people list. SQL Server text is exactly what the callers wrote; Postgres
 * compares case-insensitively (ILIKE) and, like MySQL, escapes `_` with a backslash by default
 * (MySQL reads `\\` in a literal as one backslash).
 */
export function hiddenEmailSql(
  knex?: Knex,
  negate = true
): { legacy: string; redacted: string; invalid: string } {
  const d = dialectOf(knex)
  if (d === 'mssql') {
    const nl = negate ? 'not like' : 'like'
    return {
      legacy: `email ${nl} 'legacy-%'`,
      redacted: `email ${nl} 'Redacted\\_%' escape '\\'`,
      invalid: `email ${nl} '%@invalid.local'`
    }
  }
  const nl = `${negate ? 'NOT ' : ''}${d === 'pg' ? 'ILIKE' : 'LIKE'}`
  // SQLite LIKE has no default escape character: name it.
  if (d === 'sqlite')
    return {
      legacy: `email ${nl} 'legacy-%'`,
      redacted: `email ${nl} 'Redacted\\_%' ESCAPE '\\'`,
      invalid: `email ${nl} '%@invalid.local'`
    }
  return {
    legacy: `email ${nl} 'legacy-%'`,
    redacted: d === 'pg' ? `email ${nl} 'Redacted\\_%'` : `email ${nl} 'Redacted\\\\_%'`,
    invalid: `email ${nl} '%@invalid.local'`
  }
}

/** Raw-SQL spellings for statements built as text (global search's union arms). */
export interface SqlText {
  d: SqlDialect
  /** A quoted identifier: `[x]` / `"x"` / `` `x` ``. */
  id(name: string): string
  /** `TOP n ` after SELECT on SQL Server; pair with limit(). */
  top(n: number): string
  /** ` LIMIT n` at the end of a SELECT on Postgres / MySQL. */
  limit(n: number): string
  /** An id as text: CAST(x AS nvarchar(64)) on SQL Server. */
  idText(expr: string): string
  /** A synonym-pattern CAST (`CAST(? AS nvarchar(410))`). */
  textParam(len: number): string
  /** The case-insensitive LIKE keyword. */
  like: string
  /** ` ESCAPE '\'` for backslash-escaped patterns (MySQL doubles it). */
  escape: string
  /** `CROSS APPLY` on SQL Server, `CROSS JOIN LATERAL` elsewhere. */
  crossApply: string
  /** True when the database has no LATERAL / APPLY (MariaDB): don't use `crossApply`. */
  noLateral: boolean
}

export function sqlText(knex?: Knex): SqlText {
  const d = dialectOf(knex)
  const int = (n: number) => Math.max(0, Math.floor(n))
  return {
    d,
    id: (name) =>
      d === 'pg' || d === 'sqlite'
        ? `"${name.replace(/"/g, '""')}"`
        : d === 'mysql'
          ? `\`${name.replace(/`/g, '``')}\``
          : `[${name.replace(/]/g, ']]')}]`,
    top: (n) => (d === 'mssql' ? `TOP ${int(n)} ` : ''),
    limit: (n) => (d === 'mssql' ? '' : ` LIMIT ${int(n)}`),
    idText: (expr) =>
      d === 'pg' || d === 'sqlite'
        ? `CAST(${expr} AS TEXT)`
        : d === 'mysql'
          ? `CAST(${expr} AS CHAR(64))`
          : `CAST(${expr} AS nvarchar(64))`,
    textParam: (len) =>
      d === 'pg' || d === 'sqlite'
        ? 'CAST(? AS TEXT)'
        : d === 'mysql'
          ? `CAST(? AS CHAR(${int(len)}))`
          : `CAST(? AS nvarchar(${int(len)}))`,
    like: d === 'pg' ? 'ILIKE' : 'LIKE',
    escape: d === 'mysql' ? " ESCAPE '\\\\'" : " ESCAPE '\\'",
    crossApply: d === 'mssql' ? 'CROSS APPLY' : 'CROSS JOIN LATERAL',
    noLateral: d === 'sqlite' || (d === 'mysql' && isMariaDb(knex ?? db))
  }
}

/**
 * One table's row count as the database keeps it (no scan): SQL Server's partition stats,
 * Postgres's planner estimate (pg_class.reltuples), MySQL's information_schema estimate.
 * One `?` binding: the table name. Answers a single row `{ n }`.
 */
export function tableRowsSql(knex?: Knex): string {
  const d = dialectOf(knex)
  // SQLite keeps no statistics: the cells on the table b-tree's leaf pages (dbstat) are its rows,
  // read from page headers without decoding a row.
  if (d === 'sqlite')
    return `select COALESCE(SUM(s.ncell), 0) as n from dbstat s where s.name = ? and s.pagetype = 'leaf'`
  if (d === 'pg')
    return `select greatest(c.reltuples, 0)::bigint as n from pg_class c
     join pg_namespace s on s.oid = c.relnamespace
     where c.relname = ? and s.nspname = current_schema() and c.relkind in ('r', 'p')`
  if (d === 'mysql')
    return `select table_rows as n from information_schema.tables
     where table_name = ? and table_schema = DATABASE()`
  return `select sum(p.rows) as n from sys.partitions p join sys.tables t on t.object_id = p.object_id
     where t.name = ? and p.index_id in (0, 1)`
}

/**
 * `col NOT LIKE '<prefix>_%'` with the underscore literal (system-table prefixes `nivaro_`,
 * `directus_`). SQL Server text: `<col> not like 'nivaro\_%' escape '\'`. `prefix` is trusted
 * literal text (letters only).
 */
export function notPrefixedSql(knex: Knex | undefined, colSql: string, prefix: string): string {
  if (!/^[A-Za-z]+$/.test(prefix)) throw new Error(`notPrefixedSql: bad prefix ${prefix}`)
  const d = dialectOf(knex)
  if (d === 'pg') return `${colSql} not like '${prefix}\\_%'`
  if (d === 'sqlite') return `${colSql} not like '${prefix}\\_%' escape '\\'`
  if (d === 'mysql') return `${colSql} not like '${prefix}\\\\_%'`
  return `${colSql} not like '${prefix}\\_%' escape '\\'`
}

/**
 * After rows were inserted with explicit ids: Postgres's serial sequence does not move on its
 * own (SQL Server's IDENTITY_INSERT and MySQL's AUTO_INCREMENT do), so the next plain insert
 * would collide with an id written here. Moves the sequence past the table's highest id.
 * No-op elsewhere, and for a table without an integer serial id.
 */
export async function syncIdSequence(knex: Knex, table: string): Promise<void> {
  if (dialectOf(knex) !== 'pg') return
  try {
    await knex.raw(
      `SELECT setval(pg_get_serial_sequence(?, 'id'), GREATEST((SELECT MAX(id) FROM ??), 1))`,
      [table, table]
    )
  } catch {
    /* no serial id (uuid / text key): nothing to move */
  }
}

/**
 * Physical foreign keys INTO a table: `(table_name, column_name)` rows, one `?` binding (the
 * referenced table). SQL Server text is the record-merge read as it was.
 */
export function inboundForeignKeysSql(knex?: Knex): string {
  const d = dialectOf(knex)
  if (d === 'pg')
    return `SELECT cl.relname AS table_name, a.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN LATERAL unnest(con.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.contype = 'f' AND con.confrelid = (
         SELECT c2.oid FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
          WHERE c2.relname = ? AND n2.nspname = current_schema())`
  if (d === 'mysql' || d === 'sqlite')
    return `SELECT table_name AS table_name, column_name AS column_name
       FROM information_schema.key_column_usage
       WHERE referenced_table_schema = DATABASE() AND referenced_table_name = ?
         AND table_schema = DATABASE()`
  return `SELECT t.name AS table_name, c.name AS column_name
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables t ON t.object_id = fk.parent_object_id
       JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
       WHERE fk.referenced_object_id = OBJECT_ID(?)`
}

/** One column of a Postgres / MySQL table described in SQL Server's type spelling. */
export interface PortableColumn {
  name: string
  /** The SQL Server spelling of the type (`int`, `nvarchar(120)`, `decimal(18, 2)`, `bit`,
   *  `datetime2(3)`, `uniqueidentifier`) — what callers written for sys.types expect. */
  sql: string
  identity: boolean
  computed: boolean
  /** Characters a bounded text column holds; null when unbounded or not text. */
  maxChars: number | null
}

/**
 * A Postgres or MySQL table's columns read from information_schema, each type named the way
 * SQL Server's sys.types names its equivalent (so code that judges `bit`, `datetime2`,
 * `nvarchar(n)` keeps working). Not for SQL Server: callers read sys.columns there.
 */
export async function portableColumns(knex: Knex, table: string): Promise<PortableColumn[]> {
  const d = dialectOf(knex)
  const list = rawRows<{
    name: string
    dt: string
    ct: string
    len: number | string | null
    prec: number | string | null
    scl: number | string | null
    dtp: number | string | null
    extra: string | null
  }>(
    await knex.raw(
      d === 'mysql' || d === 'sqlite'
        ? `SELECT column_name AS name, data_type AS dt, column_type AS ct,
                  character_maximum_length AS len, numeric_precision AS prec,
                  numeric_scale AS scl, datetime_precision AS dtp, extra AS extra
             FROM information_schema.columns
            WHERE table_name = ? AND table_schema = DATABASE()
            ORDER BY ordinal_position`
        : `SELECT column_name AS name, data_type AS dt, data_type AS ct,
                  character_maximum_length AS len, numeric_precision AS prec,
                  numeric_scale AS scl, datetime_precision AS dtp,
                  CASE WHEN is_identity = 'YES' OR column_default LIKE 'nextval(%' THEN 'auto_increment' ELSE '' END
                  || CASE WHEN is_generated = 'ALWAYS' THEN ' generated' ELSE '' END AS extra
             FROM information_schema.columns
            WHERE table_name = ? AND table_schema = current_schema()
            ORDER BY ordinal_position`,
      [table]
    )
  )
  return list.map((r) => {
    const dt = String(r.dt ?? '').toLowerCase()
    const ct = String(r.ct ?? '').toLowerCase()
    const len = r.len == null ? null : Number(r.len)
    const bounded = len != null && len > 0 && len <= 4000
    const extra = String(r.extra ?? '').toLowerCase()
    let sql = dt
    let maxChars: number | null = null
    if (['character varying', 'varchar', 'character', 'char'].includes(dt)) {
      sql = bounded ? `nvarchar(${len})` : 'nvarchar(max)'
      maxChars = bounded ? len : null
    } else if (['text', 'tinytext', 'mediumtext', 'longtext', 'json', 'jsonb'].includes(dt)) {
      sql = 'nvarchar(max)'
    } else if (dt === 'integer' || dt === 'int' || dt === 'mediumint') sql = 'int'
    else if (dt === 'tinyint') sql = ct.startsWith('tinyint(1)') ? 'bit' : 'tinyint'
    else if (dt === 'boolean') sql = 'bit'
    else if (dt === 'bigint') sql = 'bigint'
    else if (dt === 'numeric' || dt === 'decimal')
      sql = `decimal(${Number(r.prec ?? 18)}, ${Number(r.scl ?? 0)})`
    else if (dt === 'double precision' || dt === 'double') sql = 'float'
    else if (dt === 'float') sql = d === 'mysql' ? 'real' : 'float'
    else if (dt.startsWith('timestamp with time zone'))
      sql = `datetimeoffset(${Number(r.dtp ?? 3)})`
    else if (dt.startsWith('timestamp') || dt === 'datetime')
      sql = `datetime2(${Number(r.dtp ?? 3)})`
    else if (dt === 'uuid') sql = 'uniqueidentifier'
    else if (dt === 'bytea' || dt.endsWith('blob') || dt.endsWith('binary')) sql = 'varbinary(max)'
    return {
      name: String(r.name),
      sql,
      identity: extra.includes('auto_increment'),
      computed: extra.includes('generated') && !extra.includes('default_generated'),
      maxChars
    }
  })
}

/**
 * Every base table's row count as the database keeps it (no scan), Postgres / MySQL:
 * `(table_name, rows)` rows. (SQL Server callers read sys.dm_db_partition_stats themselves.)
 */
export function allTableRowsSql(knex?: Knex): string {
  // SQLite: leaf-page cells from dbstat, as in tableRowsSql.
  if (dialectOf(knex) === 'sqlite')
    return `SELECT m.name AS table_name, COALESCE((SELECT SUM(s.ncell) FROM dbstat s WHERE s.name = m.name AND s.pagetype = 'leaf'), 0) AS "rows"
      FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`
  if (dialectOf(knex) === 'mysql')
    return `SELECT table_name AS table_name, table_rows AS \`rows\` FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`
  return `SELECT c.relname AS table_name, greatest(c.reltuples, 0)::bigint AS rows
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = current_schema()`
}

/**
 * A record id as text, for comparing with a text column that stores ids (`item`, `item_id`,
 * `parent_id`): castText(·, 255) on the database this request reads (SQL Server text:
 * `CAST(x AS NVARCHAR(255))`).
 */
export function idText(knex: Knex | undefined, expr: string, len = 255): string {
  return castText((knex ?? db) as Knex, expr, len)
}

/**
 * Values from a JSON snapshot (trash, a promotion bundle) made fit for a plain insert/update on
 * Postgres / MySQL: an ISO date-time string bound to a date/time column becomes a Date (MySQL's
 * strict mode refuses `2026-11-20T21:43:54.000Z`; SQL Server and Postgres read it). Other values
 * pass through. SQL Server: returned unchanged.
 */
export async function snapshotValuesFor(
  knex: Knex,
  table: string,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (dialectOf(knex) === 'mssql') return values
  let info: Record<string, { type?: string }> = {}
  try {
    info = (await knex(table).columnInfo()) as Record<string, { type?: string }>
  } catch {
    return values
  }
  const out: Record<string, unknown> = { ...values }
  for (const [k, v] of Object.entries(values)) {
    const t = String(info[k]?.type ?? '').toLowerCase()
    if (typeof v !== 'string' || !/(date|time)/.test(t)) continue
    if (t === 'date') {
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) out[k] = v.slice(0, 10)
      continue
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      const d = new Date(v)
      if (!Number.isNaN(d.getTime())) out[k] = d
    }
  }
  return out
}
