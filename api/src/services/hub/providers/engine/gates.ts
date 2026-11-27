import { db } from '../../../../db/index.js'
import { isAppOwner } from '../../apps.js'
import {
  type ChecklistClaim,
  ChecklistError,
  checklistFor,
  checklistGate
} from '../../changes/checklist.js'
import { moveOpenRefusal } from '../../move-open.js'
import { envPolicy } from '../../owner-access.js'
import { archivedRefusal } from '../../releases/archived.js'
import { freezeRefusal } from '../../releases/freeze.js'
import { appAllowedConnections, type HubConnectionRow, type HubResourceRow } from '../store.js'
import type { ResourceScope, ResourceTypeSpec } from '../types.js'
import {
  type ChangeGate,
  type ChangeOrigin,
  type HubActor,
  type PlanAction,
  RESOURCE_CHANGE_CODES,
  type ResourceChangeCode,
  ResourceChangeError
} from './contract.js'

/**
 * Hub provider changes: who may change what, and what may stop a change now. Every gate is the
 * Hub's existing one, reused — never a second copy:
 *
 *  - shared scope (and any shared resource or shared type): Hub admins only (SHARED_ADMIN_ONLY);
 *  - app scope: Hub admins, or an owner of the app (nivaro_hub_app_owners) through a connection on
 *    the app's allowed list (CONNECTION_NOT_ALLOWED) — judged BEFORE any provider call;
 *  - production: THE production rule (owner-access envPolicy, unreadable = production) and the
 *    app's owners_deploy_production switch (PRODUCTION_ADMIN_ONLY);
 *  - an open move of the environment (move-open.ts, MOVE_OPEN);
 *  - freezes and deploy windows (releases/freeze.ts freezeRefusal, action `resource_change`,
 *    judged for the environment so production-only windows apply; it also refuses a retired app,
 *    ENV_ARCHIVED). A shared change names no app: only Hub-wide freezes stop it;
 *  - the pre-deploy checklist of a production environment (changes/checklist.ts, action
 *    `resource_change`, one checklist per change: version `resource-change-<changeId>`), claimed
 *    when the run starts and linked as run kind `resource`.
 * Each read that fails answers the gate's own fail-closed code (FREEZE_UNKNOWN, MOVE_UNKNOWN,
 * CHECKLIST_UNKNOWN).
 */

export interface AccessInput {
  connection: HubConnectionRow
  scope: ResourceScope
  appId: number | null
  environmentId: number | null
  types: ResourceTypeSpec[]
  rows: HubResourceRow[]
  /**
   * The run that carries this change (judged by `judgeOrigin` before any provider call), and the
   * request's own ops (the same list at plan and at start/resume). A promotion or retirement may
   * act for an owner on THIS app's existing managed resources through a connection the app's
   * allowed list does not name — the grant is per resource, never the whole connection. Any op
   * that does not name an existing resource (create, adopt) still needs the allowed list.
   */
  carriedBy?: 'promotion' | 'creation' | 'retirement' | null
  requestOps?: ReadonlyArray<{ action: string; resourceId?: number | null }>
}

export interface AccessAnswer {
  app: { id: number; key: string } | null
  env: { id: number; key: string } | null
  /** Production per THE rule (null for a change with no environment). */
  production: boolean | null
  /**
   * True when an owner passed only through the carried per-resource grant (the connection is not
   * on the app's allowed list). The planned ops must then stay on those resources:
   * `assertCarriedGrantOps` after the adapter has planned, and again at start/resume.
   */
  viaCarriedGrant?: boolean
}

/** Actions that only touch a resource the Hub already manages. */
const ON_EXISTING: ReadonlySet<string> = new Set(['update', 'delete', 'reapply', 'accept'])

const refuse = (code: ResourceChangeCode, message: string, details?: Record<string, unknown>) =>
  new ResourceChangeError(code, message, details)

