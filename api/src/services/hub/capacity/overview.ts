import { db } from '../../../db/index.js'
import type { AppLimits } from '../../capacity/limits.js'
import { listShared } from '../shared/store.js'
import {
  type CapacitySample,
  type CapacitySettings,
  limitsByEnv,
  readSettings,
  samplesSince
} from './store.js'

/**
 * Nivaro Hub capacity view (idea 9): the stored samples as the Capacity tab reads them — per
 * shared deployment its latest totals, a daily trend over 30 days and each app's latest figures
 * with its share of the deployment; per dedicated environment the same for its own stack. An app
 * whose latest share of the deployment's requests, answering time or database connections is at
 * or over `most_share` (default half) is flagged "uses most of the deployment" (only on a
 * deployment serving two apps or more).
 */

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'

export interface Figures {
  sampled_at: string
  cpu_pct: number | null
  memory_mb: number | null
  requests_per_min: number | null
  busy_ms_per_min: number | null
  errors_per_min: number | null
  db_in_use: number | null
  db_waiting: number | null
  db_pool_max: number | null
  jobs_running: number | null
  jobs_waiting: number | null
  storage_bytes: number | null
  processes: number | null
  error: string | null
}

export interface TrendPoint {
  /** Start of the bucket (day or hour), ISO. */
  at: string
  requests_per_min: number | null
  busy_ms_per_min: number | null
  cpu_pct: number | null
  memory_mb: number | null
  /** Highest connections in use seen in the bucket. */
  db_in_use: number | null
  storage_bytes: number | null
  samples: number
}

export interface Share {
  requests: number | null
  busy: number | null
  db: number | null
}

export interface AppCapacity {
  env_id: number
  app_id: number | null
  app_key: string
  app_name: string
  env_key: string
  tenant_id: string | null
  latest: Figures | null
  share: Share | null
  uses_most: boolean
  limits: AppLimits
  trend: TrendPoint[]
}

export interface SharedCapacity {
  id: number
  key: string
  name: string
  status: string
  pool_budget: number
  latest: Figures | null
  trend: TrendPoint[]
  apps: AppCapacity[]
}

export interface CapacityOverview {
  generated_at: string
  settings: CapacitySettings
  shared: SharedCapacity[]
  dedicated: AppCapacity[]
}

export function figuresOf(s: CapacitySample): Figures {
  return {
    sampled_at: s.sampled_at.toISOString(),
    cpu_pct: s.cpu_pct,
    memory_mb: s.memory_mb,
    requests_per_min: s.requests_per_min,
    busy_ms_per_min: s.busy_ms_per_min,
    errors_per_min: s.errors_per_min,
    db_in_use: s.db_in_use,
    db_waiting: s.db_waiting,
    db_pool_max: s.db_pool_max,
    jobs_running: s.jobs_running,
    jobs_waiting: s.jobs_waiting,
    storage_bytes: s.storage_bytes,
    processes: s.processes,
    error: s.error
  }
}

const avg = (xs: Array<number | null>): number | null => {
  const real = xs.filter((x): x is number => typeof x === 'number')
  return real.length ? Math.round((real.reduce((a, b) => a + b, 0) / real.length) * 10) / 10 : null
}
const max = (xs: Array<number | null>): number | null => {
  const real = xs.filter((x): x is number => typeof x === 'number')
  return real.length ? Math.max(...real) : null
}

/** Samples bucketed by `bucketMs` (day or hour, UTC), oldest first. Samples with an error and no
 *  figures count as gaps, not zeros. */
