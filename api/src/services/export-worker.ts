import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { NIVARO_VERSION } from '../version.js'
import { releaseRunSlot, renewRunSlot } from './background-runs.js'
import { isMultiTenant } from './deployment-mode.js'
import {
  asExportRedis,
  beatExportWorker,
  beatKeyOf,
  beatRoleOf,
  claimNextExport,
  EXPORT_LEASE_RENEW_MS,
  EXPORT_QUEUE_MAX_WAIT_MS,
  EXPORT_STUCK_MS,
  type ExportDrainMode,
  type ExportJob,
  type ExportJudgement,
  type ExportRedis,
  type ExportWorkerBeat,
  enqueueExport,
  exportDrainerAlive,
  exportDrainMode,
  exportHandoffEnabled,
  exportKickChannel,
  exportWorkerConcurrency,
  INVALID_EXPORT_NOTE,
  judgeExportWorker,
  LOST_EXPORT_NOTE,
  lostExportClaims,
  queuedExportAges,
  readExportBeat,
  releaseExportClaim,
  releaseLostExportClaim,
  renewExportLease,
  STALE_EXPORT_NOTE,
  shouldDrainExportsNow,
  staleQueuedExports,
  takeBackExport
} from './export-handoff.js'
import { INSTANCE_ID } from './instance-roster.js'
import { EXPORT_HANDOFF_MARK } from './job-run-sweeps.js'
import { emitJobProgress } from './live-progress.js'

/**
 * The export drainer (services/export-handoff.ts): runs background exports other processes
 * handed off. Started on every process exportDrainMode() allows — the exporter
 * (NIVARO_ROLE=exporter), EXPORT_WORKER=on, the importer while no exporter beats, the cron worker
 * while neither beats, a single process; a tick every few seconds and on every kick. Each tick
 * beats, fails runs whose drainer died and entries that waited too long, then claims jobs up to
 * exportWorkerConcurrency().
 */

const TICK_MS = 5_000
/** A stopping process waits this long for its runs to stop before putting jobs back. */
/** A stopping process waits this long for its runs to stop (inside index.ts's 8 s exit deadline). */
const SHUTDOWN_WAIT_MS = 4_000
/** The lease holder value this process writes. */
const BY = INSTANCE_ID

/** Jobs this process is running from the list: lease renewal + the whole run (claim release included). */
const runningHere = new Map<
  number,
  {
    job: ExportJob
    renew: ReturnType<typeof setInterval>
    done: Promise<void>
    settled: boolean
    skipped: boolean
  }
>()
let ticking = false
/** Set once the process is stopping: no new claims, no re-tick. */
let closing = false

function beatOf(mode: ExportDrainMode): ExportWorkerBeat {
  return {
    role: beatRoleOf(mode),
    instance: INSTANCE_ID,
    name: process.env.NIVARO_INSTANCE?.trim() || null,
    version: NIVARO_VERSION,
    at: new Date().toISOString()
  }
}

/** One pass: beat, recover lost runs, claim what fits. Single-flight per process. */
export async function drainExportsTick(app: FastifyInstance): Promise<void> {
  if (ticking || closing) return
  ticking = true
  try {
    const mode = exportDrainMode()
    const r = asExportRedis(app.redis)
    if (!r || !(await shouldDrainExportsNow(mode, r))) return
    await beatExportWorker(r, beatOf(mode))
    await failLostRuns(app, r).catch((err) =>
      app.log.warn({ err }, '[export-worker] lost-run sweep failed')
    )
    while (!closing && runningHere.size < exportWorkerConcurrency()) {
      // Pop + validate + lease + claim in one script: a crash here never loses a job.
      const claimed = await claimNextExport(r, BY)
      if (!claimed) break
      if ('invalidRunId' in claimed) {
        // Another version's job (or garbage): its run must not stay "running" for ever.
        if (claimed.invalidRunId != null)
          await failRunById(claimed.invalidRunId, INVALID_EXPORT_NOTE)
        continue
      }
      await startClaimed(app, r, claimed.job)
    }
  } catch (err) {
    app.log.error({ err }, '[export-worker] tick failed')
  } finally {
    ticking = false
  }
}

/** The run's row status (null when it cannot be read). */
async function runStatus(runId: number): Promise<string | null> {
  try {
    const row = (await db('nivaro_job_runs').where({ id: runId }).first('status')) as
      | { status?: string }
      | undefined
    return row?.status ?? null
  } catch {
    return null
  }
}

