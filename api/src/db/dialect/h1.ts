import type { Knex } from 'knex'
import { isMariaDb } from '../mysql-flavor.js'
import { rawRows } from '../raw-rows.js'
import { castText, qi, sqlDialect, tryCastDate, tryCastInt, tryCastNumber } from '../sql-dialect.js'
import { approxTableCounts } from './users-ai-config.js'

/** SQLite: user tables of the main schema (sqlite_master alias `m`). */
const SQLITE_TABLES = "m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"

/**
 * Catalog and schema-editing helpers for the DB plumbing / admin data tools (phase 2, area H1).
 * Every helper takes the knex the statement runs on. SQL Server callers keep their original T-SQL
 * in place; these are the Postgres / MySQL equivalents (and, where a helper also serves SQL
 * Server, its SQL Server branch is the statement the code always ran).
 */

/** What a SQL Server-only route answers (HTTP 501) on Postgres / MySQL. */
export const NOT_SUPPORTED_BODY = {
  error: 'This needs a SQL Server database.',
  code: 'NOT_SUPPORTED_ON_DATABASE'
} as const

export const isMssqlKnex = (knex: Knex): boolean => sqlDialect(knex) === 'mssql'

/**
 * ` AND <col> = <this database>` for an information_schema read on Postgres / MySQL (without it
 * a MySQL server lists every database's tables); empty on SQL Server (the original text).
 */
export function inThisSchema(knex: Knex, col: string): string {
  const d = sqlDialect(knex)
  if (d === 'pg') return ` AND ${col} = current_schema()`
  if (d === 'mysql') return ` AND ${col} = DATABASE()`
  return ''
}

/** The name of the database this knex is connected to. */
export async function currentDatabaseName(knex: Knex): Promise<string> {
  const d = sqlDialect(knex)
  // SQLite: the database file's name without its folder and extension.
  if (d === 'sqlite') {
    const rows = rawRows<{ f: string }>(
      await knex.raw("SELECT file AS f FROM pragma_database_list WHERE name = 'main'")
    )
    const base =
      String(rows[0]?.f ?? '')
        .split(/[\\/]/)
        .pop() ?? ''
    return base.replace(/\.(db|sqlite3?)$/i, '') || 'database'
  }
  const sql =
    d === 'pg'
      ? 'SELECT current_database() AS n'
      : d === 'mysql'
        ? 'SELECT DATABASE() AS n'
        : 'SELECT DB_NAME() AS n'
  const rows = rawRows<{ n: string }>(await knex.raw(sql))
  return String(rows[0]?.n ?? 'database')
}

/** Row counts per user table (estimates on Postgres / MySQL — no table scans). */
export async function tableRowCounts(
  knex: Knex
): Promise<Array<{ table_name: string; row_count: number }>> {
  const d = sqlDialect(knex)
  // SQLite keeps no statistics: exact counts.
  if (d === 'sqlite')
    return (await approxTableCounts(knex, null)).map((r) => ({
      table_name: r.name,
      row_count: r.row_count
    }))
  const sql =
    d === 'pg'
      ? `SELECT relname AS table_name, n_live_tup AS row_count FROM pg_stat_user_tables WHERE schemaname = current_schema()`
      : d === 'mysql'
        ? `SELECT table_name AS table_name, table_rows AS row_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`
        : `SELECT t.name AS table_name, SUM(p.row_count) AS row_count
    FROM sys.tables t
    JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
    GROUP BY t.name`
  return rawRows<{ table_name: string; row_count: number }>(await knex.raw(sql)).map((r) => ({
    table_name: String(r.table_name),
    row_count: Number(r.row_count ?? 0)
  }))
}

export interface IndexKeyColumn {
  table_name: string
  index_name: string
  /** 1-based position in the index key. */
  seq: number
  column_name: string
  is_unique: boolean
  is_primary: boolean
  has_filter: boolean
}

