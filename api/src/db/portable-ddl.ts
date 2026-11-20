import type { Knex } from 'knex'
import { isMssql } from './dialect.js'

/**
 * Schema helpers for migrations that must run on SQL Server, Postgres and MySQL.
 *
 * SQL Server keeps exactly what the migrations always did (a migration calls these only in its
 * non-SQL-Server branch, or a helper's SQL Server branch is the original statement), so a
 * database that already ran a migration and a fresh SQL Server install end up the same.
 */

type Dialect = 'mssql' | 'pg' | 'mysql' | 'sqlite'

export function dialectOf(knex: Knex): Dialect {
  const c = String((knex as any)?.client?.config?.client ?? '')
  if (c === 'mssql') return 'mssql'
  if (c === 'pg' || c === 'postgres' || c === 'postgresql') return 'pg'
  if (c === 'better-sqlite3' || c === 'sqlite3' || c === 'sqlite') return 'sqlite'
  return 'mysql'
}

/** A long text column (JSON, notes): nvarchar(max) on SQL Server, text on Postgres, longtext on MySQL. */
export function longText(
  t: Knex.CreateTableBuilder | Knex.AlterTableBuilder,
  knex: Knex,
  name: string
): Knex.ColumnBuilder {
  return isMssql(knex) ? t.specificType(name, 'nvarchar(max)') : t.text(name, 'longtext')
}

/** The long text type name for raw DDL. */
export function longTextType(knex: Knex): string {
  const d = dialectOf(knex)
  if (d === 'sqlite') return 'text'
  return d === 'mssql' ? 'nvarchar(max)' : d === 'pg' ? 'text' : 'longtext'
}

/** Quote an identifier for the active dialect. */
export function qid(knex: Knex, name: string): string {
  const d = dialectOf(knex)
  if (d === 'sqlite') return `"${name.replace(/"/g, '""')}"`
  if (d === 'mysql') return `\`${name.replace(/`/g, '``')}\``
  if (d === 'pg') return `"${name.replace(/"/g, '""')}"`
  return `[${name.replace(/]/g, ']]')}]`
}

interface IndexInfo {
  name: string
  unique: boolean
  primary: boolean
  columns: string[]
}

/** The indexes on a table (Postgres / MySQL), with their key columns in order. */
export async function listIndexes(knex: Knex, table: string): Promise<IndexInfo[]> {
  const d = dialectOf(knex)
  if (d === 'pg') {
    const rows = (
      await knex.raw(
        `SELECT i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS prim, a.attname AS col, k.ord
           FROM pg_class t
           JOIN pg_index ix ON ix.indrelid = t.oid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
          WHERE t.relname = ? AND t.relkind = 'r' AND pg_table_is_visible(t.oid)
          ORDER BY i.relname, k.ord`,
        [table]
      )
    ).rows as Array<{ name: string; uniq: boolean; prim: boolean; col: string }>
    return group(rows.map((r) => ({ name: r.name, unique: r.uniq, primary: r.prim, col: r.col })))
  }
  if (d === 'sqlite') {
    const rows = (await knex.raw(
      `SELECT il.name AS name, il."unique" AS uniq, il.origin AS origin, ii.name AS col
         FROM pragma_index_list(?) il
         JOIN pragma_index_info(il.name) ii
        ORDER BY il.name, ii.seqno`,
      [table]
    )) as Array<{ name: string; uniq: number; origin: string; col: string | null }>
    return group(
      rows.map((r) => ({
        name: r.name,
        unique: Number(r.uniq) === 1,
        primary: r.origin === 'pk',
        col: r.col ?? ''
      }))
    )
  }
  if (d === 'mysql') {
    const [rows] = (await knex.raw(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonu, COLUMN_NAME AS col, SEQ_IN_INDEX AS ord
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [table]
    )) as unknown as [Array<{ name: string; nonu: number; col: string }>]
    return group(
      rows.map((r) => ({
        name: r.name,
        unique: Number(r.nonu) === 0,
        primary: r.name === 'PRIMARY',
        col: r.col
      }))
    )
  }
  throw new Error('listIndexes: SQL Server migrations keep their own catalog SQL')
}

function group(
  rows: Array<{ name: string; unique: boolean; primary: boolean; col: string }>
): IndexInfo[] {
  const by = new Map<string, IndexInfo>()
  for (const r of rows) {
    const cur = by.get(r.name) ?? {
      name: r.name,
      unique: r.unique,
      primary: r.primary,
      columns: []
    }
    cur.columns.push(r.col)
    by.set(r.name, cur)
  }
  return [...by.values()]
}

/**
 * Drop (Postgres / MySQL) every non-primary index on `table` whose key columns are exactly
 * `columns` (any order). `unique` limits it to unique or non-unique ones. A unique constraint
 * on Postgres is dropped as a constraint (its index goes with it).
 */
export async function dropIndexesOn(
  knex: Knex,
  table: string,
  columns: string[],
  opts: { unique?: boolean } = {}
): Promise<string[]> {
  const want = [...columns]
    .map((c) => c.toLowerCase())
    .sort()
    .join(',')
  const hits = (await listIndexes(knex, table)).filter(
    (i) =>
      !i.primary &&
      (opts.unique == null || i.unique === opts.unique) &&
      [...i.columns]
        .map((c) => c.toLowerCase())
        .sort()
        .join(',') === want
  )
  for (const i of hits) await dropIndexByName(knex, table, i.name)
  return hits.map((i) => i.name)
}

