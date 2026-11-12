/**
 * Which background runs count toward the admin "System busy" pill (#2024).
 *
 * One rule, read by both sides of it: `GET /job-runs/busy` (what is running now) and the
 * `job:update` event a run emits when it starts and finishes. The event carries `busy: true`
 * for these runs only, so an open admin tab re-reads the pill when heavy work starts or ends
 * and not for each of the thousand light cron ticks an hour.
 */

/** Kinds that hold real capacity: while one runs, admins see "System busy". */
export const BUSY_KINDS: ReadonlySet<string> = new Set([
  'backfill',
  'recalc',
  'bulk',
  'export',
  'tuning',
  'render',
  'remediation'
])

/** A long-running kind, or a cron job registered as heavy. */
export function countsAsBusy(
  kind: string,
  jobId: string,
  isHeavyCron: (id: string) => boolean
): boolean {
  return BUSY_KINDS.has(kind) || (kind === 'cron' && isHeavyCron(jobId))
}
