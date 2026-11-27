// Task 11a (Hub providers): placement components that deploy through a provider resource instead
// of a GitLab or Docker driver. Same plan → confirm → check-twice flow as every promotion: the
// planner names exactly what the step makes live (bound in the plan hash), the run does it through
// ONE change of the change engine (carried by the promotion: the promotion judged freezes, deploy
// windows and its checklist), and records what it made live so a rollback goes back to it.
//
//   github_actions  the component's `github.workflow` (resource_id) is dispatched on the
//                   component's branch (target_branch, else source_branch) with the input
//                   `version` = the version promoted (the workflow declares a `version` input).
//                   A rollback dispatches it with the older version. Recorded: the branch.
//                   Task 11c, environment approval (deploy_job `approve[:<env>]`): the step
//                   approves the run of that workflow that waits for review on the GitHub
//                   environment instead (no rollback: a waiting run cannot be sent back).
//   vercel          the component's `vercel.project`; the deployment made live is a managed
//                   `vercel.deployment` of THIS environment for that project: on promote the
//                   newest one not live yet (adopt the build to make live on the environment's
//                   Resources panel first), on rollback the one this environment recorded for the
//                   version. Vercel promote / rollback. Recorded: the deployment's resource id.
//   eas_update      the component's `expo.channel`; on promote it is pointed at the branch the
//                   previous environment's same-named channel points at, on rollback at the branch
//                   recorded for the version here. Recorded: the branch's resource id.
//
// A provider component stores driver_id 0 (it deploys through no driver) and its resource_id; it
// may sit on a GitLab or a Docker placement beside the driver's own components.
import { db } from '../../db/index.js'
import type {
  HubComponent,
  HubDeployKind,
  HubEnvironmentRow,
  PromotionStep
} from './promote-types.js'
import type { PlanRequest } from './providers/engine/contract.js'

export const PROVIDER_COMPONENT_KINDS = ['github_actions', 'vercel', 'eas_update'] as const
export type ProviderComponentKind = (typeof PROVIDER_COMPONENT_KINDS)[number]

export function isProviderKind(kind: unknown): kind is ProviderComponentKind {
  return (PROVIDER_COMPONENT_KINDS as readonly unknown[]).includes(kind)
}

/** The resource type a provider component names. */
export const PROVIDER_COMPONENT_TYPE: Record<ProviderComponentKind, string> = {
  github_actions: 'github.workflow',
  vercel: 'vercel.project',
  eas_update: 'expo.channel'
}

/**
 * Task 11c: how a github_actions component makes a version live, stored in its `deploy_job` (no
 * migration): null = run the workflow (workflow_dispatch, input `version`); `approve` = approve the
 * run that waits for review on the GitHub environment named like the Hub environment (its key);
 * `approve:<name>` = on the GitHub environment <name>.
 */
export type GithubActionsMode =
  | { mode: 'dispatch' }
  | { mode: 'approve'; environment: string | null }

const GITHUB_ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,90}$/

export function githubActionsMode(deployJob: string | null | undefined): GithubActionsMode {
  const v = (deployJob ?? '').trim()
  if (v === 'approve') return { mode: 'approve', environment: null }
  if (v.startsWith('approve:')) {
    const name = v.slice('approve:'.length).trim()
    return { mode: 'approve', environment: name || null }
  }
  return { mode: 'dispatch' }
}

/** The stored `deploy_job` for a github_actions mode, or undefined when the value is not one. */
export function githubActionsModeText(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === '' || v === 'dispatch') return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t === 'approve') return 'approve'
  if (!t.startsWith('approve:')) return undefined
  const name = t.slice('approve:'.length).trim()
  if (!name) return 'approve'
  return GITHUB_ENV_NAME.test(name) ? `approve:${name}` : undefined
}

