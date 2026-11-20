import { dialectOf } from '../db/dialect/items-query.js'
import type { SqlDialect } from '../db/sql-dialect.js'

/**
 * LIKE pattern pieces for filter text. In T-SQL `%` and `_` are wildcards and
 * `[...]` is a character class, so a `_contains` value of "[ARMY TEST]" matched
 * nothing and "100%" / "a_b" matched unrelated rows. Bracketing a special
 * character makes it literal; `]` alone is already literal.
 *
 * Postgres and MySQL have no character classes in LIKE (`[` is literal) and
 * escape with a backslash by default (no ESCAPE clause needed), so there the
 * wildcards and the backslash itself are backslash-escaped. The dialect is the
 * one this request queries on unless the caller names it.
 */
export function likeEscape(value: unknown, dialect: SqlDialect = dialectOf()): string {
  const s = String(value ?? '')
  if (dialect !== 'mssql') return s.replace(/[\\%_]/g, (c) => `\\${c}`)
  return s.replace(/[%_[]/g, (c) => `[${c}]`)
}

export const likeContains = (value: unknown, dialect?: SqlDialect) =>
  `%${likeEscape(value, dialect)}%`
export const likeStartsWith = (value: unknown, dialect?: SqlDialect) =>
  `${likeEscape(value, dialect)}%`
export const likeEndsWith = (value: unknown, dialect?: SqlDialect) =>
  `%${likeEscape(value, dialect)}`

/**
 * A search pattern that may be bound as varchar against a varchar column.
 * The driver binds every string as nvarchar, and comparing a varchar column
 * with an nvarchar value converts the COLUMN for every row (Unicode rules,
 * ~3x slower on a scan: the EFP workflows search 1.2 s → 0.4 s on 85k rows).
 * Only plain printable ASCII is safe: anything else might not exist in the
 * column's code page, and the cast would turn it into a literal '?'.
 */
export function varcharSafePattern(pattern: string): boolean {
  return pattern.length <= 4000 && /^[\x20-\x7e]*$/.test(pattern)
}
