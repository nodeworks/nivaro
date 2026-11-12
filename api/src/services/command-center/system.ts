import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { apiLogSource } from '../api-log-source.js'

/**
 * Command Center system health (administrators only — names internal jobs and error counts).
 * Feeds the header SystemPill and the compact System panel. Database health comes from the
 * one-connection probe (services/db-health.ts), never a SELECT through the request pool: a full
 * pool is not a dead database (gotchas "Health signals never borrow the request pool").
 */

export interface SystemHealthAnswer {
  db_ok: boolean
  redis_ok: boolean
  errors_1h: number
  requests_1h: number
  jobs_running: number
  jobs_failed_1h: number
  runtime: { rss_mb: number; event_loop_lag_ms: { max_1m: number } }
  instances: number
}

type Pingable = { ping: () => Promise<string> }

/**
 * Server errors and all requests in the request log since `since`. Both go through
 * `apiLogSource` (no shared locks on SQL Server): the pair ran side by side over the newest
 * hour of the log, the pages the logger is inserting into, and under locking READ COMMITTED
 * both lost one deadlock to that insert. Exported so a test can read the SQL.
 */
export function requestLogCounts(
  knex: Knex,
  since: Date
): { errors: Knex.QueryBuilder; all: Knex.QueryBuilder } {
  return {
    errors: apiLogSource(knex)
      .where('created_at', '>', since)
      .where('status', '>=', 500)
      .count('* as n')
      .first(),
    all: apiLogSource(knex).where('created_at', '>', since).count('* as n').first()
  }
}

export async function readSystemHealth(
  redis: Pingable | null | undefined
): Promise<SystemHealthAnswer> {
  const hourAgo = new Date(Date.now() - 3600_000)
  const n = (r: unknown) => Number((r as { n?: number } | undefined)?.n ?? 0)
  const counts = requestLogCounts(db, hourAgo)
  const [errRow, reqRow, running, failedJobs] = await Promise.all([
    counts.errors.catch(() => undefined),
    counts.all.catch(() => undefined),
    db('nivaro_job_runs')
      .where('status', 'running')
      .count('* as n')
      .first()
      .catch(() => undefined),
    db('nivaro_job_runs')
      .where('status', 'error')
      .where('started_at', '>', hourAgo)
      .count('* as n')
      .first()
      .catch(() => undefined)
  ])
  const { isDbHealthy } = await import('../db-health.js')
  let redisOk = false
  try {
    if (redis) {
      await redis.ping()
      redisOk = true
    }
  } catch {
    redisOk = false
  }
  const { runtimeStats } = await import('../runtime-monitor.js')
  const { listInstances } = await import('../instance-roster.js')
  const rt = runtimeStats() as SystemHealthAnswer['runtime']
  return {
    db_ok: isDbHealthy(),
    redis_ok: redisOk,
    errors_1h: n(errRow),
    requests_1h: n(reqRow),
    jobs_running: n(running),
    jobs_failed_1h: n(failedJobs),
    runtime: rt,
    instances: (await listInstances().catch(() => [])).length
  }
}