/** What the planner learned for one provider component (gathered; the planner stays pure). */
export interface ProviderFact {
  connectionId: number | null
  /** The component's own resource (workflow / project / channel). */
  resourceId: number | null
  /** What the step makes live: a branch (github_actions), a deployment / branch resource id. */
  ref: string | null
  /** The ref in words ("deployment dpl_123", "branch release-4"). */
  refLabel: string | null
  /** Why the step cannot run now (a blocker), or null. */
  problem: string | null
  /** Task 11c, github_actions in approval mode: the GitHub environment the step approves. */
  approveEnvironment?: string
  /** …and the one waiting run (id + head commit) read while planning — the only one approved. */
  approveRunId?: string
  approveSha?: string
}

type ResourceLite = {
  id: number
  type: string
  name: string | null
  connection_id: number
  app_id: number | null
  environment_id: number | null
  external_id: string | null
  desired: Record<string, unknown> | null
  observed: { fields?: Record<string, unknown> } | null
}

function parse(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === 'object') return v as Record<string, unknown>
  try {
    const o = JSON.parse(String(v))
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function resourceRows(where: Record<string, unknown>): Promise<ResourceLite[]> {
  try {
    const rows = (await db('nivaro_hub_resources')
      .where(where)
      .whereNull('deleted_at')
      .orderBy('id', 'desc')
      .select(
        'id',
        'type',
        'name',
        'connection_id',
        'app_id',
        'environment_id',
        'external_id',
        'desired',
        'observed'
      )) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id),
      type: String(r.type),
      name: (r.name as string | null) ?? null,
      connection_id: Number(r.connection_id),
      app_id: r.app_id == null ? null : Number(r.app_id),
      environment_id: r.environment_id == null ? null : Number(r.environment_id),
      external_id: (r.external_id as string | null) ?? null,
      desired: parse(r.desired),
      observed: parse(r.observed) as ResourceLite['observed']
    }))
  } catch {
    return []
  }
}

async function resourceRow(id: number | null | undefined): Promise<ResourceLite | null> {
  if (id == null || !Number.isSafeInteger(Number(id))) return null
  return (await resourceRows({ id: Number(id) }))[0] ?? null
}

const refIdOf = (v: unknown): number | null => {
  const id = (v as { resourceId?: unknown } | null)?.resourceId
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * A component's resource is usable on this placement: live, the kind's type, one app's (the app
 * every environment of the placement belongs to), and app-level or one of those environments'.
 * Answers the refusal text, or null.
 */
export async function providerComponentProblem(
  placementId: number,
  kind: ProviderComponentKind,
  resourceId: unknown
): Promise<string | null> {
  if (typeof resourceId !== 'number' || !Number.isSafeInteger(resourceId) || resourceId < 1)
    return `A ${kind} component names the resource it deploys through (resource_id).`
  const r = await resourceRow(resourceId)
  const want = PROVIDER_COMPONENT_TYPE[kind]
  if (!r || r.type !== want) return `resource_id must name a managed ${want}.`
  const envs = (await db('nivaro_hub_environments')
    .where({ placement_id: placementId })
    .select('id', 'app_id')) as Array<{ id: number; app_id: number }>
  if (envs.length) {
    if (envs.some((e) => Number(e.app_id) !== r.app_id))
      return `That ${want} belongs to another app than this placement's environments.`
    if (r.environment_id != null && !envs.some((e) => Number(e.id) === r.environment_id))
      return `That ${want} belongs to another environment.`
  }
  return null
}

const blank = (): ProviderFact => ({
  connectionId: null,
  resourceId: null,
  ref: null,
  refLabel: null,
  problem: null
})

/**
 * What each provider component of the target would make live (gather). `recorded(c)` = the ref
 * this environment recorded for the version (rollback); `previousComponents` are the previous
 * environment's (promote).
 */