/** Throws the first access refusal; answers the app / environment the change is for. */
export async function judgeAccess(input: AccessInput, actor: HubActor): Promise<AccessAnswer> {
  const { connection, scope, rows, types } = input
  const sharedTouched =
    scope === 'shared' ||
    rows.some((r) => r.scope === 'shared') ||
    types.some((t) => t.scope === 'shared')
  if (sharedTouched && !actor.isAdmin)
    throw refuse(
      'SHARED_ADMIN_ONLY',
      'Shared resources (networks, hosted zones, organisation settings) are changed by Hub administrators only.'
    )
  if (connection.status === 'disabled')
    throw refuse(
      'CONNECTION_DISABLED',
      'This connection is disabled — a Hub administrator can turn it back on.'
    )
  for (const t of types)
    if (t.scope !== scope)
      throw refuse(
        'INVALID_FIELDS',
        `${t.label} is a ${t.scope === 'shared' ? 'shared' : 'per-app'} resource type; plan it in ${t.scope === 'shared' ? 'the shared' : "an app's"} scope.`
      )
  for (const r of rows) {
    if (r.connection_id !== connection.id)
      throw refuse('INVALID_FIELDS', `Resource ${r.id} belongs to another connection.`)
    if (r.scope !== scope) throw refuse('INVALID_FIELDS', `Resource ${r.id} is not in this scope.`)
  }
  if (scope === 'shared') return { app: null, env: null, production: null }

  if (input.appId == null) throw refuse('INVALID_FIELDS', 'Name the app the resources belong to.')
  const app = (await db('nivaro_hub_apps').where({ id: input.appId }).first('id', 'key')) as
    | { id: number; key: string }
    | undefined
  if (!app) throw refuse('NOT_FOUND', 'No such app.')
  let env: { id: number; key: string } | null = null
  if (input.environmentId != null) {
    const e = (await db('nivaro_hub_environments')
      .where({ id: input.environmentId })
      .first('id', 'key', 'app_id')) as { id: number; key: string; app_id: number } | undefined
    if (!e || Number(e.app_id) !== Number(app.id))
      throw refuse('INVALID_FIELDS', 'That environment does not belong to this app.')
    env = { id: Number(e.id), key: String(e.key) }
  }
  for (const r of rows) {
    if (r.app_id !== Number(app.id))
      throw refuse('INVALID_FIELDS', `Resource ${r.id} belongs to another app.`)
    if ((r.environment_id ?? null) !== (env?.id ?? null))
      throw refuse('INVALID_FIELDS', `Resource ${r.id} belongs to another environment of this app.`)
  }
  let viaCarriedGrant = false
  if (!actor.isAdmin) {
    if (!(await isAppOwner(Number(app.id), actor.id)))
      throw refuse(
        'ADMIN_ONLY',
        "Only Hub administrators and this app's owners can change its resources."
      )
    const ops = input.requestOps ?? []
    const rowIds = new Set(rows.map((r) => r.id))
    const carriedOnOwnResources =
      (input.carriedBy === 'promotion' || input.carriedBy === 'retirement') &&
      ops.length > 0 &&
      ops.every(
        (o) =>
          ON_EXISTING.has(o.action) &&
          typeof o.resourceId === 'number' &&
          o.resourceId > 0 &&
          rowIds.has(o.resourceId)
      )
    const allowed = await appAllowedConnections(Number(app.id))
    viaCarriedGrant = carriedOnOwnResources && !allowed.includes(connection.id)
    if (!carriedOnOwnResources && !allowed.includes(connection.id))
      throw refuse(
        'CONNECTION_NOT_ALLOWED',
        'This connection is not allowed for this app — a Hub administrator can allow it.'
      )
  }
  let production: boolean | null = null
  if (env) {
    let ownersMay = false
    try {
      const p = await envPolicy(env.id)
      production = p ? p.production : true
      ownersMay = p?.ownersDeployProduction ?? false
    } catch {
      production = true
    }
    if (production && !actor.isAdmin && !ownersMay)
      throw refuse(
        'PRODUCTION_ADMIN_ONLY',
        'Production resources are changed by Hub administrators on this app. A Hub administrator can let owners deploy production.'
      )
  }
  return { app: { id: Number(app.id), key: String(app.key) }, env, production, viaCarriedGrant }
}

