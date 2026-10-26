import { likeStartsWith } from '../lib/filter-like.js'

/**
 * People pickers rank a search by how a person is NAMED (2026-10-26): "Sam Pat" listed whoever
 * the table returned first (any text column matched — a department, an office, an email
 * fragment) with Sam Patel somewhere down the list. Full-name prefix first, then a first- or
 * last-name prefix, then an email prefix, then everything else the search matched; name order
 * breaks ties. Only the ORDER changes — which rows match stays the caller's search.
 *
 * Returns the ORDER BY expressions + bindings (knex `orderByRaw`), or null for a blank search.
 */
export function peopleSearchOrder(search: string | null | undefined): {
  sql: string
  bindings: string[]
} | null {
  const words = String(search ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return null
  const [first, ...rest] = words
  const cases: string[] = []
  const bindings: string[] = []
  if (rest.length > 0) {
    cases.push('WHEN first_name LIKE ? AND last_name LIKE ? THEN 0')
    bindings.push(likeStartsWith(first), likeStartsWith(rest.join(' ')))
  }
  cases.push('WHEN first_name LIKE ? THEN 1', 'WHEN last_name LIKE ? THEN 2')
  bindings.push(likeStartsWith(first), likeStartsWith(first))
  cases.push('WHEN email LIKE ? THEN 3')
  bindings.push(likeStartsWith(first))
  return {
    sql: `CASE ${cases.join(' ')} ELSE 4 END, first_name, last_name`,
    bindings
  }
}

/** Apply {@link peopleSearchOrder} to a nivaro_users query (no-op for a blank search). */
export function orderByPeopleRelevance(
  qb: { orderByRaw: (sql: string, bindings: string[]) => unknown },
  search: string | null | undefined
): boolean {
  const order = peopleSearchOrder(search)
  if (!order) return false
  qb.orderByRaw(order.sql, order.bindings)
  return true
}
