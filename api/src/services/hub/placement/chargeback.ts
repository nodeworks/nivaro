import type { Knex } from 'knex'
import { db } from '../../../db/index.js'
import { csvRow } from '../../../lib/csv-cell.js'
import { SAMPLES } from '../capacity/store.js'
import { plainText, REGION_DRIVERS, REGIONS } from './regions.js'

/**
 * Hub placement (idea 49): a rough monthly cost per app, for chargeback.
 *
 * Figures come from what the Hub already measures (hub capacity samples, every 15 minutes, kept
 * 31 days) and the newest database backup the Hub made (hub data, its size), times rates an
 * administrator sets. Per environment, over the window (default 30 days):
 *
 *   cpu cores   mean CPU (% of one core) / 100. On a shared deployment the app's CPU is the
 *               deployment's split by answering time (the capacity sample's own estimate).
 *   memory GB   mean memory. A shared deployment's memory is split between its apps by their
 *               share of its answering time over the window (evenly when nobody answered).
 *   storage GB  the newest stored-files total.
 *   database GB the newest successful Hub backup's size (unknown = not charged, flagged).
 *   + a flat amount per environment (the stack, its Redis, the Hub's own care).
 *
 * monthly = (cores × cpu rate + memory × memory rate + storage × storage rate + database ×
 * database rate + flat) × the host region's cost factor / 100. It is an estimate for showback,
 * never an invoice: a figure the Hub could not read counts as nothing and is named in `gaps`.
 *
 * Grouped per app, per department (the app's cost centre record) and per owner (an app with
 * several owners is listed under each, so owner totals overlap and say so).
 */

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const OWNERS = 'nivaro_hub_app_owners'
const USERS = 'nivaro_users'
const PLACEMENTS = 'nivaro_hub_placements'
const SHARED = 'nivaro_hub_shared_deployments'
const DATA_RUNS = 'nivaro_hub_data_runs'
export const COST_CENTERS = 'nivaro_hub_app_cost_centers'

const SETTINGS_EXT = 'nivaro-hub'
const SETTINGS_KEY = 'chargeback'

const GB = 1024 ** 3

export interface ChargebackRates {
  cpu_core_month: number
  memory_gb_month: number
  storage_gb_month: number
  database_gb_month: number
  environment_month: number
}

export interface ChargebackSettings {
  /** ISO 4217 code shown beside every amount (no conversion). */
  currency: string
  rates: ChargebackRates
  /** Days of samples the means are taken over (7–31). */
  window_days: number
}

export const DEFAULT_CHARGEBACK: ChargebackSettings = {
  currency: 'USD',
  rates: {
    cpu_core_month: 0,
    memory_gb_month: 0,
    storage_gb_month: 0,
    database_gb_month: 0,
    environment_month: 0
  },
  window_days: 30
}

const RATE_KEYS = Object.keys(DEFAULT_CHARGEBACK.rates) as (keyof ChargebackRates)[]
export const MAX_RATE = 1_000_000

/** Settings as stored or sent: each value within its bounds, the rest default. */
export function normalizeChargeback(raw: unknown): ChargebackSettings {
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const cur =
    typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency.trim().toUpperCase())
      ? o.currency.trim().toUpperCase()
      : DEFAULT_CHARGEBACK.currency
  const r = o.rates && typeof o.rates === 'object' ? (o.rates as Record<string, unknown>) : {}
  const rates = { ...DEFAULT_CHARGEBACK.rates }
  for (const k of RATE_KEYS) {
    const v = typeof r[k] === 'string' ? Number(r[k]) : r[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_RATE)
      rates[k] = Math.round(v * 10_000) / 10_000
  }
  const w = Number(o.window_days)
  const window_days = Number.isInteger(w) && w >= 7 && w <= 31 ? w : DEFAULT_CHARGEBACK.window_days
  return { currency: cur, rates, window_days }
}

