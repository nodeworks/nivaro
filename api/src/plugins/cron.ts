import { Cron } from 'croner'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { startJobRun } from '../services/job-runs.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface CronEntry {
  id: string
  /** The EFFECTIVE schedule (override when one is set). */
  expression: string
  /** The schedule the code registered — what revert restores. */
  defaultExpression: string
  /** True when an admin override is in force. */
  overridden: boolean
  extensionId?: string
  nextRun: Date | null
  /** #136 — heavy jobs serialize through one global slot. */
  heavy?: boolean
  /** #305 — declared re-run safety, shown beside the run-now button. */
  idempotent?: 'safe' | 'unsafe' | 'unknown'
  /** Plain-language purpose — what the job does and what it touches. */
  description?: string
  /** #504 — a job that no-ops behind a deployment flag, and whether that flag currently lets it run. */
  gate?: { flag: string; enabled: boolean }
  /** #198 — a paused cron's ticks return immediately. */
  paused?: boolean
  /** #32 — the job registered a dry-run handler (report, no writes). */
  supports_dry_run?: boolean
  /** #54 — chained: runs right after this job completes instead of on its
   *  own schedule (the schedule stays registered as the revert target). */
  after?: string | null
}

type CronFn = () => void | Promise<void>

interface InternalEntry extends CronEntry {
  fn: CronFn
  job: Cron
  catchUpHours?: number
  scheduleOpts?: ScheduleOpts
  dryRun?: () => Promise<unknown>
}

export interface ScheduleOpts {
  extensionId?: string
  watchdogMs?: number
  catchUpHours?: number
  heavy?: boolean
  idempotent?: 'safe' | 'unsafe' | 'unknown'
  /** Plain-language purpose, shown on the Background Jobs page. */
  description?: string
  /** #32 — what a tick WOULD do, with nothing written: returns a report
   *  (string or JSON) the Background Jobs page shows. Optional. */
  dryRun?: () => Promise<unknown>
}

/** Throws with croner's own message when the expression is not valid. */
export function assertCronExpression(expression: string): void {
  const probe = new Cron(expression, { paused: true })
  probe.stop()
}

/** The next N fire times of an expression, for admin previews. */
export function previewCronRuns(expression: string, count = 5): Date[] {
  const probe = new Cron(expression, { paused: true })
  const runs = probe.nextRuns(count)
  probe.stop()
  return runs
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

/** #75 — the knex pool's occupancy; null when the driver exposes no pool. */
async function poolOccupancy(): Promise<{ used: number; max: number; pending: number } | null> {
  try {
    const { db } = await import('../db/index.js')
    const pool = (
      db.client as {
        pool?: { numUsed: () => number; numPendingAcquires: () => number; max?: number }
      }
    ).pool
    if (!pool) return null
    return { used: pool.numUsed(), max: pool.max ?? 10, pending: pool.numPendingAcquires() }
  } catch {
    return null
  }
}

const HOT_POOL_RATIO = 0.8
const YIELD_STEP_MS = 5_000
const YIELD_MAX_MS = 10 * 60_000

/** Wait while the pool is hot (≥ 80% checked out, or acquires queued) —
 *  bounded, so a permanently busy instance still runs its heavy jobs. */
async function waitForPoolHeadroom(): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < YIELD_MAX_MS) {
    const p = await poolOccupancy()
    if (!p) return
    const hot = p.pending > 0 || p.used / Math.max(1, p.max) >= HOT_POOL_RATIO
    if (!hot) return
    await sleep(YIELD_STEP_MS)
  }
}

export class CronManager {
  private entries = new Map<string, InternalEntry>()
  private runningSince = new Map<string, number>()
  /** Paused cron ids (#198) — hydrated from settings at boot, edited via /cron routes. */
  private pausedIds = new Set<string>()
  /** Schedule overrides (cron id → expression) — hydrated from settings BEFORE
   *  extensions register, so a job scheduled later still gets its override. */
  private overrides = new Map<string, string>()
  /** Heavy-job serialization (#136): heavy ticks run one at a time, queued in
   *  arrival order — nightly procs/sweeps/backfills stop piling onto the pool. */
  private heavyChain: Promise<void> = Promise.resolve()

