import type { Knex } from 'knex'
import { rawRows } from '../raw-rows.js'
import { qi, sqlDialect } from '../sql-dialect.js'

/**
 * Catalog reads that have a real equivalent on every database (the SQL Server forms stay where
 * they are, at their call sites; these answer for Postgres and MySQL).
 */

export interface ForeignKeyRow {
  /** The table holding the foreign key column. */
  table: string
  column: string
  /** The table it points at. */
  ref_table: string
  /** The database does not vouch for existing rows (a NOT VALID constraint). */
  untrusted: boolean
}

/**
 * Every single-column foreign key of the current schema / database (Postgres: pg_constraint;
 * MySQL: information_schema). Not for SQL Server — the callers keep their sys.foreign_keys read.
 */
export async function foreignKeysNonMssql(
  knex: Knex,
  opts: { referencedTable?: string } = {}
): Promise<ForeignKeyRow[]> {
  const d = sqlDialect(knex)
  if (d === 'mssql') return []
  let rows: Array<{ t: string; c: string; rt: string; nt: unknown }>
  if (d === 'pg') {
    rows = rawRows(
      await knex.raw(
        `SELECT cl.relname AS t, a.attname AS c, rcl.relname AS rt, (NOT con.convalidated) AS nt
           FROM pg_constraint con
           JOIN pg_class cl ON cl.oid = con.conrelid
           JOIN pg_class rcl ON rcl.oid = con.confrelid
           JOIN pg_namespace n ON n.oid = cl.relnamespace
           CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
          WHERE con.contype = 'f' AND n.nspname = current_schema()`
      )
    )
  } else {
    rows = rawRows(
      await knex.raw(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt, 0 AS nt
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`
      )
    )
  }
  return rows
    .filter((r) => !opts.referencedTable || r.rt === opts.referencedTable)
    .map((r) => ({
      table: String(r.t),
      column: String(r.c),
      ref_table: String(r.rt),
      untrusted: r.nt === true || r.nt === 1 || r.nt === '1'
    }))
}

/** Base table names of the current schema / database. */
export async function listBaseTables(knex: Knex): Promise<Set<string>> {
  const d = sqlDialect(knex)
  const where =
    d === 'pg'
      ? 'AND table_schema = current_schema()'
      : d === 'mysql'
        ? 'AND table_schema = DATABASE()'
        : ''
  const rows = rawRows<{ n: string }>(
    await knex.raw(
      `SELECT table_name AS n FROM information_schema.tables WHERE table_type = 'BASE TABLE' ${where}`
    )
  )
  return new Set(rows.map((r) => String(r.n)))
}

/** Column names of one table (INFORMATION_SCHEMA; the current schema / database off SQL Server). */
export async function listColumnNames(knex: Knex, table: string): Promise<string[]> {
  const d = sqlDialect(knex)
  if (d === 'mssql') {
    const rows = rawRows<{ COLUMN_NAME: string }>(
      await knex.raw(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`, [
        table
      ])
    )
    return rows.map((r) => r.COLUMN_NAME)
  }
  const schema = d === 'pg' ? 'current_schema()' : 'DATABASE()'
  const rows = rawRows<{ col: string }>(
    await knex.raw(
      `SELECT COLUMN_NAME AS col FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ${schema}`,
      [table]
    )
  )
  return rows.map((r) => r.col)
}

/**
 * Approximate row count from the catalog (no table read): SQL Server partition stats,
 * Postgres planner statistics, MySQL TABLE_ROWS. null when the catalog cannot say.
 */
export async function approxRowCount(knex: Knex, table: string): Promise<number | null> {
  const d = sqlDialect(knex)
  let sql: string
  if (d === 'mssql')
    sql = `SELECT SUM(row_count) AS n FROM sys.dm_db_partition_stats
       WHERE object_id = OBJECT_ID(?) AND index_id IN (0, 1)`
  else if (d === 'pg')
    sql = `SELECT n_live_tup AS n FROM pg_stat_user_tables WHERE relname = ? AND schemaname = current_schema()`
  else
    sql = `SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE()`
  const n = Number(rawRows<{ n?: unknown }>(await knex.raw(sql, [table]))[0]?.n)
  return Number.isFinite(n) ? n : null
}

/**
 * Postgres and MySQL estimate a table's rows from statistics that lag behind (a freshly written
 * small table reads 0 on MySQL). For tables the estimate calls small, count them for real — a
 * few quick statements — so "14 rows" never shows as none. SQL Server's partition counts are
 * exact and are returned as given. Mutates and returns `counts` (keys lower-case).
 */
export async function exactSmallCounts(
  knex: Knex,
  counts: Map<string, number>,
  opts: { below?: number; max?: number } = {}
): Promise<Map<string, number>> {
  if (sqlDialect(knex) === 'mssql') return counts
  const below = opts.below ?? 1000
  const small = [...counts.entries()]
    .filter(([name, n]) => n < below && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .slice(0, opts.max ?? 400)
    .map(([name]) => name)
  for (let i = 0; i < small.length; i += 40) {
    const part = small.slice(i, i + 40)
    const sql = part
      .map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${qi(knex, t)}`)
      .join(' UNION ALL ')
    try {
      for (const r of rawRows<{ t: string; n: number | string }>(await knex.raw(sql)))
        counts.set(String(r.t).toLowerCase(), Number(r.n) || 0)
    } catch {
      /* a table that vanished or cannot be read keeps its estimate */
    }
  }
  return counts
}
