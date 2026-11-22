/**
 * The per-app job runner (Hub phase 5). On a shared deployment (`perAppJobs()`), a scheduled
 * job scoped to an app (services/cron-scope.ts) runs once per active app, each run inside that
 * app's tenant context so its reads and writes reach that app's database, job-run row included.
 *
 * `forEachApp` is the fan-out: it lists the active apps from the tenant registry, runs `work`
 * for each inside `withTenant`, at most `appJobConcurrency()` apps at once, and keeps going when
 * one app's work throws or hangs (a hung app holds one lane; the others carry on).
 *
 * Self-hosted and Nivaro Cloud never call it (plugins/cron.ts reaches it only under perAppJobs()).
 */
import { withTenant } from '../db/tenant-context.js'
import { appPausedCrons } from './app-job-settings.js'
import { getTenantRegistry } from './tenancy/registry.js'
import type { TenantRecord } from './tenancy/types.js'

/** Why an app did not run on a fan-out: the app paused the job; another replica claimed this
 *  fire; the app is in maintenance mode; its previous run is still going; this process stopped
 *  leading (or dropped the job) mid fan-out; a catch-up found a recent completed run. */
export type AppSkipWhy = 'paused' | 'claimed' | 'maintenance' | 'busy' | 'lease-lost' | 'recent'

export interface AppFanOutResult {
  ran: string[]
  skipped: { tenant: string; why: AppSkipWhy }[]
  failed: { tenant: string; error: string }[]
}

const DEFAULT_CONCURRENCY = 4

/** How many apps one fan-out runs at once: TENANT_JOB_CONCURRENCY, default 4, 1–16. */
export function appJobConcurrency(): number {
  const raw = Number.parseInt(String(process.env.TENANT_JOB_CONCURRENCY ?? '').trim(), 10)
  if (!Number.isFinite(raw)) return DEFAULT_CONCURRENCY
  return Math.min(16, Math.max(1, raw))
}

/** Whether the current app paused the job: its own nivaro_settings.paused_crons, cached 60 s
 *  per app (services/app-job-settings.ts). The process-wide paused set is checked separately. */
export async function appPaused(id: string): Promise<boolean> {
  return (await appPausedCrons()).has(id)
}

/** A failure's text for the fan-out result: the message only, never a stack or connection. */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/** The active apps from the tenant registry; none when the deployment has no registry. */
export async function listApps(): Promise<TenantRecord[]> {
  const registry = getTenantRegistry()
  if (!registry) return []
  return registry.listActive()
}

export async function forEachApp(
  work: (t: TenantRecord) => Promise<'ran' | AppSkipWhy>,
  opts: {
    concurrency?: number
    listActive?: () => Promise<TenantRecord[]>
    /** Called when a lane picks an app up, before its work: a reason skips it (this process
     *  stopped leading; its previous run of the job is still going). */
    start?: (t: TenantRecord) => AppSkipWhy | null
    /** Called once for every started app when its turn is over, however it ended. */
    release?: (t: TenantRecord) => void
  } = {}
): Promise<AppFanOutResult> {
  const result: AppFanOutResult = { ran: [], skipped: [], failed: [] }
  const queue = await (opts.listActive ?? listApps)()
  const lanes = Math.min(
    Math.max(1, Math.floor(opts.concurrency ?? appJobConcurrency())),
    Math.max(1, queue.length)
  )
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < queue.length) {
      const t = queue[next++]
      const why = opts.start?.(t) ?? null
      if (why) {
        result.skipped.push({ tenant: t.id, why })
        continue
      }
      try {
        // The app's own origin: links its job builds (mail, notices) name the app (phase 6).
        const out = await withTenant(t, () => work(t), t.origin)
        if (out === 'ran') result.ran.push(t.id)
        else result.skipped.push({ tenant: t.id, why: out })
      } catch (err) {
        result.failed.push({ tenant: t.id, error: errorText(err) })
      } finally {
        opts.release?.(t)
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane))
  return result
}
