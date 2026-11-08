/**
 * ix_nivaro_activity_action_timestamp — nivaro_activity (action, timestamp DESC, id DESC).
 *
 * Serves the activity log filtered by action: GET /api/activity?action=… (newest page + its
 * count), the audit report's action filter, `select distinct item where action = ? and
 * timestamp >= ?` reads and the narrow COUNT behind `exclude_actions`. Without it an action
 * filter on its own walks the (timestamp, id) index newest-first with a key lookup per row to
 * test the action — every one of ~13M rows when the action is rare (`access-request`: 15 s,
 * cancelled, army 9) — and its count scans the 1.2 GB (collection, action, timestamp) index.
 *
 * NOT a migration: SQL Server Standard builds indexes offline, so every write to
 * nivaro_activity (every item save logs a row) waits for the whole build — tens of seconds at
 * production size (13M rows; the narrower (timestamp, id) index took 18 s on production,
 * 2026-10-25). Built off-hours with `pnpm --filter @nivaro/api run index:activity-action`.
 * The reads need no change: the optimizer picks the index up once it exists.
 */

export const ACTION_INDEX = 'ix_nivaro_activity_action_timestamp'
export const ACTIVITY_TABLE = 'nivaro_activity'

/** SERVERPROPERTY('EngineEdition'): 3 = Enterprise/Developer, 5 = Azure SQL DB, 8 = Managed Instance. */
export function supportsOnlineBuild(engineEdition: number | null | undefined): boolean {
  return engineEdition === 3 || engineEdition === 5 || engineEdition === 8
}

/**
 * The CREATE statement. `lockTimeoutMs` caps how long the build waits for its table lock: a
 * waiting offline build queues every later write behind it, so it gives up instead of sitting
 * behind a long reader (run it again later).
 */
export function createActionIndexSql(opts: { online: boolean; lockTimeoutMs: number }): string {
  const withs = ['SORT_IN_TEMPDB = ON', ...(opts.online ? ['ONLINE = ON'] : [])]
  return [
    `SET LOCK_TIMEOUT ${Math.max(0, Math.floor(opts.lockTimeoutMs))};`,
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('${ACTIVITY_TABLE}') AND name = '${ACTION_INDEX}')`,
    `  CREATE INDEX ${ACTION_INDEX}`,
    `    ON ${ACTIVITY_TABLE} ([action], [timestamp] DESC, [id] DESC)`,
    `    WITH (${withs.join(', ')});`,
    'SET LOCK_TIMEOUT -1;'
  ].join('\n')
}

export function dropActionIndexSql(): string {
  return [
    `IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('${ACTIVITY_TABLE}') AND name = '${ACTION_INDEX}')`,
    `  DROP INDEX ${ACTION_INDEX} ON ${ACTIVITY_TABLE};`
  ].join('\n')
}

/**
 * Rough offline build time, for the operator's window: ~2–3 s per million rows on the EFP
 * server (the (timestamp, id) index: 18 s at 12.9M rows; this one carries the action too).
 */
export function estimateBuildSeconds(rows: number): { low: number; high: number } {
  const m = Math.max(0, rows) / 1_000_000
  return { low: Math.max(1, Math.round(m * 2)), high: Math.max(1, Math.round(m * 3)) }
}
