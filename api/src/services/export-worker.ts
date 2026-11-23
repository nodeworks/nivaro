import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { withTenant } from '../db/tenant-context.js'
import { NIVARO_VERSION } from '../version.js'
import { type AppFanOutResult, forEachApp, listApps } from './app-jobs.js'
import { appBox } from './app-state.js'
import { releaseRunSlot, renewRunSlot } from './background-runs.js'
import { isNivaroCloud, perAppJobs } from './deployment-mode.js'
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
import { parseKick } from './import-handoff.js'
import { INSTANCE_ID } from './instance-roster.js'
import { EXPORT_HANDOFF_MARK } from './job-run-sweeps.js'
import { emitJobProgress } from './live-progress.js'
import { isWorkerOnlyRole } from './process-role.js'
import { appReadyForRequests, storedAppSchemaOk } from './tenancy/app-migrations.js'
import { getTenantRegistry } from './tenancy/registry.js'
import type { TenantRecord } from './tenancy/types.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * The export drainer (services/export-handoff.ts): runs background exports other processes
 * handed off. Started on every process exportDrainMode() allows — the exporter
 * (NIVARO_ROLE=exporter), EXPORT_WORKER=on, the importer while no exporter beats, the cron worker
 * while neither beats, a single process; a tick every few seconds and on every kick. Each tick
 * beats, fails runs whose drainer died and entries that waited too long, then claims jobs up to
 * exportWorkerConcurrency().
 *
 * Hub shared deployment (Task 15): a tick runs inside one app and drains that app's list only;
 * every drainer runs a pass over every listed, ready app every SHARED_PASS_MS
 * (drainEveryAppExports) and drains the app a kick names at once (onExportKick). The jobs this
 * process holds are keyed `<app>:<run id>` (copied apps share run ids); the concurrency limit is
 * the process's, over every app.
 */

const TICK_MS = 5_000
/** Shared deployment: how often a drainer passes over every app (kicks start a run at once). */
const SHARED_PASS_MS = 10_000
/** A stopping process waits this long for its runs to stop before putting jobs back. */
/** A stopping process waits this long for its runs to stop (inside index.ts's 8 s exit deadline). */
const SHUTDOWN_WAIT_MS = 4_000
/** The lease holder value this process writes. */
const BY = INSTANCE_ID

type InApp = ReturnType<typeof AsyncLocalStorage.snapshot>

/** Jobs this process is running from the list: lease renewal + the whole run (claim release
 *  included). Keyed `<app|->:<run id>` (hereKey); each entry keeps its app's context (inApp), so a
 *  stopping process ends it inside that app. */
const runningHere = new Map<
  string,
  {
    job: ExportJob
    /** The app the job belongs to (currentTenantKey, '-' self-hosted). */
    app: string
    inApp: InApp
    renew: ReturnType<typeof setInterval>
    done: Promise<void>
    settled: boolean
    skipped: boolean
  }
>()
const appPart = () => currentTenantKey() || '-'
const hereKey = (runId: number) => `${currentTenantKey() || '-'}:${runId}`
/** The run ids this process holds for the app it is in. */
function runIdsHere(): Set<number> {
  const mine = appPart()
  const out = new Set<number>()
  for (const e of runningHere.values()) if (e.app === mine) out.add(e.job.run_id)
  return out
}
/** One pass per app at a time (overlapping ticks); another app's pass is never held up. */
const ticking = appBox(() => false)
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

/** One pass: beat, recover lost runs, claim what fits. Single-flight per process (per app on a
 *  shared deployment, inside that app). */
export async function drainExportsTick(app: FastifyInstance): Promise<void> {
  // A shared deployment drains inside an app only: outside one there is no app's list to read.
  if (perAppJobs() && !currentTenantKey()) return
  if (ticking.value || closing) return
  ticking.value = true
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
    ticking.value = false
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
    app: appPart(),
    inApp: AsyncLocalStorage.snapshot(),
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
      runningHere.delete(hereKey(job.run_id))
      // Only while the claim is still ours (a job put back and claimed elsewhere keeps its claim).
      await releaseExportClaim(r, job.run_id, BY)
      entry.settled = true
      // A slot is free again: take the next waiting job now rather than at the next tick.
      if (!closing) void runInBackgroundPool(() => drainExportsTick(app))
    })
  runningHere.set(hereKey(job.run_id), entry)
}

