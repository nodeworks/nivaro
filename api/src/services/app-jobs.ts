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
import { getTenantRegistry } from './tenancy/registry.js'
import type { TenantRecord } from './tenancy/types.js'

export type AppSkipWhy = 'paused' | 'claimed' | 'maintenance' | 'busy'

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

/** Whether this app paused the job. Task 11 replaces this stub with the app's own setting. */
export async function appPaused(_id: string): Promise<boolean> {
  return false
}

/** A failure's text for the fan-out result: the message only, never a stack or connection. */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

async function registryApps(): Promise<TenantRecord[]> {
  const registry = getTenantRegistry()
  if (!registry) return []
  return registry.listActive()
}

export async function forEachApp(
  work: (t: TenantRecord) => Promise<'ran' | AppSkipWhy>,
  opts: {
    concurrency?: number
    listActive?: () => Promise<TenantRecord[]>
    /** Decide, for every listed app before any work starts, whether it joins this fan-out:
     *  a reason skips it (e.g. its previous run of the job is still going). */
    admit?: (t: TenantRecord) => AppSkipWhy | null
    /** Called once for every admitted app when its turn is over, however it ended. */
    release?: (t: TenantRecord) => void
  } = {}
): Promise<AppFanOutResult> {
  const result: AppFanOutResult = { ran: [], skipped: [], failed: [] }
  const apps = await (opts.listActive ?? registryApps)()
  const queue: TenantRecord[] = []
  for (const t of apps) {
    const why = opts.admit?.(t) ?? null
    if (why) result.skipped.push({ tenant: t.id, why })
    else queue.push(t)
  }
  const lanes = Math.min(
    Math.max(1, Math.floor(opts.concurrency ?? appJobConcurrency())),
    Math.max(1, queue.length)
  )
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < queue.length) {
      const t = queue[next++]
      try {
        const out = await withTenant(t, () => work(t))
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
