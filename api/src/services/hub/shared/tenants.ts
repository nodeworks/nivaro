import { createHash } from 'node:crypto'
import { db } from '../../../db/index.js'
import type { HubTenantsResponse, HubTenantWire } from '../../tenancy/hub-contract.js'
import { appFromRow, environmentFromRow, type HubApp } from '../apps.js'
import { connectionUrl } from '../db/connection.js'
import { openDatabaseConnection } from '../db/databases.js'
import { environmentNames } from '../docker/render-spec.js'
import type { HubPlacementRow } from '../drivers.js'
import type { HubEnvironmentRow } from '../promote-types.js'
import { openAppKey, type SharedDeployment, tenantIdFor } from './store.js'

/**
 * Nivaro Hub phase 6: the tenants a shared deployment serves, as the phase-5 contract
 * (services/tenancy/hub-contract.ts) the deployment reads from `GET /api/hub/shared/<key>/tenants`.
 *
 * Which environments are listed (ruling P6-1 binds preflight B1/B2 over the plan):
 *  1. every environment whose placement is on this deployment (placement.shared_deployment_id),
 *     with its own status mapped to the wire (B1: there is no env status `moving`; a move sets
 *     `maintenance` at maintenance_on);
 *  2. an environment with an open move (running|waiting|interrupted) OUT of this deployment
 *     that has not reached `retire_source` (or `done`): still listed until the source is
 *     retired. Once its placement already points elsewhere (released) it is listed as
 *     `maintenance`;
 *  3. an environment with an open move INTO this deployment that is placed: `placed_at` alone
 *     (set by placeOnTarget, cleared by unplace / rollback; B2: env.placement_id changes only at
 *     release). Never by ranking the step: B8's manual order runs place_on_target before
 *     files_warm / maintenance_on / wait_idle / files_delta. Listed as `maintenance` until
 *     release.
 * Archived environments are never listed. Only rule 1 rows are `placedHere` (they run this
 * deployment's version; an observed upgrade re-pins only them).
 *
 * The body carries every app's database connection and encryption key: nothing here logs a
 * value. A tenant whose database cannot be opened is left out with a warning naming only its
 * tenant id. The deployment refuses a body over 2 MB (HUB_BODY_MAX_BYTES, hub-source.ts) and
 * keeps its last good list; a body that large is warned about here (also without values).
 */

const PLACEMENTS = 'nivaro_hub_placements'
const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const MOVES = 'nivaro_hub_moves'

/** The deployment refuses a tenants body over this (hub-source.ts HUB_BODY_MAX_BYTES). */
export const TENANTS_BODY_MAX_BYTES = 2 * 1024 * 1024

const OPEN_MOVE = ['running', 'waiting', 'interrupted']
/** A move out of here at one of these steps no longer has its app served here (every kind and
 *  order, B8 included, ends with them). */
const SOURCE_RETIRED_STEPS = new Set(['retire_source', 'done'])

const WIRE_STATUS: Record<string, HubTenantWire['status']> = {
  active: 'active',
  maintenance: 'maintenance',
  // Dead: B1 dropped env status `moving` and nothing writes it. Kept so a stray row never serves
  // normally (it would otherwise vanish from the list).
  moving: 'maintenance',
  provisioning: 'provisioning',
  waiting_for_name: 'provisioning',
  suspended: 'suspended'
}

export interface SharedTenantRow {
  env: HubEnvironmentRow
  app: HubApp
  placement: HubPlacementRow
  wireStatus: HubTenantWire['status']
  /** The environment's own placement is on this deployment (rule 1): it runs this deployment's
   *  version. False for a released move-out or a move in before release. */
  placedHere: boolean
}

