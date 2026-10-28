import { likeEscape, likeStartsWith } from '../lib/filter-like.js'

/**
 * `?search_rank=1` on a list read (2026-10-28, search program item 20): a
 * `search` is a filter, not a ranking, and a catalog search for "1002"
 * returned whatever the sort put first — the item numbered exactly 1002 could
 * sit below 10021…10029. With the option, the matching rows order by how well
 * they match, then by the caller's own sort:
 *
 *   0 primary column equals the text · 1 another searched column equals it ·
 *   2 primary starts with it · 3 another starts with it · 4 every word starts
 *   a word of some searched column · 5 everything else the search matched.
 *
 * Only the ORDER changes — which rows match stays the caller's search, and the
 * columns are exactly the searched ones (already narrowed to the caller's
 * readable fields), so ordering never reads a hidden column. The primary column
 * is the first of the request's `search_fields`; without one, the first
 * searched field. Client twin: `searchRankTier` in packages/shared/src/lib/
 * search-text.ts — change both together.
 */

/** Words the tiers look at (the client twin uses the same cap). */
export const SEARCH_RANK_MAX_WORDS = 5
/** Searched columns the tiers look at (the first N in rank order). */
export const SEARCH_RANK_MAX_COLUMNS = 8

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Searched columns in rank order: the request's `search_fields` order first, the rest after. */
export function rankColumns(
  searchCols: string[],
  requested: string[] | null | undefined
): string[] {
  const order = new Map((requested ?? []).map((f, i) => [f, i]))
  return [...searchCols]
    .filter((c) => IDENT.test(c))
    .sort((a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6))
    .slice(0, SEARCH_RANK_MAX_COLUMNS)
}

/**
 * The ORDER BY expression + bindings (knex `orderByRaw`), or null for a blank
 * search / no columns. `mssql` picks the word-start pattern: T-SQL LIKE has
 * character classes (`%[^A-Za-z0-9]word%`); elsewhere a space before the word.
 */
export function searchRankOrder(
  search: string | null | undefined,
  columns: string[],
  opts: { table?: string; mssql?: boolean } = {}
): { sql: string; bindings: string[] } | null {
  const phrase = String(search ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const cols = columns.filter((c) => IDENT.test(c)).slice(0, SEARCH_RANK_MAX_COLUMNS)
  if (!phrase || cols.length === 0) return null
  const words: string[] = []
  for (const w of phrase.toLowerCase().split(' ')) {
    if (w && !words.includes(w)) words.push(w)
    if (words.length === SEARCH_RANK_MAX_WORDS) break
  }
  const mssql = opts.mssql !== false
  const table = opts.table && IDENT.test(opts.table) ? opts.table : null
  const [primary, ...rest] = cols
  const cases: string[] = []
  const bindings: string[] = []
  // Column references are knex identifier bindings (`??`), qualified by the
  // table when given — a relation sort may have joined a same-named column.
  const ref = table ? '??.??' : '??'
  const col = (c: string) => {
    if (table) bindings.push(table)
    bindings.push(c)
    return ref
  }
  // LIKE everywhere, also for "equals" (an escaped pattern with no wildcard):
  // `=` is refused on text/ntext columns, which a search may read.
  const cmp = (c: string, pattern: string) => {
    const sql = `${col(c)} LIKE ?`
    bindings.push(pattern)
    return sql
  }
  const exact = likeEscape(phrase)
  const prefix = likeStartsWith(phrase)
  cases.push(`WHEN ${cmp(primary, exact)} THEN 0`)
  if (rest.length) cases.push(`WHEN ${rest.map((c) => cmp(c, exact)).join(' OR ')} THEN 1`)
  cases.push(`WHEN ${cmp(primary, prefix)} THEN 2`)
  if (rest.length) cases.push(`WHEN ${rest.map((c) => cmp(c, prefix)).join(' OR ')} THEN 3`)
  const wordClauses = words.map((w) => {
    const inner = mssql ? `%[^A-Za-z0-9]${likeEscape(w)}%` : `% ${likeEscape(w)}%`
    const parts = cols.flatMap((c) => [cmp(c, likeStartsWith(w)), cmp(c, inner)])
    return `(${parts.join(' OR ')})`
  })
  cases.push(`WHEN ${wordClauses.join(' AND ')} THEN 4`)
  return { sql: `CASE ${cases.join(' ')} ELSE 5 END`, bindings }
}