/** What a PUT may send: refusals for a value out of bounds (never silently dropped). */
export function chargebackRefusal(raw: unknown): string | null {
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!o) return 'Send the settings as an object.'
  // Review L5: a misspelled key is refused, never silently ignored.
  const unknown = Object.keys(o).filter((k) => !['currency', 'rates', 'window_days'].includes(k))
  if (unknown.length) return `Unknown setting: ${unknown[0].slice(0, 40)}.`
  if (
    o.currency !== undefined &&
    (typeof o.currency !== 'string' || !/^[A-Za-z]{3}$/.test(o.currency.trim()))
  )
    return 'The currency is a three-letter code (USD, EUR, GBP …).'
  const r = o.rates
  if (r !== undefined) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'rates is an object.'
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (!(RATE_KEYS as string[]).includes(k)) return `Unknown rate: ${k}.`
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_RATE)
        return `${k} is a number, 0–${MAX_RATE}.`
    }
  }
  if (o.window_days !== undefined) {
    const w = o.window_days
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 7 || w > 31)
      return 'window_days is a whole number of days, 7–31.'
  }
  return null
}

export async function readChargeback(): Promise<ChargebackSettings> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: SETTINGS_EXT, key: SETTINGS_KEY })
      .first('value')) as { value: string | null } | undefined
    return normalizeChargeback(row?.value ? JSON.parse(row.value) : {})
  } catch {
    return normalizeChargeback({})
  }
}

/** nivaro_extension_settings has no `updated_by`: who changed it is in the activity row. */
export async function writeChargeback(s: ChargebackSettings): Promise<void> {
  const value = JSON.stringify(s)
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: SETTINGS_EXT, key: SETTINGS_KEY })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: SETTINGS_EXT,
      key: SETTINGS_KEY,
      value,
      updated_at: new Date()
    })
}

// ─── cost centres ────────────────────────────────────────────────────────────

export interface CostCenter {
  department: string | null
  cost_center: string | null
}

export async function costCenters(): Promise<Map<number, CostCenter>> {
  const rows = (await db(COST_CENTERS).select('app_id', 'department', 'cost_center')) as Array<
    Record<string, unknown>
  >
  return new Map(
    rows.map((r) => [
      Number(r.app_id),
      {
        department: r.department == null ? null : String(r.department),
        cost_center: r.cost_center == null ? null : String(r.cost_center)
      }
    ])
  )
}

export function checkCostCenter(body: Record<string, unknown>): CostCenter {
  return {
    department: plainText(body.department, 120),
    cost_center: plainText(body.cost_center, 120)
  }
}

export async function setCostCenter(
  appId: number,
  c: CostCenter,
  userId: string | null
): Promise<CostCenter> {
  await db.transaction(async (trx) => {
    await trx(COST_CENTERS).where({ app_id: appId }).del()
    if (c.department || c.cost_center)
      await trx(COST_CENTERS).insert({
        app_id: appId,
        department: c.department,
        cost_center: c.cost_center,
        updated_by: userId,
        updated_at: new Date()
      })
  })
  return c
}

// ─── the figures, pure ───────────────────────────────────────────────────────

/** One environment's measured figures over the window (null = unknown). */
export interface EnvUsage {
  cpu_cores: number | null
  memory_gb: number | null
  storage_gb: number | null
  database_gb: number | null
}