/** Every index's KEY columns in order (included columns left out). */
export async function indexKeyColumns(knex: Knex): Promise<IndexKeyColumn[]> {
  const d = sqlDialect(knex)
  const sql =
    d === 'pg'
      ? `SELECT c.relname AS table_name, ic.relname AS index_name, k.ord AS seq, a.attname AS column_name,
       i.indisunique AS is_unique, i.indisprimary AS is_primary, (i.indpred IS NOT NULL) AS has_filter
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
 WHERE n.nspname = current_schema() AND c.relkind = 'r' AND k.ord <= i.indnkeyatts`
      : d === 'sqlite'
        ? // An INTEGER PRIMARY KEY is the rowid (no index row): listed as the primary key 'pk_<table>'.
          `SELECT m.name AS table_name, il.name AS index_name, ii.seqno + 1 AS seq, ii.name AS column_name,
       il."unique" AS is_unique, (il.origin = 'pk') AS is_primary, il.partial AS has_filter
  FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii
 WHERE ${SQLITE_TABLES} AND ii.name IS NOT NULL
UNION ALL
SELECT m.name, 'pk_' || m.name, p.pk, p.name, 1, 1, 0
  FROM sqlite_master m JOIN pragma_table_info(m.name) p
 WHERE ${SQLITE_TABLES} AND p.pk > 0
   AND NOT EXISTS (SELECT 1 FROM pragma_index_list(m.name) x WHERE x.origin = 'pk')`
        : d === 'mysql'
          ? `SELECT table_name AS table_name, index_name AS index_name, seq_in_index AS seq, column_name AS column_name,
       (non_unique = 0) AS is_unique, (index_name = 'PRIMARY') AS is_primary, 0 AS has_filter
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND column_name IS NOT NULL`
          : `SELECT t.name AS table_name, i.name AS index_name, ic.key_ordinal AS seq, c.name AS column_name,
       i.is_unique AS is_unique, i.is_primary_key AS is_primary, i.has_filter AS has_filter
  FROM sys.indexes i
  JOIN sys.tables t ON t.object_id = i.object_id
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
 WHERE i.index_id > 0`
  return rawRows<Record<string, unknown>>(await knex.raw(sql)).map((r) => ({
    table_name: String(r.table_name),
    index_name: String(r.index_name),
    seq: Number(r.seq),
    column_name: String(r.column_name),
    is_unique: r.is_unique === true || Number(r.is_unique) === 1,
    is_primary: r.is_primary === true || Number(r.is_primary) === 1,
    has_filter: r.has_filter === true || Number(r.has_filter) === 1
  }))
}

/** Group indexKeyColumns by index: `table.index` → ordered columns. */
export function groupIndexes(rows: IndexKeyColumn[]): Array<{
  table: string
  index: string
  columns: string[]
  unique: boolean
  primary: boolean
  filtered: boolean
}> {
  const map = new Map<string, IndexKeyColumn[]>()
  for (const r of rows) {
    const k = `${r.table_name}\u0000${r.index_name}`
    const list = map.get(k) ?? []
    list.push(r)
    map.set(k, list)
  }
  return [...map.values()].map((list) => {
    list.sort((a, b) => a.seq - b.seq)
    return {
      table: list[0].table_name,
      index: list[0].index_name,
      columns: list.map((x) => x.column_name),
      unique: list[0].is_unique,
      primary: list[0].is_primary,
      filtered: list[0].has_filter
    }
  })
}

/** Names of the user tables (base tables) of this database. */
export async function baseTableNames(knex: Knex): Promise<string[]> {
  const d = sqlDialect(knex)
  const sql =
    d === 'pg'
      ? `SELECT table_name AS name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema = current_schema()`
      : d === 'mysql' || d === 'sqlite'
        ? `SELECT table_name AS name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema = DATABASE()`
        : `SELECT name FROM sys.tables WHERE is_ms_shipped = 0`
  return rawRows<{ name: string }>(await knex.raw(sql)).map((r) => String(r.name))
}

export interface TableFootprint {
  name: string
  row_count: number | null
  size_mb: number | null
  /** MySQL keeps the table's last write time; Postgres / SQL Server keep it only since a restart (callers handle that). */
  last_write: Date | null
  /** MySQL keeps the creation time; Postgres does not. */
  created: Date | null
}

