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

export interface HubPlacementRow {
  id: number
  kind: 'dedicated'
  driver_id: number
  /** branch: GitLab drivers; stack: the swarm stack name on a Docker driver (phase 4). */
  target: PlacementTarget
}

export type PlacementTarget = { branch?: string; stack?: string }

/** A Docker placement's stack name (also the agent's `:name`). */
export const STACK_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/

export type HubPlacement = HubPlacementRow

export type Validation<T> = { ok: true; row: T } | { ok: false; code: string; message: string }

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

export function validatePlacementInput(
  body: Record<string, unknown>
): Validation<{ kind: 'dedicated'; driver_id: number; target: PlacementTarget }> {
  if (body.kind !== 'dedicated') return fail('BAD_KIND', 'Placement kind must be dedicated.')
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

/**
 * The target fields a driver kind takes (phase 4): `branch` on a GitLab driver, `stack` on a
 * Docker one. The other one is refused (BAD_TARGET).
 */
export function placementTargetRefusal(
  kind: HubDriverKind,
  target: PlacementTarget
): { ok: false; code: string; message: string } | null {
  if (kind === 'docker' && target.branch !== undefined)
    return fail('BAD_TARGET', 'A Docker placement has no target.branch; name its target.stack.')
  if (kind !== 'docker' && target.stack !== undefined)
    return fail('BAD_TARGET', 'target.stack is only for a placement on a Docker driver.')
  return null
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
  return {
    id: Number(r.id),
    kind: r.kind as 'dedicated',
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

export async function getDriver(id: number): Promise<HubDriverRow | null> {
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
): Promise<{ ok: true } | { ok: false; code: 'IN_USE' | 'NOT_FOUND' }> {
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
    await trx('nivaro_hub_drivers').where({ id }).del()
    return { ok: true as const }
  })
}

/** Deletes a placement and its components (no FK) in the caller's transaction. */
async function dropPlacement(trx: Knex.Transaction, id: number): Promise<void> {
  await trx('nivaro_hub_components').where({ placement_id: id }).del()
  await trx('nivaro_hub_placements').where({ id }).del()
}

/** Deletes a placement no environment names; IN_USE while one does. */
export async function deletePlacement(
  id: number
): Promise<{ ok: true } | { ok: false; code: 'IN_USE' | 'NOT_FOUND' }> {
  return db.transaction(async (trx) => {
    if (!(await trx('nivaro_hub_placements').where({ id }).first('id')))
      return { ok: false, code: 'NOT_FOUND' as const }
    if (await trx('nivaro_hub_environments').where({ placement_id: id }).first('id'))
      return { ok: false, code: 'IN_USE' as const }
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

type PlacementFields = { kind: 'dedicated'; driver_id: number; target: PlacementTarget }

export async function createPlacement(row: PlacementFields): Promise<HubPlacementRow> {
  const id = await insertReturningId(db, 'nivaro_hub_placements', {
    kind: row.kind,
    driver_id: row.driver_id,
    target: JSON.stringify(row.target),
    created_at: now(),
    updated_at: now()
  })
  return { id: Number(id), ...row }
}

export async function updatePlacement(
  id: number,
  patch: PlacementFields
): Promise<HubPlacementRow | null> {
  const n = await db('nivaro_hub_placements')
    .where({ id })
    .update({
      kind: patch.kind,
      driver_id: patch.driver_id,
      target: JSON.stringify(patch.target),
      updated_at: now()
    })
  if (!n) return null
  return { id, ...patch }
}

export async function getPlacement(id: number): Promise<HubPlacementRow | null> {
  const r = (await db('nivaro_hub_placements').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? toPlacementRow(r) : null
}

export type { DockerDriverConfig, DockerDriverFields }
export { HUB_MASK }