/** The write refusal for an actor who may plan but never apply (MCP, View-as / run-as). */
export function assertMayWrite(actor: HubActor): void {
  if (actor.via === 'mcp')
    throw refuse(
      'HUB_WRITE_NOT_FOR_AGENTS',
      'Connected agents can list and plan resource changes; a person applies them.'
    )
  if (actor.via === 'view_as')
    throw refuse('DELEGATED_NO_WRITE', 'View-as and run-as never change resources.')
}

export interface ChangeGateInput {
  scope: ResourceScope
  appId: number | null
  environmentId: number | null
  production: boolean | null
  /** Task 11a: the Hub run carrying the change (already judged by judgeOrigin). */
  origin?: ChangeOrigin | null
}

export interface ChangeGateAnswer {
  gates: ChangeGate[]
  /** The first failing gate that stops a start (checklist excluded: judged when the run starts). */
  refusal: ResourceChangeError | null
  /** A production checklist applies (its run id is needed to start). */
  checklist: boolean
}

const known = (code: string): ResourceChangeCode | null =>
  code in RESOURCE_CHANGE_CODES ? (code as ResourceChangeCode) : null

/** Freezes / deploy windows / open move / checklist, as gate rows. Reads only. */
export async function judgeChangeGates(o: ChangeGateInput): Promise<ChangeGateAnswer> {
  const gates: ChangeGate[] = []
  let refusal: ResourceChangeError | null = null
  const fail = (code: string, message: string, details?: Record<string, unknown>) => {
    gates.push({ code, passed: false, message })
    if (!refusal) refusal = refuse(known(code) ?? 'FROZEN', message, details)
  }

  if (o.environmentId != null) {
    try {
      const move = await moveOpenRefusal({ envIds: [o.environmentId] })
      if (move) fail('MOVE_OPEN', move.message, { move_id: move.move_id })
      else
        gates.push({
          code: 'MOVE_OPEN',
          passed: true,
          message: 'No move of this environment is open.'
        })
    } catch {
      fail(
        'MOVE_UNKNOWN',
        'The Hub could not tell whether a move of this environment is open — try again.'
      )
    }
  }

  const origin = o.origin ?? null
  const appIds = o.appId != null ? [o.appId] : []
  const envOpt = o.environmentId != null ? { envId: o.environmentId } : {}
  let frozen: Awaited<ReturnType<typeof freezeRefusal>>
  if (origin?.kind === 'promotion') {
    // The promotion judged its freezes and windows (a rollback is exempt from freezes); only a
    // retired app is refused here, as the promotion's own start refuses it.
    frozen = await archivedRefusal({ appIds, envId: o.environmentId ?? null })
  } else if (origin?.kind === 'retirement') {
    // As the retirement's own steps: action `retire` (no ENV_ARCHIVED), its own freeze left out.
    const own = retireSource(origin.retirementId)
    frozen = await freezeRefusal({
      appIds,
      action: 'retire',
      ...envOpt,
      ignoreSource: (source) => source === own
    })
  } else frozen = await freezeRefusal({ appIds, action: 'resource_change', ...envOpt })
  if (frozen) fail(frozen.code, frozen.message, { freeze: frozen.freeze })
  else
    gates.push({
      code: 'FROZEN',
      passed: true,
      message:
        origin?.kind === 'promotion'
          ? 'Part of a promotion: its freezes and deploy windows were judged when it started.'
          : 'No freeze or closed deploy window.'
    })

  let checklist = false
  // A carried change runs under its run's own checklist (promotion, creation, retirement).
  if (o.environmentId != null && o.production && !origin) {
    try {
      const { entries } = await checklistFor(
        { kind: 'environment', envId: o.environmentId },
        'resource_change'
      )
      const required = entries.filter((e) => e.required)
      if (required.length) {
        checklist = true
        gates.push({
          code: 'CHECKLIST_REQUIRED',
          passed: false,
          message: `This production change needs its pre-deploy checklist ticked first (${required.length} required item${required.length === 1 ? '' : 's'}).`
        })
      }
    } catch {
      fail(
        'CHECKLIST_UNKNOWN',
        'The Hub could not read the pre-deploy checklist — try again shortly.'
      )
    }
  }
  return { gates, refusal, checklist }
}

