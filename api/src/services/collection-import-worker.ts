import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { appMap, appSet } from './app-state.js'
import { withBackgroundWork } from './background-inflight.js'
import {
  enqueueImportJob,
  forgetImportJob,
  type ImportRedis,
  importJobAttemptsKey,
  importJobLeaseKey,
  importLeaseMs,
  judgeLeases,
  LEASE_FAIL_NOTE,
  LEASE_RENEW_MS,
  LEASE_RETRY_NOTE,
  MAX_LEASE_RETRIES,
  pruneFinishedJobEntries,
  RETRY_WINDOW_MS
} from './import-handoff.js'
import { notifyUser } from './notification-channels.js'

/**
 * Collection imports (POST /api/imports, nivaro_import_jobs) on the import worker.
 *
 * EFP prod 2026-11-19: an 86,575-row CSV ran row by row inside the web replica that took the
 * upload, every row failed, and the only way to stop it was restarting that container. The
 * upload now only stores the job (`pending`) and hands its id off (services/import-handoff.ts);
 * the same drainers that run staged imports — the importer, IMPORT_WORKER=on, the cron worker
 * while no importer beats, a single process — claim it and run it (routes/imports.ts
 * runClaimedImportJob). Cloud mode has no drainers: the tenant process runs it, as before.
 *
 * The row is the truth: a job is claimed by its own guarded `pending → processing` update. A job
 * left `processing` by a process that died stops renewing its lease (a Redis key, the table has
 * no updated_at); a drainer that sees no key on two looks LEASE_RENEW_MS apart with no progress
 * between them, past IMPORT_LEASE_MS, puts it back once — only when it never reached its rows,
 * since re-running a half-done file would create its rows twice — else marks it failed and tells
 * whoever queued it. One job per collection runs at a time.
 */

/** Jobs one process runs at once. Each is a long row-by-row loop on the background pool. */
export const MAX_PARALLEL_JOBS = 2

/** Job ids this process is running right now. */
const runningHere = appSet<string>()

/** Exported for tests. */
export function jobsRunningHere(): ReadonlySet<string> {
  return runningHere
}

export const STALE_PENDING_NOTE =
  'This import waited more than six hours without an import worker to run it, so it was not started. Check the file and queue it again.'

async function jobStatuses(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await db('nivaro_import_jobs')
      .whereIn('id', ids.slice(i, i + 500))
      .select('id', 'status')) as Array<{ id: string; status: string }>
    for (const row of rows) out.set(String(row.id), String(row.status))
  }
  return out
}

/**
 * Claim and start pending jobs, oldest first, up to MAX_PARALLEL_JOBS on this process — never a
 * second job into a collection another job (on any process) is writing: two runs matching the
 * same records would each create what the other has not written yet. A job that waited past
 * RETRY_WINDOW_MS is not started (an old file replayed over newer data is worse than asking for
 * it again): it fails with a sentence instead.
 */
export async function drainCollectionImportJobs(
  app: FastifyInstance,
  now = Date.now()
): Promise<string[]> {
  if (runningHere.size >= MAX_PARALLEL_JOBS) return []
  const pending = (await db('nivaro_import_jobs')
    .where('status', 'pending')
    .orderBy('created_at')
    .limit(20)
    .select('id', 'collection', 'created_at', 'created_by', 'file_name')) as Array<{
    id: string
    collection: string | null
    created_at: Date | string | null
    created_by: string | null
    file_name: string | null
  }>
  if (pending.length === 0) return []
  const busy = new Set(
    (
      (await db('nivaro_import_jobs').where('status', 'processing').select('collection')) as Array<{
        collection: string | null
      }>
    ).map((r) => String(r.collection ?? '').toLowerCase())
  )
  const started: string[] = []
  const { claimImportJob, runClaimedImportJob } = await import('../routes/imports.js')
  for (const row of pending) {
    if (runningHere.size >= MAX_PARALLEL_JOBS) break
    const id = String(row.id)
    if (runningHere.has(id)) continue
    const queuedAt = new Date(row.created_at ?? now).getTime()
    if (Number.isFinite(queuedAt) && now - queuedAt > RETRY_WINDOW_MS) {
      const n = await db('nivaro_import_jobs')
        .where({ id, status: 'pending' })
        .update({
          status: 'failed',
          completed_at: new Date(now),
          errors: JSON.stringify([{ row: 0, error: STALE_PENDING_NOTE }])
        })
      if (Number(n) === 1) await tellCreator(app, row, STALE_PENDING_NOTE)
      continue
    }
    const target = String(row.collection ?? '').toLowerCase()
    if (busy.has(target)) continue
    if (!(await claimImportJob(id))) continue
    busy.add(target)
    runningHere.add(id)
    started.push(id)
    void withBackgroundWork('import', `collection ${target} #${id}`, () =>
      runClaimedImportJob(id, app)
    )
      .catch((err) => app.log.error({ err, jobId: id }, 'collection import failed to run'))
      .finally(() => runningHere.delete(id))
  }
  return started
}

/**
 * A job with no lease key on one look, by when it was seen and how far it had got. A missing key
 * is not yet a dead process — a Redis restart or failover drops every key while the runs carry
 * on (and renew theirs within LEASE_RENEW_MS) — so a job is judged only when a second look more
 * than LEASE_RENEW_MS later still finds no key AND its processed_rows has not moved.
 */
const suspects = appMap<string, { at: number; processed: number }>()

/** Exported for tests. */
export function forgetLeaseSuspects(): void {
  suspects.clear()
}