export async function gatherProviderFacts(o: {
  kind: HubDeployKind
  target: HubEnvironmentRow
  components: HubComponent[]
  previousComponents: HubComponent[]
  recorded: (c: HubComponent) => string | null
  /** Task 11c: reads the GitHub run an approval step would approve (tests pass a fake). */
  readWaitingRun?: import('./providers/hooks/approval-read.js').WaitingRunReader
}): Promise<Record<number, ProviderFact>> {
  const out: Record<number, ProviderFact> = {}
  for (const c of o.components) {
    if (!isProviderKind(c.kind)) continue
    const fact = blank()
    out[c.position] = fact
    const own = await resourceRow(c.resource_id)
    const want = PROVIDER_COMPONENT_TYPE[c.kind]
    if (!own || own.type !== want) {
      fact.problem = `${c.name}: its ${want} is not a resource the Hub manages any more — set the component's resource again.`
      continue
    }
    if (own.environment_id != null && own.environment_id !== o.target.id) {
      fact.problem = `${c.name}: its ${want} belongs to another environment.`
      continue
    }
    fact.connectionId = own.connection_id
    fact.resourceId = own.id
    if (c.kind === 'github_actions') {
      const branch = c.target_branch || c.source_branch
      fact.ref = branch
      fact.refLabel = `branch ${branch}`
      if (!branch) fact.problem = `${c.name}: name the branch the workflow runs on.`
      // Task 11c: environment approval names the GitHub environment it approves (bound in the plan).
      const mode = githubActionsMode(c.deploy_job)
      if (mode.mode === 'approve') {
        const env = mode.environment ?? o.target.key
        fact.approveEnvironment = env
        fact.refLabel = `the waiting run on ${branch}, environment ${env}`
        if (o.kind === 'rollback') {
          fact.problem = `${c.name}: approves a waiting GitHub deployment, which cannot roll back — start the older run in GitHub, then promote to approve it.`
          continue
        }
        if (!branch) continue
        if (!own.external_id) {
          fact.problem = `${c.name}: its workflow has no GitHub id yet.`
          continue
        }
        // The one run the step will approve: read now, named in the plan, bound in its hash.
        const read =
          o.readWaitingRun ?? (await import('./providers/hooks/approval-read.js')).readWaitingRun
        try {
          const run = await read({
            connectionId: own.connection_id,
            workflow: own.external_id,
            environment: env,
            branch
          })
          if (!run) {
            fact.problem = `${c.name}: no run of ${own.external_id.split('#')[1] ?? 'the workflow'} on ${branch} waits for approval to ${env} — start it in GitHub, then plan the promotion again.`
            continue
          }
          fact.approveRunId = String(run.runId)
          fact.approveSha = run.headSha
          fact.refLabel = `run ${run.runId} (commit ${run.headSha.slice(0, 12)}) on ${branch}, environment ${env}`
        } catch (e) {
          fact.problem = `${c.name}: could not read the waiting runs from GitHub (${e instanceof Error ? e.message.slice(0, 200) : 'no answer'}).`
        }
      }
      continue
    }
    if (o.kind === 'rollback') {
      const ref = o.recorded(c)
      const row = ref && /^\d+$/.test(ref) ? await resourceRow(Number(ref)) : null
      const kindType = c.kind === 'vercel' ? 'vercel.deployment' : 'expo.branch'
      const fits =
        !!row &&
        row.type === kindType &&
        (c.kind !== 'vercel' ||
          (row.environment_id === o.target.id && refIdOf(row.desired?.project) === own.id))
      if (!row || !fits) {
        fact.problem = `${c.name}: the Hub has no record of what ${o.target.key} ran with this version (or it is no longer managed) — nothing to roll back to.`
        continue
      }
      fact.ref = String(row.id)
      fact.refLabel = `${c.kind === 'vercel' ? 'deployment' : 'branch'} ${row.name ?? row.external_id ?? row.id}`
      continue
    }
    if (c.kind === 'vercel') {
      const candidates = (
        await resourceRows({ type: 'vercel.deployment', environment_id: o.target.id })
      ).filter(
        (d) =>
          refIdOf(d.desired?.project) === own.id &&
          d.observed?.fields?.production !== true &&
          d.observed?.fields?.state !== 'ERROR' &&
          d.observed?.fields?.state !== 'CANCELED'
      )
      const pick = candidates[0]
      if (!pick) {
        fact.problem = `${c.name}: no Vercel deployment of this project waits to go live on ${o.target.key} — adopt the build to make live on its Resources panel first.`
        continue
      }
      fact.ref = String(pick.id)
      fact.refLabel = `deployment ${pick.external_id ?? pick.name ?? pick.id}`
      continue
    }
    // eas_update, promote: the branch the previous environment's same-named channel points at.
    const prev = o.previousComponents.find((p) => p.kind === 'eas_update' && p.name === c.name)
    const prevChannel = prev ? await resourceRow(prev.resource_id) : null
    const branchId = refIdOf(prevChannel?.desired?.branch)
    const branch = branchId ? await resourceRow(branchId) : null
    if (!prev || !prevChannel || !branch || branch.type !== 'expo.branch') {
      fact.problem = `${c.name}: the previous environment has no update channel of that name pointing at a branch the Hub manages.`
      continue
    }
    if (branch.environment_id != null && branch.environment_id !== o.target.id) {
      fact.problem = `${c.name}: the branch ${branch.name ?? branch.id} belongs to the previous environment only — make it an app-level branch so both channels can point at it.`
      continue
    }
    fact.ref = String(branch.id)
    fact.refLabel = `branch ${branch.name ?? branch.external_id ?? branch.id}`
  }
  return out
}