  setPaused(ids: string[]): void {
    this.pausedIds = new Set(ids)
  }
  pause(id: string): void {
    this.pausedIds.add(id)
  }
  resume(id: string): void {
    this.pausedIds.delete(id)
  }
  isPaused(id: string): boolean {
    return this.pausedIds.has(id)
  }

  /** Replace the override map and re-create every job whose effective
   *  schedule changed. Safe to call before or after jobs register. */
  setOverrides(map: Record<string, string>): void {
    const next = new Map<string, string>()
    for (const [id, expr] of Object.entries(map)) {
      try {
        assertCronExpression(expr)
        next.set(id, expr)
      } catch (err) {
        console.warn(`[cron] ignoring invalid override for "${id}": ${expr}`, err)
      }
    }
    this.overrides = next
    for (const id of [...this.entries.keys()]) this.rebuild(id)
  }
  getOverride(id: string): string | null {
    return this.overrides.get(id) ?? null
  }
  /** Override one job's schedule live. Throws on an invalid expression. */
  override(id: string, expression: string): void {
    assertCronExpression(expression)
    this.overrides.set(id, expression)
    this.rebuild(id)
  }
  /** Back to the schedule the code registered. */
  revert(id: string): void {
    this.overrides.delete(id)
    this.rebuild(id)
  }
  /** Re-create a job from its registered fn/opts under the current override. */
  private rebuild(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    const effective = this.overrides.get(id) ?? e.defaultExpression
    if (effective === e.expression) return
    const { fn, defaultExpression, scheduleOpts, catchUpHours, heavy, idempotent, description } = e
    this.schedule(id, defaultExpression, fn, {
      ...scheduleOpts,
      catchUpHours,
      heavy,
      idempotent,
      description
    })
  }
  /** Post-registration metadata (#136/#305) — one annotation block in
   *  server.ts marks heaviness and re-run safety without touching each
   *  schedule() call site. */
  annotate(
    id: string,
    meta: {
      heavy?: boolean
      idempotent?: 'safe' | 'unsafe' | 'unknown'
      description?: string
      gate?: { flag: string; enabled: boolean }
    }
  ): void {
    const e = this.entries.get(id)
    if (!e) return
    if (meta.heavy !== undefined) e.heavy = meta.heavy
    if (meta.idempotent) e.idempotent = meta.idempotent
    if (meta.description) e.description = meta.description
    if (meta.gate) e.gate = meta.gate
  }
  private runSerialized(heavy: boolean, work: () => Promise<void>): Promise<void> {
    if (!heavy) return work()
    // #75 — a heavy job yields to interactive traffic: while the connection
    // pool is hot it waits (5s steps, 10 min cap) before taking its turn.
    const yielding = async () => {
      await waitForPoolHeadroom()
      await work()
    }
    const next = this.heavyChain.then(yielding, yielding)
    this.heavyChain = next.catch(() => {})
    return next
  }

  // #54 — chains: childId → the job it runs after. Hydrated from
  // settings.cron_chains at boot (before schedules register) and edited live.
  private chains = new Map<string, string>()
  setChains(map: Record<string, string>): void {
    this.chains = new Map(Object.entries(map).filter(([k, v]) => k && v && k !== v))
  }
  getAfter(id: string): string | null {
    return this.chains.get(id) ?? null
  }
  /** Chain `id` after `afterId` (null = unchain). Refuses cycles. */
  setAfter(id: string, afterId: string | null): void {
    if (!afterId) {
      this.chains.delete(id)
      return
    }
    if (afterId === id) throw new Error('A job cannot run after itself')
    let cur: string | undefined = afterId
    const seen = new Set<string>([id])
    while (cur) {
      if (seen.has(cur)) throw new Error(`Chaining ${id} after ${afterId} would loop`)
      seen.add(cur)
      cur = this.chains.get(cur)
    }
    this.chains.set(id, afterId)
  }
  /** Jobs chained after `id`, in registration order. */
  chainedAfter(id: string): string[] {
    return [...this.entries.keys()].filter((k) => this.chains.get(k) === id)
  }
  private triggerChained(id: string): void {
    const kids = this.chainedAfter(id)
    if (kids.length === 0) return
    void (async () => {
      for (const kid of kids) {
        try {
          await this.runNow(kid, null)
        } catch (err) {
          console.error({ err, cronId: kid, after: id }, 'Chained cron job error')
        }
      }
    })()
  }

