import { db } from '../db/index.js'
import { getApp } from './io-holder.js'
import { type JobRunHandle, type JobRunKind, startJobRun } from './job-runs.js'
import { announceRecordAspect } from './record-events.js'
import { currentTenantKey } from './tenant-rooms.js'
import { TransitionBlockedError } from './workflow-actions.js'

/**
 * Moves that run in the background.
 *
 * A transition whose actions call a partner can take most of a minute. Marked
 * "runs in the background" (`"background": true` on one of its actions, in the
 * transition's own `actions` JSON), every run of it on a record holds that
 * record's RUN: one row in nivaro_job_runs (kind `transition`, job id
 * `transition:<instance id>`) that says who started it, which move it is and
 * that it is still alive. The row is what the pipeline panel shows as "running",
 * what refuses a second run, and what stays behind when a process dies:
 *
 *   running      status `running`, a heartbeat (`progress.beat`) every BEAT_MS
 *   moved        status `completed`, outcome "Moved to <state>"
 *   refused      status `error`, error = the reason an inline run shows
 *   interrupted  status `interrupted`: the process stopped (the existing
 *                shutdown and boot sweeps of nivaro_job_runs), or the heartbeat
 *                went quiet past LEASE_MS. The record was not moved by it, the
 *                person who started it is told, and the record is free again.
 *
 * Nothing here runs a transition or decides whether one may run. A caller that
 * opted in (`accept_pending`) answers 202 once the run is held and finishes in
 * the background (record-transition.ts); every other caller runs it while it
 * waits, exactly as before, and holds the same run for as long as that takes.
 * A transition without the mark never reaches this file.
 */

const KIND: JobRunKind = 'transition'
export const TRANSITION_RUN_KIND = 'transition'
export const TRANSITION_RUNNING = 'TRANSITION_RUNNING'

/** How often a live run says so. */
export const BEAT_MS = 10_000
/** A run silent this long has lost its process. Six missed beats. */
export const LEASE_MS = 60_000
/** At most one sweep of abandoned runs per process in this time. */
const SWEEP_EVERY_MS = 30_000

export type TransitionRunMode = 'background' | 'inline' | 'auto'

export interface TransitionRunView {
  id: number
  transition_id: string | null
  transition_label: string | null
  started_at: string
  started_by: string | null
  started_by_name: string | null
  mode: TransitionRunMode
}

export interface TransitionRunProblem extends TransitionRunView {
  /** `refused`: a check or the partner said no, nothing moved. `interrupted`:
   *  it stopped before it finished. `failed`: something of ours went wrong. */
  result: 'refused' | 'interrupted' | 'failed'
  reason: string | null
  finished_at: string | null
}

export interface TransitionRunHandle {
  id: number
  view: TransitionRunView
  /** The record moved. */
  moved(toStateLabel: string | null): Promise<void>
  /** It did not: `err` is what an inline run would have answered with. */
  refused(err: unknown): Promise<void>
  /** Given up before anything ran (the twin of a press already being applied). */
  cancel(): Promise<void>
}

/** Another run of a background move holds the record. Reads as a blocked move
 *  to every caller that already handles one (bulk, GraphQL, the registry). */
export class TransitionRunningError extends TransitionBlockedError {
  code = TRANSITION_RUNNING
  override statusCode = 409
  run: TransitionRunView
  constructor(run: TransitionRunView) {
    super(runningMessage(run))
    this.run = run
  }
}

const truthy = (v: unknown) => v === true || v === 1 || v === 'true' || v === '1'

/**
 * Whether a transition is marked to run in the background: one of its actions
 * carries `"background": true`. Takes the stored JSON or the parsed array.
 * Anything else (no actions, malformed JSON, the flag absent) is "no".
 */
export function runsInBackground(actions: unknown): boolean {
  let list: unknown = actions
  if (typeof actions === 'string') {
    // The common case costs no parse: a transition without the word is not marked.
    if (!actions.includes('"background"')) return false
    try {
      list = JSON.parse(actions)
    } catch {
      return false
    }
  }
  if (!Array.isArray(list)) return false
  return list.some(
    (a) => !!a && typeof a === 'object' && truthy((a as { background?: unknown }).background)
  )
}

export function transitionRunJobId(instanceId: string): string {
  return `transition:${String(instanceId).toUpperCase()}`
}

