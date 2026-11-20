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

// ── Column / routine / size reads (staged imports, import procedures, staging purge) ──

/**
 * Catalog reads with a Postgres / MySQL twin of the SQL Server `sys.*` read the callers used
 * (staged imports, import procedures, staging purge). SQL Server text is unchanged where a
 * caller keeps its own; these are for the other two databases unless they say otherwise.
 * Postgres reads the schemas on the search path; MySQL the current database.
 */

export interface CatalogColumn {
  name: string
  isIdentity: boolean
  isComputed: boolean
}

/** A table's columns in order, with identity (serial / auto_increment) and generated flags. */
export async function describeColumns(knex: Knex, table: string): Promise<CatalogColumn[]> {
  const d = sqlDialect(knex)
  let rows: Array<{ name: string; is_identity: unknown; is_computed: unknown }>
  if (d === 'pg') {
    rows = rawRows(
      await knex.raw(
        `SELECT c.column_name AS name,
                (c.is_identity = 'YES' OR COALESCE(c.column_default, '') LIKE 'nextval(%') AS is_identity,
                (c.is_generated = 'ALWAYS') AS is_computed
           FROM information_schema.columns c
          WHERE c.table_schema = ANY (current_schemas(false)) AND c.table_name = ?
          ORDER BY c.ordinal_position`,
        [table]
      )
    )
  } else if (d === 'mysql') {
    rows = rawRows(
      await knex.raw(
        `SELECT c.COLUMN_NAME AS name,
                (c.EXTRA LIKE '%auto_increment%') AS is_identity,
                (c.EXTRA LIKE '%GENERATED%') AS is_computed
           FROM information_schema.COLUMNS c
          WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ?
          ORDER BY c.ORDINAL_POSITION`,
        [table]
      )
    )
  } else {
    rows = rawRows(
      await knex.raw(
        `SELECT c.name, c.is_identity, c.is_computed
           FROM sys.columns c
          WHERE c.object_id = OBJECT_ID(?)
          ORDER BY c.column_id`,
        [table]
      )
    )
  }
  return rows.map((r) => ({
    name: String(r.name),
    isIdentity: r.is_identity === true || Number(r.is_identity) === 1,
    isComputed: r.is_computed === true || Number(r.is_computed) === 1
  }))
}

/** Lower-cased column names of a table ('' table = none). */
export async function columnNames(knex: Knex, table: string): Promise<string[]> {
  return (await describeColumns(knex, table)).map((c) => c.name)
}

/**
 * A stored routine's body by name (last name part, case-insensitive), or null: Postgres
 * `pg_proc.prosrc`, MySQL `information_schema.ROUTINES.ROUTINE_DEFINITION`. SQL Server callers
 * keep OBJECT_DEFINITION.
 */
export async function routineDefinition(knex: Knex, name: string): Promise<string | null> {
  const d = sqlDialect(knex)
  const bare =
    String(name)
      .split('.')
      .pop()
      ?.replace(/^[[`"]|[\]`"]$/g, '') ?? ''
  if (!bare) return null
  if (d === 'pg') {
    const rows = rawRows<{ def: string | null }>(
      await knex.raw(
        `SELECT p.prosrc AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE lower(p.proname) = lower(?) AND n.nspname = ANY (current_schemas(false))
          LIMIT 1`,
        [bare]
      )
    )
    return rows[0]?.def ?? null
  }
  if (d === 'mysql') {
    const rows = rawRows<{ def: string | null }>(
      await knex.raw(
        `SELECT ROUTINE_DEFINITION AS def FROM information_schema.ROUTINES
          WHERE ROUTINE_SCHEMA = DATABASE() AND LOWER(ROUTINE_NAME) = LOWER(?)
          LIMIT 1`,
        [bare]
      )
    )
    return rows[0]?.def ?? null
  }
  const rows = rawRows<{ def: string | null }>(
    await knex.raw('SELECT OBJECT_DEFINITION(OBJECT_ID(?)) AS def', [name])
  )
  return rows[0]?.def ?? null
}

/**
 * Size on disk (KB) of each named table that exists, keyed by lower-cased name: Postgres
 * pg_total_relation_size, MySQL DATA_LENGTH + INDEX_LENGTH. Row counts are the caller's
 * (an exact COUNT: the estimates both keep can say 0 for a table that has rows). SQL Server
 * callers keep their sys.dm_db_partition_stats read.
 */
export async function tableSizesKb(knex: Knex, tables: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!tables.length) return out
  const d = sqlDialect(knex)
  const marks = tables.map(() => '?').join(', ')
  const lower = tables.map((t) => t.toLowerCase())
  let rows: Array<{ name: string; kb: unknown }> = []
  if (d === 'pg') {
    rows = rawRows(
      await knex.raw(
        `SELECT c.relname AS name, pg_total_relation_size(c.oid) / 1024 AS kb
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY (current_schemas(false))
            AND lower(c.relname) IN (${marks})`,
        lower
      )
    )
  } else if (d === 'mysql') {
    rows = rawRows(
      await knex.raw(
        `SELECT TABLE_NAME AS name, ROUND((COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) / 1024) AS kb
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND LOWER(TABLE_NAME) IN (${marks})`,
        lower
      )
    )
  }
  for (const r of rows) out.set(String(r.name).toLowerCase(), Number(r.kb) || 0)
  return out
}