export interface EnvCostLine {
  cpu: number
  memory: number
  storage: number
  database: number
  environment: number
  /** Before the region factor. */
  subtotal: number
  factor_percent: number
  total: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** The month's cost of one environment's usage at these rates and factor. Pure. */
export function costOf(u: EnvUsage, rates: ChargebackRates, factorPercent = 100): EnvCostLine {
  const part = (v: number | null, rate: number) => (v != null && v > 0 ? v * rate : 0)
  const cpu = part(u.cpu_cores, rates.cpu_core_month)
  const memory = part(u.memory_gb, rates.memory_gb_month)
  const storage = part(u.storage_gb, rates.storage_gb_month)
  const database = part(u.database_gb, rates.database_gb_month)
  const environment = rates.environment_month
  const subtotal = cpu + memory + storage + database + environment
  const factor = Number.isFinite(factorPercent) && factorPercent > 0 ? factorPercent : 100
  return {
    cpu: round2(cpu),
    memory: round2(memory),
    storage: round2(storage),
    database: round2(database),
    environment: round2(environment),
    subtotal: round2(subtotal),
    factor_percent: factor,
    total: round2((subtotal * factor) / 100)
  }
}

interface SampleLike {
  scope: 'shared' | 'environment'
  shared_deployment_id: number | null
  environment_id: number | null
  cpu_pct: number | null
  memory_mb: number | null
  busy_ms_per_min: number | null
  storage_bytes: number | null
  sampled_at: Date
  error: string | null
}

/**
 * What the report needs of the samples in the window, per environment and per shared
 * deployment: means and sums, which the database computes (review L4: never every sample of the
 * window in the process), and each environment's newest stored-files total.
 */
export interface UsageAggregates {
  env: Map<number, { cpu: number | null; memory: number | null; busy: number }>
  shared: Map<number, { memory: number | null; busy: number }>
  storage: Map<number, number>
}

const meanOf = (xs: number[] | undefined) =>
  xs?.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

/** The aggregates of a list of samples (pure: the rule the SQL follows, and the tests). */
export function aggregatesOf(samples: readonly SampleLike[]): UsageAggregates {
  const acc = (m: Map<number, number[]>, k: number, v: number | null) => {
    if (v == null) return
    const l = m.get(k) ?? []
    l.push(v)
    m.set(k, l)
  }
  const cpu = new Map<number, number[]>()
  const mem = new Map<number, number[]>()
  const busy = new Map<number, number>()
  const sMem = new Map<number, number[]>()
  const sBusy = new Map<number, number>()
  const storage = new Map<number, { at: number; v: number }>()
  const envIds = new Set<number>()
  const sharedIds = new Set<number>()
  for (const s of samples) {
    if (s.error && s.error !== 'PARTIAL') continue
    if (s.scope === 'shared' && s.shared_deployment_id != null) {
      const k = s.shared_deployment_id
      sharedIds.add(k)
      acc(sMem, k, s.memory_mb)
      sBusy.set(k, (sBusy.get(k) ?? 0) + (s.busy_ms_per_min ?? 0))
    } else if (s.scope === 'environment' && s.environment_id != null) {
      const k = s.environment_id
      envIds.add(k)
      acc(cpu, k, s.cpu_pct)
      acc(mem, k, s.memory_mb)
      busy.set(k, (busy.get(k) ?? 0) + (s.busy_ms_per_min ?? 0))
      const at = s.sampled_at.getTime()
      if (s.storage_bytes != null && (storage.get(k)?.at ?? -1) <= at)
        storage.set(k, { at, v: s.storage_bytes })
    }
  }
  return {
    env: new Map(
      [...envIds].map((k) => [
        k,
        { cpu: meanOf(cpu.get(k)), memory: meanOf(mem.get(k)), busy: busy.get(k) ?? 0 }
      ])
    ),
    shared: new Map(
      [...sharedIds].map((k) => [k, { memory: meanOf(sMem.get(k)), busy: sBusy.get(k) ?? 0 }])
    ),
    storage: new Map([...storage].map(([k, x]) => [k, x.v]))
  }
}

/**
 * Per environment: its usage from the aggregates (pure). `sharedOf` = the shared deployment an
 * environment runs on now (its memory is split from the deployment's by answering time),
 * `appsOn` = how many of this Hub's environments each deployment serves (the even split when
 * nobody answered).
 */
export function usageFromAggregates(
  agg: UsageAggregates,
  envIds: readonly number[],
  sharedOf: ReadonlyMap<number, number>,
  appsOn: ReadonlyMap<number, number>,
  dbBytes: ReadonlyMap<number, number>
): Map<number, EnvUsage> {
  const out = new Map<number, EnvUsage>()
  for (const id of envIds) {
    const own = agg.env.get(id)
    const sid = sharedOf.get(id)
    let memoryGb: number | null = null
    if (sid === undefined) memoryGb = own?.memory == null ? null : own.memory / 1024
    else {
      const dep = agg.shared.get(sid)
      if (dep?.memory != null) {
        const share =
          dep.busy > 0
            ? Math.min(1, (own?.busy ?? 0) / dep.busy)
            : 1 / Math.max(1, appsOn.get(sid) ?? 1)
        memoryGb = (dep.memory * share) / 1024
      }
    }
    const st = agg.storage.get(id)
    const dbb = dbBytes.get(id)
    out.set(id, {
      cpu_cores: own?.cpu == null ? null : own.cpu / 100,
      memory_gb: memoryGb,
      storage_gb: st == null ? null : st / GB,
      database_gb: dbb == null ? null : dbb / GB
    })
  }
  return out
}

/** usageFromAggregates over a list of samples (tests). */
export function usageFromSamples(
  samples: readonly SampleLike[],
  envIds: readonly number[],
  sharedOf: ReadonlyMap<number, number>,
  appsOn: ReadonlyMap<number, number>,
  dbBytes: ReadonlyMap<number, number>
): Map<number, EnvUsage> {
  return usageFromAggregates(aggregatesOf(samples), envIds, sharedOf, appsOn, dbBytes)
}

const numOrNull = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)