/**
 * Claimed jobs whose drainer stopped renewing its lease: their run fails with a sentence. The
 * person's slot is NOT freed at once (a stalled-but-alive runner still holds it and will stop on
 * its next renewal); it expires on its own within two minutes. Waiting entries older than
 * EXPORT_QUEUE_MAX_WAIT_MS (their starter's watcher may be gone — a job put back at a shutdown)
 * are taken off and failed too.
 */
async function failLostRuns(app: FastifyInstance, r: ExportRedis): Promise<void> {
  for (const lost of await lostExportClaims(r, runIdsHere())) {
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
  if (r) await dropOwnBeats(r).catch(() => {})
  const {
    exportRowsDoneHere,
    exportStoppedUntouched,
    SHUTDOWN_EXPORT_NOTE,
    stopExportForShutdown
  } = await import('./export-runs.js')
  const plans: Array<{
    job: ExportJob
    entry: { done: Promise<void>; settled: boolean; skipped: boolean; inApp: InApp }
  }> = []
  for (const entry of runningHere.values()) {
    // Inside the job's own app: its local run, its rows and its row are that app's.
    entry.inApp(() => {
      const runId = entry.job.run_id
      const mode = (exportRowsDoneHere(runId) ?? 0) === 0 ? 'requeue' : 'fail'
      stopExportForShutdown(runId, mode)
    })
    plans.push({ job: entry.job, entry })
  }
  if (plans.length === 0) return
  await Promise.race([
    Promise.all(plans.map((p) => p.entry.done)),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))
  ])
  for (const p of plans) {
    await p.entry.inApp(async () => {
      // Put back only a job whose run fully stopped (its claim released) without writing a row —
      // never started, or stopped in time — and only while someone else (for this app) will run
      // it. Everything else fails now rather than waiting on a lease.
      const untouched = p.entry.skipped || exportStoppedUntouched(p.job.run_id)
      const someoneElse = r ? await exportDrainerAlive(r, INSTANCE_ID) : false
      if (p.entry.settled && untouched && someoneElse && r) {
        try {
          const { markHandedOff } = await import('./export-runs.js')
          // Waiting on the list again: no process's sweep may end it meanwhile.
          await markHandedOff(p.job.run_id, EXPORT_HANDOFF_MARK)
          await enqueueExport(r, p.job)
          return
        } catch (err) {
          app.log.warn({ err, run: p.job.run_id }, '[export-worker] could not put an export back')
        }
      }
      await failRun(app, p.job, SHUTDOWN_EXPORT_NOTE, { releaseSlot: true })
    })
  }
}

/** Remove this process's export beat (whichever role key holds it) in the app it is in. */
async function dropOwnBeat(r: ExportRedis): Promise<void> {
  for (const role of ['exporter', 'importer', 'fallback'] as const) {
    const b = await readExportBeat(r, role)
    if (b?.instance === INSTANCE_ID) await r.del(beatKeyOf(role))
  }
}

/** Self-hosted: this process's beat. Shared: its beat in every listed app. */
async function dropOwnBeats(r: ExportRedis): Promise<void> {
  if (!perAppJobs()) return dropOwnBeat(r)
  for (const t of await listApps().catch(() => [] as TenantRecord[]))
    await withTenant(t, () => dropOwnBeat(r), t.origin).catch(() => {})
}

/**
 * Readiness / preflight: is something draining the export hand-off? Reads the waiting entries and
 * the three heartbeats (judgeExportWorker).
 */
