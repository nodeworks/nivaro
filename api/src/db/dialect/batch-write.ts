import type { Knex } from 'knex'
import { sqlDialect } from '../sql-dialect.js'

/**
 * Bounded UPDATE / DELETE batches ("blank or remove at most n rows"), for retention passes that
 * must never hold a lock for long. SQL Server has `UPDATE TOP (n)` / `DELETE TOP (n)`;
 * MySQL takes `LIMIT n` on the statement; Postgres has neither, so it picks the batch's ids in
 * a subquery.
 *
 * `where` and `set` are trusted SQL text with `?` bindings (the caller passes their bindings);
 * `where` must not name the table by alias. `idColumn` is the table's key (Postgres only).
 */
export function updateBatchSql(
  knex: Knex,
  table: string,
  set: string,
  where: string,
  n: number,
  idColumn = 'id'
): string {
  const d = sqlDialect(knex)
  const lim = Math.max(1, Math.floor(n))
  if (d === 'mssql') return `UPDATE TOP (${lim}) ${table} SET ${set} WHERE ${where}`
  if (d === 'mysql') return `UPDATE ${table} SET ${set} WHERE ${where} LIMIT ${lim}`
  return `UPDATE ${table} SET ${set} WHERE ${idColumn} IN (SELECT ${idColumn} FROM ${table} WHERE ${where} LIMIT ${lim})`
}

export function deleteBatchSql(
  knex: Knex,
  table: string,
  where: string,
  n: number,
  idColumn = 'id'
): string {
  const d = sqlDialect(knex)
  const lim = Math.max(1, Math.floor(n))
  if (d === 'mssql') return `DELETE TOP (${lim}) FROM ${table} WHERE ${where}`
  if (d === 'mysql') return `DELETE FROM ${table} WHERE ${where} LIMIT ${lim}`
  return `DELETE FROM ${table} WHERE ${idColumn} IN (SELECT ${idColumn} FROM ${table} WHERE ${where} LIMIT ${lim})`
}

/** Rows a raw INSERT / UPDATE / DELETE touched, whichever shape the driver answers in. */
export function affectedRows(res: unknown): number {
  if (typeof res === 'number') return res
  if (Array.isArray(res)) {
    const first = res[0]
    if (typeof first === 'number') return first
    if (first && typeof first === 'object' && 'affectedRows' in first)
      return Number((first as { affectedRows?: number }).affectedRows ?? 0) || 0
    return Number(first ?? 0) || 0
  }
  // SQLite (better-sqlite3) answers a raw write with { changes, lastInsertRowid }.
  const r = res as { rowCount?: number; affectedRows?: number; changes?: number } | null
  return Number(r?.rowCount ?? r?.affectedRows ?? r?.changes ?? 0) || 0
}
