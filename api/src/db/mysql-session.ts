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
