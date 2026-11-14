import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import type { User } from '../types.js'
import {
  claimRunSlot,
  estimateRead,
  MAX_RUNNING_PER_USER,
  recordReadDuration,
  releaseRunSlot
} from './background-runs.js'
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
 * One person runs at most MAX_RUNNING_PER_USER background reads at once (the slots are the
 * ones slow reads in the background use).
 */

export type ExportRunKind = 'preset' | 'items' | 'audit'

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

export interface ExportFile {
  buffer: Buffer
  filename: string
  contentType: string
  rows: number
  /** More rows matched than one export holds. */
  truncated?: boolean
}

export type ExportBuilder = (ctx: ExportContext) => Promise<ExportFile>

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
const cancelKey = (runId: number) => `nvr:export-cancel:${currentTenantKey() || '-'}:${runId}`
/** Runs this process is executing: a cancel answered here aborts at once. */
const local = new Map<string, AbortController>()
const localKey = (runId: number) => `${currentTenantKey() || '-'}:${runId}`
/** Test seam: the job promise per run id. */
const running = new Map<number, Promise<void>>()

export const cancelPath = (runId: number) => `/export-runs/${runId}/cancel`

/**
 * Start an export as a background job, as `user`. Resolves once the run is recorded (its id is
 * the tray key); the build runs after the response, on the background pool.
 */
export async function startExportRun(
  app: FastifyInstance,
  opts: {
    user: User
    kind: ExportRunKind
    /** Preset id, collection, … — the job id's tail and the duration estimate's key. */
    subject: string
    /** What is being exported ("Workflows", "Friday finance"). */
    label: string
    /** Rows expected, when the start already knows. */
    total?: number | null
    build: ExportBuilder
  }
): Promise<StartedExport> {
  const user = opts.user
  const redis = app.redis ?? null
  const slotOwner = `export:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
  const slot = await claimRunSlot(redis, user.id, slotOwner)
  if (slot == null)
    throw new ExportRunError(
      429,
      `You already have ${MAX_RUNNING_PER_USER} exports or reads running in the background — wait for one to finish`,
      'BACKGROUND_BUSY'
    )
  const label = `Exporting ${opts.label}`.slice(0, 200)
  let run: JobRunHandle
  try {
    run = await startJobRun(
      'export',
      `${EXPORT_JOB_PREFIX}${opts.kind}:${opts.subject}`.slice(0, 200),
      {
        label,
        triggeredBy: user.id,
        trigger: 'manual'
      }
    )
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

  const controller = new AbortController()
  local.set(localKey(runId), controller)
  const startedAt = Date.now()

  const job = new Promise<void>((resolve) => {
    // After this response: the build must not hold the start request open.
    setImmediate(() => {
      void runInBackgroundPool(() =>
        execute(app, { ...opts, label }, run, runId, controller, startedAt)
      )
        .catch((err) => app.log?.warn?.({ err, run: runId }, 'Background export failed'))
        .finally(() => {
          local.delete(localKey(runId))
          running.delete(runId)
          void releaseRunSlot(redis, user.id, slot, slotOwner)
          resolve()
        })
    })
  })
  running.set(runId, job)
  return { run_id: runId, key: `job:${runId}`, label, total, cancel_path: cancelPath(runId) }
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

async function execute(
  app: FastifyInstance,
  opts: { user: User; kind: ExportRunKind; subject: string; label: string; build: ExportBuilder },
  run: JobRunHandle,
  runId: number,
  controller: AbortController,
  startedAt: number
): Promise<void> {
  const { user } = opts
  let lastEmit = 0
  let lastFlagCheck = 0
  let last: ExportProgress = { done: 0, total: null }
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
      // Builders report per chunk; the row and the tray hear at most ~2 a second.
      if (Date.now() - lastEmit < 500) return
      lastEmit = Date.now()
      run.progress({ phase: p.phase ?? 'Reading rows', done: p.done, total: p.total, unit: 'rows' })
    }
  }
  try {
    await throwIfCancelled()
    const file = await opts.build(ctx)
    await throwIfCancelled()
    run.progress({
      phase: 'Saving the file',
      done: file.rows,
      total: last.total ?? file.rows,
      unit: 'rows'
    })
    const { uploadFileBuffer } = await import('./files.js')
    // A private file: only its maker (and administrators) can read it.
    const stored = await uploadFileBuffer(
      user,
      file.buffer,
      file.filename,
      file.contentType,
      undefined,
      {
        private: true
      }
    )
    const fileId = String(stored.id)
    const rowsText = `${file.rows.toLocaleString('en-US')} ${file.rows === 1 ? 'row' : 'rows'}`
    // "name → file <id>" is what /my-jobs reads the Download chip from.
    await run.complete(
      `${file.truncated ? `First ${rowsText}` : rowsText} · ${file.filename} → file ${fileId}`,
      { file_id: fileId }
    )
    noteExportDuration(opts.kind, opts.subject, Date.now() - startedAt, app.redis ?? null)
    await notifyReady(app, user.id, fileId, file).catch(() => {})
  } catch (err) {
    if (err instanceof ExportCancelled || controller.signal.aborted) {
      await run.complete('Cancelled')
      emitJobProgress(user.id, {
        key: `job:${runId}`,
        kind: 'export',
        label: opts.label,
        status: 'canceled',
        outcome: 'Cancelled'
      })
      return
    }
    await run.fail(err)
  } finally {
    if (app.redis) await app.redis.del(cancelKey(runId)).catch(() => {})
  }
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
    status: cancelled
      ? ('canceled' as const)
      : row.status === 'running'
        ? ('running' as const)
        : row.status === 'error'
          ? ('error' as const)
          : ('completed' as const),
    progress,
    outcome: row.outcome,
    error: row.error ? String(row.error).split('\n')[0].slice(0, 300) : null,
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
  if (here) here.abort()
  if (app.redis) await app.redis.setex(cancelKey(runId), CANCEL_TTL_S, '1').catch(() => {})
  return 'stopped'
}

/** Test seam: wait for a run's job to settle. */
export function __waitForExportRun(runId: number): Promise<void> {
  return running.get(runId) ?? Promise.resolve()
}