export function trendOf(samples: readonly CapacitySample[], bucketMs: number): TrendPoint[] {
  const groups = new Map<number, CapacitySample[]>()
  for (const s of samples) {
    if (s.requests_per_min === null && s.cpu_pct === null && s.db_in_use === null) continue
    const k = Math.floor(s.sampled_at.getTime() / bucketMs) * bucketMs
    const g = groups.get(k)
    if (g) g.push(s)
    else groups.set(k, [s])
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, g]) => ({
      at: new Date(k).toISOString(),
      requests_per_min: avg(g.map((s) => s.requests_per_min)),
      busy_ms_per_min: avg(g.map((s) => s.busy_ms_per_min)),
      cpu_pct: avg(g.map((s) => s.cpu_pct)),
      memory_mb: avg(g.map((s) => s.memory_mb)),
      db_in_use: max(g.map((s) => s.db_in_use)),
      storage_bytes: max(g.map((s) => s.storage_bytes)),
      samples: g.length
    }))
}

const ratio = (part: number | null, whole: number | null): number | null =>
  part === null || whole === null || whole <= 0 ? null : Math.round((part / whole) * 1000) / 1000

/** One app's share of its deployment in one sample round. */
export function shareOf(app: CapacitySample, total: CapacitySample): Share {
  return {
    requests: ratio(app.requests_per_min, total.requests_per_min),
    busy: ratio(app.busy_ms_per_min, total.busy_ms_per_min),
    db: ratio(app.db_in_use, total.db_in_use)
  }
}

/** The largest of an app's shares (null when none could be worked out). */
export function topShare(s: Share | null): number | null {
  if (!s) return null
  return max([s.requests, s.busy, s.db])
}

export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000

interface Labels {
  app_id: number | null
  app_key: string
  app_name: string
  env_key: string
}

async function labelsOf(envIds: number[]): Promise<Map<number, Labels>> {
  if (!envIds.length) return new Map()
  const envs = (await db(ENVS).whereIn('id', envIds).select('id', 'key', 'app_id')) as Array<{
    id: number
    key: string
    app_id: number
  }>
  const apps = new Map(
    (
      (await db(APPS)
        .whereIn('id', [...new Set(envs.map((e) => Number(e.app_id)))])
        .select('id', 'key', 'name')) as Array<{ id: number; key: string; name: string }>
    ).map((a) => [Number(a.id), a])
  )
  return new Map(
    envs.map((e) => {
      const a = apps.get(Number(e.app_id))
      return [
        Number(e.id),
        {
          app_id: a ? Number(a.id) : null,
          app_key: a?.key ?? '?',
          app_name: a?.name ?? '?',
          env_key: String(e.key)
        }
      ]
    })
  )
}

/** Groups samples by a key, oldest first inside each group (samples come sorted). */
function groupBy<K>(samples: CapacitySample[], key: (s: CapacitySample) => K | null) {
  const out = new Map<K, CapacitySample[]>()
  for (const s of samples) {
    const k = key(s)
    if (k === null) continue
    const g = out.get(k)
    if (g) g.push(s)
    else out.set(k, [s])
  }
  return out
}

