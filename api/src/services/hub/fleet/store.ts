import { db } from '../../../db/index.js'
import { MOVE_OPEN_STATUSES } from '../move-open.js'
import type { HubEnvStatus } from '../status.js'
import { type ProbeSample, versionOf } from './probe.js'
import type { UptimeCounts } from './uptime.js'

/**
 * Hub fleet tables (migration 566): the status snapshot per environment, the uptime samples and
 * their hourly rollups, and the small reads the fleet page and the jobs share (last Hub deploy per
 * environment, people's names, environments a Hub run is busy with). Raw knex on the Hub's own
 * tables only — never an app's data.
 *
 * Raw minute samples live 48 hours: the rollup job (hub-fleet-rollup) folds them into
 * nivaro_hub_uptime_hours, and every uptime figure (page, sheet, monthly report) reads the
 * hours. Raw rows are read only by the rollup and the "recent failed probes" list.
 */

export const FLEET_STATUS = 'nivaro_hub_fleet_status'
export const SAMPLES = 'nivaro_hub_uptime_samples'
export const HOURS = 'nivaro_hub_uptime_hours'
export const ALERTS = 'nivaro_hub_fleet_alerts'
export const REPORTS = 'nivaro_hub_slo_reports'
const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const DEPLOYS = 'nivaro_hub_deploys'
const MOVES = 'nivaro_hub_moves'

/** Raw samples are kept this long (the rollup re-folds the last few hours each run). */
export const SAMPLE_KEEP_HOURS = 48
/** Hourly rollups are kept this long (monthly reports are kept for good). */
export const HOUR_KEEP_DAYS = 400
/** Resolved alerts are kept this long for the page's history. */
export const ALERT_KEEP_DAYS = 180
/** The rollup re-folds this many most recent hours each run (a late sample is never lost). */
export const ROLLUP_HOURS = 3

const HOUR_MS = 3_600_000
const CHUNK = 500

/** `fn` over `ids` in chunks of 500 (the bound-parameter cap), rows flattened. */
async function chunked<T, I>(ids: I[], fn: (chunk: I[]) => PromiseLike<unknown>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await fn(ids.slice(i, i + CHUNK))
    if (Array.isArray(r)) out.push(...(r as T[]))
  }
  return out
}

export interface ProbeTarget {
  id: number
  app_id: number
  app_key: string
  key: string
  base_url: string
  hub_token: string | null
  placement_id: number | null
}

/**
 * Every environment the probe job looks at: status 'active' only. An environment being created,
 * waiting for its name or held in maintenance by a move makes no samples, so planned windows
 * never count against its SLO.
 */
export async function listProbeTargets(): Promise<ProbeTarget[]> {
  const rows = (await db(`${ENVS} as e`)
    .join(`${APPS} as a`, 'a.id', 'e.app_id')
    .where('e.status', 'active')
    .orderBy('e.id', 'asc')
    .select(
      'e.id',
      'e.app_id',
      'a.key as app_key',
      'e.key',
      'e.base_url',
      'e.hub_token',
      'e.placement_id'
    )) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    app_id: Number(r.app_id),
    app_key: String(r.app_key),
    key: String(r.key),
    base_url: String(r.base_url),
    hub_token: (r.hub_token as string | null) ?? null,
    placement_id: r.placement_id == null ? null : Number(r.placement_id)
  }))
}

/**
 * Environments a Hub run is busy with right now: a running promotion/rollback/stack apply
 * (nivaro_hub_deploys) or an open move. Their probes are not stored (a declared window: the Hub
 * itself is restarting them), and their drift alerts are left as they are.
 */
export async function busyEnvironments(): Promise<Set<number>> {
  const out = new Set<number>()
  const read = async (table: string, statuses: string[]) => {
    try {
      const rows = (await db(table)
        .whereIn('status', statuses)
        .distinct('environment_id')) as Array<{ environment_id: number }>
      for (const r of rows) out.add(Number(r.environment_id))
    } catch {
      /* a table missing on an old database: nothing busy there */
    }
  }
  await Promise.all([read(DEPLOYS, ['running']), read(MOVES, MOVE_OPEN_STATUSES as string[])])
  return out
}

export async function recordSample(envId: number, s: ProbeSample, at: Date): Promise<void> {
  await db(SAMPLES).insert({
    environment_id: envId,
    at,
    up: s.up,
    version_ok: s.version_ok,
    ready: s.ready,
    ms: s.ms,
    code: s.code ? s.code.slice(0, 32) : null
  })
}

