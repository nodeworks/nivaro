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
}

export class CronManager {
  private entries = new Map<string, InternalEntry>()

  schedule(id: string, expression: string, fn: CronFn, opts?: { extensionId?: string }): void {
    // Replace any existing job with the same id
    this.unschedule(id)

    const job = new Cron(expression, { protect: true, catch: true }, async () => {
      // Every tick lands in nivaro_job_runs (best-effort) so the Background
      // Jobs console and per-extension health read one source of truth.
      const run = await startJobRun('cron', id, { extensionId: opts?.extensionId })
      try {
        await fn()
        await run.complete()
      } catch (err) {
        console.error({ err, cronId: id }, 'Cron job error')
        await run.fail(err)
      }
    })

    this.entries.set(id, {
      id,
      expression,
      fn,
      extensionId: opts?.extensionId,
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