async function startClaimed(app: FastifyInstance, r: ExportRedis, job: ExportJob): Promise<void> {
  const waited = Date.now() - (job.queued_at ?? job.started_at)
  if (waited > EXPORT_QUEUE_MAX_WAIT_MS) {
    await failRun(app, job, STALE_EXPORT_NOTE, { releaseSlot: true })
    await releaseExportClaim(r, job.run_id, BY)
    return
  }
  // Every renewal: the run must still be running and the lease still ours (else this build
  // stops at once); the lease and the person's slot get more time.
  const renew = setInterval(() => {
    void (async () => {
      const { abortLocalExport, exportCancelRequested } = await import('./export-runs.js')
      const status = await runStatus(job.run_id)
      const ours = status == null || status === 'running'
      if (!ours || !(await renewExportLease(r, job.run_id, BY))) {
        // Lost (lease or row taken from it): a failure, never "Cancelled".
        abortLocalExport(job.run_id, 'lost')
        return
      }
      // Cancel reaches a build stuck in an await that does not check (an upload, a commit).
      if (await exportCancelRequested(app, job.run_id)) {
        abortLocalExport(job.run_id)
        return
      }
      await renewRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner)
    })().catch(() => {})
  }, EXPORT_LEASE_RENEW_MS)
  renew.unref?.()
  const entry = {
    job,
    renew,
    settled: false,
    /** True when the process began stopping before the run started: the job is untouched. */
    skipped: false,
    done: Promise.resolve() as Promise<void>
  }
  // A run that could not start (it rejected before running) fails rather than stays "running".
  const started = (async () => {
    const { runHandedOffExport } = await import('./export-runs.js')
    const how = await runHandedOffExport(app, job, { mayStart: () => !closing })
    if (how === 'skipped') entry.skipped = true
  })()
  entry.done = started
    .catch(async (err) => {
      app.log.warn({ err, run: job.run_id }, '[export-worker] export did not start')
      await failRun(
        app,
        job,
        'The export could not be started on the export worker. Start it again.',
        { releaseSlot: true }
      )
    })
    .finally(async () => {
      clearInterval(renew)
      runningHere.delete(job.run_id)
      // Only while the claim is still ours (a job put back and claimed elsewhere keeps its claim).
      await releaseExportClaim(r, job.run_id, BY)
      entry.settled = true
      // A slot is free again: take the next waiting job now rather than at the next tick.
      if (!closing) void runInBackgroundPool(() => drainExportsTick(app))
    })
  runningHere.set(job.run_id, entry)
}

/**
 * Claimed jobs whose drainer stopped renewing its lease: their run fails with a sentence. The
 * person's slot is NOT freed at once (a stalled-but-alive runner still holds it and will stop on
 * its next renewal); it expires on its own within two minutes. Waiting entries older than
 * EXPORT_QUEUE_MAX_WAIT_MS (their starter's watcher may be gone — a job put back at a shutdown)
 * are taken off and failed too.
 */
async function failLostRuns(app: FastifyInstance, r: ExportRedis): Promise<void> {
  for (const lost of await lostExportClaims(r, new Set(runningHere.keys()))) {
    // Exactly the claim we judged (a renewal in between keeps it).
    if (!(await releaseLostExportClaim(r, lost.runId, lost.lease))) continue
    if (lost.job) await failRun(app, lost.job, LOST_EXPORT_NOTE, { releaseSlot: false })
    else await failRunById(lost.runId, LOST_EXPORT_NOTE)
    app.log.warn({ run: lost.runId }, '[export-worker] an export lost its process')
  }
  for (const stale of await staleQueuedExports(r)) {
    if (!(await takeBackExport(r, stale.raw))) continue
    await failRun(app, stale.job, STALE_EXPORT_NOTE, { releaseSlot: true })
  }
}

/** Close a run by id only (its job could not be read): guarded on `running`. */
async function failRunById(runId: number, note: string): Promise<void> {
  await db('nivaro_job_runs')
    .where({ id: runId, status: 'running' })
    .update({ status: 'error', error: note, finished_at: new Date() })
    .catch(() => 0)
}

/** Close a run that will not be made: only while the row still says running. */
async function failRun(
  app: FastifyInstance,
  job: ExportJob,
  note: string,
  opts: { releaseSlot: boolean }
): Promise<void> {
  const n = Number(
    await db('nivaro_job_runs')
      .where({ id: job.run_id, status: 'running' })
      .update({
        status: 'error',
        error: note,
        finished_at: new Date(),
        duration_ms: Math.max(0, Date.now() - job.started_at)
      })
      .catch(() => 0)
  )
  if (opts.releaseSlot)
    await releaseRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner).catch(() => {})
  else
    await renewRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner, 120).catch(
      () => {}
    )
  if (n !== 1) return
  emitJobProgress(job.user_id, {
    key: `job:${job.run_id}`,
    kind: 'export',
    label: job.label,
    status: 'error',
    error: note
  })
}

/**
 * The process is stopping (preClose). A job that has written nothing yet AND whose run stopped in
 * time goes back on the list — only while another drainer beats to take it (fix round 2: nobody
 * would ever run or fail it otherwise). Every other job fails at once with a sentence.
 */
