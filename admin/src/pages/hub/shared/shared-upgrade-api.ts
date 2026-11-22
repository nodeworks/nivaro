import type { DataTag } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Nivaro Hub phase 6 — the ONE client of Task 5's shared upgrade routes (deploy, upgrade and roll
 * back a Docker shared deployment through the agent). Everything the Upgrade panel needs from
 * Task 5 is here, so wiring a changed route or shape is a change to this file alone.
 *
 * Built against the plan's contract (ruling P6-12). Assumptions beyond the plan, each marked
 * "ASSUMED" below: the `kind` field on plan/start bodies, the override id shape, the step keys,
 * the version list route and the history route.
 */

export type SharedUpgradeKind = 'upgrade' | 'rollback'

/** Task 5's SharedUpgradePlan. */
export interface SharedUpgradePlan {
  shared_id: number
  kind: SharedUpgradeKind
  version: string
  from_version: string | null
  /** Per app: the codes that hold it back (ORDER and PREFLIGHT_FAILING a Hub admin may override). */
  apps: { env_id: number; tenant_id: string; app: string; env: string; blockers: string[] }[]
  blockers: { code: string; text: string }[]
  warnings: { code: string; text: string }[]
  plan_hash: string
}

export type SharedDeployStatus =
  | 'planned'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** One `nivaro_hub_shared_deploys` row (columns of migration 553). */
export interface SharedDeploy {
  id: number
  shared_deployment_id: number
  /** 'observed' = a version change the Hub saw on a registered deployment. */
  kind: SharedUpgradeKind | 'observed' | string
  version: string
  from_version: string | null
  status: SharedDeployStatus | string
  /** The step the runner is on (or stopped at). */
  step: string | null
  error: string | null
  plan?: SharedUpgradePlan | string | null
  job_run_id: number | null
  started_by: string | null
  started_by_name?: string | null
  started_at: string | null
  finished_at: string | null
}

export interface SharedVersions {
  versions: string[]
  /** The published releases could not be read. */
  error?: boolean
}

// ─── Query keys ──────────────────────────────────────────────────────────────────────────────

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const upgradeKeys: {
  /** The plan's key for one shared deploy run. */
  deploy: (id: number) => Tagged<readonly ['hub', 'shared-deploy', number], SharedDeploy>
  deploys: (sharedId: number) => Tagged<readonly ['hub', 'shared-deploys', number], SharedDeploy[]>
  versions: (
    sharedId: number
  ) => Tagged<readonly ['hub', 'shared-versions', number], SharedVersions>
  plan: (
    sharedId: number,
    kind: SharedUpgradeKind,
    version: string
  ) => Tagged<
    readonly ['hub', 'shared-upgrade-plan', number, SharedUpgradeKind, string],
    SharedUpgradePlan
  >
} = {
  deploy: (id) =>
    tag<SharedDeploy, readonly ['hub', 'shared-deploy', number]>([
      'hub',
      'shared-deploy',
      id
    ] as const),
  deploys: (sharedId) =>
    tag<SharedDeploy[], readonly ['hub', 'shared-deploys', number]>([
      'hub',
      'shared-deploys',
      sharedId
    ] as const),
  versions: (sharedId) =>
    tag<SharedVersions, readonly ['hub', 'shared-versions', number]>([
      'hub',
      'shared-versions',
      sharedId
    ] as const),
  plan: (sharedId, kind, version) =>
    tag<
      SharedUpgradePlan,
      readonly ['hub', 'shared-upgrade-plan', number, SharedUpgradeKind, string]
    >(['hub', 'shared-upgrade-plan', sharedId, kind, version] as const)
}

// ─── Routes ──────────────────────────────────────────────────────────────────────────────────

/** POST /api/hub/shared/:id/upgrade/plan. ASSUMED body {version, kind}. */
export const planSharedUpgrade = (sharedId: number, kind: SharedUpgradeKind, version: string) =>
  api
    .post<{ data: SharedUpgradePlan }>(`/hub/shared/${sharedId}/upgrade/plan`, { version, kind })
    .then((r) => r.data.data)

/**
 * POST /api/hub/shared/:id/upgrade → 202 {shared_deploy_id}. A 409 PLAN_CHANGED carries the plan
 * as it stands now (`plan` beside the code, as phase 2's promote). ASSUMED: `kind` rides along.
 */
export const startSharedUpgrade = (
  sharedId: number,
  body: {
    kind: SharedUpgradeKind
    version: string
    plan_hash: string
    confirm: string
    overrides: string[]
  }
) =>
  api
    .post<{ data: { shared_deploy_id: number } }>(`/hub/shared/${sharedId}/upgrade`, body)
    .then((r) => r.data.data)

/** GET /api/hub/shared-deploys/:id. */
export const fetchSharedDeploy = (id: number) =>
  api.get<{ data: SharedDeploy }>(`/hub/shared-deploys/${id}`).then((r) => r.data.data)

/** POST /api/hub/shared-deploys/:id/cancel. */
export const cancelSharedDeploy = (id: number) =>
  api.post(`/hub/shared-deploys/${id}/cancel`, {}).then(() => undefined)

/**
 * ASSUMED route (not in the plan): GET /api/hub/shared/:id/deploys → {data: SharedDeploy[]},
 * newest first. Until Task 5 has it, a 404 reads as "no history yet".
 */
export const fetchSharedDeploys = (sharedId: number) =>
  api
    .get<{ data: SharedDeploy[] }>(`/hub/shared/${sharedId}/deploys`)
    .then((r) => r.data.data ?? [])
    .catch((err: unknown) => {
      if ((err as { response?: { status?: number } })?.response?.status === 404) return []
      throw err
    })