export async function exportWorkerJudgement(redis: unknown): Promise<ExportJudgement> {
  const r = asExportRedis(redis)
  const ages = r ? await queuedExportAges(r) : []
  return judgeExportWorker({
    cloud: isNivaroCloud(),
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

/** The process drain loop and kick subscriber (self-hosted), or the per-app pass and the
 *  deployment's kick subscriber (shared). Process-wide: started once at boot, outside any app. */
let drainer: { stop: () => Promise<void> } | null = null

/**
 * May app `t`'s exports run on this process now (Hub shared deployment)? Listed `active` (never an
 * app the Hub is moving or updating) and its schema ok at this version: this process's own
 * migration state, or — on an exporter or importer, which run no migration loop (server.ts) —
 * the state the migrating replicas keep in Redis, so it never exports from a half-migrated
 * database (as staged-import-worker.ts importAppReady).
 */
async function exportAppReady(app: FastifyInstance, t: TenantRecord): Promise<boolean> {
  if (t.status !== 'active') return false
  if (!appReadyForRequests(t.id)) return false
  if (!isWorkerOnlyRole()) return true
  return storedAppSchemaOk(t, (app as unknown as { redis?: never }).redis ?? null)
}

/**
 * Hub shared deployment: one kick heard on the deployment's channel (`<app>|<run id>`). Resolves
 * the app it names and, when this process lists it, it is active and its schema is ready, runs one
 * drain pass inside it. Anything else is skipped: an app this process has not listed yet is
 * drained by the next pass (drainEveryAppExports), or the starter runs the job itself.
 */
export async function onExportKick(app: FastifyInstance, payload: string): Promise<void> {
  const { tenant } = parseKick(payload)
  if (!tenant) return
  const registry = getTenantRegistry()
  if (!registry) return
  let t: TenantRecord | null = null
  try {
    t = (await registry.byId?.(tenant)) ?? null
    if (!t) t = (await registry.listActive()).find((x) => x.id === tenant) ?? null
  } catch {
    return
  }
  if (!t || !(await exportAppReady(app, t))) return
  try {
    await withTenant(t, () => runInBackgroundPool(() => drainExportsTick(app)), t.origin)
  } catch (err) {
    app.log.warn({ err, tenant: t.id }, '[export-worker] kick drain failed')
  }
}

/** One per-app pass at a time on this process (the timer never stacks passes). */
let passing = false

/**
 * Task 15 — a drainer's pass on a Hub shared deployment: one drain pass inside every listed app
 * that is active and ready (exportAppReady), at most TENANT_JOB_CONCURRENCY at once. Inside each
 * app the drain mode decides as self-hosted, on that app's beats: the importer and the worker
 * drain an app only while no exporter beats for it. Null when a pass is already running.
 */
export async function drainEveryAppExports(app: FastifyInstance): Promise<AppFanOutResult | null> {
  if (passing) return null
  passing = true
  try {
    return await forEachApp(async (t) => {
      if (t.status === 'maintenance') return 'maintenance'
      if (t.status !== 'active' || !(await exportAppReady(app, t))) return 'not_ready'
      await runInBackgroundPool(() => drainExportsTick(app))
      return 'ran'
    })
  } catch (err) {
    app.log.warn({ err }, '[export-worker] per-app pass failed')
    return null
  } finally {
    passing = false
  }
}

/**
 * Start draining exports on this process when it may (exportDrainMode). Hears the starter's
 * kick on a duplicated connection, so a handed-off export starts at once. Returns the mode.
 * Hub shared deployment: a pass over every app every SHARED_PASS_MS and the deployment's kicks
 * (onExportKick), instead of the process loop.
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
  const shared = perAppJobs()
  const tick = shared
    ? () => void drainEveryAppExports(app)
    : () => void runInBackgroundPool(() => drainExportsTick(app))
  const timer = setInterval(tick, shared ? SHARED_PASS_MS : TICK_MS)
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
      sub.on('message', (_channel: unknown, payload: unknown) => {
        if (shared) void onExportKick(app, String(payload ?? '')).catch(() => {})
        else tick()
      })
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
  return [...runningHere.values()].map((e) => e.job.run_id)
}
export function __resetExportWorker(): void {
  closing = false
  ticking.value = false
  passing = false
}