/** Rows + size per base table on Postgres / MySQL (SQL Server callers read the DMVs themselves). */
export async function tableFootprints(knex: Knex): Promise<TableFootprint[]> {
  const d = sqlDialect(knex)
  if (d === 'pg') {
    const rows = rawRows<Record<string, unknown>>(
      await knex.raw(`SELECT c.relname AS name, COALESCE(s.n_live_tup, 0) AS row_count,
         ROUND(pg_total_relation_size(c.oid) / 1048576.0, 2) AS size_mb
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
   WHERE c.relkind = 'r' AND n.nspname = current_schema()`)
    )
    return rows.map((r) => ({
      name: String(r.name),
      row_count: Number(r.row_count),
      size_mb: Number(r.size_mb),
      last_write: null,
      created: null
    }))
  }
  if (d === 'sqlite') {
    // Exact rows; size from dbstat (the table's pages and its indexes'). No write/creation times.
    const kb = await sqliteTableKb(knex)
    return (await approxTableCounts(knex, null)).map((r) => ({
      name: r.name,
      row_count: r.row_count,
      size_mb: Math.round(((kb.get(r.name) ?? 0) / 1024) * 100) / 100,
      last_write: null,
      created: null
    }))
  }
  const rows = rawRows<Record<string, unknown>>(
    await knex.raw(`SELECT table_name AS name, table_rows AS row_count,
       ROUND((data_length + index_length) / 1048576, 2) AS size_mb, update_time AS last_write,
       create_time AS created
  FROM information_schema.tables
 WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`)
  )
  return rows.map((r) => ({
    name: String(r.name),
    row_count: r.row_count == null ? null : Number(r.row_count),
    size_mb: r.size_mb == null ? null : Number(r.size_mb),
    last_write: r.last_write ? new Date(r.last_write as string) : null,
    created: r.created ? new Date(r.created as string) : null
  }))
}

/** Database size and the biggest tables, on Postgres / MySQL. */
export async function nonMssqlStorage(
  knex: Knex
): Promise<{ total_mb: number; used_mb: number; top_tables: Array<Record<string, unknown>> }> {
  const d = sqlDialect(knex)
  if (d === 'pg') {
    const size = rawRows<{ mb: number }>(
      await knex.raw('SELECT pg_database_size(current_database()) / 1048576 AS mb')
    )
    const top = rawRows<Record<string, unknown>>(
      await knex.raw(`SELECT c.relname AS table_name, COALESCE(s.n_live_tup, 0) AS row_count,
         pg_total_relation_size(c.oid) / 1048576 AS mb
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
   WHERE c.relkind = 'r' AND n.nspname = current_schema()
   ORDER BY pg_total_relation_size(c.oid) DESC
   LIMIT 20`)
    )
    const mb = Number(size[0]?.mb ?? 0)
    return {
      total_mb: mb,
      used_mb: mb,
      top_tables: top.map((r) => ({ ...r, row_count: Number(r.row_count), mb: Number(r.mb) }))
    }
  }
  if (d === 'sqlite') {
    const pages = rawRows<{ total: number; free: number }>(
      await knex.raw(
        'SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS total, (SELECT freelist_count FROM pragma_freelist_count) * (SELECT page_size FROM pragma_page_size) AS free'
      )
    )[0]
    const total = Number(pages?.total ?? 0) / 1048576
    const kb = await sqliteTableKb(knex)
    const counts = new Map(
      (await approxTableCounts(knex, null)).map((r) => [r.name, r.row_count] as const)
    )
    const top = [...kb.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, k]) => ({
        table_name: name,
        row_count: counts.get(name) ?? 0,
        mb: Math.round(k / 1024)
      }))
    return {
      total_mb: Math.round(total),
      used_mb: Math.round(total - Number(pages?.free ?? 0) / 1048576),
      top_tables: top
    }
  }
  const size = rawRows<{ mb: number | null; used: number | null }>(
    await knex.raw(`SELECT ROUND(SUM(data_length + index_length) / 1048576) AS mb,
       ROUND(SUM(data_length + index_length - data_free) / 1048576) AS used
  FROM information_schema.tables WHERE table_schema = DATABASE()`)
  )
  const top = rawRows<Record<string, unknown>>(
    await knex.raw(`SELECT table_name AS table_name, table_rows AS row_count,
       ROUND((data_length + index_length) / 1048576) AS mb
  FROM information_schema.tables
 WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
 ORDER BY (data_length + index_length) DESC
 LIMIT 20`)
  )
  return {
    total_mb: Number(size[0]?.mb ?? 0),
    used_mb: Number(size[0]?.used ?? size[0]?.mb ?? 0),
    top_tables: top.map((r) => ({ ...r, row_count: Number(r.row_count), mb: Number(r.mb) }))
  }
}

