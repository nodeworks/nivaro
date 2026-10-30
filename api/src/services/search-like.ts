/**
 * Contains-search predicates that cost a third of a plain LIKE on SQL Server.
 *
 * A `[col] LIKE N'%x%'` over an nvarchar column compares every character under
 * the database's Unicode collation rules (SQL_Latin1_General_CP1_CI_AS on EFP):
 * ~1 s for the 85k-row EFP workflows table over its five nvarchar search columns.
 * The same scan in a BINARY collation over the upper-cased value is ~3x cheaper
 * (0.35 s) and, for a pattern of plain printable ASCII, finds the same rows:
 * among printable ASCII the only case-insensitive equivalences are the letter
 * case pairs, which UPPER folds (checked on the server, 2026-10-30, plus 1,440
 * real term × column comparisons on EFP_Staging with no difference). A value
 * can only differ through characters outside ASCII that the Unicode rules fold
 * onto ASCII letters — ligatures and expansions (æ = ae, ß = ss), full-width
 * letters, zero-weight characters — none of which a typed ASCII search is
 * written for.
 *
 * - nvarchar / nchar column + plain-ASCII text → `UPPER(col) COLLATE BIN2 LIKE ?`
 * - varchar / char column + plain-ASCII text → the pattern bound as varchar, so the
 *   column is not converted to nvarchar row by row (the list search's long-standing
 *   form, lib/filter-like.ts varcharSafePattern)
 * - anything else (non-ASCII text, an unknown or LOB `text`/`ntext` type, other
 *   dialects) → the plain LIKE, unchanged.
 *
 * The pattern is always BOUND; only the column reference (already quoted by the
 * caller) is placed in the SQL.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { isMssql } from '../db/index.js'

export const BINARY_COLLATION = 'Latin1_General_100_BIN2'

/** SQL Server? (false where the db module is stubbed without it — unit tests.) */
export function onMssql(): boolean {
  try {
    return isMssql()
  } catch {
    return false
  }
}

/** Printable ASCII only — the patterns the binary form answers exactly. */
const PLAIN_ASCII = /^[\x20-\x7e]*$/

const UNICODE_TYPES = new Set(['nvarchar', 'nchar'])
const NON_UNICODE_TYPES = new Set(['varchar', 'char'])

/** How a column's text compares: by its SQL type name (information_schema DATA_TYPE). */
export type TextKind = 'unicode' | 'ansi' | 'other'

export function textKindOf(dataType: string | null | undefined): TextKind {
  const t = String(dataType ?? '').toLowerCase()
  if (UNICODE_TYPES.has(t)) return 'unicode'
  if (NON_UNICODE_TYPES.has(t)) return 'ansi'
  return 'other'
}

export interface LikeSql {
  sql: string
  bindings: string[]
}

/**
 * `col LIKE pattern` in its cheapest exact-enough form. `pattern` is the full LIKE
 * pattern, already escaped by the caller (`%…%`); `escape` the ESCAPE character the
 * caller's escaping used (null = bracket escaping, no ESCAPE clause).
 */
export function fastLike(
  colSql: string,
  pattern: string,
  kind: TextKind,
  opts: { escape?: string | null; mssql?: boolean } = {}
): LikeSql {
  const esc = opts.escape ? ` ESCAPE '${opts.escape === "'" ? "''" : opts.escape}'` : ''
  const plain = (): LikeSql => ({ sql: `${colSql} LIKE ?${esc}`, bindings: [pattern] })
  if (opts.mssql === false) return plain()
  if (pattern.length > 4000 || !PLAIN_ASCII.test(pattern)) return plain()
  if (kind === 'unicode')
    return {
      sql: `UPPER(${colSql}) COLLATE ${BINARY_COLLATION} LIKE ?${esc}`,
      bindings: [pattern.toUpperCase()]
    }
  if (kind === 'ansi')
    return { sql: `${colSql} LIKE CAST(? AS varchar(4000))${esc}`, bindings: [pattern] }
  return plain()
}

/**
 * `col = value` bound in the column's own string type: an nvarchar value against a
 * varchar column converts the COLUMN on every row, so an index on it can never be
 * sought (SQL collations) — the exact-id pass scanned `workflows.workflow_id` for it.
 */
export function typedEquals(
  colSql: string,
  value: string,
  kind: TextKind,
  opts: { indexed?: boolean; mssql?: boolean } = {}
): LikeSql {
  const plainAscii = value.length <= 4000 && PLAIN_ASCII.test(value)
  if (opts.mssql === false || !plainAscii) return { sql: `${colSql} = ?`, bindings: [value] }
  if (kind === 'ansi') return { sql: `${colSql} = CAST(? AS varchar(4000))`, bindings: [value] }
  // No index to seek: the scan compares in the binary collation (see fastLike).
  if (kind === 'unicode' && opts.indexed === false)
    return {
      sql: `UPPER(${colSql}) COLLATE ${BINARY_COLLATION} = ?`,
      bindings: [value.toUpperCase()]
    }
  return { sql: `${colSql} = ?`, bindings: [value] }
}

/**
 * Search-only `_contains`: inside `withFastContains`, the items service compiles a
 * `_contains` filter on a column named here through `fastLike` instead of the plain
 * LIKE. Global search's tab endpoints (/counts, /records) read through the general
 * filter path; this gives them the cheap match without changing `_contains` for any
 * other caller (a list filter, a policy, a rule). Keys are collection → column → kind
 * (the search plan's own column types); a column not named keeps the plain LIKE.
 */
const fastContainsStore = new AsyncLocalStorage<Map<string, Record<string, TextKind>>>()

export function withFastContains<T>(
  kinds: Map<string, Record<string, TextKind>>,
  fn: () => Promise<T>
): Promise<T> {
  return fastContainsStore.run(kinds, fn)
}

/** The text kind of `column` on `collection` when a search asked for the fast form, else null. */
export function fastContainsKind(collection: string | null, column: string): TextKind | null {
  if (!collection) return null
  const kinds = fastContainsStore.getStore()?.get(collection)
  if (!kinds) return null
  const bare = column.startsWith(`${collection}.`) ? column.slice(collection.length + 1) : column
  if (bare.includes('.')) return null
  const kind = kinds[bare]
  return kind === 'unicode' || kind === 'ansi' ? kind : null
}
