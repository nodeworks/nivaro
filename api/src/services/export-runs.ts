import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import type { User } from '../types.js'
import { appMap, appSet } from './app-state.js'
import {
  claimRunSlot,
  estimateRead,
  maxRunningPerUser,
  recordReadDuration,
  releaseRunSlot,
  renewRunSlot
} from './background-runs.js'
import {
  assertExportDiskRoom,
  ExportDiskBusy,
  type ExportFile,
  removeExportTemp
} from './export-files.js'
import {
  asExportRedis,
  EXPORT_QUEUE_MAX_WAIT_MS,
  EXPORT_TAKE_BACK_MS,
  type ExportJob,
  type ExportRedis,
  type ExportRunKind,
  enqueueExport,
  exportCancelKey,
  exportClaimedKey,
  exportDrainerAlive,
  exportPlacement,
  exportQueueKey,
  LOST_EXPORT_NOTE,
  parseExportJob,
  queuedExportEntry,
  STALE_EXPORT_NOTE,
  takeBackExport
} from './export-handoff.js'
import type { ExportPrincipal } from './export-kinds.js'
import { EXPORT_DRAINER_MARK, EXPORT_HANDOFF_MARK } from './job-run-sweeps.js'
import { type JobRunHandle, startJobRun } from './job-runs.js'
import { emitJobProgress } from './live-progress.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Background exports (#2122 follow-up, 2026-11-13).
 *
 * A big export (an export preset, GET /items/:c/export, the audit report's CSV) used to hold one
 * request open while it read every row: the person waited, a big one hit the proxy timeout, and
 * a web process was tied up. Each of those endpoints now takes a background mode — on by
 * default for the app's own buttons once the export is big (more than EXPORT_BACKGROUND_ROWS
 * rows, or the same export usually takes longer than BACKGROUND_RUN_SLOW_MS):
 *
 *  - the job runs the SAME builder the synchronous answer runs, as the same person (their
 *    permissions, row filters, User Scopes and field lists — nothing here decides access), on
 *    the background pool;
 *  - a job is a SERIALIZABLE description (`ExportJob`: kind, subject, person, the query /
 *    filters / fields / format / preset id captured at start, workspace), rebuilt into its
 *    builder by services/export-kinds.ts — so it can run on another process: while an export
 *    drainer beats (the import worker, services/export-handoff.ts) the job is handed to it,
 *    otherwise it runs here as before;
 *  - builders stream: rows are written to a temp file page by page and the file is uploaded
 *    from disk (services/export-files.ts), so memory stays flat whatever the size;
 *  - it is a job run (`kind: 'export'`, job id `bg-export:<kind>:<subject>`), so the starter's
 *    Jobs tray shows it with rows done / total and a Cancel, and the Background Jobs console
 *    lists it;
 *  - the file goes to the files store as a PRIVATE file of the person (private-files.ts: only
 *    they and administrators can read it), the tray turns it into a Download chip, an open tab
 *    that started it downloads it at once, and the person gets "Your export is ready" with the
 *    link;
 *  - Cancel reaches the process running it: a local abort when the same process answers, a
 *    Redis flag the job reads between chunks otherwise.
 *
 * One person runs at most maxRunningPerUser() background reads at once (the slots are the
 * ones slow reads in the background use).
 */

export type { ExportFile } from './export-files.js'
export type { ExportRunKind } from './export-handoff.js'

export const EXPORT_JOB_PREFIX = 'bg-export:'

/** Rows above which the app's own export buttons run in the background. */
export function backgroundRowThreshold(): number {
  const v = Number(process.env.EXPORT_BACKGROUND_ROWS)
  return Number.isFinite(v) && v >= 100 ? Math.floor(v) : 5000
}

export type BackgroundMode = 'off' | 'auto' | 'always'

