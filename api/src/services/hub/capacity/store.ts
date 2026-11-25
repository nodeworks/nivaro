import { db } from '../../../db/index.js'
import { type AppLimits, LIMIT_KEYS, parseAppLimits } from '../../capacity/limits.js'

/**
 * Nivaro Hub capacity (migration 567): the samples the capacity job stores, the per-app limits
 * on a shared deployment and the advisor's thresholds. Aggregate figures only.
 */

export const SAMPLES = 'nivaro_hub_capacity_samples'
export const LIMITS = 'nivaro_hub_app_limits'
export const REBALANCES = 'nivaro_hub_rebalances'

/** Samples older than this are pruned by the capacity job. */
export const KEEP_DAYS = 31

export interface CapacitySample {
  sampled_at: Date
  scope: 'shared' | 'environment'
  shared_deployment_id: number | null
  environment_id: number | null
  tenant_id: string | null
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

const NUMERIC: (keyof CapacitySample)[] = [
  'shared_deployment_id',
  'environment_id',
  'cpu_pct',
  'memory_mb',
  'requests_per_min',
  'busy_ms_per_min',
  'errors_per_min',
  'db_in_use',
  'db_waiting',
  'db_pool_max',
  'jobs_running',
  'jobs_waiting',
  'storage_bytes',
  'processes'
]

/** A stored row as a sample (bigint columns read as text on every engine; dates as Date). */
export function sampleFromRow(r: Record<string, unknown>): CapacitySample {
  const out = { ...r } as Record<string, unknown>
  for (const k of NUMERIC) {
    const v = r[k]
    out[k] = v === null || v === undefined || v === '' ? null : Number(v)
  }
  out.sampled_at = r.sampled_at instanceof Date ? r.sampled_at : new Date(String(r.sampled_at))
  out.tenant_id = r.tenant_id == null ? null : String(r.tenant_id)
  out.error = r.error == null ? null : String(r.error)
  out.scope = r.scope === 'shared' ? 'shared' : 'environment'
  delete out.id
  return out as unknown as CapacitySample
}

export async function insertSamples(rows: CapacitySample[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) await db(SAMPLES).insert(rows.slice(i, i + 100))
}

/** Deletes samples older than KEEP_DAYS, at most 5000 rows per statement. */
export async function pruneSamples(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - KEEP_DAYS * 86_400_000)
  let total = 0
  for (let round = 0; round < 50; round++) {
    const ids = (await db(SAMPLES)
      .where('sampled_at', '<', before)
      .orderBy('id')
      .limit(5000)
      .pluck('id')) as number[]
    if (!ids.length) break
    total += await db(SAMPLES).whereIn('id', ids).del()
    if (ids.length < 5000) break
  }
  return total
}

/** Samples since `since`, for the environments and/or shared deployments named, oldest first. */
export async function samplesSince(
  since: Date,
  where: { envIds?: number[]; sharedIds?: number[] } = {}
): Promise<CapacitySample[]> {
  const q = db(SAMPLES).where('sampled_at', '>=', since)
  const envIds = where.envIds ?? []
  const sharedIds = where.sharedIds ?? []
  if (envIds.length || sharedIds.length)
    q.where((w) => {
      if (envIds.length) w.orWhereIn('environment_id', envIds)
      if (sharedIds.length) w.orWhereIn('shared_deployment_id', sharedIds)
    })
  const rows = (await q.orderBy('sampled_at', 'asc').orderBy('id', 'asc')) as Record<
    string,
    unknown
  >[]
  return rows.map(sampleFromRow)
}

// ─── limits ──────────────────────────────────────────────────────────────────

function limitsFromRow(r: Record<string, unknown>): AppLimits {
  const raw: Record<string, unknown> = {}
  for (const k of LIMIT_KEYS) raw[k] = r[k] == null ? undefined : Number(r[k])
  return parseAppLimits(raw) ?? {}
}

/** Every environment's limits (only those with a row), by environment id. */
export async function limitsByEnv(envIds?: number[]): Promise<Map<number, AppLimits>> {
  const q = db(LIMITS)
  if (envIds) {
    if (!envIds.length) return new Map()
    q.whereIn('environment_id', envIds)
  }
  const rows = (await q) as Record<string, unknown>[]
  return new Map(rows.map((r) => [Number(r.environment_id), limitsFromRow(r)]))
}