/** The aggregates, computed by the database over the window (review L4). */
export async function usageAggregates(since: Date): Promise<UsageAggregates> {
  const ok = (q: Knex.QueryBuilder) =>
    q
      .where('sampled_at', '>=', since)
      .where((w) => w.whereNull('error').orWhere('error', 'PARTIAL'))
  const envRows = (await ok(db(SAMPLES).where('scope', 'environment'))
    .whereNotNull('environment_id')
    .groupBy('environment_id')
    .select('environment_id')
    .avg({ cpu: 'cpu_pct' })
    .avg({ memory: 'memory_mb' })
    .sum({ busy: 'busy_ms_per_min' })) as Array<Record<string, unknown>>
  const sharedRows = (await ok(db(SAMPLES).where('scope', 'shared'))
    .whereNotNull('shared_deployment_id')
    .groupBy('shared_deployment_id')
    .select('shared_deployment_id')
    .avg({ memory: 'memory_mb' })
    .sum({ busy: 'busy_ms_per_min' })) as Array<Record<string, unknown>>
  const newest = ok(db(SAMPLES).where('scope', 'environment'))
    .whereNotNull('storage_bytes')
    .whereNotNull('environment_id')
    .groupBy('environment_id')
    .select('environment_id')
    .max({ at: 'sampled_at' })
    .as('n')
  const storeRows = (await db(`${SAMPLES} as s`)
    .join(newest, function () {
      this.on('s.environment_id', '=', 'n.environment_id').andOn('s.sampled_at', '=', 'n.at')
    })
    .where('s.scope', 'environment')
    .whereNotNull('s.storage_bytes')
    .select('s.environment_id', 's.storage_bytes')) as Array<Record<string, unknown>>
  const storage = new Map<number, number>()
  for (const r of storeRows) {
    const k = Number(r.environment_id)
    const v = numOrNull(r.storage_bytes)
    if (v != null) storage.set(k, Math.max(storage.get(k) ?? 0, v))
  }
  return {
    env: new Map(
      envRows.map((r) => [
        Number(r.environment_id),
        { cpu: numOrNull(r.cpu), memory: numOrNull(r.memory), busy: numOrNull(r.busy) ?? 0 }
      ])
    ),
    shared: new Map(
      sharedRows.map((r) => [
        Number(r.shared_deployment_id),
        { memory: numOrNull(r.memory), busy: numOrNull(r.busy) ?? 0 }
      ])
    ),
    storage
  }
}

// ─── the report ──────────────────────────────────────────────────────────────

export interface EnvCost {
  env_id: number
  env_key: string
  /** Where it runs: a Docker host, a shared deployment, a GitLab pipeline, or nowhere. */
  runs_on: string
  region: string | null
  usage: EnvUsage
  cost: EnvCostLine
  gaps: string[]
}

export interface AppCost {
  app_id: number
  app_key: string
  app_name: string
  department: string | null
  cost_center: string | null
  owners: Array<{ user_id: string; name: string }>
  environments: EnvCost[]
  total: number
}

export interface GroupCost {
  key: string
  label: string
  apps: number
  total: number
}

export interface ChargebackReport {
  generated_at: string
  window_days: number
  currency: string
  rates: ChargebackRates
  apps: AppCost[]
  departments: GroupCost[]
  owners: GroupCost[]
  total: number
  /** True when no rate is set yet (every amount is 0). */
  unrated: boolean
}

const NO_DEPARTMENT = 'No department'

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

/** The newest successful Hub backup's size per environment (one row per environment, L4). */
async function databaseBytes(envIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!envIds.length || !(await db.schema.hasTable(DATA_RUNS))) return out
  const done = () =>
    db(DATA_RUNS).where({ kind: 'db_backup', status: 'done' }).whereNotNull('artifact')
  const newest = done().groupBy('environment_id').max({ id: 'id' })
  const rows = (await done().whereIn('id', newest).select('environment_id', 'artifact')) as Array<{
    environment_id: number
    artifact: unknown
  }>
  for (const r of rows) {
    let a: unknown = r.artifact
    if (typeof a === 'string') {
      try {
        a = JSON.parse(a)
      } catch {
        continue
      }
    }
    const size = Number((a as { size_bytes?: unknown } | null)?.size_bytes)
    if (Number.isFinite(size) && size > 0) out.set(Number(r.environment_id), size)
  }
  return out
}

