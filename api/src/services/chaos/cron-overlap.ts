import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'

/**
 * The cron-overlap check (#2833) behind `GET /api/chaos/checks/cron-overlap?since=`. After a
 * lease-split drill (or any time) it reads `nivaro_job_runs` for:
 *   - the same job running twice at once (two runs whose spans overlap),
 *   - runs left `running` past their budget (half-finished: the process died or hung),
 * and names the jobs that are not safe to run twice — those that overlapped plus every job
 * not declared `idempotent: 'safe'`, with what its declaration says.
 */

export interface JobRunRow {
  id: number
  job_id: string
  status: string
  started_at: Date | string
  finished_at: Date | string | null
  instance_id?: string | null
  instance?: string | null
  trigger_kind?: string | null
}

export interface JobInfo {
  id: string
  idempotent?: 'safe' | 'unsafe' | 'unknown'
  description?: string
  budget_ms: number
}

export interface Overlap {
  job_id: string
  a: { id: number; instance: string | null; started_at: string; finished_at: string | null }
  b: { id: number; instance: string | null; started_at: string; finished_at: string | null }
  overlap_ms: number
  same_instance: boolean
}

export interface StuckRun {
  id: number
  job_id: string
  instance: string | null
  started_at: string
  running_ms: number
  budget_ms: number
}

export interface UnsafeJob {
  job_id: string
  idempotent: 'safe' | 'unsafe' | 'unknown'
  overlapped: boolean
  why: string
}

export interface OverlapReport {
  since: string
  until: string
  runs: number
  truncated: boolean
  overlaps: Overlap[]
  stuck: StuckRun[]
  unsafe: UnsafeJob[]
}

const DEFAULT_BUDGET_MS = 15 * 60_000
export const ROW_CAP = 5000

const ms = (v: Date | string | null | undefined): number | null =>
  v == null ? null : new Date(v).getTime()
const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : new Date(v).toISOString()

/** The analysis (pure). `jobs` = the registered cron jobs (idempotency + budget). */
export function analyzeCronOverlap(
  rows: JobRunRow[],
  jobs: JobInfo[],
  opts: { now?: number; since: string; until: string; truncated?: boolean }
): OverlapReport {
  const now = opts.now ?? Date.now()
  const byJob = new Map<string, JobRunRow[]>()
  for (const r of rows) {
    const list = byJob.get(r.job_id) ?? []
    list.push(r)
    byJob.set(r.job_id, list)
  }
  const info = new Map(jobs.map((j) => [j.id, j]))
  const sinceMs = new Date(opts.since).getTime()
  const overlaps: Overlap[] = []
  const stuck: StuckRun[] = []
  for (const [jobId, list] of byJob) {
    list.sort((x, y) => (ms(x.started_at) ?? 0) - (ms(y.started_at) ?? 0))
    const budget = info.get(jobId)?.budget_ms ?? DEFAULT_BUDGET_MS
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      const aStart = ms(a.started_at) ?? 0
      // A run still `running` counts as open until now — or until its budget, past which it is
      // half-finished, not overlapping anything new.
      const aEnd = ms(a.finished_at) ?? Math.min(now, aStart + budget)
      if (a.status === 'running' && a.finished_at == null && now - aStart > budget) {
        stuck.push({
          id: a.id,
          job_id: jobId,
          instance: a.instance_id ?? a.instance ?? null,
          started_at: iso(a.started_at) ?? '',
          running_ms: now - aStart,
          budget_ms: budget
        })
      }
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        const bStart = ms(b.started_at) ?? 0
        if (bStart >= aEnd) break
        const bEnd = ms(b.finished_at) ?? Math.min(now, bStart + budget)
        const overlap = Math.min(aEnd, bEnd) - bStart
        // Both started before the window (read for reach-back): only count one that lasts into it.
        if (overlap <= 0 || Math.min(aEnd, bEnd) < sinceMs) continue
        const instA = a.instance_id ?? a.instance ?? null
        const instB = b.instance_id ?? b.instance ?? null
        overlaps.push({
          job_id: jobId,
          a: {
            id: a.id,
            instance: instA,
            started_at: iso(a.started_at) ?? '',
            finished_at: iso(a.finished_at)
          },
          b: {
            id: b.id,
            instance: instB,
            started_at: iso(b.started_at) ?? '',
            finished_at: iso(b.finished_at)
          },
          overlap_ms: overlap,
          same_instance: instA != null && instA === instB
        })
      }
    }
  }
  const overlapped = new Set(overlaps.map((o) => o.job_id))
  const unsafe: UnsafeJob[] = []
  const seen = new Set<string>()
  const add = (jobId: string) => {
    if (seen.has(jobId)) return
    const j = info.get(jobId)
    const declared = j?.idempotent ?? 'unknown'
    const ran = overlapped.has(jobId)
    if (declared === 'safe' && !ran) return
    seen.add(jobId)
    unsafe.push({
      job_id: jobId,
      idempotent: declared,
      overlapped: ran,
      why:
        declared === 'unsafe'
          ? ran
            ? 'Declared unsafe to run twice, and it did run twice at once.'
            : 'Declared unsafe to run twice; its cluster lock refuses a second start.'
          : declared === 'unknown'
            ? ran
              ? 'Ran twice at once and declares nothing about re-running — check what it writes.'
              : 'Declares nothing about re-running: nothing stops two replicas running it together after a lease split.'
            : 'Declared safe, but it ran twice at once — confirm the declaration.'
    })
  }
  for (const id of overlapped) add(id)
  for (const j of jobs) if (j.idempotent !== 'safe') add(j.id)
  unsafe.sort(
    (a, b) => Number(b.overlapped) - Number(a.overlapped) || a.job_id.localeCompare(b.job_id)
  )
  overlaps.sort((a, b) => b.overlap_ms - a.overlap_ms)
  return {
    since: opts.since,
    until: opts.until,
    runs: rows.length,
    truncated: opts.truncated === true,
    overlaps,
    stuck,
    unsafe
  }
}

