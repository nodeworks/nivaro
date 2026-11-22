import { insertReturningId } from '../../db/dialect/ef.js'
import { db } from '../../db/index.js'
import { isUniqueViolation } from '../../lib/unique-violation.js'
import type { HubComponent } from './promote-types.js'

/**
 * Placement components (phase 2): the ordered pieces a placement deploys, each through its own
 * driver. Reads and validation live here; the routes (routes/hub.ts) log and answer.
 */

const TABLE = 'nivaro_hub_components'

type Fail = { ok: false; status: number; code: string; message: string }
type Result<T> = { ok: true; row: T } | Fail

export type ComponentFields = Omit<HubComponent, 'id' | 'placement_id' | 'implicit'>

const fail = (code: string, message: string, status = 400): Fail => ({
  ok: false,
  status,
  code,
  message
})

function toComponent(r: Record<string, unknown>): HubComponent {
  const s = (v: unknown) => (v == null ? null : String(v))
  return {
    id: Number(r.id),
    placement_id: Number(r.placement_id),
    position: Number(r.position),
    name: String(r.name),
    kind: r.kind as HubComponent['kind'],
    driver_id: Number(r.driver_id),
    source_branch: String(r.source_branch ?? 'main'),
    target_branch: s(r.target_branch),
    before_job: s(r.before_job),
    deploy_job: s(r.deploy_job),
    verify_url: s(r.verify_url),
    verify_field: String(r.verify_field ?? 'version')
  }
}

/** The kind of driver `id` ('gitlab' | 'docker'), or null when it does not exist. */
async function driverKind(id: number): Promise<string | null> {
  const r = (await db('nivaro_hub_drivers').where({ id }).first('kind')) as
    | { kind: string }
    | undefined
  return r ? String(r.kind) : null
}

/** The component kind a driver kind deploys: docker drivers deploy stacks only. */
const kindFits = (kind: HubComponent['kind'], driver: string): boolean =>
  driver === 'docker' ? kind === 'stack' : kind !== 'stack'

/**
 * The placement's components in position order. A phase-1 placement with none stored behaves as
 * one implicit component on its own driver: api on a GitLab driver, the stack on a Docker one.
 */
export async function listComponents(placementId: number): Promise<HubComponent[]> {
  const rows = (await db(TABLE)
    .where({ placement_id: placementId })
    .orderBy('position', 'asc')) as Record<string, unknown>[]
  if (rows.length) return rows.map(toComponent)
  const p = (await db('nivaro_hub_placements').where({ id: placementId }).first('driver_id')) as
    | { driver_id: number }
    | undefined
  if (!p) return []
  const stack = (await driverKind(Number(p.driver_id))) === 'docker'
  return [
    {
      id: null,
      placement_id: placementId,
      position: 1,
      name: stack ? 'stack' : 'api',
      kind: stack ? 'stack' : 'api',
      driver_id: Number(p.driver_id),
      source_branch: 'main',
      target_branch: null,
      before_job: null,
      deploy_job: null,
      verify_url: null,
      verify_field: 'version',
      implicit: true
    }
  ]
}

/** Stored rows only (no implicit fallback). */
export async function readComponent(id: number): Promise<HubComponent | null> {
  const r = (await db(TABLE).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? toComponent(r) : null
}

/** null or an http(s) URL with no credentials. */
export function verifyUrlOk(v: unknown): boolean {
  if (v === null) return true
  if (typeof v !== 'string' || !v.trim() || v.length > 500) return false
  try {
    const u = new URL(v.trim())
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password
  } catch {
    return false
  }
}

/** Absent keeps the default; an explicit null stays null (and is refused by the caller). */
const orDefault = (v: unknown, d: string) => (v === undefined ? d : v)

const textOrNull = (v: unknown, max: number): string | null | undefined => {
  if (v === null) return null
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) return undefined
  return v.trim()
}

/**
 * Validates the component fields in `b` over `existing` (PATCH) or defaults (create). Position
 * and driver existence are checked against the database.
 */
