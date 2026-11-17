/**
 * A list page ordered by id with a long `_in` id list on another column runs without SQL
 * Server's row goal.
 *
 * `TOP n … WHERE fk IN (250 ids) ORDER BY id` lets the optimizer assume the n matches turn
 * up early in id order, so it may walk the whole clustered index testing every row against
 * the list instead of seeking the fk index and sorting the few matches. Which plan a cached
 * statement gets depends on the ids it was first compiled with: prod 2026-11-17, the Forecast
 * export's invoice join (`purchase_order _in [250 PO ids]`, sort=id) cached the scan (est.
 * 71,015 rows with the row goal, 901,418 read) and every chunk after it took 1.4–1.8 s in SQL
 * (3–6 s per request) instead of ~0.3 s. Same rows, same order, same gates — only the plan.
 *
 * Narrow on purpose: a short `_in` (a person's filter of two statuses) can match half a table,
 * where the row goal's early stop in id order is the right plan.
 */

/** From this many values an `_in` is an id list (the same line whereInList switches at). */
export const ROW_GOAL_IN_MIN = 50

const HINT = " OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))"

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The plain column a filter holds a long `_in` list on (top level or a top-level `_and`). */
export function longInListColumn(
  filter: Record<string, unknown> | null | undefined
): string | null {
  if (!isRecord(filter)) return null
  for (const [key, val] of Object.entries(filter)) {
    if (key === '_and' && Array.isArray(val)) {
      for (const part of val) {
        const hit = longInListColumn(part as Record<string, unknown>)
        if (hit) return hit
      }
      continue
    }
    // `_or` / `_not` / relation hops (`project: {name: {_in}}`) are not a plain list on a column.
    if (key.startsWith('_') || key.toLowerCase() === 'id' || !isRecord(val)) continue
    const list = val._in
    if (Array.isArray(list) && list.length >= ROW_GOAL_IN_MIN) return key
  }
  return null
}

/** The page is ordered by the primary key alone (explicitly, or by default). */
export function sortsByIdOnly(sort: string[], pkOrder: boolean): boolean {
  if (sort.length === 0) return pkOrder
  return sort.length === 1 && /^-?id$/i.test(sort[0].trim())
}

/** SQL Server only — the caller adds that check (the hint is T-SQL). */
export function dropsRowGoal(a: {
  sort: string[]
  pkOrder: boolean
  filter: Record<string, unknown>
  search?: string | null
  keyset?: boolean
  labelLookup?: boolean
}): boolean {
  if (a.search || a.keyset || a.labelLookup) return false
  return sortsByIdOnly(a.sort, a.pkOrder) && longInListColumn(a.filter) !== null
}

/**
 * The compiled page statement with the hint, or null when it cannot be re-run as raw SQL
 * safely (a literal `?` would be read as a binding, or it already has an OPTION clause) —
 * the caller then runs it as built.
 */
export function withoutRowGoal(
  sql: string,
  bindings: readonly unknown[]
): { sql: string; bindings: unknown[] } | null {
  if (/\boption\s*\(/i.test(sql)) return null
  // Compiled SQL carries one `?` per binding and no identifier `??`: any other `?` is literal.
  if ((sql.match(/\?/g) ?? []).length !== bindings.length) return null
  return { sql: `${sql}${HINT}`, bindings: [...bindings] }
}