export async function chargebackReport(now = new Date()): Promise<ChargebackReport> {
  const settings = await readChargeback()
  const envRows = (await db(`${ENVS} as e`)
    .join(`${APPS} as a`, 'a.id', 'e.app_id')
    .leftJoin(`${PLACEMENTS} as p`, 'p.id', 'e.placement_id')
    .whereNot('e.status', 'archived')
    .orderBy('a.key', 'asc')
    .orderBy('e.position', 'asc')
    .orderBy('e.id', 'asc')
    .select(
      'e.id',
      'e.key',
      'e.app_id',
      'a.key as app_key',
      'a.name as app_name',
      'p.kind as p_kind',
      'p.driver_id as p_driver',
      'p.shared_deployment_id as p_shared'
    )) as Record<string, unknown>[]
  const appsAll = (await db(APPS).orderBy('key', 'asc').select('id', 'key', 'name')) as Array<
    Record<string, unknown>
  >
  const drivers = (await db('nivaro_hub_drivers').select('id', 'name', 'kind')) as Array<
    Record<string, unknown>
  >
  const driverName = new Map(drivers.map((d) => [Number(d.id), String(d.name)]))
  const driverKind = new Map(drivers.map((d) => [Number(d.id), String(d.kind)]))
  const shared = (await db.schema.hasTable(SHARED))
    ? ((await db(SHARED).select('id', 'key', 'driver_id')) as Array<Record<string, unknown>>)
    : []
  const sharedById = new Map(shared.map((s) => [Number(s.id), s]))
  const regions = (await db(REGIONS).select('id', 'name', 'cost_percent')) as Array<
    Record<string, unknown>
  >
  const regionById = new Map(regions.map((r) => [Number(r.id), r]))
  const members = (await db(REGION_DRIVERS).select('driver_id', 'region_id')) as Array<
    Record<string, unknown>
  >
  const regionOfDriver = new Map(members.map((m) => [Number(m.driver_id), Number(m.region_id)]))
  const owners = (await db(`${OWNERS} as o`)
    .leftJoin(`${USERS} as u`, 'u.id', 'o.user_id')
    .select('o.app_id', 'o.user_id', 'u.first_name', 'u.last_name')) as Array<
    Record<string, unknown>
  >
  const centers = await costCenters()

  const envIds = envRows.map((r) => Number(r.id))
  const sharedOf = new Map<number, number>()
  const appsOn = new Map<number, number>()
  for (const r of envRows)
    if (r.p_kind === 'shared' && r.p_shared != null) {
      const sid = Number(r.p_shared)
      sharedOf.set(Number(r.id), sid)
      appsOn.set(sid, (appsOn.get(sid) ?? 0) + 1)
    }
  const since = new Date(now.getTime() - settings.window_days * 86_400_000)
  const usage = usageFromAggregates(
    await usageAggregates(since),
    envIds,
    sharedOf,
    appsOn,
    await databaseBytes(envIds)
  )

  const appMapById = new Map<number, AppCost>()
  for (const a of appsAll) {
    const id = Number(a.id)
    const c = centers.get(id)
    appMapById.set(id, {
      app_id: id,
      app_key: String(a.key),
      app_name: String(a.name ?? a.key),
      department: c?.department ?? null,
      cost_center: c?.cost_center ?? null,
      owners: [],
      environments: [],
      total: 0
    })
  }
  for (const o of owners) {
    const app = appMapById.get(Number(o.app_id))
    if (!app) continue
    const name =
      [o.first_name, o.last_name].filter((x) => x != null && String(x).trim()).join(' ') ||
      'Unnamed'
    app.owners.push({ user_id: String(o.user_id), name })
  }
  for (const r of envRows) {
    const app = appMapById.get(Number(r.app_id))
    if (!app) continue
    const id = Number(r.id)
    const u = usage.get(id) ?? {
      cpu_cores: null,
      memory_gb: null,
      storage_gb: null,
      database_gb: null
    }
    // Where it runs, and the region whose factor applies (a shared deployment's host's).
    let runsOn = 'Not placed'
    let driverId: number | null = null
    if (r.p_kind === 'shared' && r.p_shared != null) {
      const s = sharedById.get(Number(r.p_shared))
      runsOn = `Shared ${s ? String(s.key) : `#${r.p_shared}`}`
      driverId = s?.driver_id == null ? null : Number(s.driver_id)
    } else if (r.p_kind === 'dedicated' && r.p_driver != null) {
      driverId = Number(r.p_driver)
      runsOn =
        driverKind.get(driverId) === 'docker'
          ? (driverName.get(driverId) ?? `Host #${driverId}`)
          : `GitLab ${driverName.get(driverId) ?? `#${driverId}`}`
    }
    const regionId = driverId == null ? undefined : regionOfDriver.get(driverId)
    const region = regionId === undefined ? undefined : regionById.get(regionId)
    const factor = region ? Number(region.cost_percent ?? 100) : 100
    const gaps: string[] = []
    if (u.cpu_cores == null) gaps.push('CPU')
    if (u.memory_gb == null) gaps.push('memory')
    if (u.storage_gb == null) gaps.push('storage')
    if (u.database_gb == null) gaps.push('database size')
    const cost = costOf(u, settings.rates, factor)
    app.environments.push({
      env_id: id,
      env_key: String(r.key),
      runs_on: runsOn,
      region: region ? String(region.name) : null,
      usage: {
        cpu_cores: u.cpu_cores == null ? null : Math.round(u.cpu_cores * 1000) / 1000,
        memory_gb: u.memory_gb == null ? null : Math.round(u.memory_gb * 1000) / 1000,
        storage_gb: u.storage_gb == null ? null : Math.round(u.storage_gb * 1000) / 1000,
        database_gb: u.database_gb == null ? null : Math.round(u.database_gb * 1000) / 1000
      },
      cost,
      gaps
    })
    app.total = round2(app.total + cost.total)
  }
  const apps = [...appMapById.values()].filter((a) => a.environments.length > 0)

  const group = (keyOf: (a: AppCost) => Array<{ key: string; label: string }>) => {
    const m = new Map<string, GroupCost>()
    for (const a of apps)
      for (const g of keyOf(a)) {
        const cur = m.get(g.key) ?? { key: g.key, label: g.label, apps: 0, total: 0 }
        cur.apps++
        cur.total = round2(cur.total + a.total)
        m.set(g.key, cur)
      }
    return [...m.values()].sort((x, y) => y.total - x.total || x.label.localeCompare(y.label))
  }
  const departments = group((a) => [
    { key: (a.department ?? '').toLowerCase(), label: a.department ?? NO_DEPARTMENT }
  ])
  const ownerGroups = group((a) =>
    a.owners.length
      ? a.owners.map((o) => ({ key: o.user_id, label: o.name }))
      : [{ key: '', label: 'No owner' }]
  )
  return {
    generated_at: iso(now) ?? new Date().toISOString(),
    window_days: settings.window_days,
    currency: settings.currency,
    rates: settings.rates,
    apps,
    departments,
    owners: ownerGroups,
    total: round2(apps.reduce((n, a) => n + a.total, 0)),
    unrated: RATE_KEYS.every((k) => settings.rates[k] === 0)
  }
}

