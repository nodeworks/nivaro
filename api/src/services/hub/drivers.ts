import type { Knex } from 'knex'
import { insertReturningId } from '../../db/dialect/ef.js'
import { db } from '../../db/index.js'
import type { GitCtx } from '../gitlab-client.js'
import {
  type DockerDriverConfig,
  type DockerDriverFields,
  validateDockerDriverInput
} from './docker/driver-config.js'
import { HUB_MASK, maskSecret, nextSecret, openSecret } from './secrets.js'

export interface HubDriverConfig {
  api: string
  project: string
  branch: string
  pin_file: string
  deploy_job: string
}

/** A GitLab driver as stored: config parsed, secret still sealed. */
export interface GitlabDriverRow {
  id: number
  kind: 'gitlab'
  name: string
  config: HubDriverConfig
  secret: string | null
}

/** A Docker driver (phase 4) as stored: the secret is the sealed agent token. */
export interface DockerDriverRow {
  id: number
  kind: 'docker'
  name: string
  config: DockerDriverConfig
  secret: string | null
}

/** A driver as stored: config parsed, secret still sealed. */
export type HubDriverRow = GitlabDriverRow | DockerDriverRow

export type HubDriverKind = HubDriverRow['kind']

/** A driver as the API shows it: the secret is only ever a mask. */
export type HubDriver = HubDriverRow

/** A placement on one driver: the app runs on its own (GitLab branch, or a Docker stack). */
export interface DedicatedPlacementRow {
  id: number
  kind: 'dedicated'
  driver_id: number
  /** branch: GitLab drivers; stack: the swarm stack name on a Docker driver (phase 4). */
  target: PlacementTarget
}

/**
 * Phase 6: a placement on a shared deployment (one process serving many apps). It names the
 * deployment, never a driver; `pool_max` (1–20, default 5) is the connections the app may take
 * there (Decision 16).
 */
export interface SharedPlacementRow {
  id: number
  kind: 'shared'
  shared_deployment_id: number
  driver_id: null
  target: SharedPlacementTarget
}

export type HubPlacementRow = DedicatedPlacementRow | SharedPlacementRow

/**
 * `forgotten_at` (phase 6, Docker placements): an administrator told the Hub the stack is gone
 * although its agent could not confirm it (POST /placements/:id/forget-stack). The stack guards
 * then stop refusing edits for deploys recorded before it. Only that route writes it.
 */
export type PlacementTarget = { branch?: string; stack?: string; forgotten_at?: string }

export type SharedPlacementTarget = { pool_max?: number }

/** A shared placement's connections when none are named (Decision 16). */
export const DEFAULT_POOL_MAX = 5
/** Fewer than this and one app request can starve its own background work (T8 carry). */
export const MIN_SHARED_POOL_MAX = 2
export const MAX_SHARED_POOL_MAX = 20

/** A Docker placement's stack name (also the agent's `:name`). */
export const STACK_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/

export type HubPlacement = HubPlacementRow

export type Validation<T, C extends string = string> =
  | { ok: true; row: T }
  | { ok: false; code: C; message: string; field?: { kind: string; key?: string } }

const CONFIG_KEYS = ['api', 'project', 'branch', 'pin_file', 'deploy_job'] as const

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message }
}

function validApiUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  return (
    u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
  )
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return raw
  }
}

export class DriverMisconfiguredError extends Error {
  code = 'DRIVER_MISCONFIGURED'
  constructor(message: string) {
    super(message)
    this.name = 'DriverMisconfiguredError'
  }
}

type GitlabDriverFields = {
  kind: 'gitlab'
  name: string
  config: HubDriverConfig
  secret: string | null
}
type DriverFields = GitlabDriverFields | DockerDriverFields

export function validateDriverInput(
  body: Record<string, unknown>,
  existing?: HubDriverRow
): Validation<DriverFields> {
  const kind = body.kind ?? existing?.kind
  if (kind !== 'gitlab' && kind !== 'docker')
    return fail('BAD_KIND', 'Driver kind must be gitlab or docker.')
  if (existing && existing.kind !== kind)
    return fail('BAD_KIND', 'A driver keeps its kind; add a new driver instead.')
  if (kind === 'docker')
    return validateDockerDriverInput(body, existing?.kind === 'docker' ? existing : undefined)
  return validateGitlabDriverInput(body, existing?.kind === 'gitlab' ? existing : undefined)
}