export async function getLimits(envId: number): Promise<AppLimits> {
  return (await limitsByEnv([envId])).get(envId) ?? {}
}

/** Stores an environment's limits (an empty set removes its row). Answers whether it changed. */
export async function setLimits(envId: number, limits: AppLimits, by: string): Promise<boolean> {
  const before = await getLimits(envId)
  const same = LIMIT_KEYS.every((k) => (before[k] ?? null) === (limits[k] ?? null))
  if (same) return false
  const cols = {
    requests_per_minute: limits.requests_per_minute ?? null,
    jobs: limits.jobs ?? null,
    storage_mb: limits.storage_mb ?? null
  }
  const empty = LIMIT_KEYS.every((k) => limits[k] == null)
  const exists = await db(LIMITS).where({ environment_id: envId }).first('id')
  if (empty) {
    if (exists) await db(LIMITS).where({ environment_id: envId }).del()
    return true
  }
  const by_ = /^[0-9a-f-]{36}$/i.test(by) ? by : null
  if (exists)
    await db(LIMITS)
      .where({ environment_id: envId })
      .update({ ...cols, updated_by: by_, updated_at: new Date() })
  else
    await db(LIMITS).insert({
      environment_id: envId,
      ...cols,
      updated_by: by_,
      updated_at: new Date()
    })
  return true
}

// ─── advisor thresholds ──────────────────────────────────────────────────────

export interface CapacitySettings {
  /** "Fits shared": every one of these holds over the last 7 days (95th percentile). */
  fits: { max_rpm: number; max_memory_mb: number; max_db_in_use: number; max_storage_gb: number }
  /** "Outgrew shared": the app's share of its deployment over `share` in at least `sustained` of
   *  the samples of the last 7 days (requests, busy time or connections), or over max_rpm. */
  outgrew: { share: number; sustained: number; max_rpm: number }
  /** "Uses most of the deployment": an app's latest share over this. */
  most_share: number
  /** Fewest samples (15 min each) over 7 days before any advice: 96 = one day. */
  min_samples: number
}

export const DEFAULT_SETTINGS: CapacitySettings = {
  fits: { max_rpm: 30, max_memory_mb: 768, max_db_in_use: 3, max_storage_gb: 20 },
  outgrew: { share: 0.5, sustained: 0.6, max_rpm: 600 },
  most_share: 0.5,
  min_samples: 96
}

const SETTINGS_EXT = 'nivaro-hub'
const SETTINGS_KEY = 'capacity'

const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt

/** Settings as stored or sent, each value within its bounds, the rest default. */
export function normalizeSettings(raw: unknown): CapacitySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const d = DEFAULT_SETTINGS
  return {
    fits: {
      max_rpm: num(r.fits?.max_rpm, 0, 100_000, d.fits.max_rpm),
      max_memory_mb: num(r.fits?.max_memory_mb, 0, 1_000_000, d.fits.max_memory_mb),
      max_db_in_use: num(r.fits?.max_db_in_use, 0, 100, d.fits.max_db_in_use),
      max_storage_gb: num(r.fits?.max_storage_gb, 0, 100_000, d.fits.max_storage_gb)
    },
    outgrew: {
      share: num(r.outgrew?.share, 0.05, 1, d.outgrew.share),
      sustained: num(r.outgrew?.sustained, 0.05, 1, d.outgrew.sustained),
      max_rpm: num(r.outgrew?.max_rpm, 1, 10_000_000, d.outgrew.max_rpm)
    },
    most_share: num(r.most_share, 0.05, 1, d.most_share),
    min_samples: Math.round(num(r.min_samples, 1, 672, d.min_samples))
  }
}

export async function readSettings(): Promise<CapacitySettings> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: SETTINGS_EXT, key: SETTINGS_KEY })
      .first('value')) as { value: string | null } | undefined
    return normalizeSettings(row?.value ? JSON.parse(row.value) : {})
  } catch {
    return normalizeSettings({})
  }
}

export async function writeSettings(s: CapacitySettings, by: string): Promise<void> {
  const value = JSON.stringify(s)
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: SETTINGS_EXT, key: SETTINGS_KEY })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date(), updated_by: by })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: SETTINGS_EXT,
      key: SETTINGS_KEY,
      value,
      updated_at: new Date(),
      updated_by: by
    })
}
