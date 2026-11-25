// Hub enhancement 47: what retiring an app would do, environment by environment, and what stops
// it now. The plan is bound to its hash: a retirement opens only on the plan the person read
// (PLAN_STALE otherwise), and a step only runs on the environments that plan named.
import { createHash } from 'node:crypto'
import { db } from '../../../db/index.js'
import { creationOpenRefusal } from '../create/store.js'
import { readPolicy } from '../data/policy.js'
import { dockerTargetOf } from '../docker/stack-guards.js'
import { moveOpenRefusal } from '../move-open.js'
import { envPolicy, PRODUCTION_KEY_RE } from '../owner-access.js'
import { openRetirementOf, type RetireEnvPlan, type RetirePlan } from './retire-store.js'

export interface PlanLine {
  code: string
  text: string
}

export interface RetirePlanView extends RetirePlan {
  plan_hash: string
  blockers: PlanLine[]
  warnings: PlanLine[]
  /** What each step will do, in plain sentences. */
  lines: Record<string, string[]>
}

export class RetireError extends Error {
  code: string
  status: number
  extra: Record<string, unknown>
  constructor(code: string, message: string, status = 409, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RetireError'
    this.code = code
    this.status = status
    this.extra = extra
  }
}

export function planHashOf(p: RetirePlan): string {
  const stable = {
    app: [p.app.id, p.app.key],
    envs: p.environments.map((e) => [e.id, e.key, e.kind, e.freeze, e.production, e.stack]),
    production: p.production
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

async function envKind(
  e: Record<string, unknown>
): Promise<Pick<RetireEnvPlan, 'kind' | 'stack' | 'freeze' | 'has_link'>> {
  const hasLink = !!e.hub_token && !!String(e.base_url ?? '').trim()
  const status = String(e.status ?? '')
  let shared = false
  if (e.placement_id != null) {
    const p = (await db('nivaro_hub_placements').where({ id: e.placement_id }).first('kind')) as
      | { kind: string }
      | undefined
    shared = p?.kind === 'shared'
  }
  const nothingRuns = status === 'suspended' || status === 'archived'
  if (shared)
    return {
      kind: 'shared',
      stack: null,
      freeze: nothingRuns ? 'none' : 'status',
      has_link: hasLink
    }
  const docker = await dockerTargetOf(Number(e.id))
  const freeze = nothingRuns ? 'none' : hasLink ? 'link' : 'manual'
  if (docker?.stackName)
    return { kind: 'docker', stack: docker.stackName, freeze, has_link: hasLink }
  return { kind: 'manual', stack: null, freeze, has_link: hasLink }
}

/** The app's environments as a retirement sees them (archived ones left out: nothing to do). */
export async function gatherPlan(appId: number): Promise<RetirePlan> {
  const app = (await db('nivaro_hub_apps').where({ id: appId }).first('id', 'key', 'name')) as
    | { id: number; key: string; name: string }
    | undefined
  if (!app) throw new RetireError('NOT_FOUND', 'Not found', 404)
  const rows = (await db('nivaro_hub_environments')
    .where({ app_id: appId })
    .orderBy([
      { column: 'position', order: 'asc' },
      { column: 'id', order: 'asc' }
    ])
    .select('*')) as Array<Record<string, unknown>>
  const environments: RetireEnvPlan[] = []
  for (const e of rows) {
    if (String(e.status ?? '') === 'archived') continue
    const kind = await envKind(e)
    const pol = await envPolicy(Number(e.id)).catch(() => null)
    const policy = await readPolicy(Number(e.id)).catch(() => null)
    environments.push({
      id: Number(e.id),
      key: String(e.key),
      status: String(e.status ?? 'active'),
      // THE production rule (owner-access envPolicy); unreadable = production (fails closed).
      production: pol ? pol.production : true,
      ...kind,
      database: e.db_ref != null && String(e.db_ref).trim() !== '',
      files_target: !!policy?.files_target
    })
  }
  return {
    app: { id: Number(app.id), key: String(app.key), name: String(app.name || app.key) },
    environments,
    production: environments.some((e) => e.production)
  }
}

/** Plain sentences per step for the plan (the wizard shows them under each step). */
export function planLines(p: RetirePlan): Record<string, string[]> {
  const envs = p.environments
  // A key that already says production needs no "(production)" after it.
  const name = (e: RetireEnvPlan) =>
    `${e.key}${e.production && !PRODUCTION_KEY_RE.test(e.key) ? ' (production)' : ''}`
  return {
    freeze: [
      'A Hub freeze for the app: no promotion, Apply now, move or upgrade while it retires.',
      ...envs.map((e) =>
        e.freeze === 'link'
          ? `${name(e)}: strict maintenance over its hub link — nobody writes, administrators included.`
          : e.freeze === 'status'
            ? `${name(e)}: served in maintenance by its shared deployment.`
            : e.freeze === 'manual'
              ? `${name(e)}: no hub link — put it in maintenance yourself and say so at sign-off.`
              : `${name(e)}: ${e.status}, nothing runs there.`
      )
    ],
    export: envs.map(
      (e) =>
        `${name(e)}: ${e.database ? 'a database backup' : 'no database the Hub knows'} and ${
          e.files_target ? 'a files backup to its backup target' : 'no files backup target'
        }${!e.database || !e.files_target ? ' — sign off what is skipped with a reason' : ''}.`
    ),
    notice: [
      'The people who signed in to the app through the Hub, its owners and the Hub administrators get the final notice (in the app and by email); the maintenance page shows it.'
    ],
    remove: envs.map((e) =>
      e.kind === 'docker'
        ? `${name(e)}: the Docker stack ${e.stack} is removed (its volumes and its database stay).`
        : e.kind === 'shared'
          ? `${name(e)}: taken off its shared deployment (its database stays).`
          : `${name(e)}: the Hub cannot stop it — stop it yourself and confirm at sign-off.`
    ),
    archive: [
      'Every environment is archived and the app is marked retired. The freeze stays, so nothing is deployed to it again.'
    ]
  }
}

/** The plan with what blocks a retirement from opening now. */
export async function retirePlan(appId: number): Promise<RetirePlanView> {
  const plan = await gatherPlan(appId)
  const blockers: PlanLine[] = []
  const warnings: PlanLine[] = []
  const archived = (await db('nivaro_hub_apps').where({ id: appId }).first('archived_at')) as
    | { archived_at: unknown }
    | undefined
  if (archived?.archived_at)
    blockers.push({ code: 'APP_ARCHIVED', text: 'This app is retired already.' })
  const open = await openRetirementOf(appId)
  if (open)
    blockers.push({
      code: 'RETIRE_OPEN',
      text: `Retirement #${open.id} of this app is still open: continue or cancel it.`
    })
  if (!plan.environments.length)
    warnings.push({
      code: 'NO_ENVIRONMENTS',
      text: 'The app has no live environment: only the Hub record is archived.'
    })
  const ids = plan.environments.map((e) => e.id)
  const move = ids.length ? await moveOpenRefusal({ envIds: ids }) : null
  if (move) blockers.push({ code: move.code, text: move.message })
  for (const e of plan.environments) {
    const c = await creationOpenRefusal(e.id)
    if (c) blockers.push({ code: c.code, text: `${e.key}: ${c.message}` })
    if (e.freeze === 'manual')
      warnings.push({
        code: 'NO_LINK',
        text: `${e.key} has no hub link: the Hub cannot freeze it or post the notice there.`
      })
  }
  return { ...plan, plan_hash: planHashOf(plan), blockers, warnings, lines: planLines(plan) }
}