/** The checklist version one change is ticked for (the admin panel builds the same string). */
export const checklistVersionOf = (changeId: number) => `resource-change-${changeId}`

/** Claims the production checklist of this change (null = none applies). */
export async function claimResourceChecklist(
  environmentId: number,
  changeId: number,
  runId: unknown
): Promise<ChecklistClaim | null> {
  try {
    return await checklistGate({
      target: { kind: 'environment', envId: environmentId },
      action: 'resource_change',
      version: checklistVersionOf(changeId),
      runId
    })
  } catch (e) {
    if (e instanceof ChecklistError)
      throw refuse(known(e.code) ?? 'CHECKLIST_REQUIRED', e.message, e.extra ?? undefined)
    throw e
  }
}

// ── Task 11a: carried changes ──

/** The freeze source a retirement writes (lifecycle/retire-steps.ts retireFreezeSource). */
const retireSource = (id: number) => `retire:${id}`

const ORIGIN_ACTIONS: Record<ChangeOrigin['kind'], readonly PlanAction[]> = {
  promotion: ['adopt', 'update'],
  creation: ['create', 'adopt', 'update'],
  retirement: ['delete']
}

/**
 * Throws ORIGIN_INVALID unless `origin` is a run that may carry this change NOW: the right kind of
 * operations, the same app (and environment), and the run itself still going. Judged at every
 * plan, start (re-plan) and resume, so an exception never outlives its run.
 */
export async function judgeOrigin(
  origin: ChangeOrigin,
  c: {
    scope: ResourceScope
    appId: number | null
    environmentId: number | null
    actions: PlanAction[]
  }
): Promise<void> {
  const bad = (message: string) => refuse('ORIGIN_INVALID', message)
  const allowed = ORIGIN_ACTIONS[origin?.kind as ChangeOrigin['kind']]
  if (!allowed) throw bad('Unknown carrier of this change.')
  if (c.scope !== 'app' || c.appId == null)
    throw bad("A change carried by a Hub run belongs to one app's resources.")
  const wrong = c.actions.find((a) => !allowed.includes(a))
  if (!c.actions.length || wrong)
    throw bad(
      origin.kind === 'retirement'
        ? 'A retirement only deletes resources.'
        : `A ${origin.kind} cannot ${wrong ?? 'do that to'} resources.`
    )
  if (origin.kind === 'promotion') {
    // The environment's own resources, or the app's (an app-level workflow / project the
    // environment's component deploys through).
    const d = (await db('nivaro_hub_deploys')
      .where({ id: Number(origin.deployId) })
      .first('id', 'status', 'kind', 'environment_id', 'app_id')) as
      | Record<string, unknown>
      | undefined
    if (
      !d ||
      String(d.status) !== 'running' ||
      !['promote', 'rollback'].includes(String(d.kind)) ||
      Number(d.app_id) !== Number(c.appId) ||
      (c.environmentId != null && Number(d.environment_id) !== Number(c.environmentId))
    )
      throw bad('The promotion this change belongs to is not running on this environment.')
    return
  }
  if (origin.kind === 'creation') {
    const r = (await db('nivaro_hub_creations')
      .where({ id: Number(origin.creationId) })
      .first('id', 'status', 'environment_id', 'app_id')) as Record<string, unknown> | undefined
    if (
      !r ||
      String(r.status) !== 'running' ||
      (c.environmentId != null && Number(r.environment_id) !== Number(c.environmentId)) ||
      Number(r.app_id) !== Number(c.appId)
    )
      throw bad('The creation this change belongs to is not running for this environment.')
    return
  }
  const r = (await db('nivaro_hub_retirements')
    .where({ id: Number(origin.retirementId) })
    .first('id', 'status', 'step', 'app_id', 'steps')) as Record<string, unknown> | undefined
  let steps: Array<{ key?: unknown; state?: unknown }> = []
  try {
    const raw = typeof r?.steps === 'string' ? JSON.parse(r.steps) : r?.steps
    if (Array.isArray(raw)) steps = raw
  } catch {
    steps = []
  }
  const remove = steps.find((s) => s?.key === 'remove')
  if (
    !r ||
    String(r.status) !== 'running' ||
    String(r.step ?? '') !== 'remove' ||
    remove?.state !== 'running' ||
    Number(r.app_id) !== Number(c.appId)
  )
    throw bad("The retirement this change belongs to is not removing this app's resources now.")
}