function validateGitlabDriverInput(
  body: Record<string, unknown>,
  existing?: GitlabDriverRow
): Validation<GitlabDriverFields> {
  const name = body.name !== undefined ? body.name : existing?.name
  if (typeof name !== 'string' || !name.trim()) return fail('BAD_NAME', 'A driver needs a name.')

  const incoming = (body.config ?? {}) as Record<string, unknown>
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    return fail('BAD_CONFIG', 'Driver config must be an object.')
  }
  for (const k of Object.keys(incoming)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
      return fail('BAD_CONFIG', `Unknown config key: ${k}.`)
    }
  }
  const config = {} as Record<string, string>
  for (const k of CONFIG_KEYS) {
    const v = incoming[k] !== undefined ? incoming[k] : existing?.config[k]
    if (typeof v !== 'string' || !v.trim()) {
      return fail('BAD_CONFIG', `Config ${k} is required.`)
    }
    config[k] = v.trim()
  }
  if (!validApiUrl(config.api)) {
    return fail('BAD_CONFIG', 'Config api must be an https URL (http only for localhost).')
  }

  if (body.secret !== undefined && body.secret !== null && typeof body.secret !== 'string') {
    return fail('BAD_SECRET', 'The token must be text.')
  }
  const stored = existing?.secret ?? null
  // Absent = keep on update (nextSecret reads undefined as clear).
  const secret = body.secret === undefined && existing ? stored : nextSecret(body.secret, stored)
  if (
    existing &&
    stored &&
    secret === stored &&
    (originOf(config.api) !== originOf(existing.config.api) ||
      config.project !== existing.config.project)
  ) {
    return fail(
      'SECRET_REQUIRED',
      'Enter the token again when the GitLab address or project changes'
    )
  }
  return {
    ok: true,
    row: { kind: 'gitlab', name: name.trim(), config: config as unknown as HubDriverConfig, secret }
  }
}

export function publicDriver(row: HubDriverRow): HubDriver {
  return { ...row, secret: maskSecret(row.secret) }
}

/**
 * Which repository a GitLab address + project path name: base without /api/v4 or trailing
 * slashes, path without outer slashes, both lower-cased. The same for a driver's config
 * (driverIdentity) and for the GitCtx made from it, so a run can tell its driver was edited.
 */
export function repositoryIdentity(api: string, project: string): string {
  const base = String(api ?? '')
    .trim()
    // Lower-cased first, so `/API/v4` is stripped too.
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\/api\/v4$/, '')
    // `https://host//api/v4` leaves a slash behind once /api/v4 is gone.
    .replace(/\/+$/, '')
  const path = String(project ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
  return `${base}|${path}`
}

/** GitCtx for the shared GitLab client: `base` is the host (the client adds /api/v4). */
export function driverCtx(row: HubDriverRow): GitCtx {
  if (row.kind === 'docker')
    throw new DriverMisconfiguredError('A Docker driver has no GitLab project to push to.')
  if (!row.config || typeof row.config.api !== 'string' || !row.config.api.trim()) {
    throw new DriverMisconfiguredError('The driver has no GitLab address configured.')
  }
  const base = row.config.api.replace(/\/+$/, '').replace(/\/api\/v4$/, '')
  return {
    provider: 'gitlab',
    base,
    project: row.config.project,
    token: openSecret(row.secret),
    ref: row.config.branch
  }
}

type DedicatedFields = { kind: 'dedicated'; driver_id: number; target: PlacementTarget }
type SharedFields = {
  kind: 'shared'
  shared_deployment_id: number
  driver_id: null
  target: SharedPlacementTarget
}
export type PlacementFields = DedicatedFields | SharedFields

/**
 * A placement as sent. Dedicated: a driver and its target (branch / stack). Shared (phase 6): a
 * shared deployment, no driver, and `target.pool_max` (whole number; under 2 is POOL_TOO_SMALL,
 * over 20 BAD_TARGET). `forgotten_at` is never taken from a body.
 */
