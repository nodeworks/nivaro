import { db } from '../db/index.js'

/**
 * Is anything long running right now that a rolling update would cut off?
 * Read by the deploy script (GET /api/preflight/quiet) right before it rolls the
 * servers, and by scripts/deploy-quiet-check.ts by hand. 2026-11-08: a
 * 46,900-row PO import finished 3 s after a production rolling update.
 *
 * Busy = an import queued or running (nivaro_import_queue), or a job run still
 * `running` that started in the last 6 hours. Older `running` rows are runs a
 * past restart cut off; they never finish and must not block forever. Callers
 * poll twice ~25 s apart: sub-second jobs (every-minute crons) finish between
 * polls, a long run is seen by both.
 */
export interface DeployQuietState {
  quiet: boolean
  imports: string[]
  jobs: string[]
}

const BUSY_IMPORT_STATUSES = ['queued', 'pending', 'running', 'processing']
const STALE_RUNNING_HOURS = 6

export async function deployQuietState(): Promise<DeployQuietState> {
  const imports = (await db('nivaro_import_queue')
    .whereIn('status', BUSY_IMPORT_STATUSES)
    .whereRaw('created_at > DATEADD(hour, -?, GETUTCDATE())', [STALE_RUNNING_HOURS])
    .select('id', 'import_key', 'status')) as Array<{
    id: number
    import_key: string
    status: string
  }>
  const jobs = (await db('nivaro_job_runs')
    .where('status', 'running')
    .whereRaw('started_at > DATEADD(hour, -?, GETUTCDATE())', [STALE_RUNNING_HOURS])
    .select('job_id', 'started_at')) as Array<{ job_id: string; started_at: Date | string }>
  const importLines = imports.map((i) => `import #${i.id} ${i.import_key} (${i.status})`)
  const jobLines = jobs.map(
    (j) => `job ${j.job_id} (running since ${new Date(j.started_at).toISOString()})`
  )
  return {
    quiet: importLines.length === 0 && jobLines.length === 0,
    imports: importLines,
    jobs: jobLines
  }
}