/**
 * ASSUMED route (not in the plan): GET /api/hub/shared/:id/upgrade/versions →
 * {data: {versions, error?}} — the published releases of the Hub image (registry). Until Task 5
 * has it, a 404 reads as an empty list and the picker takes a typed version (the plan still
 * refuses one the registry does not have: VERSION_UNKNOWN).
 */
export const fetchSharedVersions = (sharedId: number) =>
  api
    .get<{ data: SharedVersions }>(`/hub/shared/${sharedId}/upgrade/versions`)
    .then((r) => ({ versions: r.data.data?.versions ?? [], error: r.data.data?.error === true }))
    .catch((err: unknown) => {
      if ((err as { response?: { status?: number } })?.response?.status === 404)
        return { versions: [] as string[], error: false }
      throw err
    })

// ─── Plan helpers ────────────────────────────────────────────────────────────────────────────

/** Per-app blockers a Hub admin may override (logged): ORDER (plan) and PREFLIGHT_FAILING (R17). */
export const OVERRIDABLE = new Set(['ORDER', 'PREFLIGHT_FAILING'])

/** ASSUMED: how an override names one app's blocker in the start body's `overrides`. */
export const overrideId = (app: { env_id: number }, code: string) => `${app.env_id}:${code}`

/** The blockers still open: plan-wide ones, and per-app ones not overridden. */
export function openBlockers(plan: SharedUpgradePlan, overrides: ReadonlySet<string>): number {
  let n = plan.blockers.length
  for (const a of plan.apps)
    for (const code of a.blockers)
      if (!(OVERRIDABLE.has(code) && overrides.has(overrideId(a, code)))) n++
  return n
}

/** The plan a start refused with 409 PLAN_CHANGED carried, if any. */
export function changedSharedPlanOf(err: unknown): SharedUpgradePlan | null {
  const data = (err as { response?: { data?: { code?: unknown; plan?: unknown } } })?.response?.data
  if (data?.code !== 'PLAN_CHANGED') return null
  const plan = data.plan as SharedUpgradePlan | undefined
  return plan && Array.isArray(plan.apps) && typeof plan.plan_hash === 'string' ? plan : null
}

/** ASSUMED step keys of the run, in order (Task 5's run steps 1–5). */
export const UPGRADE_STEPS: { key: string; label: string }[] = [
  { key: 'render', label: 'Write the stack' },
  { key: 'apply', label: 'Apply it through the agent' },
  { key: 'wait_version', label: 'Every replica runs the version' },
  { key: 'wait_schema', label: "Every app's database is up to date" },
  { key: 'verify', label: 'Each app answers at the version' }
]

export type StepState = 'done' | 'running' | 'failed' | 'stopped' | 'pending'

/** Each step's state from the run's status and the step it is on. */
export function stepStates(d: Pick<SharedDeploy, 'status' | 'step'>): StepState[] {
  const at = UPGRADE_STEPS.findIndex((s) => s.key === d.step)
  return UPGRADE_STEPS.map((_, i) => {
    if (d.status === 'success') return 'done'
    if (at < 0) return 'pending'
    if (i < at) return 'done'
    if (i > at) return 'pending'
    if (d.status === 'failed') return 'failed'
    if (d.status === 'cancelled' || d.status === 'interrupted') return 'stopped'
    return 'running'
  })
}

// ─── Copy (Task 5's planner and refusal codes) ───────────────────────────────────────────────

/** Why an upgrade cannot start, per code (plan-wide and per app). */
export const UPGRADE_COPY: Record<string, { title: string; hint?: string }> = {
  SHARED_NOT_HUB_DEPLOYED: {
    title: 'The Hub does not run this deployment',
    hint: 'It runs elsewhere; it is upgraded by whoever runs it. The Hub records the version it sees.'
  },
  BUSY: {
    title: 'Something else holds this deployment or one of its apps',
    hint: 'A move, a placement or another upgrade is running. Wait for it to finish, then plan again.'
  },
  VERSION_UNKNOWN: {
    title: 'That version is not in the image registry',
    hint: 'Pick a published version.'
  },
  AGENT_UNREACHABLE: {
    title: 'The Hub agent did not answer',
    hint: "Check the Docker driver's agent, then plan again."
  },
  ORDER: {
    title: 'The environment before this one has not run this version',
    hint: 'Promote it there first, or go ahead anyway (a Hub administrator; it is logged).'
  },
  PREFLIGHT_FAILING: {
    title: "The app's preflight checks fail",
    hint: 'Fix the failing checks, or go ahead anyway (a Hub administrator; it is logged).'
  },
  PLAN_CHANGED: {
    title: 'The plan changed',
    hint: 'Check the new plan, then type the key again to start it.'
  },
  CONFIRM_REQUIRED: {
    title: "Type the deployment's key to confirm",
    hint: 'Nothing was started. Type the key exactly as shown, then start again.'
  },
  NOT_RUNNING: {
    title: 'That upgrade is not running any more',
    hint: 'It already finished, failed or was stopped. Reload to see how it ended.'
  }
}

/** A code this screen has no words for keeps the planner's sentence (or a plain one). */
export const upgradeCopy = (code: string, text?: string): { title: string; hint?: string } =>
  UPGRADE_COPY[code] ?? { title: text || 'Held back by a check the Hub made', hint: `Code ${code}` }

export const KIND_WORDS: Record<string, string> = {
  upgrade: 'Upgrade',
  rollback: 'Rollback',
  observed: 'Seen running'
}
