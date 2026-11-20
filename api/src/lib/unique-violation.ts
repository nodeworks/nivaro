/**
 * True when a database refused a write because a unique key / unique index already holds the
 * value — on every database Nivaro runs on:
 *
 *   SQL Server  2627 (PRIMARY KEY / UNIQUE constraint), 2601 (unique index) — on the error, on its
 *               tedious `originalError(.info)`, or on one of an AggregateError's `errors[]`
 *   Postgres    SQLSTATE 23505 (unique_violation)
 *   MySQL / MariaDB  errno 1062 (ER_DUP_ENTRY)
 *   SQLite      SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT_PRIMARYKEY (better-sqlite3 `code`)
 *
 * No imports: safe for any module, tests included.
 */
export function isUniqueViolation(err: unknown): boolean {
  return check(err, 0)
}

const SQLITE_CODES = new Set(['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'])

function check(err: unknown, depth: number): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false
  const e = err as {
    number?: unknown
    code?: unknown
    errno?: unknown
    errors?: unknown
    originalError?: { number?: unknown; info?: { number?: unknown } }
    cause?: unknown
  }
  const n = e.number ?? e.originalError?.info?.number ?? e.originalError?.number
  if (n === 2627 || n === 2601) return true
  if (e.code === '23505') return true
  if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) return true
  if (typeof e.code === 'string' && SQLITE_CODES.has(e.code)) return true
  if (Array.isArray(e.errors) && e.errors.some((x) => check(x, depth + 1))) return true
  return e.cause != null && check(e.cause, depth + 1)
}
