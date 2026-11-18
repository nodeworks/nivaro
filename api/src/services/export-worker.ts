import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { NIVARO_VERSION } from '../version.js'
import { releaseRunSlot } from './background-runs.js'
import {
  asExportRedis,
  beatExportWorker,
  claimExport,
  EXPORT_LEASE_RENEW_MS,
  EXPORT_QUEUE_MAX_WAIT_MS,
  type ExportJob,
  type ExportRedis,
  type ExportWorkerBeat,
  exportDrainMode,
  exportKickChannel,
  exportWorkerParallel,
  LOST_EXPORT_NOTE,
  lostExportClaims,
  popExport,
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

/** Run ids this process is running from the list. */
const runningHere = new Map<number, ReturnType<typeof setInterval>>()
let ticking = false

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
  if (ticking) return
  ticking = true
  try {
    const mode = exportDrainMode()
    const r = asExportRedis(app.redis)
    if (!r || !(await shouldDrainExportsNow(mode, r))) return
    await beatExportWorker(r, beatOf(mode))
    await failLostRuns(app, r).catch((err) =>
      app.log.warn({ err }, '[export-worker] lost-run sweep failed')
    )
    while (runningHere.size < exportWorkerParallel()) {
      const job = await popExport(r)
      if (!job) break
      await startClaimed(app, r, job)
    }
  } catch (err) {
    app.log.error({ err }, '[export-worker] tick failed')
  } finally {
    ticking = false
  }
}

async function startClaimed(app: FastifyInstance, r: ExportRedis, job: ExportJob): Promise<void> {
  const waited = Date.now() - (job.queued_at ?? job.started_at)
  if (waited > EXPORT_QUEUE_MAX_WAIT_MS) {
    await failRun(app, job, STALE_EXPORT_NOTE)
    return
  }
  await claimExport(r, job, INSTANCE_ID)
  const renew = setInterval(() => {
    void renewExportLease(r, job.run_id, INSTANCE_ID)
  }, EXPORT_LEASE_RENEW_MS)
  renew.unref?.()
  runningHere.set(job.run_id, renew)
  const { runHandedOffExport } = await import('./export-runs.js')
  void runHandedOffExport(app, job)
    .catch((err) => app.log.warn({ err, run: job.run_id }, '[export-worker] export failed'))
    .finally(async () => {
      clearInterval(renew)
      runningHere.delete(job.run_id)
      await releaseExportClaim(r, job.run_id)
      // A slot is free again: take the next waiting job now rather than at the next tick.
      void runInBackgroundPool(() => drainExportsTick(app))
    })
}

/** Claimed jobs whose drainer stopped renewing its lease: their run fails with a sentence. */
async function failLostRuns(app: FastifyInstance, r: ExportRedis): Promise<void> {
  for (const job of await lostExportClaims(r, new Set(runningHere.keys()))) {
    await failRun(app, job, LOST_EXPORT_NOTE)
    await releaseExportClaim(r, job.run_id)
    app.log.warn({ run: job.run_id }, '[export-worker] an export lost its process')
  }
}

/** Close a run that will not be made: only while the row still says running. */
async function failRun(app: FastifyInstance, job: ExportJob, note: string): Promise<void> {
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
  await releaseRunSlot(app.redis ?? null, job.user_id, job.slot, job.slot_owner).catch(() => {})
  if (n !== 1) return
  emitJobProgress(job.user_id, {
    key: `job:${job.run_id}`,
    kind: 'export',
    label: job.label,
    status: 'error',
    error: note
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
export async function startExportDrainer(app: FastifyInstance): Promise<ImportDrainMode> {
  const mode = exportDrainMode()
  if (mode === 'off' || drainer || !asExportRedis(app.redis)) return mode
  const tick = () => void runInBackgroundPool(() => drainExportsTick(app))
  let sub: KickSubscriber | null = null
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
  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  tick()
  app.log.info({ mode }, '[export-worker] running background exports handed off by other processes')
  drainer = {
    stop: async () => {
      clearInterval(timer)
      const conn = sub
      if (conn) await (conn.quit?.() ?? Promise.resolve()).catch(() => conn.disconnect?.())
      drainer = null
    }
  }
  app.addHook('onClose', async () => drainer?.stop())
  return mode
}

/** Test seam. */
export function __exportRunsHere(): number[] {
  return [...runningHere.keys()]
}