/** "20 seconds ago" / "3 minutes ago", for a run that started moments ago. */
function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 5) return 'just now'
  if (s < 90) return `${s} seconds ago`
  const m = Math.round(s / 60)
  return `${m} minute${m === 1 ? '' : 's'} ago`
}

/** The refusal a second run gets: the item-action wording, plus who and when. */
export function runningMessage(run: TransitionRunView, now = Date.now()): string {
  const label = run.transition_label?.trim() || 'A move'
  const who =
    run.mode === 'auto'
      ? `started automatically ${ago(run.started_at, now)}`
      : `started ${run.started_by_name ? `by ${run.started_by_name} ` : ''}${ago(run.started_at, now)}`
  return `${label} is already running on this record (${who}). Wait for it to finish, then check the result.`
}

interface RunRow {
  id: number
  label: string | null
  status: string
  started_at: Date | string
  finished_at: Date | string | null
  outcome: string | null
  error: string | null
  progress: string | null
}

interface RunMeta {
  instance_id: string | null
  transition_id: string | null
  transition_label: string | null
  collection: string | null
  item: string | null
  by: string | null
  by_name: string | null
  mode: TransitionRunMode
  record_label: string | null
  beat: string | null
  result: string | null
}

const COLUMNS = [
  'id',
  'label',
  'status',
  'started_at',
  'finished_at',
  'outcome',
  'error',
  'progress'
] as const

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function metaOf(row: Pick<RunRow, 'progress'>): RunMeta {
  let p: Record<string, unknown> = {}
  try {
    const v = row.progress ? JSON.parse(row.progress) : null
    if (v && typeof v === 'object' && !Array.isArray(v)) p = v as Record<string, unknown>
  } catch {
    p = {}
  }
  const mode = p.mode === 'background' || p.mode === 'auto' ? p.mode : 'inline'
  return {
    instance_id: text(p.instance_id),
    transition_id: text(p.transition_id),
    transition_label: text(p.transition_label),
    collection: text(p.collection),
    item: text(p.item),
    by: text(p.by),
    by_name: text(p.by_name),
    mode,
    record_label: text(p.record_label),
    beat: text(p.beat),
    result: text(p.result)
  }
}

const isoOf = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function viewOf(row: RunRow, meta = metaOf(row)): TransitionRunView {
  return {
    id: Number(row.id),
    transition_id: meta.transition_id,
    transition_label: meta.transition_label ?? row.label,
    started_at: isoOf(row.started_at) ?? new Date().toISOString(),
    started_by: meta.by,
    started_by_name: meta.by_name,
    mode: meta.mode
  }
}

/** A running row whose process has gone quiet (or one a sweep already closed). */
export function leaseExpired(
  row: Pick<RunRow, 'status' | 'started_at' | 'progress'>,
  now = Date.now()
): boolean {
  if (row.status !== 'running') return false
  const last = metaOf(row).beat ?? isoOf(row.started_at)
  const at = last ? new Date(last).getTime() : Number.NaN
  return !Number.isFinite(at) || now - at > LEASE_MS
}

/** Marks a run that was closed for its process: the starter has been told. */
const STOPPED_OUTCOME = 'Stopped before it finished'
const STOPPED_REASON =
  'It stopped before it finished, so the record was not moved. If this step sends something to another system, check there before you run it again.'
/** The process stopped after the state had changed: what follows a move may not have run. */
const STOPPED_AFTER_MOVE =
  'The record moved, but the run stopped before everything that follows the move had finished (updates to other systems, notifications). Check the record.'
/** The history could not be read: say only what is known. */
const STOPPED_UNKNOWN =
  'It stopped before it finished. Open the record to see where it is now, and check any other system this step sends to before you run it again.'
const FAILED_REASON = 'Something went wrong while it ran. Open the record to see where it is now.'
/** The outcome of a run that gave way before anything ran: never shown as a result. */
const NOT_STARTED = 'Not started'

async function tell(
  meta: RunMeta,
  subject: string,
  message: string,
  userId: string | null = meta.by
): Promise<void> {
  if (!userId) return
  try {
    const app = getApp()
    if (!app) return
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, userId, {
      subject,
      message,
      ...(meta.collection ? { collection: meta.collection } : {}),
      ...(meta.item ? { item: meta.item } : {}),
      // The words a finished bulk push uses: a result of something this person started.
      category: 'system',
      always_inbox: true
    })
  } catch {
    /* the run's row holds the outcome; the panel shows it */
  }
}