/** `?background=` / body `background`: 1/true/always → always, auto → auto, else off. */
export function parseBackgroundMode(
  raw: unknown,
  fallback: BackgroundMode = 'off'
): BackgroundMode {
  if (raw == null || raw === '') return fallback
  const s = String(raw).toLowerCase()
  if (s === '1' || s === 'true' || s === 'always' || s === 'yes') return 'always'
  if (s === 'auto') return 'auto'
  return 'off'
}

type RedisLike = NonNullable<FastifyInstance['redis']>

/** Whether an export of `rows` rows should go to the background under `mode`. */
export async function decideBackground(
  mode: BackgroundMode,
  opts: {
    rows: number | null
    kind: ExportRunKind
    subject: string
    redis?: RedisLike | null
  }
): Promise<boolean> {
  if (mode === 'always') return true
  if (mode === 'off') return false
  if (opts.rows != null && opts.rows > backgroundRowThreshold()) return true
  const est = await estimateRead(`export-${opts.kind}`, opts.subject, opts.redis).catch(() => null)
  return !!est?.slow
}

/** A synchronous export finished: teach the estimate how long this one takes. */
export function noteExportDuration(
  kind: ExportRunKind,
  subject: string,
  ms: number,
  redis?: RedisLike | null
): void {
  try {
    recordReadDuration(`export-${kind}`, subject, ms, redis ?? null)
  } catch {
    /* the estimate is decoration */
  }
}

/** Background mode needs a person acting for themselves: never under View-as. */
export function backgroundRefusal(req: FastifyRequest): string | null {
  if (!req.user?.id) return 'Sign in to export in the background'
  if ((req as { masqueradeAdminId?: string }).masqueradeAdminId)
    return 'Background exports are not available while viewing as someone — export it directly'
  return null
}

// ── The job ──────────────────────────────────────────────────────────────────

export interface ExportProgress {
  /** Rows written so far. */
  done: number
  /** Rows the export will hold (null when not known yet). */
  total: number | null
  phase?: string
}

export interface ExportContext {
  /** Aborted when the person cancels. Builders check it between chunks (`throwIfCancelled`). */
  signal: AbortSignal
  progress(p: ExportProgress): void
  /** Throws ExportCancelled once the person cancelled (checks the cross-process flag too). */
  throwIfCancelled(): Promise<void>
}

export class ExportCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'ExportCancelled'
  }
}

export class ExportRunError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message)
  }
}

export interface StartedExport {
  run_id: number
  /** The Jobs tray key (`job:<id>`). */
  key: string
  label: string
  total: number | null
  /** API path (under /api) that cancels the run. */
  cancel_path: string
}

const CANCEL_TTL_S = 60 * 60
const cancelKey = (runId: number) => exportCancelKey(runId)
/** How often a running or waiting job renews its per-person slot. */
const SLOT_RENEW_MS = 60_000
/** What a job asked to stop for a shutdown does: back on the list, or failed with a sentence. */
type ShutdownMode = 'requeue' | 'fail'

/** A job this process is running. */
interface RunHere {
  controller: AbortController
  job: ExportJob
  /** Rows the build reported so far. */
  rows: number
  /** Set when the process stops under the job (export-worker.ts preClose). */
  shutdown?: ShutdownMode
  /** Set when the run was lost or ended elsewhere (its lease, its row): it fails with
   *  LOST_EXPORT_NOTE, never "Cancelled" (fix round 3). */
  lost?: boolean
}
/** Runs this process is executing: a cancel answered here aborts at once. */
const local = new Map<string, RunHere>()
const localKey = (runId: number) => `${currentTenantKey() || '-'}:${runId}`
/** Test seam: the job promise per run id. */
const running = appMap<number, Promise<void>>()
/** Jobs this process handed off and still watches (take-back when nobody drains). */
const waiting = appMap<number, ReturnType<typeof setInterval>>()

export const SHUTDOWN_EXPORT_NOTE =
  'The process running this export stopped (a restart) before the file was finished. Start the export again.'

