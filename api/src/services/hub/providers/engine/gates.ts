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
import { freezeRefusal } from '../../releases/freeze.js'
import { appAllowedConnections, type HubConnectionRow, type HubResourceRow } from '../store.js'
import type { ResourceScope, ResourceTypeSpec } from '../types.js'
import {
  type ChangeGate,
  type HubActor,
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
}

export interface AccessAnswer {
  app: { id: number; key: string } | null
  env: { id: number; key: string } | null
  /** Production per THE rule (null for a change with no environment). */
  production: boolean | null
}

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
  if (!actor.isAdmin) {
    if (!(await isAppOwner(Number(app.id), actor.id)))
      throw refuse(
        'ADMIN_ONLY',
        "Only Hub administrators and this app's owners can change its resources."
      )
    const allowed = await appAllowedConnections(Number(app.id))
    if (!allowed.includes(connection.id))
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
  return { app: { id: Number(app.id), key: String(app.key) }, env, production }
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

  const frozen = await freezeRefusal({
    appIds: o.appId != null ? [o.appId] : [],
    action: 'resource_change',
    ...(o.environmentId != null ? { envId: o.environmentId } : {})
  })
  if (frozen) fail(frozen.code, frozen.message, { freeze: frozen.freeze })
  else gates.push({ code: 'FROZEN', passed: true, message: 'No freeze or closed deploy window.' })

  let checklist = false
  if (o.environmentId != null && o.production) {
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
