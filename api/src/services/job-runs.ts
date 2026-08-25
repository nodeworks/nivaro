import { db } from '../db/index.js'
import { getIo } from './io-holder.js'

/**
 * The one funnel for background-execution history. Wrap any cron/backfill/
 * remediation body in `recordJobRun` and the Background Jobs console sees it:
 * status, duration, outcome, error, live progress. Every write here is
 * best-effort — job bookkeeping must never break the job.
 */

export type JobRunKind = 'cron' | 'remediation' | 'backfill' | 'recalc' | 'monitor' | 'chaos' | 'export'

export interface JobRunHandle {
  /** DB row id, null when the insert failed (bookkeeping degraded). */
  id: number | null
  progress(blob: Record<string, unknown>): void
  complete(outcome?: string): Promise<void>
  fail(err: unknown): Promise<void>
}

/** Live job progress (#271): every lifecycle change lands on the Background
 *  Jobs console's watch room. Fire-and-forget decoration. */
function emitJobEvent(payload: Record<string, unknown>): void {
  try {
    getIo()?.to('watch:jobs').emit('job:update', payload)
  } catch {
    /* decoration */
  }
}

export async function startJobRun(
  kind: JobRunKind,
  jobId: string,
  opts?: { label?: string; extensionId?: string; triggeredBy?: string | null }
): Promise<JobRunHandle> {
  const startedAt = new Date()
  let id: number | null = null
  try {
    const [row] = await db('nivaro_job_runs')
      .insert({
        kind,
        job_id: jobId.slice(0, 200),
        label: opts?.label?.slice(0, 300) ?? null,
        extension_id: opts?.extensionId?.slice(0, 100) ?? null,
        status: 'running',
        started_at: startedAt,
        triggered_by: opts?.triggeredBy ?? null
      })
      .returning('id')
    id = typeof row === 'object' ? (row as { id: number }).id : (row as number)
  } catch {
    // degraded bookkeeping — the job itself proceeds
  }
  emitJobEvent({ id, kind, job_id: jobId, status: 'running', started_at: startedAt.toISOString() })

  const finish = async (patch: Record<string, unknown>) => {
    if (id == null) return
    try {
      await db('nivaro_job_runs')
        .where('id', id)
        .update({
          ...patch,
          finished_at: new Date(),
          duration_ms: Date.now() - startedAt.getTime()
        })
    } catch {
      // ignore
    }
  }

  return {
    id,
    progress(blob) {
      if (id == null) return
      db('nivaro_job_runs')
        .where('id', id)
        .update({ progress: JSON.stringify(blob).slice(0, 4000) })
        .catch(() => {})
      emitJobEvent({ id, kind, job_id: jobId, status: 'running', progress: blob })
    },
    complete: async (outcome) => {
      await finish({ status: 'completed', outcome: outcome?.slice(0, 2000) ?? null })
      emitJobEvent({ id, kind, job_id: jobId, status: 'completed', outcome: outcome ?? null })
    },
    fail: async (err) => {
      await finish({
        status: 'error',
        error: String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 4000)
      })
      emitJobEvent({
        id,
        kind,
        job_id: jobId,
        status: 'error',
        error: String(err instanceof Error ? err.message : err).slice(0, 300)
      })
    }
  }
}

/** Convenience wrapper: run `fn` under a job-run record. The fn's string
 *  return value (if any) becomes the outcome. Rethrows after recording. */
export async function withJobRun<T>(
  kind: JobRunKind,
  jobId: string,
  opts: { label?: string; extensionId?: string; triggeredBy?: string | null } | undefined,
  fn: (run: JobRunHandle) => Promise<T>
): Promise<T> {
  const run = await startJobRun(kind, jobId, opts)
  try {
    const result = await fn(run)
    await run.complete(typeof result === 'string' ? result : undefined)
    return result
  } catch (err) {
    await run.fail(err)
    throw err
  }
}

/** Retention: newest N per (kind, job_id) plus a hard age cap — per-minute
 *  crons write 1,440 rows a day and nobody needs last month's ticks. */
export async function pruneJobRuns(keepPerJob = 50, maxAgeDays = 30): Promise<number> {
  const ageCutoff = new Date(Date.now() - maxAgeDays * 86_400_000)
  let deleted = 0
  try {
    deleted += await db('nivaro_job_runs').where('started_at', '<', ageCutoff).del()
    // Keep the newest N per job via a ROW_NUMBER window — one statement, no
    // per-job loop (MSSQL: deleting from a CTE targets the base table).
    const res = await db.raw(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY kind, job_id ORDER BY id DESC) AS rn
         FROM nivaro_job_runs
       )
       DELETE FROM ranked WHERE rn > ?`,
      [keepPerJob]
    )
    const n = Array.isArray(res) ? Number(res[0]) : 0
    if (Number.isFinite(n)) deleted += n
  } catch {
    // best-effort
  }
  return deleted
}
