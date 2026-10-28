import { db } from '../db/index.js'
import { accessSignature } from './ai-answer-cache.js'
import { createShortCache } from './short-cache.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Search item 24 — SQL Server full-text search where it exists, plus a short
 * per-person answer cache for the global search.
 *
 * A contains-LIKE (`col LIKE '%x%'`) reads every row: fine on a few thousand
 * rows, seconds on a wide table with long text. Where a DBA has built a
 * full-text index, `CONTAINS(col, '"x*"')` answers from the index instead.
 * Nothing here ever CREATES an index — that is `scripts/search-fts.mjs
 * --execute`, run by hand (production is a replication publisher: DBA first).
 *
 * Differences callers must accept before switching a column to CONTAINS:
 *   - It matches word STARTS ("budg" finds "budget review"), not any substring
 *     ("123" does not find "ABC123"). Keep LIKE on id-like columns.
 *   - Every word must appear (AND), in any order, in any of the columns.
 *   - The index is updated asynchronously (change tracking AUTO): a row saved a
 *     moment ago may not be found yet.
 *
 * `ftsAvailable` / `ftsColumns` read sys.fulltext_indexes once per tenant per
 * 5 minutes (one query for every table); a database without full-text (or a
 * login that cannot read the catalog views) answers false — the LIKE path.
 */

const FTS_TTL_MS = 5 * 60_000
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_TERMS = 8
const MAX_TERM_CHARS = 100

/** Lower-cased table name → its full-text indexed columns (lower-cased). */
type FtsMap = Map<string, Set<string>>

const ftsCache = createShortCache<FtsMap>('search-fts', FTS_TTL_MS, { max: 500 })

async function loadFtsMap(): Promise<FtsMap> {
  const out: FtsMap = new Map()
  try {
    // Only enabled indexes whose first crawl finished: a half-populated index
    // answers "no match" for rows it has not read yet.
    const rows = (await db.raw(`
      SELECT t.name AS table_name, c.name AS column_name
      FROM sys.fulltext_indexes fi
      JOIN sys.tables t ON t.object_id = fi.object_id
      JOIN sys.fulltext_index_columns fic ON fic.object_id = fi.object_id
      JOIN sys.columns c ON c.object_id = fic.object_id AND c.column_id = fic.column_id
      WHERE fi.is_enabled = 1 AND fi.has_crawl_completed = 1
        AND SCHEMA_NAME(t.schema_id) = 'dbo'
    `)) as Array<{ table_name: string; column_name: string }>
    for (const r of Array.isArray(rows) ? rows : []) {
      const t = String(r.table_name).toLowerCase()
      const set = out.get(t) ?? new Set<string>()
      set.add(String(r.column_name).toLowerCase())
      out.set(t, set)
    }
  } catch {
    /* no full-text on this server, or no catalog permission: every answer is false */
  }
  return out
}

function ftsMap(): Promise<FtsMap> {
  return ftsCache.get(currentTenantKey() || '-', loadFtsMap)
}

/**
 * Whether `table` has an enabled, populated full-text index — and, when
 * `column` is given, whether every named column is in it.
 */
export async function ftsAvailable(table: string, column?: string | string[]): Promise<boolean> {
  if (!IDENT.test(table)) return false
  const cols = (await ftsMap()).get(table.toLowerCase())
  if (!cols || cols.size === 0) return false
  if (column == null) return true
  const want = Array.isArray(column) ? column : [column]
  return want.length > 0 && want.every((c) => cols.has(String(c).toLowerCase()))
}

/** The given columns that are full-text indexed on `table`, in the order given. */
export async function ftsColumns(table: string, columns: string[]): Promise<string[]> {
  if (!IDENT.test(table)) return []
  const cols = (await ftsMap()).get(table.toLowerCase())
  if (!cols) return []
  return columns.filter((c) => cols.has(c.toLowerCase()))
}

/** Drop the cached catalog (tests; after a script built an index in this process). */
export function forgetFtsCatalog(): void {
  ftsCache.forget()
}

/**
 * The CONTAINS search condition for what a person typed: each word becomes a
 * quoted prefix term (`"budg*"`), joined with AND. Double quotes are removed
 * (they would end the term) and a "word" with no letter or digit is dropped
 * (`-`, `&`), so the condition can never be a syntax error. Null when nothing
 * searchable is left.
 */