/**
 * Task 11a: Hub records outside the resource table that still use resources a change deletes.
 * A database server linked to an `aws.rds_instance` (nivaro_hub_db_servers.resource_id) holding a
 * database of ANOTHER app (or of no environment) stops the delete (SHARED_IN_USE, never
 * overridable); the change's own app's databases go with it (a delete is destructive and
 * typed-confirmed; RDS takes a final snapshot). Fails closed: a read that fails blocks.
 */
export async function hubRecordBlockers(
  deleted: HubResourceRow[],
  appId: number | null
): Promise<Array<{ code: string; message: string }>> {
  // Task 33: a Neon branch may be a database server too.
  const rds = deleted.filter((r) => r.type === 'aws.rds_instance' || r.type === 'neon.branch')
  if (!rds.length) return []
  const out: Array<{ code: string; message: string }> = []
  try {
    if (!(await db.schema.hasColumn('nivaro_hub_db_servers', 'resource_id'))) return []
    const servers = (await db('nivaro_hub_db_servers')
      .whereIn(
        'resource_id',
        rds.map((r) => r.id)
      )
      .select('id', 'name')) as Array<{ id: number; name: string }>
    for (const s of servers) {
      const dbIds = (
        (await db('nivaro_hub_databases').where({ server_id: s.id }).select('id')) as Array<{
          id: number
        }>
      ).map((x) => Number(x.id))
      if (!dbIds.length) continue
      const refs = dbIds.map((id) => `hub-db:${id}`)
      const envs = (await db('nivaro_hub_environments')
        .whereIn('db_ref', refs)
        .select('app_id', 'db_ref')) as Array<{ app_id: number; db_ref: string }>
      const owned = new Set(envs.map((e) => String(e.db_ref)))
      const foreign =
        refs.some((r) => !owned.has(r)) ||
        envs.some((e) => appId == null || Number(e.app_id) !== appId)
      if (foreign)
        out.push({
          code: 'SHARED_IN_USE',
          message: `Database server ${s.name} is this ${rds.some((r) => r.type === 'neon.branch') ? 'database resource' : 'RDS instance'}, and it still holds databases of other apps (or of no environment). Move or drop them first.`
        })
    }
  } catch {
    out.push({
      code: 'SHARED_IN_USE',
      message:
        'The Hub could not read whether a database server still uses this RDS instance; try again.'
    })
  }
  return out
}

/**
 * After the adapter has planned (and again at start/resume): a change that passed only through
 * the carried per-resource grant may not make anything new at the provider. Any planned create or
 * replace, or an op with no stored resource of this change, needs the app's allowed list.
 */
export function assertCarriedGrantOps(
  access: Pick<AccessAnswer, 'viaCarriedGrant'>,
  ops: ReadonlyArray<{ kind: string }>,
  resourceIds: ReadonlyArray<number | null>,
  rowIds: ReadonlySet<number>
): void {
  if (!access.viaCarriedGrant) return
  const bad = ops.some(
    (o, i) =>
      o.kind === 'create' ||
      o.kind === 'replace' ||
      resourceIds[i] == null ||
      !rowIds.has(Number(resourceIds[i]))
  )
  if (bad)
    throw refuse(
      'CONNECTION_NOT_ALLOWED',
      'This change would make something new through a connection this app is not allowed — a Hub administrator can allow it.'
    )
}