const subjectFor = (meta: RunMeta, what: string) =>
  `${meta.transition_label ?? 'The move'} ${what}${meta.record_label ? `: ${meta.record_label}` : ''}`

/**
 * Whether the run's own move reached the record's history before its process
 * stopped (the state changes before the actions that follow a move run).
 * Null = could not be read.
 */
async function moveLanded(meta: RunMeta, row: RunRow): Promise<boolean | null> {
  if (!meta.instance_id || !meta.transition_id) return false
  try {
    const hit = await db('nivaro_workflow_history')
      .where({ instance: meta.instance_id, transition: meta.transition_id })
      .where('timestamp', '>=', new Date(row.started_at))
      .first('id')
    return !!hit
  } catch {
    return null
  }
}

/**
 * Close a run whose process is gone. Nothing is run again: whether the partner
 * was reached is not known, only whether the record moved. Whoever closes it
 * first (one UPDATE wins) tells the person who started it. Also adopts a row
 * the job-run sweeps already marked `interrupted` (a shutdown, a boot) and
 * nobody has been told about yet.
 */
async function releaseAbandoned(row: RunRow): Promise<boolean> {
  const meta = metaOf(row)
  const landed = await moveLanded(meta, row)
  const reason = landed ? STOPPED_AFTER_MOVE : landed === false ? STOPPED_REASON : STOPPED_UNKNOWN
  let won = 0
  try {
    won = Number(
      await db('nivaro_job_runs')
        .where({ id: row.id })
        .whereIn('status', ['running', 'interrupted'])
        .whereNull('outcome')
        .update({
          status: 'interrupted',
          finished_at: row.finished_at ?? new Date(),
          outcome: STOPPED_OUTCOME,
          error: reason,
          progress: JSON.stringify({ ...meta, result: 'interrupted' })
        })
    )
  } catch {
    return false
  }
  if (won !== 1) return false
  if (meta.collection && meta.item) announceRecordAspect(meta.collection, meta.item, '$state')
  // An automatic run started nobody.
  if (meta.mode !== 'auto') await tell(meta, subjectFor(meta, 'stopped before it finished'), reason)
  return true
}

async function runningRows(jobId: string): Promise<RunRow[]> {
  return (await db('nivaro_job_runs')
    .where({ kind: TRANSITION_RUN_KIND, job_id: jobId, status: 'running' })
    .orderBy('id', 'asc')
    .limit(10)
    .select(...COLUMNS)) as RunRow[]
}

/** The run that holds this record now, or null. Abandoned ones are closed on the way. */
async function liveRun(jobId: string): Promise<RunRow | null> {
  for (const row of await runningRows(jobId)) {
    if (leaseExpired(row)) {
      await releaseAbandoned(row)
      continue
    }
    return row
  }
  return null
}

/** Per tenant: this module's state is shared by every tenant of the process. */
const lastSweep = new Map<string, number>()

/**
 * Close every abandoned run, whichever record it is on: a run nobody looks at
 * would otherwise wait for its record to be opened. Asked for whenever the
 * feature is used (a take, a panel read on a pipeline that has a background
 * move), at most once per SWEEP_EVERY_MS per process, so a deployment that
 * marks no transition never runs it.
 */
export async function sweepAbandonedRuns(force = false): Promise<number> {
  const now = Date.now()
  const tenant = currentTenantKey() || '-'
  if (!force && now - (lastSweep.get(tenant) ?? 0) < SWEEP_EVERY_MS) return 0
  lastSweep.set(tenant, now)
  let closed = 0
  try {
    const rows = (await db('nivaro_job_runs')
      .where({ kind: TRANSITION_RUN_KIND })
      .whereIn('status', ['running', 'interrupted'])
      .whereNull('outcome')
      .where('started_at', '<', new Date(now - LEASE_MS))
      .orderBy('id', 'asc')
      .limit(50)
      .select(...COLUMNS)) as RunRow[]
    for (const row of rows) {
      if (row.status === 'interrupted' || leaseExpired(row, now)) {
        if (await releaseAbandoned(row)) closed++
      }
    }
  } catch {
    /* the next reader of each record still closes its own */
  }
  return closed
}

async function nameOf(userId: string | null): Promise<string | null> {
  if (!userId) return null
  try {
    const u = (await db('nivaro_users')
      .where({ id: userId })
      .first('first_name', 'last_name', 'email')) as
      | { first_name: string | null; last_name: string | null; email: string | null }
      | undefined
    return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || null
  } catch {
    return null
  }
}

