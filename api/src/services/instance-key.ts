/**
 * The deployment slot this process serves (`NIVARO_INSTANCE`, else NODE_ENV) — the per-instance
 * settings key, the api_logs `instance` column and the job-run `instance` column. Leaf module:
 * no database import, so the roster and job bookkeeping can read it without a cycle.
 */
export function instanceKey(): string {
  return process.env.NIVARO_INSTANCE?.trim() || process.env.NODE_ENV?.trim() || 'default'
}
