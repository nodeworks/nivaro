import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { errorText } from '../lib/db-refusal.js'
import { registerAppKeyed } from './app-forget.js'
import { cronTicksEnabled } from './cron-ticks.js'
import { instanceKey } from './instance-key.js'
import { INSTANCE_ID } from './instance-roster.js'
import { getApp, getIo } from './io-holder.js'
import { stableIssueKey } from './issue-key.js'
import { countsAsBusy } from './job-busy.js'
import { progressJson } from './job-run-sentences.js'
import { emitJobProgress } from './live-progress.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * The one funnel for background-execution history. Wrap any cron/backfill/
 * remediation body in `recordJobRun` and the Background Jobs console sees it:
 * status, duration, outcome, error, live progress. Every write here is
 * best-effort — job bookkeeping must never break the job.
 */

export type JobRunKind =
  | 'cron'
  | 'remediation'
  | 'backfill'
  | 'recalc'
  | 'monitor'
  | 'chaos'
  | 'export'
  | 'directory'
  | 'bulk'
  | 'task'
  | 'ai'
  | 'tuning'
  | 'render'
  /** One background run of a workflow move (services/transition-runs.ts). */
  | 'transition'
  /** One Hub promotion or rollback of an environment (services/hub/promote-run.ts). */
  | 'deploy'

/**
 * How a run started (#1050 / #1051): `schedule` = the clock fired it; `run-now` = someone
 * clicked; `chained` = it ran after the job it is chained to; `catch-up` = a boot caught up a
 * missed run; `manual` = any other code path (a route, a remediation).
 */
export type JobRunTrigger = 'schedule' | 'run-now' | 'chained' | 'catch-up' | 'manual'

/**
 * #1051 — a scheduled run from a process whose ticks are off must not happen: the dev laptop
 * shares its database with staging, so it would run (and mail) everything twice. Raised as one
 * deduped issue per job, naming the code path (the stack) that started it.
 */
function assertTicksAllowed(jobId: string, trigger: JobRunTrigger | undefined): boolean {
  const ticks = cronTicksEnabled()
  if (trigger !== 'schedule' || ticks) return ticks
  const where = new Error('scheduled job run from a ticks-off process').stack ?? null
  void import('./error-tracking.js')
    .then(({ trackError }) =>
      trackError({
        source: 'server',
        route: 'cron/ticks-off',
        severity: 'high',
        // the message names this process (its id changes every boot): one issue per job
        fingerprint: stableIssueKey('cron-ticks-off', jobId),
        refreshDetails: true,
        message: `Scheduled run of "${jobId}" started on a process with ticks off (${instanceKey()} · ${INSTANCE_ID}) — CRON_TICKS=off should have stopped it; the stack names the code path`,
        stack: where
      })
    )
    .catch(() => {})
  return ticks
}

/** The origin columns (migration 388), only on a database that has them. */
async function originFields(
  jobId: string,
  trigger: JobRunTrigger | undefined,
  leaseHolder: string | null | undefined
): Promise<Record<string, unknown>> {
  const ticks = assertTicksAllowed(jobId, trigger)
  if (!(await hasColumn('nivaro_job_runs', 'instance_id').catch(() => false))) return {}
  return {
    instance: instanceKey().slice(0, 80),
    instance_id: INSTANCE_ID,
    trigger_kind: trigger ?? 'manual',
    ticks_enabled: ticks,
    lease_holder: leaseHolder ? String(leaseHolder).slice(0, 120) : null
  }
}

export interface JobRunHandle {
  /** DB row id, null when the insert failed (bookkeeping degraded). */
  id: number | null
  progress(blob: Record<string, unknown>): void
  /** One line in the run's live log (an open run shows it as it is written). */
  log(line: string, level?: JobLogLevel): void
  /** `result` rides the starter's Jobs-tray entry only: a details link or the file it made. */
  complete(outcome?: string, result?: { href?: string; file_id?: string }): Promise<void>
  fail(err: unknown): Promise<void>
  /** A `guardRunning` run: false once a complete / fail found the row no longer running
   *  (another process ended it) — nothing was written or told. */
  stillOurs?(): boolean
}

/** Live job progress (#271): every lifecycle change lands on the Background
 *  Jobs console's watch room. Fire-and-forget decoration. */