export function validatePlacementInput(body: Record<string, unknown>): Validation<PlacementFields> {
  if (body.kind === 'shared') return validateSharedPlacementInput(body)
  if (body.kind !== 'dedicated')
    return fail('BAD_KIND', 'Placement kind must be dedicated or shared.')
  const driverId = body.driver_id
  if (typeof driverId !== 'number' || !Number.isInteger(driverId)) {
    return fail('BAD_DRIVER', 'driver_id must be a number.')
  }
  const target = (body.target ?? {}) as Record<string, unknown>
  if (typeof target !== 'object' || Array.isArray(target)) {
    return fail('BAD_TARGET', 'target must be an object.')
  }
  const out: PlacementTarget = {}
  if (target.branch !== undefined) {
    if (typeof target.branch !== 'string' || !target.branch.trim()) {
      return fail('BAD_TARGET', 'target.branch must be a non-empty string.')
    }
    out.branch = target.branch.trim()
  }
  if (target.stack !== undefined) {
    if (typeof target.stack !== 'string' || !STACK_NAME_RE.test(target.stack)) {
      return fail(
        'BAD_TARGET',
        'target.stack must be 2–41 lower-case letters, digits or dashes, starting with a letter.'
      )
    }
    out.stack = target.stack
  }
  return { ok: true, row: { kind: 'dedicated', driver_id: driverId, target: out } }
}

function validateSharedPlacementInput(body: Record<string, unknown>): Validation<SharedFields> {
  // A driver belongs to a dedicated placement: a shared one names a deployment instead.
  if (body.driver_id !== undefined && body.driver_id !== null)
    return fail(
      'BAD_KIND',
      'A shared placement names a shared deployment, never a driver; leave driver_id out.'
    )
  const sharedId = body.shared_deployment_id
  if (typeof sharedId !== 'number' || !Number.isInteger(sharedId) || sharedId < 1)
    return fail('BAD_SHARED', 'shared_deployment_id must name a shared deployment.')
  const target = (body.target ?? {}) as Record<string, unknown>
  if (typeof target !== 'object' || target === null || Array.isArray(target))
    return fail('BAD_TARGET', 'target must be an object.')
  const refused = placementTargetRefusal('shared', target as PlacementTarget)
  if (refused) return refused
  const out: SharedPlacementTarget = {}
  if (target.pool_max !== undefined) {
    const n = target.pool_max
    if (typeof n !== 'number' || !Number.isInteger(n) || n > MAX_SHARED_POOL_MAX)
      return fail(
        'BAD_TARGET',
        `target.pool_max must be a whole number of connections, at most ${MAX_SHARED_POOL_MAX}.`
      )
    if (n < MIN_SHARED_POOL_MAX)
      return fail(
        'POOL_TOO_SMALL',
        `An app on a shared deployment needs at least ${MIN_SHARED_POOL_MAX} database connections.`
      )
    out.pool_max = n
  }
  return {
    ok: true,
    row: { kind: 'shared', shared_deployment_id: sharedId, driver_id: null, target: out }
  }
}

/** A shared placement's `pool_max`, or the default when none is set. */
export function sharedPoolMax(target: SharedPlacementTarget | null | undefined): number {
  const n = target?.pool_max
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SHARED_POOL_MAX
    ? n
    : DEFAULT_POOL_MAX
}

/**
 * The target fields a driver kind takes (phase 4): `branch` on a GitLab driver, `stack` on a
 * Docker one. The other one is refused (BAD_TARGET).
 */
export function placementTargetRefusal(
  kind: HubDriverKind | 'shared',
  target: PlacementTarget
): { ok: false; code: string; message: string } | null {
  // Phase 6: a shared placement runs on the deployment's own stack — no branch or stack of its own.
  if (kind === 'shared')
    return target.branch !== undefined || target.stack !== undefined
      ? fail('BAD_TARGET', 'A shared placement has no target.branch or target.stack.')
      : null
  if (kind === 'docker' && target.branch !== undefined)
    return fail('BAD_TARGET', 'A Docker placement has no target.branch; name its target.stack.')
  if (kind !== 'docker' && target.stack !== undefined)
    return fail('BAD_TARGET', 'target.stack is only for a placement on a Docker driver.')
  return null
}

/**
 * Another placement on the same Docker driver already names this swarm stack (ruling P4-21):
 * two placements naming one stack would let either environment restart, read or remove the
 * other's. 409 STACK_NAME_TAKEN; null when the name is free (or the target names no stack).
 */
export async function placementStackRefusal(
  driverId: number,
  target: PlacementTarget,
  exceptId: number | null = null
): Promise<{ ok: false; code: string; message: string; status: 409 } | null> {
  if (target.stack === undefined) return null
  const rows = (await db('nivaro_hub_placements')
    .where({ driver_id: driverId })
    .select('id', 'target')) as Array<Record<string, unknown>>
  const taken = rows.some(
    (r) =>
      Number(r.id) !== exceptId && parseObj<PlacementTarget>(r.target, {}).stack === target.stack
  )
  if (!taken) return null
  return {
    ...fail(
      'STACK_NAME_TAKEN',
      `Another placement on this driver already deploys stack ${target.stack} — pick another name.`
    ),
    status: 409
  }
}

