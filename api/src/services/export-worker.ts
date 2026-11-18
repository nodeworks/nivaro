import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { NIVARO_VERSION } from '../version.js'
import { releaseRunSlot, renewRunSlot } from './background-runs.js'
import {
  asExportRedis,
  beatExportWorker,
  claimNextExport,
  EXPORT_LEASE_RENEW_MS,
  EXPORT_QUEUE_MAX_WAIT_MS,
  type ExportJob,
  type ExportRedis,
  type ExportWorkerBeat,
  enqueueExport,
  exportDrainMode,
  exportKickChannel,
  exportWorkerParallel,
  LOST_EXPORT_NOTE,
  lostExportClaims,
  releaseExportClaim,
  renewExportLease,
  STALE_EXPORT_NOTE,
  shouldDrainExportsNow
} from './export-handoff.js'
import type { ImportDrainMode } from './import-handoff.js'
import { INSTANCE_ID } from './instance-roster.js'
import { emitJobProgress } from './live-progress.js'

/**
 * The export drainer (services/export-handoff.ts): runs background exports other processes
 * handed off. Started on every process that drains staged imports (exportDrainMode — the
 * importer, IMPORT_WORKER=on, the cron worker while no importer beats, a single process); a tick
 * every few seconds and on every kick. Each tick beats, fails runs whose drainer died, then
 * claims jobs up to exportWorkerParallel().
 */

const TICK_MS = 5_000
/** A stopping process waits this long for its runs to stop before putting jobs back. */
const SHUTDOWN_WAIT_MS = 8_000

/** Jobs this process is running from the list: lease renewal + the whole run (claim release included). */
const runningHere = new Map<
  number,
  { job: ExportJob; renew: ReturnType<typeof setInterval>; done: Promise<void> }
>()
let ticking = false
/** Set once the process is stopping: no new claims, no re-tick. */
let closing = false

function beatOf(mode: ImportDrainMode): ExportWorkerBeat {
  return {
    role: mode === 'importer' ? 'importer' : 'fallback',
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
    while (!closing && runningHere.size < exportWorkerParallel()) {
      // Pop + claim + lease in one script: a crash here never loses a job.
      const job = await claimNextExport(r, INSTANCE_ID)
      if (!job) break
      await startClaimed(app, r, job)
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
    await releaseExportClaim(r, job.run_id)
    return
  }
  // Every renewal: the run must still be running (another process may have ended it — then this
  // build stops at once), the lease and the person's slot get more time.
  const renew = setInterval(() => {
    void (async () => {
      const status = await runStatus(job.run_id)
      if (status != null && status !== 'running') {
        const { abortLocalExport } = await import('./export-runs.js')
        abortLocalExport(job.run_id)
        return
      }
      await renewExportLease(r, job.run_id, INSTANCE_ID)
      await renewRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner)
    })().catch(() => {})
  }, EXPORT_LEASE_RENEW_MS)
  renew.unref?.()
  let started: Promise<void>
  try {
    const { runHandedOffExport } = await import('./export-runs.js')
    started = runHandedOffExport(app, job)
  } catch (err) {
    // Claimed but it could not start: close the run rather than leave it "running".
    clearInterval(renew)
    await failRun(
      app,
      job,
      'The export could not be started on the export worker. Start it again.',
      {
        releaseSlot: true
      }
    )
    await releaseExportClaim(r, job.run_id)
    app.log.warn({ err, run: job.run_id }, '[export-worker] export did not start')
    return
  }
  const done = started
    .catch((err) => app.log.warn({ err, run: job.run_id }, '[export-worker] export failed'))
    .finally(async () => {
      clearInterval(renew)
      runningHere.delete(job.run_id)
      await releaseExportClaim(r, job.run_id)
      // A slot is free again: take the next waiting job now rather than at the next tick.
      if (!closing) void runInBackgroundPool(() => drainExportsTick(app))
    })
  runningHere.set(job.run_id, { job, renew, done })
}

/**
 * Claimed jobs whose drainer stopped renewing its lease: their run fails with a sentence. The
 * person's slot is NOT freed at once (a stalled-but-alive runner still holds it and will stop on
 * its next renewal); it expires on its own within two minutes.
 */
async function failLostRuns(app: FastifyInstance, r: ExportRedis): Promise<void> {
  for (const job of await lostExportClaims(r, new Set(runningHere.keys()))) {
    await failRun(app, job, LOST_EXPORT_NOTE, { releaseSlot: false })
    await releaseExportClaim(r, job.run_id)
    app.log.warn({ run: job.run_id }, '[export-worker] an export lost its process')
  }
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
 * The process is stopping (preClose): a job that has written nothing yet goes back on the list
 * for another drainer (its row untouched, its slot kept); one already under way fails at once
 * with a sentence instead of waiting for its lease to run out.
 */
export async function stopExportDrainerRuns(app: FastifyInstance): Promise<void> {
  closing = true
  const r = asExportRedis(app.redis)
  const { exportRowsDoneHere, stopExportForShutdown } = await import('./export-runs.js')
  const plans: Array<{ job: ExportJob; mode: 'requeue' | 'fail'; done: Promise<void> }> = []
  for (const [runId, entry] of runningHere) {
    const mode = (exportRowsDoneHere(runId) ?? 0) === 0 ? 'requeue' : 'fail'
    stopExportForShutdown(runId, mode)
    plans.push({ job: entry.job, mode, done: entry.done })
  }
  if (plans.length === 0) return
  await Promise.race([
    Promise.all(plans.map((p) => p.done)),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))
  ])
  // Claims are released by now (each run's chain): put the untouched jobs back.
  for (const p of plans) {
    if (p.mode !== 'requeue' || !r) continue
    await enqueueExport(r, p.job).catch((err) =>
      app.log.warn({ err, run: p.job.run_id }, '[export-worker] could not put an export back')
    )
  }
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
export async function startExportDrainer(app: FastifyInstance): Promise<ImportDrainMode> {
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