/** Builds the overview from samples (pure; the loader below reads them). */
export function buildOverview(input: {
  now: Date
  settings: CapacitySettings
  shared: { id: number; key: string; name: string; status: string; pool_budget: number }[]
  samples: CapacitySample[]
  labels: Map<number, Labels>
  limits: Map<number, AppLimits>
  bucketMs?: number
}): CapacityOverview {
  const bucket = input.bucketMs ?? DAY_MS
  const totals = groupBy(input.samples, (s) =>
    s.scope === 'shared' ? s.shared_deployment_id : null
  )
  const perEnv = groupBy(input.samples, (s) =>
    s.scope === 'environment' ? s.environment_id : null
  )

  const appOf = (
    envId: number,
    rows: CapacitySample[],
    total: CapacitySample | null
  ): AppCapacity => {
    const l = input.labels.get(envId)
    const latest = rows[rows.length - 1] ?? null
    // The share is taken in the deployment's latest round only (an app sampled with the round).
    const share =
      latest && total && latest.sampled_at.getTime() === total.sampled_at.getTime()
        ? shareOf(latest, total)
        : null
    return {
      env_id: envId,
      app_id: l?.app_id ?? null,
      app_key: l?.app_key ?? '?',
      app_name: l?.app_name ?? '?',
      env_key: l?.env_key ?? String(envId),
      tenant_id: latest?.tenant_id ?? null,
      latest: latest ? figuresOf(latest) : null,
      share,
      uses_most: false,
      limits: input.limits.get(envId) ?? {},
      trend: trendOf(rows, bucket)
    }
  }

  const sharedOut: SharedCapacity[] = input.shared.map((s) => {
    const t = totals.get(s.id) ?? []
    const total = t[t.length - 1] ?? null
    // The apps of its latest round (what it serves now), else every app ever sampled on it.
    const ids = new Set<number>()
    for (const [envId, rows] of perEnv) {
      const last = rows[rows.length - 1]
      if (last?.shared_deployment_id !== s.id) continue
      if (total && last.sampled_at.getTime() !== total.sampled_at.getTime()) continue
      ids.add(envId)
    }
    const apps = [...ids].map((envId) =>
      appOf(
        envId,
        (perEnv.get(envId) ?? []).filter((r) => r.shared_deployment_id === s.id),
        total
      )
    )
    if (apps.length >= 2)
      for (const a of apps) a.uses_most = (topShare(a.share) ?? 0) >= input.settings.most_share
    apps.sort((a, b) => (topShare(b.share) ?? -1) - (topShare(a.share) ?? -1))
    return {
      id: s.id,
      key: s.key,
      name: s.name,
      status: s.status,
      pool_budget: s.pool_budget,
      latest: total ? figuresOf(total) : null,
      trend: trendOf(t, bucket),
      apps
    }
  })

  const dedicated: AppCapacity[] = []
  for (const [envId, rows] of perEnv) {
    const last = rows[rows.length - 1]
    if (!last || last.shared_deployment_id !== null) continue
    dedicated.push(
      appOf(
        envId,
        rows.filter((r) => r.shared_deployment_id === null),
        null
      )
    )
  }
  dedicated.sort((a, b) => `${a.app_key}/${a.env_key}`.localeCompare(`${b.app_key}/${b.env_key}`))
  return {
    generated_at: input.now.toISOString(),
    settings: input.settings,
    shared: sharedOut,
    dedicated
  }
}

/** The Capacity tab's overview over the last `days` days (daily trend). */
export async function capacityOverview(days = 30, now = new Date()): Promise<CapacityOverview> {
  const since = new Date(now.getTime() - days * DAY_MS)
  const [samples, settings, shared, limits] = await Promise.all([
    samplesSince(since),
    readSettings(),
    listShared(),
    limitsByEnv()
  ])
  const envIds = [
    ...new Set(samples.map((s) => s.environment_id).filter((x): x is number => x !== null))
  ]
  return buildOverview({
    now,
    settings,
    shared: shared.filter(
      (s) => s.status !== 'retired' || samples.some((x) => x.shared_deployment_id === s.id)
    ),
    samples,
    labels: await labelsOf(envIds),
    limits
  })
}

/** One environment's (or deployment's) hourly trend over the last `days` days. */
export async function capacityTrend(
  where: { envId?: number; sharedId?: number },
  days = 30,
  now = new Date()
): Promise<{ trend: TrendPoint[]; latest: Figures | null }> {
  const since = new Date(now.getTime() - days * DAY_MS)
  const rows = (
    await samplesSince(
      since,
      where.envId ? { envIds: [where.envId] } : { sharedIds: [where.sharedId ?? -1] }
    )
  ).filter((s) =>
    where.envId
      ? s.scope === 'environment' && s.environment_id === where.envId
      : s.scope === 'shared'
  )
  const last = rows[rows.length - 1]
  return { trend: trendOf(rows, HOUR_MS), latest: last ? figuresOf(last) : null }
}
