import { Cron } from 'croner'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

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
      try {
        await fn()
      } catch (err) {
        console.error({ err, cronId: id }, 'Cron job error')
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
