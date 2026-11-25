import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { createPlacement, placementStackRefusal, STACK_NAME_RE } from '../drivers.js'

/**
 * Hub placement (idea 48): Docker hosts grouped in regions, and where each environment runs.
 *
 * A HOST is a Docker driver: one Hub agent in front of one swarm. A REGION is a named group of
 * hosts (a data centre, a cloud region, a rack) with a cost factor the chargeback report applies
 * (cost_percent, 100 = the rates as set). A host is in at most one region; a host in none is
 * "not grouped". GitLab drivers are not hosts (their pipelines decide where an app runs).
 *
 * Where an environment runs is still its placement: this module only reads placements to draw
 * the map, and gives an environment that has none yet a new Docker stack placement on the host
 * picked (placeEnvironment). An environment that already runs moves to another host through the
 * move engine (move kind between_stacks, or to/from a shared deployment): never here.
 */

export const REGIONS = 'nivaro_hub_regions'
export const REGION_DRIVERS = 'nivaro_hub_region_drivers'
const DRIVERS = 'nivaro_hub_drivers'
const PLACEMENTS = 'nivaro_hub_placements'
const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const SHARED = 'nivaro_hub_shared_deployments'
const SAMPLES = 'nivaro_hub_capacity_samples'

export const REGION_KEY_RE = /^[a-z][a-z0-9-]{1,40}$/
export const MIN_COST_PERCENT = 1
export const MAX_COST_PERCENT = 1000

export interface Region {
  id: number
  key: string
  name: string
  note: string | null
  cost_percent: number
  position: number
}

export class PlacementError extends Error {
  code: string
  statusCode: number
  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.name = 'PlacementError'
    this.code = code
    this.statusCode = statusCode
  }
}

const bad = (code: string, message: string) => new PlacementError(code, message, 400)