/** A placement row as stored, its target parsed (the shared kind keeps `pool_max` there). */
function placementOf(r: Record<string, unknown>): HubPlacementRow {
  let target: Record<string, unknown> = {}
  try {
    const v = typeof r.target === 'string' ? JSON.parse(r.target) : r.target
    if (v && typeof v === 'object' && !Array.isArray(v)) target = v as Record<string, unknown>
  } catch {
    // a damaged target reads as empty
  }
  return {
    ...(r as object),
    id: Number(r.id),
    kind: String(r.kind),
    driver_id: r.driver_id == null ? null : Number(r.driver_id),
    target
  } as unknown as HubPlacementRow
}

/** The environments this deployment serves now, with the placement that puts them here. */
export async function tenantsOf(shared: SharedDeployment): Promise<SharedTenantRow[]> {
  const placementRows = (await db(PLACEMENTS).where({
    shared_deployment_id: shared.id
  })) as Record<string, unknown>[]
  if (!placementRows.length) return []
  const placements = new Map(placementRows.map((r) => [Number(r.id), placementOf(r)]))
  const ids = [...placements.keys()]

  /** env id → [placement here, forced wire status (null = the env's own)] */
  const pick = new Map<number, { placementId: number; forced: HubTenantWire['status'] | null }>()

  const placed = (await db(ENVS).whereIn('placement_id', ids).select('id', 'placement_id')) as {
    id: number
    placement_id: number
  }[]
  for (const e of placed)
    pick.set(Number(e.id), { placementId: Number(e.placement_id), forced: null })

  const moves = (await db(MOVES)
    .whereIn('status', OPEN_MOVE)
    .where((q) => q.whereIn('from_placement_id', ids).orWhereIn('to_placement_id', ids))
    .select(
      'environment_id',
      'from_placement_id',
      'to_placement_id',
      'step',
      'placed_at'
    )) as Record<string, unknown>[]
  for (const m of moves) {
    const envId = Number(m.environment_id)
    if (pick.has(envId)) continue // placed here: its own status rules
    const from = Number(m.from_placement_id)
    const to = Number(m.to_placement_id)
    if (placements.has(from) && !SOURCE_RETIRED_STEPS.has(String(m.step ?? ''))) {
      pick.set(envId, { placementId: from, forced: 'maintenance' })
      continue
    }
    if (placements.has(to) && m.placed_at != null)
      pick.set(envId, { placementId: to, forced: 'maintenance' })
  }
  if (!pick.size) return []

  const envRows = (await db(ENVS).whereIn('id', [...pick.keys()])) as Record<string, unknown>[]
  const appIds = [...new Set(envRows.map((r) => Number(r.app_id)))]
  const apps = new Map(
    ((await db(APPS).whereIn('id', appIds)) as Record<string, unknown>[]).map((r) => [
      Number(r.id),
      appFromRow(r)
    ])
  )

  const out: SharedTenantRow[] = []
  for (const r of envRows) {
    const env = environmentFromRow(r) as HubEnvironmentRow
    if (env.status === 'archived') continue
    const app = apps.get(env.app_id)
    const p = pick.get(env.id)
    const placement = p ? placements.get(p.placementId) : undefined
    if (!app || !p || !placement) continue
    const wireStatus = p.forced ?? WIRE_STATUS[env.status]
    if (!wireStatus) continue // a status the contract has no word for is never served
    out.push({ env, app, placement, wireStatus, placedHere: p.forced === null })
  }
  return out.sort((a, b) => tenantIdFor(a.app, a.env).localeCompare(tenantIdFor(b.app, b.env)))
}

/** The database row id an environment's db_ref names (`hub-db:<id>`, phase 3), or null. */
function databaseId(dbRef: unknown): number | null {
  const m = /^hub-db:(\d+)$/.exec(String(dbRef ?? ''))
  return m ? Number(m[1]) : null
}