export async function validateComponentInput(
  placementId: number,
  b: Record<string, unknown>,
  existing?: HubComponent
): Promise<Result<ComponentFields>> {
  const pick = <K extends keyof ComponentFields>(k: K): unknown =>
    b[k] !== undefined ? b[k] : existing?.[k]

  const kind = pick('kind')
  if (kind !== 'api' && kind !== 'frontend' && kind !== 'stack')
    return fail('BAD_KIND', 'Component kind must be api, frontend or stack.')

  const name = pick('name')
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64)
    return fail('BAD_NAME', 'A component needs a name (up to 64 characters).')

  const driverId = pick('driver_id')
  if (typeof driverId !== 'number' || !Number.isInteger(driverId))
    return fail('BAD_DRIVER', 'driver_id must name an existing driver.')
  const ownKind = await driverKind(driverId)
  if (driverId !== existing?.driver_id && !ownKind)
    return fail('BAD_DRIVER', 'driver_id must name an existing driver.')
  if (ownKind) {
    const refused = await driverKindRefusal(placementId, kind, ownKind, existing?.id ?? null)
    if (refused) return refused
  }

  let position = pick('position')
  if (position === undefined) {
    const last = (await db(TABLE)
      .where({ placement_id: placementId })
      .max({ p: 'position' })
      .first()) as { p: number | null } | undefined
    position = last?.p == null ? 1 : Number(last.p) + 1
  }
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 1 || position > 100)
    return fail('BAD_POSITION', 'position must be a whole number from 1 to 100.')
  const taken = db(TABLE).where({ placement_id: placementId, position })
  if (existing?.id != null) taken.whereNot({ id: existing.id })
  if (await taken.first('id'))
    return fail('POSITION_TAKEN', `Position ${position} is already used on this placement.`, 409)

  if (kind === 'stack') {
    // A stack has no branches or jobs: the Docker driver deploys it through the Hub agent.
    const verifyUrl = pick('verify_url') ?? null
    if (!verifyUrlOk(verifyUrl))
      return fail('BAD_VERIFY_URL', 'verify_url must be an http(s) URL or null.')
    const field = textOrNull(orDefault(pick('verify_field'), 'version'), 64)
    if (!field) return fail('BAD_VERIFY_FIELD', 'verify_field must be a field name.')
    return {
      ok: true,
      row: {
        position,
        name: name.trim(),
        kind,
        driver_id: driverId,
        source_branch: 'main',
        target_branch: null,
        before_job: null,
        deploy_job: null,
        verify_url: verifyUrl === null ? null : String(verifyUrl).trim(),
        verify_field: field
      }
    }
  }

  const source = textOrNull(orDefault(pick('source_branch'), 'main'), 200)
  if (!source) return fail('BAD_BRANCH', 'source_branch must be a branch name.')
  const target = textOrNull(pick('target_branch') ?? null, 200)
  if (target === undefined)
    return fail('BAD_BRANCH', 'target_branch must be a branch name or null.')
  const beforeJob = textOrNull(pick('before_job') ?? null, 100)
  const deployJob = textOrNull(pick('deploy_job') ?? null, 100)
  if (beforeJob === undefined || deployJob === undefined)
    return fail('BAD_JOB', 'before_job and deploy_job must be job names or null.')

  const verifyUrl = pick('verify_url') ?? null
  if (!verifyUrlOk(verifyUrl))
    return fail('BAD_VERIFY_URL', 'verify_url must be an http(s) URL or null.')
  const field = textOrNull(orDefault(pick('verify_field'), 'version'), 64)
  if (!field) return fail('BAD_VERIFY_FIELD', 'verify_field must be a field name.')

  return {
    ok: true,
    row: {
      position,
      name: name.trim(),
      kind,
      driver_id: driverId,
      source_branch: source,
      target_branch: target,
      before_job: beforeJob,
      deploy_job: deployJob,
      verify_url: verifyUrl === null ? null : String(verifyUrl).trim(),
      verify_field: field
    }
  }
}

/**
 * One driver kind per placement (phase 4, Decision 12): a stack only on a Docker driver and api /
 * frontend only on GitLab ones (KIND_DRIVER_MISMATCH); every component on the placement's own
 * driver kind (MIXED_DRIVER_KINDS); a Docker placement holds exactly one component (ONE_STACK).
 */
async function driverKindRefusal(
  placementId: number,
  kind: HubComponent['kind'],
  ownKind: string,
  selfId: number | null
): Promise<Fail | null> {
  if (!kindFits(kind, ownKind))
    return fail(
      'KIND_DRIVER_MISMATCH',
      kind === 'stack'
        ? 'A stack component needs a Docker driver.'
        : `A ${kind} component needs a GitLab driver.`
    )
  const placement = (await db('nivaro_hub_placements')
    .where({ id: placementId })
    .first('driver_id')) as { driver_id: number } | undefined
  const kinds = new Set<string>()
  const placementKind = placement ? await driverKind(Number(placement.driver_id)) : null
  if (placementKind) kinds.add(placementKind)
  const others = db(`${TABLE} as c`)
    .join('nivaro_hub_drivers as d', 'd.id', 'c.driver_id')
    .where('c.placement_id', placementId)
    .select('c.id', 'd.kind')
  if (selfId != null) others.whereNot('c.id', selfId)
  const rows = (await others) as Array<{ id: number; kind: string }>
  for (const r of rows) kinds.add(String(r.kind))
  for (const k of kinds)
    if (k !== ownKind)
      return fail(
        'MIXED_DRIVER_KINDS',
        'Every component of a placement deploys through the same kind of driver (GitLab or Docker).'
      )
  if (ownKind === 'docker' && rows.length)
    return fail('ONE_STACK', 'A Docker placement deploys exactly one stack component.', 409)
  return null
}

const racedPosition = (position: number): Fail =>
  fail('POSITION_TAKEN', `Position ${position} is already used on this placement.`, 409)

export async function createComponent(
  placementId: number,
  row: ComponentFields
): Promise<Result<HubComponent>> {
  try {
    const id = await insertReturningId(db, TABLE, {
      placement_id: placementId,
      ...row,
      created_at: new Date(),
      updated_at: new Date()
    })
    return { ok: true, row: { id: Number(id), placement_id: placementId, ...row } }
  } catch (e) {
    if (isUniqueViolation(e)) return racedPosition(row.position)
    throw e
  }
}

export async function updateComponent(
  existing: HubComponent,
  row: ComponentFields
): Promise<Result<HubComponent>> {
  try {
    await db(TABLE)
      .where({ id: existing.id })
      .update({ ...row, updated_at: new Date() })
    return { ok: true, row: { ...existing, ...row } }
  } catch (e) {
    if (isUniqueViolation(e)) return racedPosition(row.position)
    throw e
  }
}

export async function deleteComponent(id: number): Promise<boolean> {
  return (await db(TABLE).where({ id }).del()) > 0
}

/** Every app with an environment deployed through this placement. */
export async function appsOfPlacement(placementId: number): Promise<number[]> {
  const rows = (await db('nivaro_hub_environments')
    .where({ placement_id: placementId })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}