/**
 * Jobs left `processing` whose lease ran out (two looks, see `suspects`): back to `pending` once
 * when the run never reached its rows (total_rows unset — the mark written before row 1) and it
 * started within RETRY_WINDOW_MS, else failed with a sentence and the creator told. Without Redis
 * there is no lease to read, so nothing is judged (a person can still cancel). Each update
 * matches the started_at it read, so two drainers never both act on one job.
 */
export async function recoverLostCollectionJobs(
  app: FastifyInstance,
  r: ImportRedis | null,
  now = Date.now()
): Promise<Array<{ id: string; action: 'retry' | 'fail' }>> {
  if (!r) return []
  const rows = (await db('nivaro_import_jobs')
    .where('status', 'processing')
    .select(
      'id',
      'started_at',
      'processed_rows',
      'total_rows',
      'created_by',
      'file_name',
      'errors'
    )) as Array<{
    id: string
    started_at: Date | string | null
    processed_rows: number | null
    total_rows: number | null
    created_by: string | null
    file_name: string | null
    errors: string | null
  }>
  const candidates: typeof rows = []
  const stillProcessing = new Set(rows.map((row) => String(row.id)))
  for (const id of [...suspects.keys()]) if (!stillProcessing.has(id)) suspects.delete(id)
  for (const row of rows) {
    const id = String(row.id)
    if (runningHere.has(id)) continue
    // A live run renews its lease key; one that exists means a process is on it.
    const lease = await r.get(importJobLeaseKey(id)).catch(() => 'unknown')
    if (lease) {
      suspects.delete(id)
      continue
    }
    const processed = Number(row.processed_rows ?? 0)
    const seen = suspects.get(id)
    if (!seen || seen.processed !== processed) {
      suspects.set(id, { at: now, processed })
      continue
    }
    if (now - seen.at <= LEASE_RENEW_MS) continue
    candidates.push(row)
  }
  if (candidates.length === 0) return []
  const attempts = new Map<number, number>()
  const hget = (r as unknown as { hget?: (k: string, f: string) => Promise<string | null> }).hget
  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]
    // A run that may have written rows is never re-run from the top: total_rows is set before
    // row 1, so a run that got that far may have written row 1 before its first progress write.
    if (row.total_rows != null || Number(row.processed_rows ?? 0) > 0) {
      attempts.set(i, MAX_LEASE_RETRIES)
      continue
    }
    const n = Number(await hget?.call(r, importJobAttemptsKey(), String(row.id)).catch(() => null))
    if (Number.isFinite(n) && n > 0) attempts.set(i, n)
  }
  // judgeLeases keys rows by a number: the candidate's index stands in for the uuid. No lease
  // key and a start older than the lease time = the process is gone.
  const verdicts = judgeLeases(
    candidates.map((c, i) => ({ id: i, updated_at: null, started_at: c.started_at })),
    attempts,
    now,
    importLeaseMs()
  )
  const acted: Array<{ id: string; action: 'retry' | 'fail' }> = []
  for (const v of verdicts) {
    const row = candidates[v.id]
    if (!row) continue
    const id = String(row.id)
    const q = db('nivaro_import_jobs').where({ id, status: 'processing' })
    if (row.started_at) q.where('started_at', row.started_at as Date)
    else q.whereNull('started_at')
    let kept: unknown[] = []
    try {
      const parsed = JSON.parse(String(row.errors ?? '[]'))
      if (Array.isArray(parsed)) kept = parsed
    } catch {
      /* no usable list */
    }
    const n = Number(
      v.action === 'retry'
        ? await q.update({ status: 'pending', started_at: null })
        : await q.update({
            status: 'failed',
            completed_at: new Date(now),
            errors: JSON.stringify([{ row: 0, error: LEASE_FAIL_NOTE }, ...kept])
          })
    )
    if (n !== 1) continue
    suspects.delete(id)
    acted.push({ id, action: v.action })
    if (v.action === 'retry') {
      await r.hincrby(importJobAttemptsKey(), id, 1).catch(() => 0)
      await enqueueImportJob(r, id)
    } else {
      await forgetImportJob(r, id)
      await tellCreator(app, row, LEASE_FAIL_NOTE)
    }
    app.log.warn(
      { jobId: id, action: v.action, note: v.action === 'retry' ? LEASE_RETRY_NOTE : undefined },
      'collection import lost its worker'
    )
  }
  return acted
}

/** Drop hand-off entries of jobs that are final or gone. */
export async function pruneCollectionJobEntries(r: ImportRedis | null): Promise<number> {
  if (!r) return 0
  return pruneFinishedJobEntries(r, jobStatuses)
}

/** Pending jobs for the readiness check (`import-worker`): their queued-at times. */
export async function pendingJobTimes(limit = 500): Promise<Array<Date | string | null>> {
  const rows = (await db('nivaro_import_jobs')
    .where('status', 'pending')
    .select('created_at')
    .limit(limit)
    .catch(() => [])) as Array<{ created_at: Date | string | null }>
  return rows.map((r) => r.created_at)
}

async function tellCreator(
  app: FastifyInstance,
  row: { id: string; created_by: string | null; file_name: string | null },
  message: string
): Promise<void> {
  if (!row.created_by) return
  try {
    await notifyUser(app, String(row.created_by), {
      subject: `${row.file_name ?? 'CSV'} import failed`,
      message,
      // Clients resolve nivaro_import_jobs into the imports console.
      collection: 'nivaro_import_jobs',
      item: String(row.id)
    })
  } catch {
    // A notification failure never changes the job.
  }
}