export const cancelPath = (runId: number) => `/export-runs/${runId}/cancel`
export const exportJobId = (job: Pick<ExportJob, 'kind' | 'subject'>) =>
  `${EXPORT_JOB_PREFIX}${job.kind}:${job.subject}`.slice(0, 200)

/**
 * May this request's export run on ANOTHER process (fix round 1, decision A)? Only a person's
 * own browser session: the other process rebuilds the principal from the person's id, and an API
 * key's scopes / scope restrictions / sandbox flag, an OAuth (MCP) token's narrowing, a
 * run-as-key or a View-as live on THIS request's principal only. Those run where they started,
 * with the principal as the request had it.
 */
export function exportMayHandOff(req: FastifyRequest): boolean {
  const r = req as FastifyRequest & {
    authMethod?: string
    masqueradeAdminId?: string
    apiKeySimulatedId?: number | null
    apiKeyId?: number | null
    apiKeyScopes?: unknown
    oauthScopes?: unknown
    oauthClientId?: string
    mcpInner?: boolean
  }
  if (r.authMethod !== 'session') return false
  if (r.masqueradeAdminId || r.apiKeySimulatedId != null || r.apiKeyId != null) return false
  if (r.apiKeyScopes || r.oauthScopes || r.oauthClientId || r.mcpInner) return false
  const u = (req.user ?? {}) as Record<string, unknown>
  return !Object.keys(u).some((k) => k.startsWith('api_key_'))
}

/**
 * Start an export as a background job, as `user`. Resolves once the run is recorded (its id is
 * the tray key); the build runs after the response — on an export drainer when one beats and
 * `handOff` allows it (services/export-handoff.ts), else here on the background pool.
 */