/**
 * Hold this record's run for a background move, or refuse because one is
 * already held (TransitionRunningError). Null = the run could not be recorded;
 * the caller then runs the move the way it always did, without one.
 */
export async function takeTransitionRun(opts: {
  instance: { id: string; collection: string; item: string }
  transition: { id: string; label: string }
  userId: string | null
  mode: TransitionRunMode
  /** The record as people name it ("IR-1042"), for the Jobs tray and the notification. */
  recordLabel?: string | null
}): Promise<TransitionRunHandle | null> {
  try {
    return await takeRun(opts)
  } catch (err) {
    if (err instanceof TransitionRunningError) throw err
    // The run's own bookkeeping never stops a move: it goes on without one.
    return null
  }
}

async function takeRun(opts: {
  instance: { id: string; collection: string; item: string }
  transition: { id: string; label: string }
  userId: string | null
  mode: TransitionRunMode
  recordLabel?: string | null
}): Promise<TransitionRunHandle | null> {
  const jobId = transitionRunJobId(opts.instance.id)
  void sweepAbandonedRuns()

  const held = await liveRun(jobId)
  if (held) throw new TransitionRunningError(viewOf(held))

  const meta: RunMeta = {
    instance_id: String(opts.instance.id),
    transition_id: String(opts.transition.id),
    transition_label: opts.transition.label,
    collection: opts.instance.collection,
    item: String(opts.instance.item),
    by: opts.userId,
    by_name: await nameOf(opts.userId),
    mode: opts.mode,
    record_label: opts.recordLabel?.trim() || null,
    beat: new Date().toISOString(),
    result: null
  }
  const startedAt = new Date()
  const job: JobRunHandle = await startJobRun(KIND, jobId, {
    label: `${opts.transition.label} · ${meta.record_label ?? `${meta.collection} ${meta.item}`}`,
    // Only a run its starter does not wait for belongs in their Jobs tray.
    triggeredBy: opts.mode === 'background' ? opts.userId : null
  })
  if (job.id == null) return null
  const id = job.id
  const writeProgress = (patch: Partial<RunMeta> = {}) =>
    db('nivaro_job_runs')
      .where({ id })
      .update({ progress: JSON.stringify({ ...meta, ...patch }) })
  try {
    await writeProgress()
  } catch {
    // Without who and what, the row cannot be read as a run: let it go.
    await job.complete(NOT_STARTED).catch(() => {})
    return null
  }

  // Two takes at the same moment both saw nothing held. The older row keeps it.
  const first = (await runningRows(jobId)).find((r) => !leaseExpired(r))
  if (first && Number(first.id) !== id) {
    await writeProgress({ result: 'cancelled' }).catch(() => {})
    await job.complete(NOT_STARTED).catch(() => {})
    throw new TransitionRunningError(viewOf(first))
  }

  const beat = setInterval(() => {
    meta.beat = new Date().toISOString()
    writeProgress().catch(() => {})
  }, BEAT_MS)
  beat.unref?.()
  let open = true
  const close = () => {
    open = false
    clearInterval(beat)
  }
  const view: TransitionRunView = {
    id,
    transition_id: meta.transition_id,
    transition_label: meta.transition_label,
    started_at: startedAt.toISOString(),
    started_by: meta.by,
    started_by_name: meta.by_name,
    mode: meta.mode
  }
  // Every open copy of the record shows "running" now, not at its next reload.
  announceRecordAspect(meta.collection, meta.item, '$state')

  return {
    id,
    view,
    async moved(toStateLabel) {
      if (!open) return
      close()
      try {
        // A reader that lost patience may have closed this run as stopped and
        // told its starter so. It finished after all: the row and the starter
        // get the truth. (A row a shutdown merely marked, with nobody told,
        // is simply completed.)
        const before = (await db('nivaro_job_runs').where({ id }).first('status', 'outcome')) as
          | { status: string; outcome: string | null }
          | undefined
        const toldStopped = before?.outcome === STOPPED_OUTCOME
        await db('nivaro_job_runs')
          .where({ id })
          .update({
            progress: JSON.stringify({ ...meta, result: 'moved' }),
            ...(toldStopped ? { error: null } : {})
          })
        await job.complete(toStateLabel ? `Moved to ${toStateLabel}` : 'Moved')
        if (toldStopped && meta.mode !== 'auto')
          await tell(
            meta,
            subjectFor(meta, 'finished after all'),
            toStateLabel ? `The record is now at ${toStateLabel}.` : 'The record moved.'
          )
      } catch {
        /* bookkeeping never undoes a move */
      }
      announceRecordAspect(meta.collection, meta.item, '$state')
    },
    async refused(err) {
      if (!open) return
      close()
      // A refusal written for people (a check, the partner's answer) is kept
      // as it is: it is what an inline run shows, and it comes before anything
      // has moved. Anything else is ours, and says nothing about the record.
      const known = err instanceof TransitionBlockedError || isRefusalForPeople(err)
      const reason = known ? (err as Error).message.slice(0, 1500) : FAILED_REASON
      try {
        await writeProgress({ result: known ? 'refused' : 'failed' })
        await job.fail(reason)
      } catch {
        /* the caller still answers or notifies with the reason */
      }
      announceRecordAspect(meta.collection, meta.item, '$state')
      // Someone who waited for the answer already has it.
      if (meta.mode === 'background')
        await tell(
          meta,
          subjectFor(meta, known ? 'did not go through' : 'ran into a problem'),
          reason
        )
    },
    async cancel() {
      if (!open) return
      close()
      try {
        await writeProgress({ result: 'cancelled' })
        await job.complete(NOT_STARTED)
      } catch {
        /* a row left running is closed by its lease */
      }
      announceRecordAspect(meta.collection, meta.item, '$state')
    }
  }
}

