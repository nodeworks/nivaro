import { Cron } from 'croner'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { startJobRun } from '../services/job-runs.js'

export interface CronEntry {
  id: string
  expression: string
  extensionId?: string
  nextRun: Date | null
}

type CronFn = () => void | Promise<void>

interface InternalEntry extends CronEntry {
  fn: CronFn
  job: Cron
  catchUpHours?: number
}

// Cron watchdog (#93): a tick still running when its budget expires raises a
// deduped issue naming the job — a hung cron otherwise reads as "everything is
// fine" while its work silently stops happening. Overlap skips (croner's
// protect) were silent for the same reason; they raise the same way.
const WATCHDOG_DEFAULT_MS = 15 * 60 * 1000

function raiseCronIssue(message: string, severity: 'medium' | 'high'): void {
  void import('../services/error-tracking.js')
    .then(({ trackError }) =>
      trackError({ source: 'server', route: 'cron/watchdog', message, severity })
    )
    .catch(() => {})
}

export class CronManager {
  private entries = new Map<string, InternalEntry>()
  private runningSince = new Map<string, number>()

  schedule(
    id: string,
    expression: string,
    fn: CronFn,
    opts?: { extensionId?: string; watchdogMs?: number; catchUpHours?: number }
  ): void {
    // Replace any existing job with the same id
    this.unschedule(id)

    const budget = opts?.watchdogMs ?? WATCHDOG_DEFAULT_MS
    const job = new Cron(
      expression,
      {
        // protect blocks the tick when the previous one is still running —
        // the callback form makes the skip VISIBLE instead of silent.
        protect: () => {
          const since = this.runningSince.get(id)
          const mins = since ? Math.round((Date.now() - since) / 60_000) : 0
          raiseCronIssue(
            `Cron "${id}" tick skipped — the previous tick has been running for ${mins} minute(s)`,
            'medium'
          )
        },
        catch: true
      },
      async () => {
        // Every tick lands in nivaro_job_runs (best-effort) so the Background
        // Jobs console and per-extension health read one source of truth.
        const run = await startJobRun('cron', id, { extensionId: opts?.extensionId })
        this.runningSince.set(id, Date.now())
        const watchdog = setTimeout(() => {
          raiseCronIssue(
            `Cron "${id}" has been running for over ${Math.round(budget / 60_000)} minutes — likely hung (its work has stopped happening)`,
            'high'
          )
        }, budget)
        try {
          await fn()
          await run.complete()
        } catch (err) {
          console.error({ err, cronId: id }, 'Cron job error')
          await run.fail(err)
        } finally {
          clearTimeout(watchdog)
          this.runningSince.delete(id)
        }
      }
    )

    this.entries.set(id, {
      id,
      expression,
      fn,
      extensionId: opts?.extensionId,
      catchUpHours: opts?.catchUpHours,
      job,
      get nextRun() {
        return job.nextRun() ?? null
      }
    })
  }

  /**
   * Run a scheduled job's handler immediately, out of band. Used by the admin
   * "run now" endpoint to re-run a failed nightly job (or to exercise one in a
   * test window) without waiting for its next tick. Errors propagate to the
   * caller so the endpoint can report them; the scheduled run is unaffected.
   */
  async runNow(id: string, triggeredBy?: string | null): Promise<boolean> {
    const entry = this.entries.get(id)
    if (!entry) return false
    const run = await startJobRun('cron', id, {
      extensionId: entry.extensionId,
      triggeredBy: triggeredBy ?? null
    })
    try {
      await entry.fn()
      await run.complete()
    } catch (err) {
      await run.fail(err)
      throw err
    }
    return true
  }

  /** Flag an already-registered job for boot catch-up (#328). */
  markCatchUp(id: string, hours: number): void {
    const entry = this.entries.get(id)
    if (entry) entry.catchUpHours = hours
  }

  /**
   * Missed-cron catch-up (#328): jobs flagged with catchUpHours run once on
   * boot when no completed run exists inside that window — a restart that
   * straddled 3am no longer silently skips a nightly. Only idempotent
   * detectors/cleanups should opt in.
   */
  async runCatchUps(): Promise<void> {
    const { db } = await import('../db/index.js')
    for (const entry of this.entries.values()) {
      const hours = entry.catchUpHours
      if (!hours) continue
      try {
        const recent = await db('nivaro_job_runs')
          .where({ job_id: entry.id, status: 'completed' })
          .where('started_at', '>=', new Date(Date.now() - hours * 3_600_000))
          .first('id')
        if (recent) continue
        console.log(`[cron] catch-up run for overdue job "${entry.id}"`)
        await this.runNow(entry.id, null)
      } catch (err) {
        console.warn(`[cron] catch-up for "${entry.id}" failed:`, err)
      }
    }
  }

  unschedule(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.job.stop()
    this.entries.delete(id)
  }

  unscheduleByExtension(extensionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.extensionId === extensionId) {
        entry.job.stop()
        this.entries.delete(id)
      }
    }
  }

  setExtensionEnabled(extensionId: string, enabled: boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.extensionId !== extensionId) continue
      if (enabled) {
        entry.job.resume()
      } else {
        entry.job.pause()
      }
    }
  }

  list(): CronEntry[] {
    return Array.from(this.entries.values()).map(({ id, expression, extensionId, job }) => ({
      id,
      expression,
      extensionId,
      nextRun: job.nextRun() ?? null
    }))
  }

  stopAll(): void {
    for (const entry of this.entries.values()) {
      entry.job.stop()
    }
    this.entries.clear()
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    cron: CronManager
  }
}

export const cronPlugin = fp(async (app: FastifyInstance) => {
  const manager = new CronManager()

  app.decorate('cron', manager)

  app.addHook('onClose', async () => {
    manager.stopAll()
  })

  app.log.info('Cron manager ready')
})