export interface FleetStatusRow {
  environment_id: number
  app_id: number
  state: string | null
  version: string | null
  version_since: string | null
  preflight: string | null
  readiness_score: number | null
  open_issues: number | null
  source: string | null
  error: string | null
  failing: string[]
  checked_at: string | null
  up: boolean | null
  probed_at: string | null
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function bool(v: unknown): boolean | null {
  if (v == null) return null
  return v === true || v === 1 || v === '1' || v === 'true'
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function failingOf(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return []
  try {
    const a = JSON.parse(v) as unknown
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function statusRowFrom(r: Record<string, unknown>): FleetStatusRow {
  return {
    environment_id: Number(r.environment_id),
    app_id: Number(r.app_id),
    state: (r.state as string | null) ?? null,
    version: (r.version as string | null) ?? null,
    version_since: iso(r.version_since),
    preflight: (r.preflight as string | null) ?? null,
    readiness_score: num(r.readiness_score),
    open_issues: num(r.open_issues),
    source: (r.source as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    failing: failingOf(r.failing),
    checked_at: iso(r.checked_at),
    up: bool(r.up),
    probed_at: iso(r.probed_at)
  }
}

export async function readFleetStatus(envIds?: number[]): Promise<Map<number, FleetStatusRow>> {
  const rows = (
    envIds
      ? await chunked(envIds, (chunk) =>
          db(FLEET_STATUS).whereIn('environment_id', chunk).select('*')
        )
      : await db(FLEET_STATUS).select('*')
  ) as Array<Record<string, unknown>>
  return new Map(rows.map((r) => [Number(r.environment_id), statusRowFrom(r)]))
}

export interface StatusPatch {
  /** A fresh status read (hub link / public / shared). */
  status?: HubEnvStatus
  /** A probe sample (version seen publicly + up/down). */
  probe?: ProbeSample
}

const cut = (v: string | null | undefined, n: number) => (v ? String(v).slice(0, n) : null)

/** A unique-key violation on insert (the row appeared since we looked), on any of the engines. */
function isDuplicate(err: unknown): boolean {
  const e = err as { code?: unknown; number?: unknown; errno?: unknown; message?: unknown }
  return (
    e?.number === 2627 ||
    e?.number === 2601 ||
    e?.code === '23505' ||
    e?.code === 'ER_DUP_ENTRY' ||
    e?.errno === 1062 ||
    /UNIQUE constraint failed|duplicate key/i.test(String(e?.message ?? ''))
  )
}

/**
 * Writes what the probe tick learned about one environment, race-safe (update, else insert, and an
 * insert that loses a race becomes an update). Every text is cut to its column; a version is kept
 * only when it looks like one (versionOf). `version_since` moves only when the version changes.
 */
export async function writeFleetStatus(
  envId: number,
  appId: number,
  patch: StatusPatch,
  now: Date
): Promise<void> {
  const prev = (await db(FLEET_STATUS)
    .where({ environment_id: envId })
    .first('version', 'version_since')) as Record<string, unknown> | undefined
  const row: Record<string, unknown> = { app_id: appId, updated_at: now }
  const seen = versionOf(patch.status?.version) ?? versionOf(patch.probe?.version)
  if (patch.status) {
    const s = patch.status
    Object.assign(row, {
      state: cut(s.state, 16),
      preflight: cut(s.preflight, 16),
      readiness_score: s.readiness_score ?? null,
      open_issues: s.open_issues ?? null,
      source: cut(s.source, 16),
      error: cut(s.error, 200),
      failing: s.failing?.length ? JSON.stringify(s.failing.slice(0, 20)) : null,
      checked_at: now
    })
  }
  if (patch.probe) Object.assign(row, { up: patch.probe.up, probed_at: now })
  if (seen) {
    const was = (prev?.version as string | null | undefined) ?? null
    row.version = seen
    if (seen !== was || !prev?.version_since) row.version_since = now
  }
  const update = () => db(FLEET_STATUS).where({ environment_id: envId }).update(row)
  if (prev) {
    await update()
    return
  }
  try {
    await db(FLEET_STATUS).insert({ environment_id: envId, ...row })
  } catch (err) {
    if (!isDuplicate(err)) throw err
    await update()
  }
}

/** Status rows of environments that no longer exist. */
export async function forgetGoneEnvironments(keep: number[]): Promise<void> {
  const rows = (await db(FLEET_STATUS).select('environment_id')) as Array<{
    environment_id: number
  }>
  const keepSet = new Set(keep)
  const gone = rows.map((r) => Number(r.environment_id)).filter((id) => !keepSet.has(id))
  if (!gone.length) return
  const live = new Set(
    (
      (await chunked(gone, (chunk) => db(ENVS).whereIn('id', chunk).select('id'))) as Array<{
        id: number
      }>
    ).map((r) => Number(r.id))
  )
  const dead = gone.filter((id) => !live.has(id))
  if (dead.length)
    await chunked(dead, (chunk) => db(FLEET_STATUS).whereIn('environment_id', chunk).delete())
}

/** The UTC hour `d` falls in. */
export function hourOf(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS)
}

/** The 95th percentile of `values` (nearest-rank), or null. */
export function p95(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

/**
 * Folds the raw samples of the last ROLLUP_HOURS hours into nivaro_hub_uptime_hours (one row per
 * environment + hour, rewritten each run, so a late sample is counted). Answers rows written.
 */
export async function rollupHours(now: Date): Promise<number> {
  const from = new Date(hourOf(now).getTime() - (ROLLUP_HOURS - 1) * HOUR_MS)
  const rows = (await db(SAMPLES)
    .where('at', '>=', from)
    .select('environment_id', 'at', 'up', 'ms')) as Array<Record<string, unknown>>
  const buckets = new Map<
    string,
    { env: number; hour: Date; n: number; up: number; ms: number[] }
  >()
  for (const r of rows) {
    const at = new Date(iso(r.at) ?? '')
    if (!Number.isFinite(at.getTime())) continue
    const env = Number(r.environment_id)
    const hour = hourOf(at)
    const k = `${env}:${hour.getTime()}`
    const b = buckets.get(k) ?? { env, hour, n: 0, up: 0, ms: [] }
    b.n++
    if (bool(r.up)) b.up++
    const ms = num(r.ms)
    if (ms != null) b.ms.push(ms)
    buckets.set(k, b)
  }
  for (const b of buckets.values()) {
    const row = { samples: b.n, up_samples: b.up, ms_p95: p95(b.ms) }
    const where = { environment_id: b.env, hour: b.hour }
    const n = Number(await db(HOURS).where(where).update(row)) || 0
    if (n > 0) continue
    try {
      await db(HOURS).insert({ ...where, ...row })
    } catch (err) {
      if (!isDuplicate(err)) throw err
      await db(HOURS).where(where).update(row)
    }
  }
  return buckets.size
}

/** Samples and answered samples per environment over the hours in [from, to). */
export async function uptimeCounts(
  envIds: number[],
  from: Date,
  to: Date
): Promise<Map<number, UptimeCounts>> {
  const out = new Map<number, UptimeCounts>()
  if (!envIds.length) return out
  const rows = (await chunked(envIds, (chunk) =>
    db(HOURS)
      .whereIn('environment_id', chunk)
      .where('hour', '>=', hourOf(from))
      .where('hour', '<', to)
      .groupBy('environment_id')
      .select('environment_id')
      .sum({ samples: 'samples', up: 'up_samples' })
  )) as Array<{ environment_id: number; samples: number | string; up: number | string }>
  for (const r of rows)
    out.set(Number(r.environment_id), { samples: Number(r.samples) || 0, up: Number(r.up) || 0 })
  return out
}

/** One environment's hours from `from` (oldest first). */
export async function uptimeHourSeries(
  envId: number,
  from: Date
): Promise<Array<{ at: string; samples: number; up: number; ms: number | null }>> {
  const rows = (await db(HOURS)
    .where({ environment_id: envId })
    .where('hour', '>=', hourOf(from))
    .orderBy('hour', 'asc')
    .limit(24 * 31)
    .select('hour', 'samples', 'up_samples', 'ms_p95')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    at: iso(r.hour) ?? '',
    samples: Number(r.samples) || 0,
    up: Number(r.up_samples) || 0,
    ms: num(r.ms_p95)
  }))
}

/** The newest failed probes of one environment (raw samples, so the last 48 hours at most). */
export async function recentFailures(
  envId: number,
  limit = 50
): Promise<Array<{ at: string; code: string | null }>> {
  const rows = (await db(SAMPLES)
    .where({ environment_id: envId, up: false })
    .orderBy('at', 'desc')
    .limit(limit)
    .select('at', 'code')) as Array<Record<string, unknown>>
  return rows.map((r) => ({ at: iso(r.at) ?? '', code: (r.code as string | null) ?? null }))
}

/** Deletes raw samples past 48 h, hours past 400 days and old resolved alerts, in batches. */
export async function pruneSamples(now: Date, batch = 5000, maxBatches = 200): Promise<number> {
  const before = new Date(now.getTime() - SAMPLE_KEEP_HOURS * HOUR_MS)
  let total = 0
  for (let i = 0; i < maxBatches; i++) {
    const ids = (
      (await db(SAMPLES)
        .where('at', '<', before)
        .orderBy('id', 'asc')
        .limit(batch)
        .select('id')) as Array<{ id: number }>
    ).map((r) => Number(r.id))
    if (!ids.length) break
    await chunked(ids, (chunk) => db(SAMPLES).whereIn('id', chunk).delete())
    total += ids.length
    if (ids.length < batch) break
  }
  await db(HOURS)
    .where('hour', '<', new Date(now.getTime() - HOUR_KEEP_DAYS * 24 * HOUR_MS))
    .delete()
  const alertsBefore = new Date(now.getTime() - ALERT_KEEP_DAYS * 24 * HOUR_MS)
  await db(ALERTS).whereNotNull('resolved_at').where('resolved_at', '<', alertsBefore).delete()
  return total
}

export interface LastDeploy {
  id: number
  environment_id: number
  kind: string
  version: string
  status: string
  started_by: string | null
  started_at: string | null
  finished_at: string | null
}

function deployFrom(r: Record<string, unknown>): LastDeploy {
  return {
    id: Number(r.id),
    environment_id: Number(r.environment_id),
    kind: String(r.kind),
    version: String(r.version),
    status: String(r.status),
    started_by: (r.started_by as string | null) ?? null,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at)
  }
}

/**
 * The newest Hub promotion/rollback per environment (any result), and the newest successful one
 * (what "deployed at" means for the stale-deploy rule).
 */
export async function lastDeploys(
  envIds: number[]
): Promise<{ last: Map<number, LastDeploy>; lastSuccess: Map<number, LastDeploy> }> {
  const last = new Map<number, LastDeploy>()
  const lastSuccess = new Map<number, LastDeploy>()
  if (!envIds.length) return { last, lastSuccess }
  const newestIds = async (success: boolean) =>
    (
      (await chunked(envIds, (chunk) => {
        const q = db(DEPLOYS).whereIn('environment_id', chunk)
        if (success) q.where('status', 'success')
        return q.groupBy('environment_id').select('environment_id').max({ id: 'id' })
      })) as Array<{ id: number | string | null }>
    )
      .map((r) => Number(r.id))
      .filter((id) => Number.isFinite(id) && id > 0)
  const [a, b] = await Promise.all([newestIds(false), newestIds(true)])
  const ids = [...new Set([...a, ...b])]
  if (!ids.length) return { last, lastSuccess }
  const rows = (await chunked(ids, (chunk) =>
    db(DEPLOYS)
      .whereIn('id', chunk)
      .select(
        'id',
        'environment_id',
        'kind',
        'version',
        'status',
        'started_by',
        'started_at',
        'finished_at'
      )
  )) as Array<Record<string, unknown>>
  const byId = new Map(rows.map((r) => [Number(r.id), deployFrom(r)]))
  for (const id of a) {
    const d = byId.get(id)
    if (d) last.set(d.environment_id, d)
  }
  for (const id of b) {
    const d = byId.get(id)
    if (d) lastSuccess.set(d.environment_id, d)
  }
  return { last, lastSuccess }
}

/** User id → a readable name (first + last, else email, else the id). Unknown ids keep the id. */
export async function namesOf(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x).map((x) => x.toLowerCase()))].filter(
    (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x)
  )
  const out = new Map<string, string>()
  if (!want.length) return out
  try {
    const rows = (await chunked(want, (chunk) =>
      db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
    )) as Array<Record<string, unknown>>
    for (const u of rows) {
      const full = [u.first_name, u.last_name]
        .filter((x) => typeof x === 'string' && x.trim())
        .join(' ')
        .trim()
      out.set(String(u.id).toLowerCase(), full || (typeof u.email === 'string' ? u.email : ''))
    }
  } catch {
    /* names are a nicety */
  }
  return out
}

export function nameFrom(names: Map<string, string>, id: string | null | undefined): string | null {
  if (!id) return null
  return names.get(id.toLowerCase()) || id
}