  /** #32 — run a job's dry-run handler; null when it has none. */
  async dryRun(id: string): Promise<{ supported: boolean; report: unknown }> {
    const e = this.entries.get(id)
    if (!e?.dryRun) return { supported: false, report: null }
    return { supported: true, report: await e.dryRun() }
  }

  /** #81 — when the schedule last SHOULD have fired (null for one-shot or
   *  unparseable expressions). Derived from the next two runs' spacing, so an
   *  irregular expression reads as its nearest regular period. */
  expectedPreviousRun(id: string, now = new Date()): Date | null {
    const e = this.entries.get(id)
    if (!e) return null
    try {
      const probe = new Cron(e.expression)
      const n1 = probe.nextRun(now)
      const n2 = n1 ? probe.nextRun(n1) : null
      if (!n1 || !n2) return null
      const period = n2.getTime() - n1.getTime()
      if (period <= 0) return null
      return new Date(n1.getTime() - period)
    } catch {
      return null
    }
  }

  schedule(id: string, expression: string, fn: CronFn, opts?: ScheduleOpts): void {
    // Replace any existing job with the same id
    this.unschedule(id)

    // An admin override (settings.cron_overrides) wins over the registered
    // expression; the registered one is kept as the revert target.
    const effective = this.overrides.get(id) ?? expression
    const budget = opts?.watchdogMs ?? WATCHDOG_DEFAULT_MS
    const job = new Cron(
      effective,
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
        // Paused (#198): the schedule stays registered (so resume needs no
        // deploy) but ticks return without running or recording anything.
        if (this.pausedIds.has(id)) return
        // Chained (#54): this job runs after another one completes, not on
        // its own clock — the tick is a no-op while the chain stands.
        if (this.chains.has(id)) return
        // Every tick lands in nivaro_job_runs (best-effort) so the Background
        // Jobs console and per-extension health read one source of truth.
        await this.runSerialized(this.entries.get(id)?.heavy === true, async () => {
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
            this.triggerChained(id)
          } catch (err) {
            console.error({ err, cronId: id }, 'Cron job error')
            await run.fail(err)
          } finally {
            clearTimeout(watchdog)
            this.runningSince.delete(id)
          }
        })
      }
    )

    const self = this
    this.entries.set(id, {
      id,
      expression: effective,
      defaultExpression: expression,
      overridden: effective !== expression,
      fn,
      scheduleOpts: opts,
      extensionId: opts?.extensionId,
      catchUpHours: opts?.catchUpHours,
      heavy: opts?.heavy,
      idempotent: opts?.idempotent ?? 'unknown',
      description: opts?.description,
      dryRun: opts?.dryRun,
      job,
      get nextRun() {
        return job.nextRun() ?? null
      },
      get paused() {
        return self.pausedIds.has(id)
      },
      get supports_dry_run() {
        return !!self.entries.get(id)?.dryRun
      },
      get after() {
        return self.chains.get(id) ?? null
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
      this.triggerChained(id)
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
    return Array.from(this.entries.values()).map(
      ({
        id,
        expression,
        defaultExpression,
        overridden,
        extensionId,
        job,
        heavy,
        idempotent,
        description,
        gate
      }) => ({
        id,
        expression,
        defaultExpression,
        overridden,
        extensionId,
        nextRun: job.nextRun() ?? null,
        heavy,
        idempotent,
        description,
        gate,
        paused: this.pausedIds.has(id),
        // list() rebuilds entries — every annotate()/option field must be
        // copied here or the registry silently drops it (the first cron bug).
        supports_dry_run: !!this.entries.get(id)?.dryRun,
        after: this.chains.get(id) ?? null
      })
    )
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