/** Drop one index by name (Postgres / MySQL); a Postgres constraint-backed index drops its constraint. */
export async function dropIndexByName(knex: Knex, table: string, name: string): Promise<void> {
  const d = dialectOf(knex)
  if (d === 'pg') {
    const con = (
      await knex.raw(
        `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = ? AND c.conname = ? AND pg_table_is_visible(t.oid)`,
        [table, name]
      )
    ).rows as unknown[]
    if (con.length)
      await knex.raw(`ALTER TABLE ${qid(knex, table)} DROP CONSTRAINT ${qid(knex, name)}`)
    else await knex.raw(`DROP INDEX IF EXISTS ${qid(knex, name)}`)
    return
  }
  if (d === 'sqlite') {
    await knex.raw(`DROP INDEX IF EXISTS ${qid(knex, name)}`)
    return
  }
  if (d === 'mysql') {
    const drop = () => knex.raw(`ALTER TABLE ${qid(knex, table)} DROP INDEX ${qid(knex, name)}`)
    try {
      await drop()
    } catch (err) {
      // 1553: a foreign key relies on this index (MySQL needs an index leading with the FK
      // column; SQL Server and Postgres do not). Give the FK its own index, then drop.
      if ((err as { errno?: number }).errno !== 1553) throw err
      const lead = (await listIndexes(knex, table)).find((i) => i.name === name)?.columns[0]
      if (!lead) throw err
      await knex.raw(
        `CREATE INDEX ${qid(knex, `${table}_${lead}_fk`.slice(0, 64))} ON ${qid(knex, table)} (${qid(knex, lead)})`
      )
      await drop()
    }
    return
  }
  throw new Error('dropIndexByName: SQL Server migrations keep their own catalog SQL')
}

/** True when an index of this name exists on the table (any dialect). */
export async function indexExists(knex: Knex, table: string, name: string): Promise<boolean> {
  const d = dialectOf(knex)
  if (d === 'mssql') {
    const r = (await knex.raw(
      'SELECT 1 AS x FROM sys.indexes WHERE name = ? AND object_id = OBJECT_ID(?)',
      [name, table]
    )) as unknown[]
    return r.length > 0
  }
  return (await listIndexes(knex, table)).some((i) => i.name.toLowerCase() === name.toLowerCase())
}

/**
 * Create an index unless one of that name exists (Postgres / MySQL). Postgres keeps INCLUDE
 * columns and a WHERE filter; MySQL has neither, so it gets the key columns only. SQL Server
 * migrations keep their own CREATE INDEX text.
 */
export async function ensureIndex(knex: Knex, spec: IndexSpec): Promise<void> {
  const d = dialectOf(knex)
  if (d === 'mssql')
    throw new Error('ensureIndex: SQL Server migrations keep their own CREATE INDEX')
  if (await indexExists(knex, spec.table, spec.name)) return
  const cols = spec.columns.map((c) => {
    const m = /^(\S+)(\s+(ASC|DESC))?$/i.exec(c.trim())
    return m ? `${qid(knex, m[1])}${m[2] ?? ''}` : c
  })
  let sql = `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX ${qid(knex, spec.name)} ON ${qid(knex, spec.table)} (${cols.join(', ')})`
  if (d === 'pg') {
    if (spec.include?.length)
      sql += ` INCLUDE (${spec.include.map((c) => qid(knex, c)).join(', ')})`
    if (spec.where) sql += ` WHERE ${spec.where}`
  }
  // SQLite keeps the WHERE filter (a partial index); it has no INCLUDE, nor N'…' literals.
  if (d === 'sqlite' && spec.where) sql += ` WHERE ${spec.where.replace(/\bN'/g, "'")}`
  await knex.raw(sql)
}

const TSQL_INDEX =
  /^\s*(?:IF\b[\s\S]*?(?=\bCREATE\s))?CREATE\s+(UNIQUE\s+)?(?:NON)?(?:CLUSTERED\s+)?INDEX\s+\[?(\w+)\]?\s+ON\s+(?:\[?dbo\]?\.)?\[?(\w+)\]?\s*\(([^)]*)\)(?:\s*INCLUDE\s*\(([^)]*)\))?(?:\s*WHERE\s+([\s\S]*?))?(?:\s*WITH\s*\([^)]*\))?\s*;?\s*$/i

const cols = (s: string) =>
  s
    .split(',')
    .map((c) => c.trim().replace(/\[(\w+)\]/g, '$1'))
    .filter(Boolean)

/**
 * Build, on Postgres / MySQL, the index a T-SQL `[IF NOT EXISTS (… sys.indexes …)] CREATE INDEX
 * … [INCLUDE (…)] [WHERE …]` statement describes. Throws on text it cannot read, so nothing is
 * skipped silently.
 */
export async function createIndexFromTsql(knex: Knex, sql: string): Promise<void> {
  await ensureIndex(knex, parseTsqlIndex(sql))
}

export interface IndexSpec {
  name: string
  table: string
  columns: string[]
  unique?: boolean
  include?: string[]
  where?: string
}

/** Read a T-SQL CREATE INDEX statement (optionally behind an IF … guard). Pure; throws when it is not one. */
export function parseTsqlIndex(sql: string): IndexSpec {
  const m = TSQL_INDEX.exec(sql)
  if (!m) throw new Error(`createIndexFromTsql: not a CREATE INDEX statement: ${sql.slice(0, 120)}`)
  return {
    name: m[2],
    table: m[3],
    columns: cols(m[4]),
    unique: !!m[1],
    include: m[5] ? cols(m[5]) : undefined,
    where: m[6]
      ? m[6]
          .replace(/\[(\w+)\]/g, '$1')
          .replace(/\s+/g, ' ')
          .trim()
      : undefined
  }
}