export function ftsSearchCondition(phrase: string): string | null {
  const words = String(phrase ?? '')
    .normalize('NFKC')
    .replace(/["“”]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/\*+$/, '').slice(0, MAX_TERM_CHARS).trim())
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
  const unique = [...new Set(words.map((w) => w.toLowerCase()))].slice(0, MAX_TERMS)
  if (unique.length === 0) return null
  return unique.map((w) => `"${w}*"`).join(' AND ')
}

/**
 * A safe `CONTAINS(...)` clause over `columns` for `phrase`, for knex
 * `whereRaw(sql, bindings)` / `db.raw`. The phrase only ever travels as a
 * bound parameter; column names must be plain identifiers (anything else
 * throws — a programming error, never user input). `alias` qualifies the
 * columns (`[w].[name]`). Null when there are no columns or no searchable
 * words — the caller keeps its LIKE.
 */
export function ftsCondition(
  columns: string[],
  phrase: string,
  opts: { alias?: string } = {}
): { sql: string; bindings: string[] } | null {
  const cols = [...new Set(columns)]
  if (cols.length === 0) return null
  for (const c of cols) if (!IDENT.test(c)) throw new Error(`Unsafe column name: ${c}`)
  if (opts.alias != null && !IDENT.test(opts.alias))
    throw new Error(`Unsafe table alias: ${opts.alias}`)
  const condition = ftsSearchCondition(phrase)
  if (!condition) return null
  const q = (c: string) => (opts.alias ? `[${opts.alias}].[${c}]` : `[${c}]`)
  const target = cols.length === 1 ? q(cols[0]) : `(${cols.map(q).join(', ')})`
  return { sql: `CONTAINS(${target}, ?)`, bindings: [condition] }
}

// ─── Global search answer cache ──────────────────────────────────────────────

const SEARCH_ANSWER_TTL_MS = 20_000

/** What a search answer is keyed on. Everything that makes two answers differ is in it. */
export interface SearchAnswerKeyInput {
  user: {
    id: unknown
    role?: unknown
    api_key_scopes?: unknown
    api_key_scope_restrictions?: unknown
    api_key_sandbox?: unknown
  }
  q: string
  /** Request options that change the answer (`labels=1`, a scope prefix…). */
  variant?: string | null
  /** x-workspace of the request. */
  workspace?: string | null
}

/** The query as two equal searches type it: trimmed, lower-case, single spaces. */
export function normalizeSearchQuery(q: string): string {
  return String(q ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * tenant | person | access signature (role, API-key scopes, sandbox) |
 * workspace | variant | normalized query. Per PERSON, not per role: row
 * filters may name $CURRENT_USER, User Scopes are per person and answers carry
 * "mine" flags — two people with one role can get different answers.
 */
export function searchAnswerKey(i: SearchAnswerKeyInput): string {
  return [
    currentTenantKey(),
    String(i.user.id ?? '').toUpperCase(),
    accessSignature(i.user),
    i.workspace ?? '',
    i.variant ?? '',
    normalizeSearchQuery(i.q)
  ].join('|')
}

const answerCache = createShortCache<unknown>('global-search-answer', SEARCH_ANSWER_TTL_MS, {
  max: 2000
})

/**
 * A 20-second answer cache for the global search (typing, retyping and the
 * palette's tab counts repeat one search many times), with single-flight:
 * concurrent identical searches share one run. Authorisation stays inside
 * `load` — only the computed answer is reused, and only by the same person
 * with the same access. A failed load is never remembered.
 *
 *   const data = await searchAnswerCache.get({ user, q, variant: labels ? 'labels' : '' },
 *     () => runSearch(...))
 */
export const searchAnswerCache = {
  get<T>(input: SearchAnswerKeyInput, load: () => Promise<T>): Promise<T> {
    return answerCache.get(searchAnswerKey(input), load) as Promise<T>
  },
  /** Drop everything (a synonym or search-config write that should show at once). */
  forget(): void {
    answerCache.forget()
  },
  size: (): number => answerCache.size()
}