export interface ForeignKeyInfo {
  constraint_name: string
  column_name: string
  referenced_table: string
  referenced_column: string
}

/** Every table some OTHER table's foreign key points at (Postgres / MySQL): name → the referencing `parent (fk)` entries. */
export async function referencedTables(
  knex: Knex
): Promise<Array<{ referenced: string; parent: string; fk: string }>> {
  const d = sqlDialect(knex)
  const sql =
    d === 'pg'
      ? `SELECT rt.relname AS referenced, pt.relname AS parent, con.conname AS fk
           FROM pg_constraint con
           JOIN pg_class pt ON pt.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = pt.relnamespace
           JOIN pg_class rt ON rt.oid = con.confrelid
          WHERE con.contype = 'f' AND con.confrelid <> con.conrelid AND n.nspname = current_schema()`
      : d === 'mysql'
        ? `SELECT referenced_table_name AS referenced, table_name AS parent, constraint_name AS fk
             FROM information_schema.referential_constraints
            WHERE constraint_schema = DATABASE() AND referenced_table_name <> table_name`
        : d === 'sqlite'
          ? `SELECT DISTINCT f."table" AS referenced, m.name AS parent, 'fk_' || m.name || '_' || f.id AS fk
               FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
              WHERE ${SQLITE_TABLES} AND f."table" <> m.name`
          : `SELECT rt.name AS referenced, pt.name AS parent, fk.name AS fk
             FROM sys.foreign_keys fk
             JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
             JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
            WHERE rt.object_id <> pt.object_id`
  return rawRows<{ referenced: string; parent: string; fk: string }>(await knex.raw(sql))
}