/** A 4xx thrown with a sentence for the person (a move with nowhere to go). */
function isRefusalForPeople(err: unknown): boolean {
  const status = Number((err as { statusCode?: unknown } | null)?.statusCode)
  return err instanceof Error && Number.isInteger(status) && status >= 400 && status < 500
}

/**
 * What the pipeline panel shows for a record: the run that holds it now, and
 * the last run that did not move it, if that happened since the record came
 * to the step it is at (`since`). Read only for pipelines that have a
 * background move.
 */
export async function transitionRunState(
  instanceId: string,
  opts: { since?: Date | string | null } = {}
): Promise<{ running: TransitionRunView | null; problem: TransitionRunProblem | null }> {
  void sweepAbandonedRuns()
  const rows = (await db('nivaro_job_runs')
    .where({ kind: TRANSITION_RUN_KIND, job_id: transitionRunJobId(instanceId) })
    .orderBy('id', 'desc')
    .limit(5)
    .select(...COLUMNS)) as RunRow[]
  let running: TransitionRunView | null = null
  for (const row of rows) {
    if (row.status !== 'running') continue
    if (leaseExpired(row)) {
      // Closed here (or by whoever got there first), then read as it now
      // stands: it shows below as the run that stopped, or as whatever its
      // process wrote if that was alive after all.
      await releaseAbandoned(row)
      const now = (await db('nivaro_job_runs')
        .where({ id: row.id })
        .first(...COLUMNS)) as RunRow | undefined
      if (now) Object.assign(row, now)
      // Still unreleased and still silent: not shown as running either.
      if (row.status !== 'running' || leaseExpired(row)) continue
    }
    running = viewOf(row)
  }
  // The newest run that ran to an end decides: one that moved the record
  // leaves nothing to say. A run that gave way before it started is not one.
  const last = rows.find((r) => r.status !== 'running' && r.outcome !== NOT_STARTED)
  let problem: TransitionRunProblem | null = null
  if (last && (last.status === 'error' || last.status === 'interrupted')) {
    const meta = metaOf(last)
    const since = isoOf(opts.since ?? null)
    const started = isoOf(last.started_at)
    const current = !since || !started || new Date(started).getTime() >= new Date(since).getTime()
    if (current) {
      problem = {
        ...viewOf(last, meta),
        result:
          last.status === 'interrupted'
            ? 'interrupted'
            : meta.result === 'failed'
              ? 'failed'
              : 'refused',
        reason: firstLine(last.error) ?? (last.status === 'interrupted' ? STOPPED_UNKNOWN : null),
        finished_at: isoOf(last.finished_at)
      }
    }
  }
  return { running, problem }
}

/** A stored error may carry a stack under its first line. */
function firstLine(v: string | null): string | null {
  const line = String(v ?? '')
    .split('\n')[0]
    .trim()
  return line || null
}