export async function startExportRun(
  app: FastifyInstance,
  opts: {
    user: User
    isAdmin: boolean
    kind: ExportRunKind
    /** Preset id, collection, … — the job id's tail and the duration estimate's key. */
    subject: string
    /** What is being exported ("Workflows", "Friday finance"). */
    label: string
    /** Rows expected, when the start already knows. */
    total?: number | null
    /** What the builder needs (services/export-kinds.ts) — JSON only. */
    params: Record<string, unknown>
    workspaceId?: string | null
    /** May it run on another process (exportMayHandOff)? Default: no. */
    handOff?: boolean
  }
): Promise<StartedExport> {
  const user = opts.user
  const redis = app.redis ?? null
  // The work dir is over its quota: refuse now rather than fail later (services/export-files.ts).
  try {
    await assertExportDiskRoom()
  } catch (err) {
    if (err instanceof ExportDiskBusy) throw new ExportRunError(409, err.message, err.code)
    throw err
  }
  const slotOwner = `export:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
  const slot = await claimRunSlot(redis, user.id, slotOwner)
  if (slot == null)
    throw new ExportRunError(
      429,
      `You already have ${maxRunningPerUser()} exports or reads running in the background — wait for one to finish`,
      'BACKGROUND_BUSY'
    )
  const label = `Exporting ${opts.label}`.slice(0, 200)
  let run: JobRunHandle
  try {
    run = await startJobRun('export', exportJobId(opts), {
      label,
      triggeredBy: user.id,
      trigger: 'manual',
      // Another process may end this run (a lost lease): never overwrite its outcome.
      guardRunning: true
    })
  } catch (err) {
    await releaseRunSlot(redis, user.id, slot, slotOwner)
    throw err
  }
  if (run.id == null) {
    await releaseRunSlot(redis, user.id, slot, slotOwner)
    throw new ExportRunError(
      503,
      'The export could not be started — try again',
      'EXPORT_NOT_STARTED'
    )
  }
  const runId = run.id
  const total = opts.total ?? null
  const job: ExportJob = {
    v: 1,
    run_id: runId,
    kind: opts.kind,
    subject: opts.subject,
    label,
    user_id: String(user.id),
    workspace_id: opts.workspaceId ?? null,
    // A JSON round trip: what a drainer would get is exactly what runs here too.
    params: JSON.parse(JSON.stringify(opts.params ?? {})) as Record<string, unknown>,
    total,
    slot,
    slot_owner: slotOwner,
    started_at: Date.now()
  }
  const first = { phase: 'Starting', done: 0, total, unit: 'rows' }
  run.progress(first)
  // The tray offers Cancel from the first tick.
  emitJobProgress(user.id, {
    key: `job:${runId}`,
    kind: 'export',
    label,
    status: 'running',
    progress: first,
    cancel_path: cancelPath(runId)
  })

  const started = {
    run_id: runId,
    key: `job:${runId}`,
    label,
    total,
    cancel_path: cancelPath(runId)
  }
  const principal: ExportPrincipal = { user, isAdmin: opts.isAdmin }
  const r = asExportRedis(redis)
  if (
    opts.handOff === true &&
    r &&
    (await exportPlacement(r).catch(() => 'here' as const)) === 'handoff'
  ) {
    try {
      // Marked handed off FIRST: this process's shutdown and boot sweeps leave the row alone
      // from now on (services/job-run-sweeps.ts); the drainer adopts it when it claims it.
      await markHandedOff(runId, EXPORT_HANDOFF_MARK)
      const raw = await enqueueExport(r, job).catch(async (err) => {
        await markHandedOff(runId, null)
        throw err
      })
      run.progress({ phase: 'Waiting for the export worker', done: 0, total, unit: 'rows' })
      watchHandedOff(app, r, raw, job, run, principal)
      return started
    } catch (err) {
      app.log?.warn?.({ err, run: runId }, 'Export hand-off failed; running it here')
    }
  }
  runJob(app, job, run, principal)
  return started
}

/**
 * Run a job on this process, after the current response (setImmediate), on the background pool.
 * `principal` is the person as the starter read them (a job started here); a job from the
 * hand-off list reads them again (services/export-kinds.ts principalFor). The job renews its
 * per-person slot while it runs.
 */
function runJob(
  app: FastifyInstance,
  job: ExportJob,
  run: JobRunHandle,
  principal?: ExportPrincipal
): Promise<void> {
  const here: RunHere = { controller: new AbortController(), job, rows: 0 }
  local.set(localKey(job.run_id), here)
  // The slot is renewed only for a run that is alive: not cancelled, and its row still running
  // (fix round 2 — a run ended elsewhere while it sits in an await that ignores Cancel stops
  // here instead of holding the slot).
  const renew = setInterval(() => {
    void (async () => {
      if (here.controller.signal.aborted) return
      if (!(await stillRunning(job.run_id))) {
        here.lost = true
        here.controller.abort()
        return
      }
      // Cancel reaches a build stuck in an await that does not check (an upload, a commit).
      if (await cancelRequested(app, job.run_id)) {
        here.controller.abort()
        return
      }
      await renewRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner)
    })().catch(() => {})
  }, SLOT_RENEW_MS)
  renew.unref?.()
  const done = new Promise<void>((resolve) => {
    setImmediate(() => {
      void runInBackgroundPool(() => execute(app, job, run, here, principal))
        .catch((err) => app.log?.warn?.({ err, run: job.run_id }, 'Background export failed'))
        .finally(() => {
          clearInterval(renew)
          local.delete(localKey(job.run_id))
          running.delete(job.run_id)
          // A job going back on the list keeps its slot (it is still the person's export).
          if (here.shutdown !== 'requeue')
            void releaseRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner)
          resolve()
        })
    })
  })
  running.set(job.run_id, done)
  return done
}

/**
 * Set or clear the hand-off mark of a run row (`lease_holder`, migration 388): while the job
 * waits on the list (EXPORT_HANDOFF_MARK) the starter's sweeps skip it; null = it runs here again.
 */
export async function markHandedOff(runId: number, mark: string | null): Promise<void> {
  try {
    const { hasColumn } = await import('../lib/column-probe.js')
    if (!(await hasColumn('nivaro_job_runs', 'lease_holder').catch(() => false))) return
    await db('nivaro_job_runs')
      .where({ id: runId, status: 'running' })
      .update({ lease_holder: mark })
  } catch {
    /* bookkeeping: the lost-lease sweep still judges the run */
  }
}

/** A drainer runs a job it claimed from the hand-off list (services/export-worker.ts). */
export async function runHandedOffExport(
  app: FastifyInstance,
  job: ExportJob,
  opts: { mayStart?: () => boolean } = {}
): Promise<'ran' | 'skipped'> {
  const { resumeJobRun } = await import('./job-runs.js')
  // The drainer is stopping: never start (the job is untouched and can go back on the list).
  if (opts.mayStart && !opts.mayStart()) return 'skipped'
  const run = resumeJobRun(job.run_id, 'export', exportJobId(job), {
    label: job.label,
    triggeredBy: job.user_id,
    startedAt: job.started_at,
    guardRunning: true,
    // The drainer takes the row over: the starter leaving (shutdown, restart) never ends it.
    adopt: EXPORT_DRAINER_MARK
  })
  if (run.adopted && !(await run.adopted)) {
    // The run no longer runs (cancelled or ended while it waited): nothing to make.
    await releaseRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner)
    return 'ran'
  }
  await runJob(app, job, run)
  return 'ran'
}

/**
 * Stop a run this process executes, at once. `lost`: its lease or its row was taken from it —
 * it fails with LOST_EXPORT_NOTE; otherwise it is a Cancel.
 */
export function abortLocalExport(runId: number, reason: 'cancel' | 'lost' = 'cancel'): boolean {
  const here = local.get(localKey(runId))
  if (!here) return false
  if (reason === 'lost') here.lost = true
  here.controller.abort()
  return true
}

/** Did the person cancel this run (the cross-process flag)? Unknown = no. */
export async function exportCancelRequested(app: FastifyInstance, runId: number): Promise<boolean> {
  return cancelRequested(app, runId)
}

/** Rows a run this process executes has written so far (null when it does not run here). */
export function exportRowsDoneHere(runId: number): number | null {
  return local.get(localKey(runId))?.rows ?? null
}

/**
 * The process is stopping under a job (export-worker.ts preClose): `requeue` stops it without
 * touching its row (the caller puts the job back on the list), `fail` stops it and fails the run
 * with SHUTDOWN_EXPORT_NOTE.
 */
export function stopExportForShutdown(runId: number, mode: ShutdownMode): boolean {
  const here = local.get(localKey(runId))
  if (!here) return false
  here.shutdown = mode
  here.controller.abort()
  return true
}

/** Did a run this process executed stop for a shutdown without writing (it may go back)? */
export const exportStoppedUntouched = (runId: number) => untouched.delete(runId)
/** Runs that stopped in `requeue` mode — their row untouched (cleared when read). */
const untouched = appSet<number>()

/**
 * While a handed-off job waits on the list, check that someone is there to run it: once no
 * drainer beats any more, take it back (LREM — only one side can win against the drainer's
 * claim) and run it here. The job keeps its per-person slot while it waits. After
 * EXPORT_QUEUE_MAX_WAIT_MS a job still listed is taken off and its run failed.
 */
function watchHandedOff(
  app: FastifyInstance,
  r: ExportRedis,
  raw: string,
  job: ExportJob,
  run: JobRunHandle,
  principal: ExportPrincipal
): void {
  const since = Date.now()
  let busy = false
  let lastRenew = Date.now()
  const stop = () => {
    const t = waiting.get(job.run_id)
    if (t) clearInterval(t)
    waiting.delete(job.run_id)
  }
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      // A Redis error is "unknown": keep watching (never stop on a failed read).
      const raws = await r.lrange(exportQueueKey(), 0, 999)
      const listed = raws.some((x) => parseExportJob(x)?.run_id === job.run_id)
      if (!listed) {
        // Off the list: stop only once a drainer holds it (claimed) or the run ended.
        const claimed = await r.hget(exportClaimedKey(), String(job.run_id))
        if (claimed != null || !(await stillRunning(job.run_id))) return stop()
        return
      }
      if (Date.now() - since > EXPORT_QUEUE_MAX_WAIT_MS) {
        stop()
        // Waited too long: nobody will run it — close it rather than leave it "running".
        if (await takeBackExport(r, raw)) {
          await run.fail(new Error(STALE_EXPORT_NOTE))
          await releaseRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner)
        }
        return
      }
      if (Date.now() - lastRenew >= SLOT_RENEW_MS) {
        lastRenew = Date.now()
        await renewRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner)
      }
      if (await exportDrainerAlive(r)) return
      if (!(await takeBackExport(r, raw))) return
      stop()
      app.log?.info?.({ run: job.run_id }, 'No export worker is running: exporting here')
      // Runs here again: this process's sweeps judge it like any other run.
      await markHandedOff(job.run_id, null)
      void runJob(app, job, run, principal)
    })()
      .catch(() => {})
      .finally(() => {
        busy = false
      })
  }, EXPORT_TAKE_BACK_MS)
  timer.unref?.()
  waiting.set(job.run_id, timer)
}

async function cancelRequested(app: FastifyInstance, runId: number): Promise<boolean> {
  const redis = app.redis ?? null
  if (!redis) return false
  try {
    return (await redis.get(cancelKey(runId))) != null
  } catch {
    return false
  }
}

/** Is the run's row still `running` (another process may have ended it)? Unknown = yes. */
async function stillRunning(runId: number): Promise<boolean> {
  try {
    const row = (await db('nivaro_job_runs').where({ id: runId }).first('status')) as
      | { status?: string }
      | undefined
    return !row || row.status === 'running'
  } catch {
    return true
  }
}

async function execute(
  app: FastifyInstance,
  job: ExportJob,
  run: JobRunHandle,
  here: RunHere,
  principal?: ExportPrincipal
): Promise<void> {
  const runId = job.run_id
  const { controller } = here
  let lastEmit = 0
  let lastFlagCheck = 0
  let last: ExportProgress = { done: 0, total: job.total }
  const throwIfCancelled = async () => {
    if (controller.signal.aborted) throw new ExportCancelled()
    // The flag a cancel answered by another replica leaves: read at most once a second.
    if (Date.now() - lastFlagCheck < 1000) return
    lastFlagCheck = Date.now()
    if (await cancelRequested(app, runId)) {
      controller.abort()
      throw new ExportCancelled()
    }
  }
  const ctx: ExportContext = {
    signal: controller.signal,
    throwIfCancelled,
    progress(p) {
      last = p
      here.rows = p.done
      // Builders report per chunk; the row and the tray hear at most ~2 a second.
      if (Date.now() - lastEmit < 500) return
      lastEmit = Date.now()
      run.progress({ phase: p.phase ?? 'Reading rows', done: p.done, total: p.total, unit: 'rows' })
    }
  }
  let file: ExportFile | null = null
  try {
    await throwIfCancelled()
    const { buildExportFromJob, judgePrincipal } = await import('./export-kinds.js')
    // A job from the hand-off list reads the person again, the way a request would: an active
    // account whose role signs in, not waiting for access, still in the job's workspace.
    let who = principal
    if (!who) {
      const judged = await judgePrincipal(job.user_id, job.workspace_id)
      if (!judged.ok) throw new ExportRunError(403, judged.reason, 'EXPORT_NO_ACCESS')
      who = judged.who
    }
    file = await buildExportFromJob(job, who, ctx)
    await throwIfCancelled()
    // Another process ended the run meanwhile (a lost lease): store nothing.
    if (!(await stillRunning(runId))) return
    run.progress({
      phase: 'Saving the file',
      done: file.rows,
      total: last.total ?? file.rows,
      unit: 'rows'
    })
    const { uploadFileFromPath } = await import('./files.js')
    // A private file: only its maker (and administrators) can read it. Streamed from disk.
    const stored = await uploadFileFromPath(
      who.user,
      file.path,
      file.filename,
      file.contentType,
      undefined,
      // Cancel reaches the upload too.
      { private: true, signal: controller.signal }
    )
    const fileId = String(stored.id)
    const rowsText = `${file.rows.toLocaleString('en-US')} ${file.rows === 1 ? 'row' : 'rows'}`
    // "name → file <id>" is what /my-jobs reads the Download chip from.
    await run.complete(
      `${file.truncated ? `First ${rowsText}` : rowsText} · ${file.filename} → file ${fileId}`,
      { file_id: fileId }
    )
    if (run.stillOurs?.() === false) {
      // The run was ended elsewhere meanwhile: nobody will be pointed at this file — remove it.
      const { deleteFile } = await import('./files.js')
      await deleteFile(fileId).catch(() => {})
      return
    }
    noteExportDuration(job.kind, job.subject, Date.now() - job.started_at, app.redis ?? null)
    await notifyReady(app, job.user_id, fileId, file).catch(() => {})
  } catch (err) {
    if (here.shutdown === 'requeue') {
      untouched.add(runId)
      return
    }
    if (here.shutdown === 'fail') {
      await run.fail(new Error(SHUTDOWN_EXPORT_NOTE))
      return
    }
    if (here.lost) {
      // Lost its lease or its row: a failure with a sentence, never "Cancelled".
      await run.fail(new Error(LOST_EXPORT_NOTE))
      return
    }
    if (err instanceof ExportCancelled || controller.signal.aborted) {
      await completeCancelled(job, run)
      return
    }
    await run.fail(err)
  } finally {
    await removeExportTemp(file?.path)
    if (app.redis && here.shutdown !== 'requeue')
      await app.redis.del(cancelKey(runId)).catch(() => {})
  }
}

async function completeCancelled(job: ExportJob, run: JobRunHandle): Promise<void> {
  await run.complete('Cancelled')
  // The run was already ended elsewhere: say nothing.
  if (run.stillOurs?.() === false) return
  emitJobProgress(job.user_id, {
    key: `job:${job.run_id}`,
    kind: 'export',
    label: job.label,
    status: 'canceled',
    outcome: 'Cancelled'
  })
}

async function notifyReady(
  app: FastifyInstance,
  userId: string,
  fileId: string,
  file: ExportFile
): Promise<void> {
  const { notifyUser } = await import('./notification-channels.js')
  const { buildExportReadyMail } = await import('./mail-builders.js')
  const built = await buildExportReadyMail(fileId).catch(() => null)
  await notifyUser(app, userId, {
    subject: 'Your export is ready',
    category: 'reports',
    message: `${file.filename} — ${file.rows.toLocaleString('en-US')} ${file.rows === 1 ? 'row' : 'rows'}${file.truncated ? ' (the first ones only — narrow the filter for the rest)' : ''}. Open this to download it.`,
    // The download itself: the file route checks it is theirs on every read.
    target: { kind: 'external', url: `/api/files/${fileId}?download=1` },
    ...(built ? { template: built.template, template_data: built.data } : {})
  })
}

// ── Reading and cancelling a run ─────────────────────────────────────────────

interface RunRow {
  id: number
  kind: string
  job_id: string
  label: string | null
  status: string
  progress: string | null
  outcome: string | null
  error: string | null
  triggered_by: string | null
  started_at: Date | string | null
  finished_at: Date | string | null
}

async function readRun(runId: number): Promise<RunRow | null> {
  if (!Number.isInteger(runId) || runId <= 0) return null
  const row = (await db('nivaro_job_runs')
    .where({ id: runId })
    .first(
      'id',
      'kind',
      'job_id',
      'label',
      'status',
      'progress',
      'outcome',
      'error',
      'triggered_by',
      'started_at',
      'finished_at'
    )
    .catch(() => null)) as RunRow | null | undefined
  const isExport = row?.kind === 'export' && String(row.job_id ?? '').startsWith(EXPORT_JOB_PREFIX)
  return isExport && row ? row : null
}

const sameUser = (a: unknown, b: unknown) =>
  !!a && !!b && String(a).toUpperCase() === String(b).toUpperCase()

/** The run as its starter sees it; null for another person's run or not an export run. */
export async function getExportRun(userId: string, runId: number) {
  const row = await readRun(runId)
  if (!row || !sameUser(row.triggered_by, userId)) return null
  let progress: Record<string, unknown> | null = null
  try {
    progress = row.progress ? (JSON.parse(row.progress) as Record<string, unknown>) : null
  } catch {
    progress = null
  }
  const cancelled = row.status === 'completed' && row.outcome === 'Cancelled'
  const fileId = row.outcome?.match(/→ file ([0-9a-fA-F-]{8,})\s*$/)?.[1] ?? null
  return {
    run_id: row.id,
    key: `job:${row.id}`,
    label: row.label,
    // Only `completed` is a success; `interrupted` (a restart cut it) and any status this code
    // does not know are errors (fix round 3), never "completed".
    status: cancelled
      ? ('canceled' as const)
      : row.status === 'running'
        ? ('running' as const)
        : row.status === 'completed'
          ? ('completed' as const)
          : ('error' as const),
    progress,
    outcome: row.outcome,
    error: row.error
      ? String(row.error).split('\n')[0].slice(0, 300)
      : row.status === 'interrupted'
        ? 'The export was interrupted by a restart. Start it again.'
        : row.status !== 'completed' && row.status !== 'running'
          ? 'The export did not finish. Start it again.'
          : null,
    file_id: fileId,
    ...(row.status === 'running' ? { cancel_path: cancelPath(row.id) } : {})
  }
}

/** Cancel a run: its starter (or an administrator) may. */
export async function cancelExportRun(
  app: FastifyInstance,
  user: User,
  runId: number,
  isAdmin: boolean
): Promise<'stopped' | 'finished' | 'not_found'> {
  const row = await readRun(runId)
  if (!row) return 'not_found'
  if (!sameUser(row.triggered_by, user.id) && !isAdmin) return 'not_found'
  if (row.status !== 'running') return 'finished'
  const here = local.get(localKey(runId))
  if (here) here.controller.abort()
  if (app.redis) await app.redis.setex(cancelKey(runId), CANCEL_TTL_S, '1').catch(() => {})
  // Still waiting on the hand-off list: take it off and close it now (no drainer will start it).
  const r = asExportRedis(app.redis)
  const listed = r ? await queuedExportEntry(r, runId).catch(() => null) : null
  if (r && listed && (await takeBackExport(r, listed.raw))) {
    const t = waiting.get(runId)
    if (t) clearInterval(t)
    waiting.delete(runId)
    const { resumeJobRun } = await import('./job-runs.js')
    const run = resumeJobRun(runId, 'export', exportJobId(listed.job), {
      label: listed.job.label,
      triggeredBy: listed.job.user_id,
      startedAt: listed.job.started_at,
      guardRunning: true
    })
    await completeCancelled(listed.job, run)
    await releaseRunSlot(
      app.redis ?? null,
      listed.job.user_id,
      listed.job.slot,
      listed.job.slot_owner
    )
    await app.redis?.del(cancelKey(runId)).catch(() => {})
  }
  return 'stopped'
}

/** Test seam: wait for a run's job to settle. */
export function __waitForExportRun(runId: number): Promise<void> {
  return running.get(runId) ?? Promise.resolve()
}