/** Foreign keys declared ON `table` (its own columns pointing elsewhere). Postgres / MySQL. */
export async function foreignKeysOnTable(knex: Knex, table: string): Promise<ForeignKeyInfo[]> {
  const d = sqlDialect(knex)
  if (d === 'pg') {
    return rawRows<ForeignKeyInfo>(
      await knex.raw(
        `SELECT con.conname AS constraint_name, a.attname AS column_name,
                rt.relname AS referenced_table, ra.attname AS referenced_column
           FROM pg_constraint con
           JOIN pg_class pt ON pt.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = pt.relnamespace
           JOIN pg_class rt ON rt.oid = con.confrelid
           CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, rattnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
           JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.rattnum
          WHERE con.contype = 'f' AND n.nspname = current_schema() AND pt.relname = ?`,
        [table]
      )
    )
  }
  return rawRows<ForeignKeyInfo>(
    await knex.raw(
      `SELECT constraint_name AS constraint_name, column_name AS column_name,
              referenced_table_name AS referenced_table, referenced_column_name AS referenced_column
         FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [table]
    )
  )
}

/** Foreign keys that bind `table.column` on either side (the column holds one, or is the one pointed at). */
export async function foreignKeysTouching(
  knex: Knex,
  table: string,
  column: string
): Promise<Array<{ fk_name: string }>> {
  const d = sqlDialect(knex)
  if (d === 'pg') {
    return rawRows<{ fk_name: string }>(
      await knex.raw(
        `SELECT DISTINCT con.conname AS fk_name
           FROM pg_constraint con
           JOIN pg_class pt ON pt.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = pt.relnamespace
           JOIN pg_class rt ON rt.oid = con.confrelid
           CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, rattnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
           JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.rattnum
          WHERE con.contype = 'f' AND n.nspname = current_schema()
            AND ((pt.relname = ? AND a.attname = ?) OR (rt.relname = ? AND ra.attname = ?))`,
        [table, column, table, column]
      )
    )
  }
  return rawRows<{ fk_name: string }>(
    await knex.raw(
      `SELECT DISTINCT constraint_name AS fk_name
         FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL
          AND ((table_name = ? AND column_name = ?)
            OR (referenced_table_name = ? AND referenced_column_name = ?))`,
      [table, column, table, column]
    )
  )
}

/** Drop the foreign key(s) on `table.column` (Postgres / MySQL); returns how many were dropped. */
export async function dropForeignKeysOnColumn(
  knex: Knex,
  table: string,
  column: string
): Promise<number> {
  const d = sqlDialect(knex)
  const fks = (await foreignKeysOnTable(knex, table)).filter((f) => f.column_name === column)
  const names = [...new Set(fks.map((f) => f.constraint_name))]
  // SQLite cannot drop a constraint: knex rebuilds the table without the column's foreign key.
  if (d === 'sqlite') {
    if (names.length) await knex.schema.alterTable(table, (t) => t.dropForeign([column]))
    return names.length
  }
  for (const name of names) {
    await knex.raw(
      d === 'pg'
        ? `ALTER TABLE ${qi(knex, table)} DROP CONSTRAINT ${qi(knex, name)}`
        : `ALTER TABLE ${qi(knex, table)} DROP FOREIGN KEY ${qi(knex, name)}`
    )
  }
  return names.length
}

/** Does `table.column` hold an auto-generated id (IDENTITY / serial / AUTO_INCREMENT)? */
export async function hasIdentityColumn(
  knex: Knex,
  table: string,
  column = 'id'
): Promise<boolean> {
  const d = sqlDialect(knex)
  if (d === 'pg') {
    const rows = rawRows<{ x: number }>(
      await knex.raw(
        `SELECT 1 AS x FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?
            AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')`,
        [table, column]
      )
    )
    return rows.length > 0
  }
  if (d === 'sqlite') {
    // A lone INTEGER PRIMARY KEY is the rowid: SQLite numbers new rows itself.
    const rows = rawRows<{ x: number }>(
      await knex.raw(
        `SELECT 1 AS x FROM pragma_table_info(?) p
          WHERE p.name = ? AND p.pk = 1 AND lower(p.type) = 'integer'
            AND (SELECT COUNT(*) FROM pragma_table_info(?) q WHERE q.pk > 0) = 1`,
        [table, column, table]
      )
    )
    return rows.length > 0
  }
  if (d === 'mysql') {
    const rows = rawRows<{ x: number }>(
      await knex.raw(
        `SELECT 1 AS x FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
            AND extra LIKE '%auto_increment%'`,
        [table, column]
      )
    )
    return rows.length > 0
  }
  const rows = rawRows<{ x: number }>(
    await knex.raw(
      `SELECT 1 AS x FROM sys.identity_columns ic WHERE ic.object_id = OBJECT_ID(?) AND ic.name = ?`,
      [table, column]
    )
  )
  return rows.length > 0
}

/**
 * After rows were inserted with explicit ids into a serial column, move Postgres' sequence past
 * the highest one (MySQL's AUTO_INCREMENT follows on its own; SQL Server's IDENTITY_INSERT keeps
 * its own counter).
 */
export async function resyncIdentity(knex: Knex, table: string, column = 'id'): Promise<void> {
  if (sqlDialect(knex) !== 'pg') return
  await knex.raw(
    `SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX(${qi(knex, column)}) FROM ${qi(knex, table)}), 1), (SELECT MAX(${qi(knex, column)}) IS NOT NULL FROM ${qi(knex, table)}))`,
    [qi(knex, table), column]
  )
}

