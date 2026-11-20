import { VIEW_AS_MOVE_ACTION } from './activity-filters.js'

/**
 * The activity feed's page of ids on SQL Server: one branch per collection, each seeking that
 * collection's records, then the newest `limit` of them all.
 *
 * Prod 2026-11-19 (POST /api/activity/feed, Project 360 of project 7775, 503 after 15 s): the
 * feed read `TOP 30 … WHERE (collection = A AND item IN OPENJSON(…)) OR (collection = B AND …)
 * ORDER BY id DESC` — OPENJSON lists OR'd into one predicate under a row-goal plan. SQL Server
 * walked the activity clustered index backwards re-parsing every JSON list for each row (14.4 s
 * of CPU on 7,853 pages) and would have needed ~5.6M rows to find 30 matches. Per-collection
 * branches seek `ix_nivaro_activity_collection_item`; the row-goal hint keeps the optimizer
 * from betting on an early stop in id order. The lists are always OPENJSON and the branches go
 * in collection-name order, so the statement text — and its cached plan — depends only on how
 * many collections the feed covers.
 *
 * Same rows as the builder it replaces: `action` not 'read' and not a View-as move row (a null
 * action was never listed — `NOT action = 'read'` drops it), optional `id < before`.
 */
export function feedPageIdsSql(
  groups: ReadonlyMap<string, readonly string[]>,
  opts: { limit: number; before?: number | null }
): { sql: string; bindings: unknown[] } | null {
  const entries = [...groups.entries()]
    .filter(([, ids]) => ids.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (entries.length === 0) return null
  const limit = Math.max(1, Math.floor(opts.limit))
  const before = opts.before != null && Number.isFinite(opts.before) ? opts.before : null
  const bindings: unknown[] = [limit]
  const branches = entries.map(([collection, ids], i) => {
    bindings.push(limit, 'read', VIEW_AS_MOVE_ACTION, collection, JSON.stringify(ids.map(String)))
    if (before != null) bindings.push(before)
    return (
      `SELECT [id] FROM (SELECT TOP (?) [a].[id] FROM [nivaro_activity] AS [a] WITH (NOLOCK)` +
      ` WHERE [a].[action] <> ? AND [a].[action] <> ? AND [a].[collection] = ?` +
      ` AND [a].[item] IN (SELECT [value] FROM OPENJSON(?))` +
      (before != null ? ' AND [a].[id] < ?' : '') +
      ` ORDER BY [a].[id] DESC) AS [b${i}]`
    )
  })
  return {
    sql:
      `SELECT TOP (?) [u].[id] FROM (${branches.join(' UNION ALL ')}) AS [u]` +
      ` ORDER BY [u].[id] DESC OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))`,
    bindings
  }
}
