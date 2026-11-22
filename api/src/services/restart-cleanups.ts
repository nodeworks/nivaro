/**
 * Restart clean-ups (#292 and the Data Integrity reset): work a restart killed is still marked
 * 'running'. Self-hosted, server.ts runs both passes once at boot against its database. On a Hub
 * shared deployment (Hub phase 5, P5-10) the same passes run once per app, inside that app,
 * through the job fan-out: best-effort, never failing boot, one app never stopping the others.
 */
import { db } from '../db/index.js'
import { type AppFanOutResult, forEachApp } from './app-jobs.js'

/** Both passes against the current database (the app's own inside a tenant context). */
export async function runRestartCleanups(): Promise<void> {
  // Restart impact report (#292): job runs still marked 'running' from
  // BEFORE this boot were killed by the restart — mark them interrupted
  // and raise one summary issue with the names.
  try {
    const bootTime = new Date(Date.now() - process.uptime() * 1000)
    // #1051 — only runs of THIS deployment slot whose process is no longer in the roster.
    // The dev laptop shares its database with staging: unscoped, every laptop boot marked
    // staging's in-flight runs interrupted. Rows from before migration 388 carry no
    // instance: only a ticking (deployed) process sweeps those, never a dev laptop.
    const { hasColumn } = await import('../lib/column-probe.js')
    const { listInstances } = await import('./instance-roster.js')
    const { instanceKey } = await import('./instance-key.js')
    const { cronTicksEnabled } = await import('./cron-ticks.js')
    const { skipHandedOffExports } = await import('./job-run-sweeps.js')
    const scoped = await hasColumn('nivaro_job_runs', 'instance_id').catch(() => false)
    const live = scoped ? (await listInstances()).map((i) => String(i.id)).filter(Boolean) : []
    const sweepsLegacy = cronTicksEnabled()
    const stranded = (await db('nivaro_job_runs')
      .where('status', 'running')
      .where('started_at', '<', bootTime)
      .modify((q) => {
        if (!scoped) return
        q.where((w) => {
          w.where((o) => {
            o.where('instance', instanceKey())
            if (live.length) o.whereNotIn('instance_id', live)
          })
          if (sweepsLegacy) w.orWhereNull('instance')
        })
        // Background exports handed to a drainer: the drainer judges them (lost leases),
        // never the process that started them (services/job-run-sweeps.ts).
        skipHandedOffExports(q)
      })
      .limit(50)
      .select('id', 'kind', 'job_id')) as Array<{ id: number; kind: string; job_id: string }>
    if (stranded.length > 0) {
      await db('nivaro_job_runs')
        .whereIn(
          'id',
          stranded.map((r) => r.id)
        )
        .update({ status: 'interrupted', finished_at: new Date() })
      const { trackError } = await import('./error-tracking.js')
      const { restartImpactIssue } = await import('./system-issues.js')
      await trackError(
        restartImpactIssue(
          stranded.map((r) => r.job_id),
          stranded.length
        )
      )
    }
  } catch {
    /* job-runs table shape mid-migration — skip */
  }

  // Same for Data Integrity sweeps: a conformance run still 'running'
  // from before this boot died with the process, and its row would
  // 409 every new run for that collection forever.
  try {
    const bootTime = new Date(Date.now() - process.uptime() * 1000)
    await db('nivaro_conformance_runs')
      .where('status', 'running')
      .where('started_at', '<', bootTime)
      .update({
        status: 'error',
        error: 'Interrupted by an API restart — run it again.',
        finished_at: new Date()
      })
  } catch {
    /* table absent mid-migration — skip */
  }
}

/** Shared deployment: both passes once in every active app. Never throws. */
export async function runRestartCleanupsPerApp(): Promise<AppFanOutResult> {
  try {
    return await forEachApp(async () => {
      await runRestartCleanups()
      return 'ran'
    })
  } catch {
    return { ran: [], skipped: [], failed: [] }
  }
}
