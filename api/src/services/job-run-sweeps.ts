import type { Knex } from 'knex'

/**
 * Background exports handed to another process (fix round 3): their job-run row is marked in
 * `lease_holder` (migration 388's column) while the job waits on the hand-off list
 * (`EXPORT_HANDOFF_MARK`) and once a drainer adopted it (`EXPORT_DRAINER_MARK`). The process
 * that STARTED the run must not mark it interrupted when it shuts down or after it restarted —
 * the run is the drainer's (services/export-worker.ts handles its own shutdown and lost leases).
 * Both sweeps (index.ts shutdown, server.ts restart-impact) apply skipHandedOffExports.
 */
export const EXPORT_HANDOFF_MARK = 'export-handoff'
export const EXPORT_DRAINER_MARK = 'export-drainer'
export const HANDED_OFF_MARKS = [EXPORT_HANDOFF_MARK, EXPORT_DRAINER_MARK] as const

/** Leave handed-off export runs out of a sweep of `nivaro_job_runs` (lease_holder must exist). */
export function skipHandedOffExports<T extends Knex.QueryBuilder>(q: T): T {
  q.where((w) => {
    w.whereNull('lease_holder').orWhereNotIn('lease_holder', [...HANDED_OFF_MARKS])
  })
  return q
}
