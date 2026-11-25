import { db } from '../../../db/index.js'
import type { CapacityUsage } from '../../capacity/app-usage.js'
import { appFromRow, environmentFromRow } from '../apps.js'
import { listShared, type SharedDeployment, tenantIdFor } from '../shared/store.js'
import { type SharedTenantRow, tenantsOf } from '../shared/tenants.js'
import { readLinkedUsage, readSharedUsage, type UsageRead } from './client.js'
import { type CapacitySample, insertSamples, pruneSamples } from './store.js'

/**
 * Nivaro Hub capacity job (`hub-capacity-sample`, every 15 minutes, Hub only): reads every shared
 * deployment's usage over its link and every hub-linked dedicated environment's over its hub
 * link, and stores one sample row per deployment (its totals) and per environment. Prunes rows
 * older than 31 days. A side that does not answer gets a row with its error code (the trend shows
 * the gap, never a zero).
 *
 * Per app on a shared deployment, CPU is an estimate: the deployment's CPU split by the app's
 * share of the time spent answering requests. Memory is the deployment's only (one process holds
 * every app; its memory is not split).
 */

const ENVS = 'nivaro_hub_environments'
const PLACEMENTS = 'nivaro_hub_placements'
const APPS = 'nivaro_hub_apps'
const LANES = 4

export interface SampleDeps {
  listShared?: () => Promise<SharedDeployment[]>
  tenantsOf?: (s: SharedDeployment) => Promise<SharedTenantRow[]>
  readShared?: (s: SharedDeployment) => Promise<UsageRead>
  readLinked?: (env: { base_url: string; hub_token: string | null }) => Promise<UsageRead>
  dedicated?: () => Promise<
    { id: number; base_url: string; hub_token: string | null; tenant_id: string }[]
  >
  insert?: (rows: CapacitySample[]) => Promise<void>
  prune?: () => Promise<number>
  now?: () => Date
}

const blank = (
  at: Date,
  over: Partial<CapacitySample> & Pick<CapacitySample, 'scope'>
): CapacitySample => ({
  sampled_at: at,
  shared_deployment_id: null,
  environment_id: null,
  tenant_id: null,
  cpu_pct: null,
  memory_mb: null,
  requests_per_min: null,
  busy_ms_per_min: null,
  errors_per_min: null,
  db_in_use: null,
  db_waiting: null,
  db_pool_max: null,
  jobs_running: null,
  jobs_waiting: null,
  storage_bytes: null,
  processes: null,
  error: null,
  ...over
})

const sum = (xs: Array<number | null>): number | null => {
  const real = xs.filter((x): x is number => typeof x === 'number')
  return real.length ? real.reduce((a, b) => a + b, 0) : null
}

/** The rows of one shared deployment's answer: its totals, then one per environment it serves. */
export function sharedRows(
  at: Date,
  shared: Pick<SharedDeployment, 'id' | 'pool_budget'>,
  tenants: { env_id: number; tenant_id: string }[],
  read: UsageRead
): CapacitySample[] {
  if (!read.ok)
    return [
      blank(at, { scope: 'shared', shared_deployment_id: shared.id, error: read.code }),
      ...tenants.map((t) =>
        blank(at, {
          scope: 'environment',
          shared_deployment_id: shared.id,
          environment_id: t.env_id,
          tenant_id: t.tenant_id,
          error: read.code
        })
      )
    ]
  const u: CapacityUsage = read.usage
  const byId = new Map(u.apps.map((a) => [a.id, a]))
  const busyAll = u.totals.busy_ms_per_min
  const total = blank(at, {
    scope: 'shared',
    shared_deployment_id: shared.id,
    cpu_pct: u.totals.cpu_pct,
    memory_mb: u.totals.memory_mb,
    requests_per_min: u.totals.requests_per_min,
    busy_ms_per_min: busyAll,
    errors_per_min: sum(u.apps.map((a) => a.errors_per_min)),
    db_in_use: sum(u.apps.map((a) => a.db.in_use)),
    db_waiting: sum(u.apps.map((a) => a.db.waiting)),
    db_pool_max: shared.pool_budget,
    jobs_running: sum(u.apps.map((a) => a.jobs.running)),
    jobs_waiting: sum(u.apps.map((a) => a.jobs.waiting)),
    storage_bytes: sum(u.apps.map((a) => a.storage_bytes)),
    processes: u.processes.length,
    error: u.partial ? 'PARTIAL' : null
  })
  const rows = [total]
  for (const t of tenants) {
    const a = byId.get(t.tenant_id)
    if (!a) {
      rows.push(
        blank(at, {
          scope: 'environment',
          shared_deployment_id: shared.id,
          environment_id: t.env_id,
          tenant_id: t.tenant_id,
          error: 'NOT_LISTED'
        })
      )
      continue
    }
    rows.push(
      blank(at, {
        scope: 'environment',
        shared_deployment_id: shared.id,
        environment_id: t.env_id,
        tenant_id: t.tenant_id,
        cpu_pct:
          u.totals.cpu_pct !== null && busyAll > 0
            ? Math.round(((u.totals.cpu_pct * a.busy_ms_per_min) / busyAll) * 10) / 10
            : u.totals.cpu_pct !== null
              ? 0
              : null,
        requests_per_min: a.requests_per_min,
        busy_ms_per_min: a.busy_ms_per_min,
        errors_per_min: a.errors_per_min,
        db_in_use: a.db.in_use,
        db_waiting: a.db.waiting,
        db_pool_max: a.db.pool_max,
        jobs_running: a.jobs.running,
        jobs_waiting: a.jobs.waiting,
        storage_bytes: a.storage_bytes,
        processes: a.db.processes || null,
        error: u.partial ? 'PARTIAL' : null
      })
    )
  }
  return rows
}