function parseObj<T>(raw: unknown, fallback: T): T {
  let v: unknown = raw
  if (typeof raw === 'string') {
    if (!raw) return fallback
    try {
      v = JSON.parse(raw)
    } catch {
      return fallback
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback
}

function toDriverRow(r: Record<string, unknown>): HubDriverRow {
  const base = {
    id: Number(r.id),
    name: String(r.name),
    secret: (r.secret as string | null) ?? null
  }
  if (r.kind === 'docker')
    return { ...base, kind: 'docker', config: parseObj(r.config, {} as DockerDriverConfig) }
  return { ...base, kind: r.kind as 'gitlab', config: parseObj(r.config, {} as HubDriverConfig) }
}

function toPlacementRow(r: Record<string, unknown>): HubPlacementRow {
  if (r.kind === 'shared')
    return {
      id: Number(r.id),
      kind: 'shared',
      shared_deployment_id: Number(r.shared_deployment_id),
      driver_id: null,
      target: parseObj<SharedPlacementTarget>(r.target, {})
    }
  return {
    id: Number(r.id),
    kind: 'dedicated',
    driver_id: Number(r.driver_id),
    target: parseObj(r.target, {})
  }
}

const now = () => new Date()

export async function listDrivers(): Promise<HubDriverRow[]> {
  const rows = (await db('nivaro_hub_drivers').select('*').orderBy('id')) as Record<
    string,
    unknown
  >[]
  return rows.map(toDriverRow)
}

export async function getDriver(id: number | null): Promise<HubDriverRow | null> {
  if (id == null) return null
  const r = (await db('nivaro_hub_drivers').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? toDriverRow(r) : null
}

export async function createDriver(row: DriverFields): Promise<HubDriverRow> {
  const id = await insertReturningId(db, 'nivaro_hub_drivers', {
    kind: row.kind,
    name: row.name,
    config: JSON.stringify(row.config),
    secret: row.secret,
    created_at: now(),
    updated_at: now()
  })
  return { id: Number(id), ...row }
}

export async function updateDriver(id: number, patch: DriverFields): Promise<HubDriverRow | null> {
  const n = await db('nivaro_hub_drivers')
    .where({ id })
    .update({
      kind: patch.kind,
      name: patch.name,
      config: JSON.stringify(patch.config),
      secret: patch.secret,
      updated_at: now()
    })
  if (!n) return null
  return { id, ...patch }
}

/**
 * Deletes a driver. Refused (IN_USE) only while an environment names one of its placements; a
 * placement no environment names (left by a deleted environment or a failed adopt) goes with it.
 */
export async function deleteDriver(
  id: number
): Promise<
  | { ok: true }
  | { ok: false; code: 'IN_USE' | 'NOT_FOUND' }
  | { ok: false; code: 'DRIVER_IN_USE'; shared: string }
> {
  // Review L5: a shared deployment that is not retired deploys through it (its agent, or the
  // GitLab pipeline the Hub upgrades it through). Read before the transaction: an install whose
  // hub schema predates shared deployments has no table to read.
  const sharedUser = (await db.schema.hasTable('nivaro_hub_shared_deployments'))
    ? ((await db('nivaro_hub_shared_deployments')
        .where({ driver_id: id })
        .whereNot({ status: 'retired' })
        .first('key')) as { key: string } | undefined)
    : undefined
  if (sharedUser) return { ok: false, code: 'DRIVER_IN_USE', shared: String(sharedUser.key) }
  const regionTable = await db.schema.hasTable('nivaro_hub_region_drivers')
  return db.transaction(async (trx) => {
    if (!(await trx('nivaro_hub_drivers').where({ id }).first('id')))
      return { ok: false, code: 'NOT_FOUND' as const }
    const used = await trx('nivaro_hub_placements as p')
      .join('nivaro_hub_environments as e', 'e.placement_id', 'p.id')
      .where('p.driver_id', id)
      .first('p.id')
    if (used) return { ok: false, code: 'IN_USE' as const }
    // A component of an in-use placement names the driver too.
    const usedByComponent = await trx('nivaro_hub_components as c')
      .join('nivaro_hub_environments as e', 'e.placement_id', 'c.placement_id')
      .where('c.driver_id', id)
      .first('c.id')
    if (usedByComponent) return { ok: false, code: 'IN_USE' as const }
    await trx('nivaro_hub_components')
      .where({ driver_id: id })
      .orWhereIn('placement_id', trx('nivaro_hub_placements').where({ driver_id: id }).select('id'))
      .del()
    await trx('nivaro_hub_placements').where({ driver_id: id }).del()
    // Hub placement (review L6): the host leaves its region with it.
    if (regionTable) await trx('nivaro_hub_region_drivers').where({ driver_id: id }).del()
    await trx('nivaro_hub_drivers').where({ id }).del()
    return { ok: true as const }
  })
}

/** Deletes a placement and its components (no FK) in the caller's transaction. */
async function dropPlacement(trx: Knex.Transaction, id: number): Promise<void> {
  await trx('nivaro_hub_components').where({ placement_id: id }).del()
  await trx('nivaro_hub_placements').where({ id }).del()
}

/**
 * Deletes a placement no environment names; IN_USE while one does, PLACEMENT_IN_USE while an
 * open move (running, waiting or interrupted) names it as its source or target (phase 6, ruling
 * P6-21: the move's rollback still needs it).
 */
export async function deletePlacement(
  id: number
): Promise<{ ok: true } | { ok: false; code: 'IN_USE' | 'PLACEMENT_IN_USE' | 'NOT_FOUND' }> {
  return db.transaction(async (trx) => {
    if (!(await trx('nivaro_hub_placements').where({ id }).first('id')))
      return { ok: false, code: 'NOT_FOUND' as const }
    if (await trx('nivaro_hub_environments').where({ placement_id: id }).first('id'))
      return { ok: false, code: 'IN_USE' as const }
    // The moves table exists from migration 553 on (a database behind it has no moves).
    if (
      (await trx.schema.hasTable('nivaro_hub_moves')) &&
      (await trx('nivaro_hub_moves')
        .whereIn('status', ['running', 'waiting', 'interrupted'])
        .where((q) => q.where({ from_placement_id: id }).orWhere({ to_placement_id: id }))
        .first('id'))
    )
      return { ok: false, code: 'PLACEMENT_IN_USE' as const }
    await dropPlacement(trx, id)
    return { ok: true as const }
  })
}

/**
 * Inside an environment write: deletes placement `id` when no environment names it any more
 * (a dedicated placement belongs to its one environment).
 */
export async function releasePlacement(trx: Knex.Transaction, id: number | null): Promise<void> {
  if (id == null) return
  if (await trx('nivaro_hub_environments').where({ placement_id: id }).first('id')) return
  await dropPlacement(trx, id)
}

/** The columns a placement write sets (shared_deployment_id only for the shared kind). */
function placementCols(row: PlacementFields): Record<string, unknown> {
  return {
    kind: row.kind,
    driver_id: row.driver_id,
    target: JSON.stringify(row.target),
    ...(row.kind === 'shared' ? { shared_deployment_id: row.shared_deployment_id } : {})
  }
}

export async function createPlacement(
  row: PlacementFields,
  k: Knex = db
): Promise<HubPlacementRow> {
  const id = await insertReturningId(k, 'nivaro_hub_placements', {
    ...placementCols(row),
    created_at: now(),
    updated_at: now()
  })
  return { id: Number(id), ...row } as HubPlacementRow
}

export async function updatePlacement(
  id: number,
  patch: PlacementFields,
  k: Knex = db
): Promise<HubPlacementRow | null> {
  const n = await k('nivaro_hub_placements')
    .where({ id })
    .update({ ...placementCols(patch), updated_at: now() })
  if (!n) return null
  return { id, ...patch } as HubPlacementRow
}

/**
 * Phase 6: the environment's placement is on a shared deployment (Decision 17: promotions, stack
 * actions and creation then answer SHARED_PLACEMENT — upgrade the deployment instead).
 */
export async function placedOnShared(envId: number, k: Knex = db): Promise<boolean> {
  const row = (await k('nivaro_hub_environments as e')
    .join('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .where('e.id', envId)
    .first('p.kind')) as { kind: string } | undefined
  return row?.kind === 'shared'
}

/** The sentence every SHARED_PLACEMENT refusal uses. */
export const SHARED_PLACEMENT_MESSAGE =
  'This environment runs on a shared deployment, which owns its stack and version. Upgrade or change the shared deployment instead, or move the environment off it.'

export async function getPlacement(id: number): Promise<HubPlacementRow | null> {
  const r = (await db('nivaro_hub_placements').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? toPlacementRow(r) : null
}

export type { DockerDriverConfig, DockerDriverFields }
export { HUB_MASK }