/** Text from a body: trimmed, one line, at most `max` characters; null when blank. */
export function plainText(v: unknown, max: number): string | null {
  if (v == null) return null
  if (typeof v !== 'string') return null
  let out = ''
  for (const ch of v) {
    const c = ch.charCodeAt(0)
    out += c < 0x20 || c === 0x7f ? ' ' : ch
  }
  const t = out.replace(/ {2,}/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

function regionFromRow(r: Record<string, unknown>): Region {
  return {
    id: Number(r.id),
    key: String(r.key),
    name: String(r.name),
    note: r.note == null ? null : String(r.note),
    cost_percent: Number(r.cost_percent ?? 100),
    position: Number(r.position ?? 0)
  }
}

export interface RegionFields {
  key: string
  name: string
  note: string | null
  cost_percent: number
  position: number
}

/** A region as sent (create: every required field; update: over the stored one). */
export function checkRegionInput(body: Record<string, unknown>, existing?: Region): RegionFields {
  const key = body.key !== undefined ? body.key : existing?.key
  if (typeof key !== 'string' || !REGION_KEY_RE.test(key))
    throw bad(
      'BAD_KEY',
      'A region key is 2–41 lower-case letters, digits or dashes, starting with a letter.'
    )
  if (existing && key !== existing.key)
    throw bad('BAD_KEY', 'A region keeps its key; make a new region instead.')
  const name = body.name !== undefined ? plainText(body.name, 120) : (existing?.name ?? null)
  if (!name) throw bad('BAD_NAME', 'A region needs a name.')
  const note = body.note !== undefined ? plainText(body.note, 500) : (existing?.note ?? null)
  const pct = body.cost_percent !== undefined ? body.cost_percent : (existing?.cost_percent ?? 100)
  if (
    typeof pct !== 'number' ||
    !Number.isInteger(pct) ||
    pct < MIN_COST_PERCENT ||
    pct > MAX_COST_PERCENT
  )
    throw bad(
      'BAD_COST_PERCENT',
      `The cost factor is a whole percentage, ${MIN_COST_PERCENT}–${MAX_COST_PERCENT} (100 = the rates as set).`
    )
  const pos = body.position !== undefined ? body.position : (existing?.position ?? 0)
  if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 0 || pos > 10_000)
    throw bad('BAD_POSITION', 'position is a whole number, 0–10000.')
  return { key, name, note, cost_percent: pct, position: pos }
}

export async function listRegions(): Promise<Region[]> {
  const rows = (await db(REGIONS).orderBy('position', 'asc').orderBy('id', 'asc')) as Record<
    string,
    unknown
  >[]
  return rows.map(regionFromRow)
}

export async function getRegion(id: number): Promise<Region | null> {
  const r = (await db(REGIONS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? regionFromRow(r) : null
}

export async function createRegion(f: RegionFields, userId: string | null): Promise<Region> {
  if (await db(REGIONS).where({ key: f.key }).first('id'))
    throw new PlacementError('KEY_TAKEN', `A region named ${f.key} already exists.`, 409)
  const now = new Date()
  const id = await insertReturningId(db, REGIONS, {
    ...f,
    created_by: userId,
    created_at: now,
    updated_at: now
  })
  return { id: Number(id), ...f }
}

export async function updateRegion(id: number, f: RegionFields): Promise<Region | null> {
  const n = await db(REGIONS)
    .where({ id })
    .update({ ...f, updated_at: new Date() })
  return n ? { id, ...f } : null
}

/** Deletes the region; its hosts become "not grouped" (nothing else changes). */
export async function deleteRegion(id: number): Promise<boolean> {
  return db.transaction(async (trx) => {
    const n = await trx(REGIONS).where({ id }).del()
    if (n) await trx(REGION_DRIVERS).where({ region_id: id }).del()
    return n > 0
  })
}

/**
 * Puts a Docker driver (host) in a region (null = in none), with an optional label shown beside
 * its name. Refused for a driver that is not a Docker one (NOT_A_HOST).
 */
export async function setHostRegion(
  driverId: number,
  regionId: number | null,
  label: string | null
): Promise<{ region_id: number | null; label: string | null }> {
  const d = (await db(DRIVERS).where({ id: driverId }).first('id', 'kind')) as
    | { id: number; kind: string }
    | undefined
  if (!d) throw new PlacementError('NOT_FOUND', 'No such driver.', 404)
  if (d.kind !== 'docker')
    throw bad(
      'NOT_A_HOST',
      'Only a Docker driver is a host: a GitLab pipeline decides where its app runs.'
    )
  if (regionId !== null && !(await getRegion(regionId)))
    throw new PlacementError('NOT_FOUND', 'No such region.', 404)
  return db.transaction(async (trx) => {
    await trx(REGION_DRIVERS).where({ driver_id: driverId }).del()
    if (regionId !== null)
      await trx(REGION_DRIVERS).insert({
        driver_id: driverId,
        region_id: regionId,
        label,
        updated_at: new Date()
      })
    return { region_id: regionId, label: regionId !== null ? label : null }
  })
}

// ─── the map ─────────────────────────────────────────────────────────────────

export interface HostEnvironment {
  env_id: number
  app_id: number
  app_key: string
  app_name: string
  env_key: string
  status: string
  stack: string | null
}

export interface HostShared {
  id: number
  key: string
  name: string
  status: string
  apps: number
}

export interface HostFigures {
  /** Sum of the latest CPU (% of one core) of its environments and shared deployments. */
  cpu_pct: number | null
  memory_mb: number | null
  storage_bytes: number | null
  sampled_at: string | null
}

export interface Host {
  driver_id: number
  name: string
  label: string | null
  region_id: number | null
  environments: HostEnvironment[]
  shared: HostShared[]
  figures: HostFigures
}

export interface PlacementMap {
  regions: Array<Region & { hosts: Host[] }>
  /** Docker hosts in no region. */
  ungrouped: Host[]
  /** Environments with no placement yet (not archived): pick a host for them. */
  unplaced: Array<Omit<HostEnvironment, 'stack'>>
}

function parseTarget(raw: unknown): { stack?: unknown } {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v))

/** The latest capacity sample (≤ 2 hours old) per environment and per shared deployment. */
async function latestFigures(now: Date): Promise<{
  env: Map<number, Record<string, unknown>>
  shared: Map<number, Record<string, unknown>>
}> {
  const env = new Map<number, Record<string, unknown>>()
  const shared = new Map<number, Record<string, unknown>>()
  if (!(await db.schema.hasTable(SAMPLES))) return { env, shared }
  const rows = (await db(SAMPLES)
    .where('sampled_at', '>=', new Date(now.getTime() - 2 * 3_600_000))
    .whereNull('error')
    .orderBy('sampled_at', 'asc')
    .select(
      'scope',
      'environment_id',
      'shared_deployment_id',
      'cpu_pct',
      'memory_mb',
      'storage_bytes',
      'sampled_at'
    )) as Record<string, unknown>[]
  for (const r of rows) {
    if (r.scope === 'shared' && r.shared_deployment_id != null)
      shared.set(Number(r.shared_deployment_id), r)
    else if (
      r.scope === 'environment' &&
      r.environment_id != null &&
      r.shared_deployment_id == null
    )
      env.set(Number(r.environment_id), r)
  }
  return { env, shared }
}

function addFigures(into: HostFigures, r: Record<string, unknown> | undefined) {
  if (!r) return
  const add = (k: 'cpu_pct' | 'memory_mb' | 'storage_bytes') => {
    const v = num(r[k])
    if (v !== null) into[k] = (into[k] ?? 0) + v
  }
  add('cpu_pct')
  add('memory_mb')
  add('storage_bytes')
  const at = r.sampled_at instanceof Date ? r.sampled_at : new Date(String(r.sampled_at))
  if (Number.isFinite(at.getTime()) && (!into.sampled_at || at.toISOString() > into.sampled_at))
    into.sampled_at = at.toISOString()
}

export async function placementMap(now = new Date()): Promise<PlacementMap> {
  const regions = await listRegions()
  const drivers = (await db(DRIVERS)
    .where({ kind: 'docker' })
    .orderBy('name')
    .select('id', 'name')) as Array<{
    id: number
    name: string
  }>
  const members = (await db(REGION_DRIVERS).select('driver_id', 'region_id', 'label')) as Array<{
    driver_id: number
    region_id: number
    label: string | null
  }>
  const memberOf = new Map(members.map((m) => [Number(m.driver_id), m]))
  const envRows = (await db(`${ENVS} as e`)
    .join(`${APPS} as a`, 'a.id', 'e.app_id')
    .leftJoin(`${PLACEMENTS} as p`, 'p.id', 'e.placement_id')
    .whereNot('e.status', 'archived')
    .orderBy('a.key', 'asc')
    .orderBy('e.position', 'asc')
    .select(
      'e.id',
      'e.app_id',
      'e.key',
      'e.status',
      'e.placement_id',
      'a.key as app_key',
      'a.name as app_name',
      'p.kind as p_kind',
      'p.driver_id as p_driver',
      'p.target as p_target'
    )) as Record<string, unknown>[]
  const sharedRows = (await db.schema.hasTable(SHARED))
    ? ((await db(SHARED)
        .whereNot({ status: 'retired' })
        .whereNotNull('driver_id')
        .select('id', 'key', 'name', 'status', 'driver_id')) as Record<string, unknown>[])
    : []
  const sharedApps = new Map<number, number>()
  if (sharedRows.length) {
    const counts = (await db(`${ENVS} as e`)
      .join(`${PLACEMENTS} as p`, 'p.id', 'e.placement_id')
      .where('p.kind', 'shared')
      .whereNot('e.status', 'archived')
      .groupBy('p.shared_deployment_id')
      .select('p.shared_deployment_id as sid')
      .count({ n: '*' })) as Array<{ sid: unknown; n: unknown }>
    for (const c of counts) sharedApps.set(Number(c.sid), Number(c.n))
  }
  const figures = await latestFigures(now)

  const hosts = new Map<number, Host>()
  for (const d of drivers) {
    const m = memberOf.get(Number(d.id))
    hosts.set(Number(d.id), {
      driver_id: Number(d.id),
      name: String(d.name),
      label: m?.label ?? null,
      region_id: m ? Number(m.region_id) : null,
      environments: [],
      shared: [],
      figures: { cpu_pct: null, memory_mb: null, storage_bytes: null, sampled_at: null }
    })
  }
  const unplaced: PlacementMap['unplaced'] = []
  for (const r of envRows) {
    const base = {
      env_id: Number(r.id),
      app_id: Number(r.app_id),
      app_key: String(r.app_key),
      app_name: String(r.app_name ?? r.app_key),
      env_key: String(r.key),
      status: String(r.status)
    }
    if (r.placement_id == null) {
      unplaced.push(base)
      continue
    }
    if (r.p_kind !== 'dedicated' || r.p_driver == null) continue
    const host = hosts.get(Number(r.p_driver))
    if (!host) continue
    const stack = parseTarget(r.p_target).stack
    host.environments.push({ ...base, stack: typeof stack === 'string' ? stack : null })
    addFigures(host.figures, figures.env.get(base.env_id))
  }
  for (const s of sharedRows) {
    const host = hosts.get(Number(s.driver_id))
    if (!host) continue
    host.shared.push({
      id: Number(s.id),
      key: String(s.key),
      name: String(s.name ?? s.key),
      status: String(s.status),
      apps: sharedApps.get(Number(s.id)) ?? 0
    })
    addFigures(host.figures, figures.shared.get(Number(s.id)))
  }
  const all = [...hosts.values()]
  return {
    regions: regions.map((rg) => ({ ...rg, hosts: all.filter((h) => h.region_id === rg.id) })),
    ungrouped: all.filter(
      (h) => h.region_id === null || !regions.some((rg) => rg.id === h.region_id)
    ),
    unplaced
  }
}

/** The region of a Docker driver (host), or null. */
export async function regionOfDriver(driverId: number | null): Promise<Region | null> {
  if (driverId == null) return null
  const m = (await db(REGION_DRIVERS).where({ driver_id: driverId }).first('region_id')) as
    | { region_id: number }
    | undefined
  return m ? getRegion(Number(m.region_id)) : null
}

/**
 * Gives an environment that has no placement yet a new Docker stack placement on host
 * `driverId` (stack `stack`): "run it here". Refused for an environment that already has one
 * (ALREADY_PLACED: move it instead), a driver that is not a Docker host, a bad or taken stack
 * name. The placement row and the environment write are one transaction, and the write only
 * lands while the environment still has no placement (a concurrent placement wins).
 */
export async function placeEnvironment(
  envId: number,
  driverId: number,
  stack: string
): Promise<{ placement_id: number }> {
  if (!STACK_NAME_RE.test(stack))
    throw bad(
      'BAD_STACK',
      'A stack name is 2–41 lower-case letters, digits or dashes, starting with a letter.'
    )
  const env = (await db(ENVS).where({ id: envId }).first('id', 'placement_id', 'status')) as
    | { id: number; placement_id: number | null; status: string }
    | undefined
  if (!env) throw new PlacementError('NOT_FOUND', 'No such environment.', 404)
  if (env.status === 'archived')
    throw new PlacementError('ARCHIVED', 'This environment is archived.', 409)
  if (env.placement_id != null)
    throw new PlacementError(
      'ALREADY_PLACED',
      'This environment already runs somewhere. Move it to the other host instead (Move… on its row).',
      409
    )
  const d = (await db(DRIVERS).where({ id: driverId }).first('id', 'kind')) as
    | { id: number; kind: string }
    | undefined
  if (!d) throw new PlacementError('NOT_FOUND', 'No such host.', 404)
  if (d.kind !== 'docker') throw bad('NOT_A_HOST', 'Only a Docker driver is a host.')
  const taken = await placementStackRefusal(driverId, { stack })
  if (taken) throw new PlacementError(taken.code, taken.message, 409)
  return db.transaction(async (trx) => {
    const p = await createPlacement(
      { kind: 'dedicated', driver_id: driverId, target: { stack } },
      trx
    )
    const n = await trx(ENVS)
      .where({ id: envId })
      .whereNull('placement_id')
      .update({ placement_id: p.id, updated_at: new Date() })
    if (!n)
      throw new PlacementError(
        'ALREADY_PLACED',
        'This environment was placed meanwhile. Look again.',
        409
      )
    return { placement_id: p.id }
  })
}