function originOf(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

function poolMaxOf(placement: HubPlacementRow): number | null {
  const n = (placement.target as Record<string, unknown> | null)?.pool_max
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 20 ? n : null
}

/** Where a tenant left out is reported: a tenant id and a plain reason, never a value. */
export interface TenantsLog {
  warn(obj: Record<string, unknown>, msg: string): void
}

const silent: TenantsLog = { warn: () => {} }

/** A tenant left out is warned about once per this window (every replica polls every 30 s, and
 *  a provisioning env is NOT_READY for a while). */
const WARN_EVERY_MS = 5 * 60_000
const warned = new Map<string, number>()

function warnOnce(log: TenantsLog, key: string, obj: Record<string, unknown>, msg: string): void {
  const now = Date.now()
  const last = warned.get(key)
  if (last !== undefined && now - last < WARN_EVERY_MS) return
  if (warned.size > 5000) warned.clear()
  warned.set(key, now)
  log.warn(obj, msg)
}

/** Test seam: forget which tenants were warned about. */
export function _resetTenantWarningsForTests(): void {
  warned.clear()
}

/**
 * The tenants body and its ETag (`"` + sha256 of the body without `generated_at` + `"`), so the
 * tag changes exactly when what the deployment would serve changes.
 */
export async function tenantsBody(
  shared: SharedDeployment,
  now: Date = new Date(),
  log: TenantsLog = silent
): Promise<{ body: HubTenantsResponse; etag: string; rows: SharedTenantRow[] }> {
  const rows = await tenantsOf(shared)
  const refs = new Map(
    rows.length
      ? (
          (await db(ENVS)
            .whereIn(
              'id',
              rows.map((r) => r.env.id)
            )
            .select('id', 'db_ref')) as { id: number; db_ref: string | null }[]
        ).map((r) => [Number(r.id), r.db_ref])
      : []
  )
  const tenants: HubTenantWire[] = []
  const listed: SharedTenantRow[] = []
  for (const row of rows) {
    const { env, app, placement, wireStatus } = row
    const id = tenantIdFor(app, env)
    const recordId = databaseId(refs.get(env.id))
    if (recordId === null) {
      warnOnce(
        log,
        `${shared.id}|${id}|no-record`,
        { tenant: id },
        'hub shared tenants: environment has no Hub database record'
      )
      continue
    }
    let client: HubTenantWire['db']['client']
    let connection: string
    try {
      const c = await openDatabaseConnection(recordId)
      client = c.engine
      connection = connectionUrl(c)
    } catch (err) {
      // The code only (NOT_READY, NO_CONNECTION, …): driver text could carry the connection.
      const raw = (err as { code?: unknown } | null)?.code
      const code = typeof raw === 'string' ? raw : null
      warnOnce(
        log,
        `${shared.id}|${id}|${code}`,
        { tenant: id, code },
        'hub shared tenants: database record cannot be opened; tenant left out'
      )
      continue
    }
    const wire: HubTenantWire = {
      id,
      app_key: app.key,
      env_key: env.key,
      name: app.name,
      status: wireStatus,
      hostnames: environmentNames(env),
      db: { client, connection }
    }
    const pool = poolMaxOf(placement)
    if (pool !== null) wire.pool_max = pool
    const origin = originOf(env.base_url)
    if (origin) wire.origin = origin
    let key: string | null = null
    try {
      key = await openAppKey(env.id)
    } catch {
      key = null
    }
    if (key) wire.encryption_key = key
    tenants.push(wire)
    listed.push(row)
  }

  const hashed = JSON.stringify({ data: { deployment: shared.key, tenants } })
  const etag = `"${createHash('sha256').update(hashed).digest('hex')}"`
  const body: HubTenantsResponse = {
    data: { deployment: shared.key, generated_at: now.toISOString(), tenants }
  }
  if (Buffer.byteLength(hashed) > TENANTS_BODY_MAX_BYTES)
    warnOnce(
      log,
      `${shared.id}|too-large`,
      { deployment: shared.key, tenants: tenants.length, bytes: Buffer.byteLength(hashed) },
      'hub shared tenants: the list is over the 2 MB a deployment accepts; it keeps its last list'
    )
  return { body, etag, rows: listed }
}