export async function stopExportDrainerRuns(app: FastifyInstance): Promise<void> {
  closing = true
  const r = asExportRedis(app.redis)
  // Stop beating at once: the importer (or the worker) takes exports over without waiting for
  // this process's beat to expire. Only our own beat is removed.
  if (r) await dropOwnBeat(r).catch(() => {})
  const {
    exportRowsDoneHere,
    exportStoppedUntouched,
    SHUTDOWN_EXPORT_NOTE,
    stopExportForShutdown
  } = await import('./export-runs.js')
  const plans: Array<{
    job: ExportJob
    entry: { done: Promise<void>; settled: boolean; skipped: boolean }
  }> = []
  for (const [runId, entry] of runningHere) {
    const mode = (exportRowsDoneHere(runId) ?? 0) === 0 ? 'requeue' : 'fail'
    stopExportForShutdown(runId, mode)
    plans.push({ job: entry.job, entry })
  }
  if (plans.length === 0) return
  await Promise.race([
    Promise.all(plans.map((p) => p.entry.done)),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))
  ])
  const someoneElse = r ? await exportDrainerAlive(r, INSTANCE_ID) : false
  for (const p of plans) {
    // Put back only a job whose run fully stopped (its claim released) without writing a row —
    // never started, or stopped in time — and only while someone else will run it. Everything
    // else fails now rather than waiting on a lease.
    const untouched = p.entry.skipped || exportStoppedUntouched(p.job.run_id)
    if (p.entry.settled && untouched && someoneElse && r) {
      try {
        const { markHandedOff } = await import('./export-runs.js')
        // Waiting on the list again: no process's sweep may end it meanwhile.
        await markHandedOff(p.job.run_id, EXPORT_HANDOFF_MARK)
        await enqueueExport(r, p.job)
        continue
      } catch (err) {
        app.log.warn({ err, run: p.job.run_id }, '[export-worker] could not put an export back')
      }
    }
    await failRun(app, p.job, SHUTDOWN_EXPORT_NOTE, { releaseSlot: true })
  }
}

/** Remove this process's export beat (whichever role key holds it). */
async function dropOwnBeat(r: ExportRedis): Promise<void> {
  for (const role of ['exporter', 'importer', 'fallback'] as const) {
    const b = await readExportBeat(r, role)
    if (b?.instance === INSTANCE_ID) await r.del(beatKeyOf(role))
  }
}

/**
 * Readiness / preflight: is something draining the export hand-off? Reads the waiting entries and
 * the three heartbeats (judgeExportWorker).
 */
export async function exportWorkerJudgement(redis: unknown): Promise<ExportJudgement> {
  const r = asExportRedis(redis)
  const ages = r ? await queuedExportAges(r) : []
  return judgeExportWorker({
    cloud: isMultiTenant(),
    handoff: exportHandoffEnabled(),
    redis: !!r,
    exporter: await readExportBeat(r, 'exporter'),
    importer: await readExportBeat(r, 'importer'),
    fallback: await readExportBeat(r, 'fallback'),
    self: exportDrainMode(),
    queued: ages.length,
    stuck: ages.filter((a) => a > EXPORT_STUCK_MS).length
  })
}

interface KickSubscriber {
  subscribe: (c: string) => Promise<unknown>
  on: (e: string, fn: (...a: unknown[]) => void) => unknown
  quit?: () => Promise<unknown>
  disconnect?: () => void
}

let drainer: { stop: () => Promise<void> } | null = null

/**
 * Start draining exports on this process when it may (exportDrainMode). Hears the starter's
 * kick on a duplicated connection, so a handed-off export starts at once. Returns the mode.
 */
export async function startExportDrainer(app: FastifyInstance): Promise<ExportDrainMode> {
  const mode = exportDrainMode()
  if (mode === 'off' || drainer || !asExportRedis(app.redis)) return mode
  // Hooks first, before any await (a hook added once the server is up would throw).
  // preClose: the runs stop (and jobs that wrote nothing go back) before the server closes.
  app.addHook('preClose', async () => {
    await stopExportDrainerRuns(app).catch((err) =>
      app.log.warn({ err }, '[export-worker] stopping runs failed')
    )
  })
  app.addHook('onClose', async () => drainer?.stop())
  const tick = () => void runInBackgroundPool(() => drainExportsTick(app))
  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  let sub: KickSubscriber | null = null
  drainer = {
    stop: async () => {
      clearInterval(timer)
      const conn = sub
      if (conn) await (conn.quit?.() ?? Promise.resolve()).catch(() => conn.disconnect?.())
      drainer = null
    }
  }
  try {
    const dup = (app as unknown as { redis?: { duplicate?: () => unknown } }).redis?.duplicate?.()
    if (dup) {
      sub = dup as KickSubscriber
      sub.on('error', () => {})
      await sub.subscribe(exportKickChannel())
      sub.on('message', () => tick())
    }
  } catch {
    sub = null
  }
  tick()
  app.log.info({ mode }, '[export-worker] running background exports handed off by other processes')
  return mode
}

/** Test seams. */
export function __exportRunsHere(): number[] {
  return [...runningHere.keys()]
}
export function __resetExportWorker(): void {
  closing = false
  ticking = false
}