/** The report as CSV, one line per environment (every text cell formula-safe, lib/csv-cell). */
export function chargebackCsv(r: ChargebackReport): string {
  const head = [
    'App',
    'App key',
    'Department',
    'Cost centre',
    'Owners',
    'Environment',
    'Runs on',
    'Region',
    'CPU cores',
    'Memory GB',
    'Storage GB',
    'Database GB',
    'CPU cost',
    'Memory cost',
    'Storage cost',
    'Database cost',
    'Environment cost',
    'Region factor %',
    'Monthly total',
    'Currency',
    'Not measured'
  ]
  const n = (v: number | null) => (v == null ? '' : String(v))
  const lines = [csvRow(head)]
  for (const a of r.apps)
    for (const e of a.environments)
      lines.push(
        csvRow([
          a.app_name,
          a.app_key,
          a.department ?? '',
          a.cost_center ?? '',
          a.owners.map((o) => o.name).join('; '),
          e.env_key,
          e.runs_on,
          e.region ?? '',
          n(e.usage.cpu_cores),
          n(e.usage.memory_gb),
          n(e.usage.storage_gb),
          n(e.usage.database_gb),
          e.cost.cpu.toFixed(2),
          e.cost.memory.toFixed(2),
          e.cost.storage.toFixed(2),
          e.cost.database.toFixed(2),
          e.cost.environment.toFixed(2),
          String(e.cost.factor_percent),
          e.cost.total.toFixed(2),
          r.currency,
          e.gaps.join('; ')
        ])
      )
  return `${lines.join('\r\n')}\r\n`
}
