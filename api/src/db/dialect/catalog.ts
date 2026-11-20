import type { Knex } from 'knex'
import { rawRows } from '../raw-rows.js'
import { sqlDialect } from '../sql-dialect.js'

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