/** The columns of a table, from the live catalog (names as stored). */
export async function liveColumnNames(knex: Knex, table: string): Promise<string[]> {
  const rows = rawRows<{ name: string }>(
    await knex.raw(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?${inThisSchema(knex, 'table_schema')}`,
      [table]
    )
  )
  return rows.map((r) => String(r.name))
}

// ─── Schema editing ─────────────────────────────────────────────────────────

export type AbstractColumnType =
  | 'string'
  | 'text'
  | 'integer'
  | 'bigInteger'
  | 'boolean'
  | 'decimal'
  | 'float'
  | 'date'
  | 'datetime'
  | 'uuid'

/** The physical type for an abstract Nivaro field type on Postgres / MySQL. */
export function physicalType(knex: Knex, type: AbstractColumnType, maxLen?: number): string {
  const d = sqlDialect(knex)
  const n = maxLen && Number.isInteger(maxLen) && maxLen > 0 && maxLen <= 4000 ? maxLen : 255
  if (d === 'pg') {
    const map: Record<AbstractColumnType, string> = {
      string: `varchar(${n})`,
      text: 'text',
      integer: 'integer',
      bigInteger: 'bigint',
      boolean: 'boolean',
      decimal: 'numeric(18,4)',
      float: 'double precision',
      date: 'date',
      datetime: 'timestamptz',
      uuid: 'uuid'
    }
    return map[type]
  }
  if (d === 'sqlite') {
    // The type names knex itself declares on SQLite (db/sqlite.ts reads date/datetime as dates).
    const map: Record<AbstractColumnType, string> = {
      string: `varchar(${n})`,
      text: 'text',
      integer: 'integer',
      bigInteger: 'bigint',
      boolean: 'boolean',
      decimal: 'float',
      float: 'float',
      date: 'date',
      datetime: 'datetime',
      uuid: 'char(36)'
    }
    return map[type]
  }
  const map: Record<AbstractColumnType, string> = {
    string: `varchar(${n})`,
    text: 'longtext',
    integer: 'int',
    bigInteger: 'bigint',
    boolean: 'tinyint(1)',
    decimal: 'decimal(18,4)',
    float: 'double',
    date: 'date',
    datetime: 'datetime(3)',
    uuid: 'char(36)'
  }
  return map[type]
}

/**
 * SQL true when the (non-null) value in `col` can NOT be converted to `type` — the Postgres /
 * MySQL stand-in for `TRY_CAST(col AS type) IS NULL`.
 */
export function castFailureCondition(
  knex: Knex,
  col: string,
  type: AbstractColumnType,
  maxLen?: number,
  fromType?: string
): string {
  const d = sqlDialect(knex)
  if (d === 'pg' && fromType) {
    const from = pgSourceKind(fromType)
    // A date/time value always converts to a date/time; Postgres prints it with its zone
    // ('2026-01-02 03:04:05+00'), which the text check below would refuse.
    if (from === 'temporal' && (type === 'date' || type === 'datetime')) return '1 = 0'
    if (from === 'boolean' && type !== 'boolean') col = pgBitExpr(col)
  }
  switch (type) {
    case 'integer':
      return `${tryCastInt(knex, col)} IS NULL`
    case 'bigInteger':
      return `${tryCastInt(knex, col, true)} IS NULL`
    case 'decimal':
    case 'float':
      return `${tryCastNumber(knex, col)} IS NULL`
    case 'date':
    case 'datetime':
      return `${tryCastDate(knex, col)} IS NULL`
    case 'boolean':
      return `LOWER(${castText(knex, col)}) NOT IN ('0', '1', 'true', 'false', 't', 'f')`
    case 'uuid': {
      const re = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      return d === 'pg'
        ? `${castText(knex, col)} !~ '${re}'`
        : `${castText(knex, col)} NOT REGEXP '${re}'`
    }
    case 'string': {
      const n = maxLen && maxLen > 0 && maxLen <= 4000 ? maxLen : 255
      return d === 'sqlite'
        ? `LENGTH(${castText(knex, col)}) > ${n}`
        : `CHAR_LENGTH(${castText(knex, col)}) > ${n}`
    }
    default:
      return '1 = 0'
  }
}

/** What a Postgres source column is, for a type change (`fromType` = information_schema data_type). */
function pgSourceKind(fromType: string): 'boolean' | 'temporal' | 'other' {
  const t = fromType.toLowerCase()
  if (t === 'boolean' || t === 'bit') return 'boolean'
  if (t === 'date' || t.startsWith('timestamp') || t === 'datetime2' || t === 'datetimeoffset')
    return 'temporal'
  return 'other'
}

/** A Postgres boolean as SQL Server's bit converts: 1 / 0 (text '1' / '0', number 1 / 0). */
function pgBitExpr(col: string): string {
  return `(CASE WHEN ${col} THEN 1 WHEN NOT ${col} THEN 0 END)`
}

/**
 * Postgres `USING` expression that converts `col` to `type` (NULL for what cannot convert).
 * `fromType` (the column's current data_type) makes a boolean convert like SQL Server's bit
 * (1 / 0, '1' / '0') and a date/time convert to a date/time directly.
 */
export function pgUsing(
  knex: Knex,
  col: string,
  type: AbstractColumnType,
  fromType?: string
): string {
  if (fromType) {
    const from = pgSourceKind(fromType)
    if (from === 'temporal' && type === 'date') return `(${col})::date`
    if (from === 'temporal' && type === 'datetime') return `(${col})::timestamptz`
    // A timestamp as text reads like MySQL's DATETIME(3) ('2026-05-06 07:08:09.120', UTC), not
    // Postgres' own '2026-05-06 07:08:09.12+00'. A date keeps its plain '2026-05-06'.
    const t = fromType.toLowerCase()
    if ((type === 'string' || type === 'text') && from === 'temporal' && t !== 'date') {
      const utc =
        t === 'datetimeoffset' || t.includes('with time zone') ? ` AT TIME ZONE 'UTC'` : ''
      const text = `to_char((${col})${utc}, 'YYYY-MM-DD HH24:MI:SS.MS')`
      return type === 'text' ? text : `(${text})::${physicalType(knex, 'string')}`
    }
    if (from === 'boolean' && type !== 'boolean') return pgUsing(knex, pgBitExpr(col), type)
  }
  switch (type) {
    case 'integer':
      return tryCastInt(knex, col)
    case 'bigInteger':
      return tryCastInt(knex, col, true)
    case 'decimal':
      return `(${tryCastNumber(knex, col)})::numeric(18,4)`
    case 'float':
      return tryCastNumber(knex, col)
    case 'date':
      return `(${tryCastDate(knex, col)})::date`
    case 'datetime':
      return `(${tryCastDate(knex, col)})::timestamptz`
    case 'boolean':
      return `(CASE WHEN LOWER(${castText(knex, col)}) IN ('1', 'true', 't') THEN true WHEN LOWER(${castText(knex, col)}) IN ('0', 'false', 'f') THEN false END)`
    case 'uuid':
      return `(CASE WHEN ${castFailureCondition(knex, col, 'uuid')} THEN NULL ELSE ${castText(knex, col)} END)::uuid`
    default:
      return `${col}::${physicalType(knex, type)}`
  }
}

/**
 * A column's default, read so a type change can put it back (SQL Server refuses ALTER COLUMN while a
 * default constraint holds it; Postgres drops it for the USING; MySQL's MODIFY COLUMN redefines the
 * column without it). Null: no default.
 *  - SQL Server: the constraint name + definition (`((7))`), re-added as `DEFAULT … FOR`.
 *  - Postgres: the expression, a literal's trailing cast taken off ('x'::character varying → 'x')
 *    so the literal takes the new type.
 *  - MySQL: the literal (bound) or, for an expression default (DEFAULT_GENERATED), `(expr)`.
 *  - MariaDB: COLUMN_DEFAULT is already SQL ('x', 7, current_timestamp()).
 */
export async function columnDefaultForRetype(
  knex: Knex,
  table: string,
  column: string
): Promise<{ sql: string; bindings: string[]; constraint?: string } | null> {
  const d = sqlDialect(knex)
  if (d === 'mssql') {
    const rows = rawRows<{ name: string; definition: string }>(
      await knex.raw(
        `SELECT dc.name AS name, dc.definition AS definition
           FROM sys.default_constraints dc
           JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
          WHERE dc.parent_object_id = OBJECT_ID(?) AND c.name = ?`,
        [table, column]
      )
    )
    return rows[0] ? { sql: rows[0].definition, bindings: [], constraint: rows[0].name } : null
  }
  if (d === 'pg') {
    const rows = rawRows<{ column_default: string | null }>(
      await knex.raw(
        `SELECT column_default AS column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
        [table, column]
      )
    )
    const v = rows[0]?.column_default
    if (v == null || /^nextval\(/i.test(v)) return null
    let expr = v.trim()
    while (/^\(([\s\S]*)\)$/.test(expr) && !/\)[\s\S]*\(/.test(expr.slice(1, -1)))
      expr = expr.slice(1, -1).trim()
    const literal =
      /^('(?:[^']|'')*'|-?\d+(?:\.\d+)?)((?:::\s*[a-z_][a-z0-9_ ]*(?:\(\d+(?:,\s*\d+)?\))?)+)$/i.exec(
        expr
      )
    return { sql: literal ? literal[1] : v, bindings: [] }
  }
  if (d === 'mysql') {
    const rows = rawRows<{ COLUMN_DEFAULT: string | null; EXTRA: string | null }>(
      await knex.raw(
        `SELECT COLUMN_DEFAULT AS COLUMN_DEFAULT, EXTRA AS EXTRA FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
      )
    )
    const row = rows[0]
    if (!row || row.COLUMN_DEFAULT == null) return null
    const v = String(row.COLUMN_DEFAULT)
    if (isMariaDb(knex)) return /^NULL$/i.test(v) ? null : { sql: v, bindings: [] }
    // A text literal kept as an expression default (a TEXT column's) reads `_utf8mb4\'req\'`.
    const charsetLiteral = /^_[a-z0-9]+\\'([\s\S]*)\\'$/i.exec(v)
    if (charsetLiteral) return { sql: '?', bindings: [charsetLiteral[1].replace(/\\'/g, "'")] }
    if (/DEFAULT_GENERATED/i.test(String(row.EXTRA ?? ''))) return { sql: `(${v})`, bindings: [] }
    return { sql: '?', bindings: [v] }
  }
  return null
}

/** Rename a column (Postgres / MySQL 8). */
export async function renameColumn(
  knex: Knex,
  table: string,
  from: string,
  to: string
): Promise<void> {
  await knex.raw(
    `ALTER TABLE ${qi(knex, table)} RENAME COLUMN ${qi(knex, from)} TO ${qi(knex, to)}`
  )
}

/** Rename a table (Postgres / MySQL). */
export async function renameTable(knex: Knex, from: string, to: string): Promise<void> {
  const d = sqlDialect(knex)
  await knex.raw(
    d === 'mysql'
      ? `RENAME TABLE ${qi(knex, from)} TO ${qi(knex, to)}`
      : `ALTER TABLE ${qi(knex, from)} RENAME TO ${qi(knex, to)}`
  )
}

/** True when an information_schema column row is a uuid column (uuid on Postgres, char(36) on MySQL, uniqueidentifier on SQL Server). */
export function isUuidColumn(dataType: unknown, maxLen?: unknown): boolean {
  const t = String(dataType ?? '').toLowerCase()
  if (t === 'uniqueidentifier' || t === 'uuid') return true
  return (t === 'char' || t === 'varchar') && Number(maxLen) === 36
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/**
 * A row read back from JSON (a snapshot, a content bundle) carries its timestamps as ISO text
 * ("2026-11-19T10:00:00.000Z"). SQL Server and Postgres accept that as a datetime value; MySQL
 * refuses the trailing Z, so on MySQL (and Postgres, harmlessly) they become Dates again. SQL
 * Server rows are returned untouched.
 */
export function reviveIsoDates(knex: Knex, row: Record<string, unknown>): Record<string, unknown> {
  if (sqlDialect(knex) === 'mssql') return row
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v
  }
  return out
}

/** SQLite: KB on disk per table (its pages plus its indexes'), from dbstat. */
async function sqliteTableKb(knex: Knex): Promise<Map<string, number>> {
  const rows = rawRows<{ name: string; kb: number }>(
    await knex.raw(
      `SELECT m.tbl_name AS name, SUM(s.pgsize) / 1024.0 AS kb
         FROM dbstat s JOIN sqlite_master m ON m.name = s.name
        WHERE m.tbl_name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        GROUP BY m.tbl_name`
    )
  )
  return new Map(rows.map((r) => [String(r.name), Number(r.kb) || 0]))
}