export type JobLogLevel = 'info' | 'warn' | 'error'

export interface JobLogLine {
  seq: number
  at: string
  level: JobLogLevel
  line: string
}

const LOG_KEEP = 300
const LOG_TTL_SECONDS = 24 * 60 * 60
const LOG_LINE_MAX = 500
/** run id → its recent lines on THIS node (the Redis list is the cross-node copy). */
const logMemory = registerAppKeyed(
  new Map<string, { at: number; seq: number; lines: JobLogLine[] }>()
)

const logKey = (id: number, tenant: string = currentTenantKey()) => `${tenant || '-'}:${id}`

/** Append a line to a run's log and tell the Background Jobs room. Best-effort. */
function appendJobLog(
  id: number | null,
  line: string,
  level: JobLogLevel = 'info',
  tenant: string = currentTenantKey()
): void {
  if (id == null) return
  try {
    const key = logKey(id, tenant)
    let slot = logMemory.get(key)
    if (!slot) {
      slot = { at: Date.now(), seq: 0, lines: [] }
      logMemory.set(key, slot)
      if (logMemory.size > 200) {
        const oldest = [...logMemory.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) logMemory.delete(oldest[0])
      }
    }
    slot.at = Date.now()
    const entry: JobLogLine = {
      seq: ++slot.seq,
      at: new Date().toISOString(),
      level,
      line: line.slice(0, LOG_LINE_MAX)
    }
    slot.lines.push(entry)
    if (slot.lines.length > LOG_KEEP) slot.lines.splice(0, slot.lines.length - LOG_KEEP)
    const redis = getApp()?.redis as import('ioredis').Redis | undefined
    if (redis) {
      const rkey = `nvr:joblog:${key}`
      void redis
        .multi()
        .rpush(rkey, JSON.stringify(entry))
        .ltrim(rkey, -LOG_KEEP, -1)
        .expire(rkey, LOG_TTL_SECONDS)
        .exec()
        .catch(() => {})
    }
    emitJobEvent({ id, kind: 'log', log: entry }, 'job:log', tenant)
  } catch {
    /* decoration */
  }
}

/** The recent log of a run: Redis (every node's lines) when it holds some, else this node's memory. */
export async function readJobLog(id: number, after = 0): Promise<JobLogLine[]> {
  const key = logKey(id)
  const redis = getApp()?.redis as import('ioredis').Redis | undefined
  if (redis) {
    try {
      const raw = await redis.lrange(`nvr:joblog:${key}`, 0, -1)
      if (raw.length > 0) {
        return raw.map((r) => JSON.parse(r) as JobLogLine).filter((l) => l.seq > after)
      }
    } catch {
      /* fall through to memory */
    }
  }
  return (logMemory.get(key)?.lines ?? []).filter((l) => l.seq > after)
}

/** "done 25, total 100" for one progress blob (scalar values only). */
function progressLine(blob: Record<string, unknown>): string {
  return Object.entries(blob)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')
}

function emitJobEvent(
  payload: Record<string, unknown>,
  event = 'job:update',
  tenant: string = currentTenantKey()
): void {
  try {
    getIo()?.to(tenantScopedRoom('watch:jobs', tenant)).emit(event, payload)
  } catch {
    /* decoration */
  }
}

/** Asked once per run; a registry that is not up yet (boot, a script) just answers no. */
function runCountsAsBusy(kind: string, jobId: string): boolean {
  try {
    const cron = getApp()?.cron as { isHeavy?: (id: string) => boolean } | undefined
    return countsAsBusy(kind, jobId, (id) => cron?.isHeavy?.(id) === true)
  } catch {
    return false
  }
}

