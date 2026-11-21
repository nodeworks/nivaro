/**
 * Runs once on every new MySQL / MariaDB connection.
 *
 * - `time_zone`: DATETIME defaults and NOW() agree with the UTC timestamps the API writes.
 * - `collation_connection`: tables take the database's default collation (MySQL 8:
 *   utf8mb4_0900_ai_ci), but mysql2 opens the connection as utf8mb4_unicode_ci. A CAST(... AS CHAR)
 *   or other string expression then carries the connection collation at the same coercibility as
 *   the column, and comparing the two fails: "Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT)
 *   and (utf8mb4_unicode_ci,IMPLICIT)". Matching the database's collation removes the clash on MySQL
 *   and MariaDB alike.
 */
export const MYSQL_SESSION_SQL =
  "SET time_zone = '+00:00', collation_connection = @@collation_database"

/** The part of a mysql2 column definition the type cast reads. */
export interface MysqlTypeCastField {
  type: string
  length: number
  /** The table (alias) the column comes from; '' for a computed value such as COUNT(*). */
  table?: string
  string: () => string | null
}

/**
 * mysql2 `typeCast` for every MySQL / MariaDB pool: a TINYINT(1) column — what knex creates for
 * `table.boolean()` — reads back as true / false, like SQL Server's bit and Postgres' boolean (the
 * driver would answer 0 / 1), a DECIMAL reads as a number and a BIGINT column as its digits (text).
 * NULL stays null; any other column type is the driver's own reading.
 * Writes are untouched: MySQL takes true / false and 1 / 0 alike.
 */
export function mysqlTypeCast(field: MysqlTypeCastField, next: () => unknown): unknown {
  if (field.type === 'TINY' && field.length === 1) {
    const v = field.string()
    return v == null ? null : Number(v) !== 0
  }
  // DECIMAL reads as a number, like SQL Server (tedious) — the driver would answer '12.50'.
  // SUM / AVG of whole numbers are DECIMAL on MySQL too.
  if (field.type === 'NEWDECIMAL' || field.type === 'DECIMAL') {
    const v = field.string()
    return v == null ? null : Number(v)
  }
  // A BIGINT column reads as its exact digits, like SQL Server (tedious) and Postgres — the driver
  // would answer a number and round anything past 2^53 (9007199254740993 read back ...992). A
  // computed BIGINT (COUNT(*), no table) stays the driver's number, like SQL Server's int COUNT.
  if (field.type === 'LONGLONG' && field.table) return field.string()
  return next()
}