/** Read the runs (cron kind) started in the window and analyse them. */
export async function checkCronOverlap(
  jobs: JobInfo[],
  opts: { since: Date; until?: Date; now?: number }
): Promise<OverlapReport> {
  const until = opts.until ?? new Date(opts.now ?? Date.now())
  const cols = ['id', 'job_id', 'status', 'started_at', 'finished_at']
  if (await hasColumn('nivaro_job_runs', 'instance_id').catch(() => false))
    cols.push('instance_id', 'instance', 'trigger_kind')
  // A run started before `since` can still overlap one inside it: reach back one budget.
  const reach = Math.max(DEFAULT_BUDGET_MS, ...jobs.map((j) => j.budget_ms))
  const rows = (await db('nivaro_job_runs')
    .where('kind', 'cron')
    .where('started_at', '>=', new Date(opts.since.getTime() - reach))
    .where('started_at', '<=', until)
    .orderBy('started_at', 'asc')
    .limit(ROW_CAP + 1)
    .select(cols)) as JobRunRow[]
  const truncated = rows.length > ROW_CAP
  return analyzeCronOverlap(truncated ? rows.slice(0, ROW_CAP) : rows, jobs, {
    now: opts.now,
    since: opts.since.toISOString(),
    until: until.toISOString(),
    truncated
  })
}

// ─── The schedulers on this process ───────────────────────────────────────────

interface CronHost {
  cron?: {
    leader?: { isLeader(): boolean; renew(): Promise<void> }
    list(): Array<{ id: string; idempotent?: 'safe' | 'unsafe' | 'unknown'; description?: string }>
    budgetMs(id: string): number
  }
}

type CronLike = NonNullable<CronHost['cron']>

/** The schedulers on this process: the app's, plus the chaos test one when it runs. */
export async function cronSchedulers(app: unknown): Promise<CronLike[]> {
  const { chaosTestScheduler } = await import('./cron-test-job.js')
  return [
    (app as CronHost | null)?.cron,
    chaosTestScheduler() as unknown as CronLike | null
  ].filter((c): c is CronLike => !!c)
}

/** Every registered job with its re-run declaration and budget (the overlap check's input). */
export async function cronJobsOf(app: unknown) {
  return (await cronSchedulers(app)).flatMap((cron) =>
    cron.list().map((e) => ({
      id: e.id,
      idempotent: e.idempotent,
      description: e.description,
      budget_ms: cron.budgetMs(e.id)
    }))
  )
}