export async function startJobRun(
  kind: JobRunKind,
  jobId: string,
  opts?: {
    label?: string
    extensionId?: string
    triggeredBy?: string | null
    /** The integration event chain this run started (#707) — lets the console
     *  open the path of everything the run wrote. Probed per tenant, so a
     *  database behind migration 385 keeps recording runs without it. */
    chainId?: string | null
    /** #1050 / #1051 — how the run started (default `manual`). */
    trigger?: JobRunTrigger
    /** #1051 — the scheduler lease holder when a scheduled run started. */
    leaseHolder?: string | null
    /** complete / fail write only while the row still says `running` (a background export
     *  another process may have failed meanwhile — its outcome must not be overwritten). */
    guardRunning?: boolean
  }
): Promise<JobRunHandle> {
  const startedAt = new Date()
  // The run's own tenant: later log lines (cron callbacks, timers) key by it, not by whoever is current.
  const tenant = currentTenantKey()
  // Runs the "System busy" pill counts say so on every lifecycle event (services/job-busy.ts):
  // an open admin tab re-reads the pill for those only, not for every light cron tick.
  const busy = runCountsAsBusy(kind, jobId)
  const emitRun = (payload: Record<string, unknown>) =>
    emitJobEvent(busy ? { ...payload, busy: true } : payload, 'job:update', tenant)
  let id: number | null = null
  try {
    const origin = await originFields(jobId, opts?.trigger, opts?.leaseHolder)
    const chain =
      opts?.chainId && (await hasColumn('nivaro_job_runs', 'chain_id').catch(() => false))
        ? { chain_id: opts.chainId }
        : {}
    const [row] = await db('nivaro_job_runs')
      .insert({
        ...chain,
        ...origin,
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
  emitRun({ id, kind, job_id: jobId, status: 'running', started_at: startedAt.toISOString() })
  appendJobLog(id, `Started${opts?.label ? `: ${opts.label}` : ''}`, 'info', tenant)
  const handle = jobRunHandle({
    id,
    kind,
    jobId,
    label: opts?.label ?? null,
    starter: opts?.triggeredBy && opts.trigger !== 'schedule' ? opts.triggeredBy : null,
    startedAt,
    tenant,
    busy,
    guardRunning: !!opts?.guardRunning
  })
  // The Jobs tray (#1724): the person who started a run hears every step on their own
  // room (never the shared watch room). Scheduled ticks start nobody, so say nothing.
  if (opts?.triggeredBy && opts.trigger !== 'schedule' && id != null)
    emitJobProgress(opts.triggeredBy, {
      key: `job:${id}`,
      kind,
      label: opts?.label ?? jobId,
      status: 'running'
    })
  return handle
}

/**
 * A handle for a run another process started (a background export handed to the import
 * worker, services/export-handoff.ts): progress, log, complete and fail write the same row and
 * reach the same Jobs tray and Background Jobs room as the starter's handle would. Nothing is
 * inserted — the row exists.
 */
export function resumeJobRun(
  id: number,
  kind: JobRunKind,
  jobId: string,
  opts: {
    label?: string | null
    triggeredBy?: string | null
    startedAt?: Date | number | null
    /** See startJobRun. */
    guardRunning?: boolean
    /**
     * Take the run row over (a background export claimed by a drainer, fix round 3): its
     * instance becomes this process and its lease holder `adopt`, so the starter's shutdown and
     * boot sweeps no longer count it as theirs (services/job-run-sweeps.ts). `handle.adopted`
     * resolves true once the row was taken over (false when it no longer runs).
     */
    adopt?: string
  }
): JobRunHandle & { adopted?: Promise<boolean> } {
  const startedAt = new Date(opts.startedAt ?? Date.now())
  const handle = jobRunHandle({
    id,
    kind,
    jobId,
    label: opts.label ?? null,
    starter: opts.triggeredBy ?? null,
    startedAt: Number.isFinite(startedAt.getTime()) ? startedAt : new Date(),
    tenant: currentTenantKey(),
    busy: runCountsAsBusy(kind, jobId),
    guardRunning: !!opts.guardRunning
  })
  if (!opts.adopt) return handle
  const holder = opts.adopt
  const adopted = (async () => {
    try {
      const origin = await hasColumn('nivaro_job_runs', 'instance_id').catch(() => false)
      const n = await db('nivaro_job_runs')
        .where({ id, status: 'running' })
        .update(
          origin
            ? {
                instance: instanceKey().slice(0, 80),
                instance_id: INSTANCE_ID,
                lease_holder: holder.slice(0, 120)
              }
            : { status: 'running' }
        )
      return Number(n) === 1
    } catch {
      return false
    }
  })()
  return Object.assign(handle, { adopted })
}

function jobRunHandle(o: {
  id: number | null
  kind: JobRunKind
  jobId: string
  label: string | null
  /** The person whose Jobs tray hears this run (null for scheduled runs). */
  starter: string | null
  startedAt: Date
  tenant: string
  busy: boolean
  guardRunning?: boolean
}): JobRunHandle {
  const { id, kind, jobId, startedAt, tenant, busy, starter } = o
  const emitRun = (payload: Record<string, unknown>) =>
    emitJobEvent(busy ? { ...payload, busy: true } : payload, 'job:update', tenant)
  const tray = (ev: Omit<Parameters<typeof emitJobProgress>[1], 'key' | 'kind' | 'label'>) => {
    if (!starter || id == null) return
    emitJobProgress(starter, {
      key: `job:${id}`,
      kind,
      label: o.label ?? jobId,
      ...ev
    })
  }

  /** Write the final state; false when a guarded run was no longer running. */
  let lost = false
  const finish = async (patch: Record<string, unknown>): Promise<boolean> => {
    if (id == null) return true
    try {
      const q = db('nivaro_job_runs').where('id', id)
      if (o.guardRunning) q.where('status', 'running')
      const n = await q.update({
        ...patch,
        finished_at: new Date(),
        duration_ms: Date.now() - startedAt.getTime()
      })
      if (o.guardRunning && Number(n) !== 1) lost = true
      return !lost
    } catch {
      // ignore — bookkeeping never breaks the job
      return true
    }
  }

  // Progress calls arrive per chunk (sometimes many a second): the log keeps one line per 2 s.
  let lastProgressLine = 0
  return {
    id,
    progress(blob) {
      if (id == null) return
      db('nivaro_job_runs')
        .where('id', id)
        // Valid JSON always; a `skipped` list (#21) may run past the plain 4000-char cap.
        .update({ progress: progressJson(blob) })
        .catch(() => {})
      // The skipped list stays in the row (read on demand), never in every live event.
      const live = Array.isArray(blob.skipped) ? { ...blob, skipped: undefined } : blob
      emitRun({ id, kind, job_id: jobId, status: 'running', progress: live })
      if (Date.now() - lastProgressLine >= 2000) {
        lastProgressLine = Date.now()
        const text = progressLine(blob)
        if (text) appendJobLog(id, `Progress: ${text}`, 'info', tenant)
      }
      tray({ status: 'running', progress: live })
    },
    log(line, level = 'info') {
      appendJobLog(id, line, level, tenant)
    },
    stillOurs: () => !lost,
    complete: async (outcome, result) => {
      if (!(await finish({ status: 'completed', outcome: outcome?.slice(0, 2000) ?? null }))) return
      appendJobLog(id, `Completed${outcome ? `: ${outcome}` : ''}`, 'info', tenant)
      emitRun({ id, kind, job_id: jobId, status: 'completed', outcome: outcome ?? null })
      tray({
        status: 'completed',
        outcome: outcome?.slice(0, 300) ?? null,
        ...(result?.href ? { href: result.href } : {}),
        ...(result?.file_id ? { file_id: result.file_id } : {})
      })
    },
    fail: async (err) => {
      const written = await finish({
        status: 'error',
        error:
          `${errorText(err, 1500)}${err instanceof Error && err.stack ? `\n${err.stack}` : ''}`.slice(
            0,
            4000
          )
      })
      if (!written) return
      appendJobLog(id, `Failed: ${errorText(err, 300)}`, 'error', tenant)
      emitRun({
        id,
        kind,
        job_id: jobId,
        status: 'error',
        error: errorText(err, 300)
      })
      tray({ status: 'error', error: errorText(err, 300) })
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
    // Keep the newest N per job via a ROW_NUMBER window — one statement, no per-job loop, on
    // all five engines: DELETE … WHERE id IN (SELECT id FROM (<ranked>) r WHERE rn > N). (The
    // old CTE delete ran on SQL Server only; elsewhere only the age cut applied.) The window
    // keeps the derived table materialised, so MySQL/MariaDB accept the self-reference.
    const ranked = db('nivaro_job_runs').select(
      'id',
      db.raw('ROW_NUMBER() OVER (PARTITION BY kind, job_id ORDER BY id DESC) AS rn')
    )
    const n = await db('nivaro_job_runs')
      .whereIn('id', db.from(ranked.as('r')).select('r.id').where('r.rn', '>', keepPerJob))
      .del()
    if (Number.isFinite(Number(n))) deleted += Number(n)
  } catch {
    // best-effort
  }
  return deleted
}