/** The planned step of a provider component (driver 'provider'; nothing GitLab or Docker). */
export function providerStepFor(
  c: HubComponent,
  fact: ProviderFact | undefined,
  version: string
): PromotionStep {
  const f = fact ?? blank()
  return {
    position: c.position,
    component: c.name,
    kind: c.kind,
    driverId: 0,
    sourceSha: null,
    targetBranch: c.kind === 'github_actions' ? (f.ref ?? '') : '',
    pinText: null,
    pinFile: null,
    beforeJob: null,
    deployJob: '',
    verifyUrl: c.verify_url,
    verifyField: c.verify_field,
    want: version,
    driver: 'provider',
    provider: {
      kind: c.kind as ProviderComponentKind,
      connectionId: f.connectionId ?? 0,
      resourceId: f.resourceId ?? 0,
      ref: f.ref ?? '',
      refLabel: f.refLabel ?? '',
      ...(f.approveEnvironment ? { approveEnvironment: f.approveEnvironment } : {}),
      ...(f.approveRunId ? { approveRunId: f.approveRunId } : {}),
      ...(f.approveSha ? { approveSha: f.approveSha } : {})
    }
  }
}

/** The resource row one provider step writes (the deployment for vercel, else the component's). */
export function providerWrittenResource(s: PromotionStep): number {
  const p = s.provider
  if (!p) return 0
  return p.kind === 'vercel' ? Number(p.ref) : p.resourceId
}

/**
 * The change one provider step makes (one operation on one resource). `envId` = the environment
 * of the resource it writes: null for an app-level one (a workflow or project every environment
 * of the app deploys through) — the promotion judged the environment's gates.
 */
export function providerChangeRequest(
  s: PromotionStep,
  o: { appId: number; envId: number | null; kind: HubDeployKind; version: string }
): PlanRequest {
  const p = s.provider
  if (!p) throw new Error('not a provider step')
  const base = {
    connectionId: p.connectionId,
    scope: 'app' as const,
    appId: o.appId,
    ...(o.envId != null ? { environmentId: o.envId } : {})
  }
  if (p.kind === 'github_actions' && p.approveEnvironment)
    return {
      ...base,
      ops: [
        {
          action: 'update',
          resourceId: p.resourceId,
          fields: {
            ref: p.ref,
            approve_environment: p.approveEnvironment,
            approve_run_id: p.approveRunId ?? '',
            approve_sha: p.approveSha ?? '',
            approve: true
          }
        }
      ]
    }
  if (p.kind === 'github_actions')
    return {
      ...base,
      ops: [
        {
          action: 'update',
          resourceId: p.resourceId,
          fields: { ref: p.ref, inputs: JSON.stringify({ version: o.version }), dispatch: true }
        }
      ]
    }
  if (p.kind === 'vercel')
    return {
      ...base,
      ops: [
        {
          action: 'update',
          resourceId: Number(p.ref),
          fields: { mode: o.kind === 'rollback' ? 'rollback' : 'promote' }
        }
      ]
    }
  return {
    ...base,
    ops: [
      {
        action: 'update',
        resourceId: p.resourceId,
        fields: { branch: { resourceId: Number(p.ref) } }
      }
    ]
  }
}