/** The row of one dedicated environment's answer. */
export function dedicatedRow(
  at: Date,
  env: { id: number; tenant_id: string },
  read: UsageRead
): CapacitySample {
  if (!read.ok)
    return blank(at, {
      scope: 'environment',
      environment_id: env.id,
      tenant_id: env.tenant_id,
      error: read.code
    })
  const u = read.usage
  const a = u.apps[0]
  return blank(at, {
    scope: 'environment',
    environment_id: env.id,
    tenant_id: env.tenant_id,
    cpu_pct: u.totals.cpu_pct,
    memory_mb: u.totals.memory_mb,
    requests_per_min: u.totals.requests_per_min,
    busy_ms_per_min: u.totals.busy_ms_per_min,
    errors_per_min: a?.errors_per_min ?? null,
    db_in_use: a?.db.in_use ?? null,
    db_waiting: a?.db.waiting ?? null,
    db_pool_max: a?.db.pool_max ?? null,
    jobs_running: a?.jobs.running ?? null,
    jobs_waiting: a?.jobs.waiting ?? null,
    storage_bytes: a?.storage_bytes ?? null,
    processes: u.processes.length,
    error: u.partial ? 'PARTIAL' : null
  })
}

/** Hub-linked environments not on a shared deployment, archived ones left out. */
async function dedicatedEnvs(): Promise<
  { id: number; base_url: string; hub_token: string | null; tenant_id: string }[]
> {
  const rows = (await db(ENVS).whereNotNull('hub_token').whereNot('status', 'archived')) as Record<
    string,
    unknown
  >[]
  if (!rows.length) return []
  const placementIds = [
    ...new Set(rows.map((r) => r.placement_id).filter((x) => x != null))
  ] as number[]
  const shared = new Set(
    placementIds.length
      ? (
          (await db(PLACEMENTS)
            .whereIn('id', placementIds)
            .where('kind', 'shared')
            .pluck('id')) as Array<number | string>
        ).map(Number)
      : []
  )
  const apps = new Map(
    (
      (await db(APPS).whereIn('id', [...new Set(rows.map((r) => Number(r.app_id)))])) as Record<
        string,
        unknown
      >[]
    ).map((r) => [Number(r.id), appFromRow(r)])
  )
  const out: { id: number; base_url: string; hub_token: string | null; tenant_id: string }[] = []
  for (const r of rows) {
    if (r.placement_id != null && shared.has(Number(r.placement_id))) continue
    const env = environmentFromRow(r)
    const app = apps.get(env.app_id)
    if (!app) continue
    out.push({
      id: env.id,
      base_url: env.base_url,
      // The sealed value, not the masked one environmentFromRow answers.
      hub_token: (r.hub_token as string | null) ?? null,
      tenant_id: tenantIdFor(app, env)
    })
  }
  return out
}

async function inLanes<T>(items: T[], work: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(LANES, items.length) }, async () => {
      while (next < items.length) await work(items[next++])
    })
  )
}

export interface SampleResult {
  shared: number
  environments: number
  failed: number
  pruned: number
}

/** One capacity sample of every side; answers what it stored. */
export async function runCapacitySample(deps: SampleDeps = {}): Promise<SampleResult> {
  const at = (deps.now ?? (() => new Date()))()
  const rows: CapacitySample[] = []
  let failed = 0
  const shareds = (await (deps.listShared ?? listShared)()).filter((s) => s.status !== 'retired')
  await inLanes(shareds, async (s) => {
    let tenants: { env_id: number; tenant_id: string }[] = []
    try {
      tenants = (await (deps.tenantsOf ?? tenantsOf)(s))
        .filter((t) => t.placedHere)
        .map((t) => ({ env_id: t.env.id, tenant_id: tenantIdFor(t.app, t.env) }))
    } catch {
      tenants = []
    }
    let read: UsageRead
    try {
      read = await (deps.readShared ?? ((x: SharedDeployment) => readSharedUsage(x)))(s)
    } catch {
      read = { ok: false, code: 'UNREACHABLE' }
    }
    if (!read.ok) failed++
    rows.push(...sharedRows(at, s, tenants, read))
  })
  const envs = await (deps.dedicated ?? dedicatedEnvs)()
  await inLanes(envs, async (e) => {
    let read: UsageRead
    try {
      read = await (deps.readLinked ?? ((x) => readLinkedUsage(x)))(e)
    } catch {
      read = { ok: false, code: 'UNREACHABLE' }
    }
    if (!read.ok) failed++
    rows.push(dedicatedRow(at, e, read))
  })
  await (deps.insert ?? insertSamples)(rows)
  const pruned = await (deps.prune ?? (() => pruneSamples(at)))()
  return {
    shared: shareds.length,
    environments: rows.filter((r) => r.scope === 'environment').length,
    failed,
    pruned
  }
}
