import type { DataTag } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Nivaro Hub phase 6 — the ONE client of Task 5's shared upgrade routes (deploy, upgrade and roll
 * back a Docker shared deployment through the agent: routes/hub-shared-upgrade.ts). Everything
 * the Upgrade panel needs from Task 5 is here, so a changed route or shape is a change to this
 * file alone. Contract: task-5-report.md (overrides `CODE:env_id`, steps render → apply →
 * wait_version → wait_schema → verify, `GET /shared/:id/deploys` for the history). The version
 * list is Task 17's own `GET /shared/:id/upgrade/versions` (routes/hub-shared.ts).
 */

export type SharedUpgradeKind = 'upgrade' | 'rollback'

/** Task 5's SharedUpgradePlan. */
export interface SharedUpgradePlan {
  shared_id: number
  kind: SharedUpgradeKind
  version: string
  from_version: string | null
  /** Per app: the codes that hold it back (ORDER and PREFLIGHT_FAILING a Hub admin may override). */
  apps: {
    env_id: number
    tenant_id: string
    app: string
    env: string
    blockers: string[]
    /** One sentence per blocker, in the same order. */
    notes?: string[]
    status?: string
    placed?: boolean
    base_url?: string
  }[]
  blockers: { code: string; text: string }[]
  warnings: { code: string; text: string }[]
  plan_hash: string
  /** The typed confirmation the start needs (the deployment key). */
  confirm?: string
  /** The per-app codes a Hub admin may override. */
  overridable?: string[]
  /**
   * P6-29: an upgrade to an older version (or one either side of which is not semver). The start
   * needs `downgrade: true`, else 409 DOWNGRADE_NEEDS_CONFIRM. The plan also warns DOWNGRADE.
   */
  downgrade?: boolean
  image?: string | null
  stack?: string | null
  hostnames?: string[]
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
  overrides?: string[]
  apps?: { env_id: number; app_id: number; status: string; from_version: string | null }[]
  log?: { seq: number; at: string; level: 'info' | 'warn' | 'error'; line: string }[]
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

/** POST /api/hub/shared/:id/upgrade/plan {version, kind}. */
export const planSharedUpgrade = (sharedId: number, kind: SharedUpgradeKind, version: string) =>
  api
    .post<{ data: SharedUpgradePlan }>(`/hub/shared/${sharedId}/upgrade/plan`, { version, kind })
    .then((r) => r.data.data)

/**
 * POST /api/hub/shared/:id/upgrade → 202 {shared_deploy_id}. A 409 PLAN_CHANGED, BLOCKED or
 * APP_BLOCKED carries the plan as it stands now (`plan` beside the code).
 */
export const startSharedUpgrade = (
  sharedId: number,
  body: {
    kind: SharedUpgradeKind
    version: string
    plan_hash: string
    confirm: string
    overrides: string[]
    /** Sent (true) only when the person confirmed an upgrade to an older version. */
    downgrade?: true
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

/** GET /api/hub/shared/:id/deploys → the runs, newest first (no plan, apps or log). */
export const fetchSharedDeploys = (sharedId: number) =>
  api
    .get<{ data: SharedDeploy[] }>(`/hub/shared/${sharedId}/deploys`)
    .then((r) => r.data.data ?? [])

/**
 * GET /api/hub/shared/:id/upgrade/versions → the Hub image's published versions (the registry).
 * The picker also takes a typed version; the plan refuses one the registry lacks (VERSION_UNKNOWN).
 */
export const fetchSharedVersions = (sharedId: number) =>
  api
    .get<{ data: SharedVersions }>(`/hub/shared/${sharedId}/upgrade/versions`)
    .then((r) => ({ versions: r.data.data?.versions ?? [], error: r.data.data?.error === true }))

// ─── Plan helpers ────────────────────────────────────────────────────────────────────────────

/** Per-app blockers a Hub admin may override (logged): ORDER (plan) and PREFLIGHT_FAILING (R17). */
export const OVERRIDABLE = new Set(['ORDER', 'PREFLIGHT_FAILING'])

/** Whether the plan lets a Hub admin override this per-app code (the plan's list wins). */
export const isOverridable = (plan: Pick<SharedUpgradePlan, 'overridable'>, code: string) =>
  (plan.overridable ?? [...OVERRIDABLE]).includes(code)

/** How an override names one app's blocker in the start body's `overrides`: `CODE:env_id`. */
export const overrideId = (app: { env_id: number }, code: string) => `${code}:${app.env_id}`

/** The blockers still open: plan-wide ones, and per-app ones not overridden. */
export function openBlockers(plan: SharedUpgradePlan, overrides: ReadonlySet<string>): number {
  let n = plan.blockers.length
  for (const a of plan.apps)
    for (const code of a.blockers)
      if (!(isOverridable(plan, code) && overrides.has(overrideId(a, code)))) n++
  return n
}

/** Refusals of a start that carry the plan as it stands now. */
const PLAN_CARRYING = new Set(['PLAN_CHANGED', 'BLOCKED', 'APP_BLOCKED', 'DOWNGRADE_NEEDS_CONFIRM'])

/** The plan a refused start carried (PLAN_CHANGED, BLOCKED, APP_BLOCKED) and its code. */
export function refusedPlanOf(err: unknown): { code: string; plan: SharedUpgradePlan } | null {
  const data = (err as { response?: { data?: { code?: unknown; plan?: unknown } } })?.response?.data
  if (typeof data?.code !== 'string' || !PLAN_CARRYING.has(data.code)) return null
  const plan = data.plan as SharedUpgradePlan | undefined
  return plan && Array.isArray(plan.apps) && typeof plan.plan_hash === 'string'
    ? { code: data.code, plan }
    : null
}

/**
 * A run's `error` without its leading code (`START_FAILED: The stack …` → `The stack …`): the
 * sentence is for people, the code is not.
 */
export const runErrorText = (error: string): string =>
  error.replace(/^[A-Z][A-Z0-9_]{2,63}:\s*/, '').trim()

/**
 * Numeric x.y.z order: 0.3.10 > 0.3.9. Missing or non-numeric parts count as 0. A twin of the
 * API's compareVersions (services/hub/promote-plan.ts).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const XYZ = /^\d+\.\d+\.\d+$/

/** Published versions, newest first (the registry's order is not promised). */
export const newestFirst = (versions: string[]): string[] =>
  [...versions].sort((a, b) => compareVersions(b, a))

/** An upgrade to a version older than the one running: a downgrade, never a default. */
export const isDowngrade = (
  kind: SharedUpgradeKind,
  version: string,
  current: string | null
): boolean =>
  kind === 'upgrade' &&
  !!current &&
  XYZ.test(version) &&
  XYZ.test(current) &&
  compareVersions(version, current) < 0

/**
 * The version an upgrade starts on: the newest published one when it is newer than what runs
 * (or nothing runs yet). Null when the deployment already runs the newest: nothing to plan.
 */
export function defaultUpgradeVersion(versions: string[], current: string | null): string | null {
  const newest = newestFirst(versions)[0]
  if (!newest) return null
  if (!current || !XYZ.test(current) || !XYZ.test(newest)) return newest === current ? null : newest
  return compareVersions(newest, current) > 0 ? newest : null
}

/** The run's step keys, in order (Task 5's run steps 1–5). */
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
  MOVE_OPEN: {
    title: 'A move into or out of this deployment is open',
    hint: 'Resume it or roll it back first (Move… on that environment), then plan again.'
  },
  EXTENSION_MISSING: {
    title: 'The app uses an extension this deployment does not load',
    hint: "Add it to the deployment's extensions (Edit), then plan again."
  },
  SHARED_NOT_HUB_DEPLOYED: {
    title: 'The Hub does not run this deployment',
    hint: 'It runs elsewhere; it is upgraded by whoever runs it. The Hub records the version it sees.'
  },
  BUSY: {
    title: 'Something else holds this deployment or one of its apps',
    hint: 'Wait for it to finish, then plan again.'
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
  HUB_URL_UNUSABLE: {
    title: "The Hub's own address is not one the deployment could start with",
    hint: 'Set HUB_URL on the Hub to its https address (no path), restart the Hub, then plan again. The deployment refuses to boot without an address it can reach.'
  },
  AGENT_TOO_OLD: {
    title: 'The Hub agent is too old for shared deployments',
    hint: 'Update the agent on the Docker host to 0.2.0 or later, then plan again.'
  },
  REDIS_URL_MISSING: {
    title: 'This deployment uses external Redis, but no Redis address is stored',
    hint: 'Edit the deployment and enter its Redis address, or set Redis to Bundled, then plan again.'
  },
  REDIS_NOT_AVAILABLE: {
    title: 'The Docker host cannot run the Redis this deployment needs',
    hint: 'Allow bundled Redis on the agent, or use external Redis, then plan again.'
  },
  SHARED_RETIRED: {
    title: 'This shared deployment is retired',
    hint: 'It can no longer be upgraded.'
  },
  BAD_VERSION: { title: 'That is not a version', hint: 'Pick a published version.' },
  NOT_DEPLOYED_BEFORE: {
    title: 'The Hub never deployed this version here',
    hint: 'A rollback redeploys a version this deployment ran before. Pick one from its history.'
  },
  NO_DRIVER: {
    title: 'The deployment has no Docker driver',
    hint: 'Its driver was removed. Add the deployment again on a Docker driver.'
  },
  NO_STACK_NAME: {
    title: 'The deployment has no stack name',
    hint: 'Add the deployment again with a stack name.'
  },
  IMAGE_NOT_ALLOWED: {
    title: 'The agent does not allow this image',
    hint: "Add the Hub image to the agent's image allow-list, then plan again."
  },
  EXTENSION_NOT_ALLOWED: {
    title: 'The agent does not allow one of the extensions',
    hint: "Add it to the agent's extension allow-list, or remove it from the deployment."
  },
  EXTENSION_UNPINNED: {
    title: 'An extension has no pinned image',
    hint: 'Give every extension its image pin (extension=repo@sha256:…): edit the deployment.'
  },
  PATTERN_NOT_ALLOWED: {
    title: 'The agent does not allow this host pattern',
    hint: "Use a pattern under the agent's host suffixes, or change them on the agent."
  },
  HOSTNAME_NOT_ALLOWED: {
    title: 'The agent does not allow one of the app names',
    hint: "Use names under the agent's host suffixes, or change them on the agent."
  },
  TOO_MANY_HOSTNAMES: {
    title: 'Too many app names outside the host pattern',
    hint: 'At most 10 names may sit outside the pattern. Widen the pattern so it covers them.'
  },
  NO_ROUTE: {
    title: 'Nothing would route to this deployment',
    hint: 'Give it a host pattern (edit the deployment), or place an app with a name on it.'
  },
  HOSTNAME_INVALID: {
    title: 'One of the app names is not a valid host name',
    hint: "Fix the environment's address on its app page."
  },
  PUBLISH_PORT_NOT_ALLOWED: {
    title: 'The agent does not allow publishing that port',
    hint: 'Remove the publish port from the deployment settings, or allow it on the agent.'
  },
  BLOCKED: {
    title: 'Something now holds the upgrade back',
    hint: 'The plan below is as it stands now. Clear what it names, then start again.'
  },
  APP_BLOCKED: {
    title: 'An app is held back',
    hint: 'The plan below is as it stands now. Clear what it names, or go ahead anyway where it offers.'
  },
  CONFIRM_MISMATCH: {
    title: "Type the deployment's key to confirm",
    hint: 'Nothing was started. Type the key exactly as shown, then start again.'
  },
  BAD_PLAN_HASH: {
    title: 'Check the plan before you start',
    hint: 'A start must carry the plan you checked. Read the plan again, then start.'
  },
  BAD_KIND: { title: 'Pick upgrade or roll back' },
  BAD_OVERRIDES: {
    title: 'An override is not one the plan offers',
    hint: 'Read the plan again and tick only what it offers.'
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
  },
  DOWNGRADE_NEEDS_CONFIRM: {
    title: 'This version is older than the one the deployment runs',
    hint: 'Tick that you mean to downgrade, or pick a newer version. To go back to a version it ran before, use Roll back.'
  }
}

/** A code this screen has no words for keeps the planner's sentence (or a plain one). */
export const upgradeCopy = (code: string, text?: string): { title: string; hint?: string } =>
  UPGRADE_COPY[code] ?? { title: text || 'Held back by a check the Hub made' }

/**
 * Warnings shown elsewhere: APPS_AFFECTED (the apps table lists them), DOWNGRADE (the downgrade
 * box says it, with the planner's sentence).
 */
export const SILENT_WARNINGS = new Set(['APPS_AFFECTED', 'DOWNGRADE'])

export const KIND_WORDS: Record<string, string> = {
  upgrade: 'Upgrade',
  rollback: 'Rollback',
  observed: 'Seen running'
}

// ─── Design review P6-29: words, not codes ──────────────────────────────────────────────────

const STATUS_LINE_WORDS: Record<string, string> = {
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

/**
 * One run log line for people: a stop line (`failed: CODE: sentence`) loses its code; a line
 * that starts with a step key (`render: …`) starts with the step's name instead. Anything else
 * (the run's own numbered lines) stays as written.
 */
export function logLineWords(line: string): string {
  const stop = /^(failed|cancelled|interrupted):\s*[A-Z][A-Z0-9_]{2,63}:\s*([\s\S]*)$/.exec(line)
  if (stop) return `${STATUS_LINE_WORDS[stop[1]]}: ${stop[2].trim()}`
  const step = /^([a-z_]+):\s*([\s\S]*)$/.exec(line)
  const label = step && UPGRADE_STEPS.find((s) => s.key === step[1])?.label
  return label ? `${label}: ${step[2].trim()}` : line
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'its', 'this'])
const words = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/\b(does|did|do)(n't| not)\b/g, ' not ')
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))

/**
 * The planner's sentence says nothing the title does not ("The Hub agent does not answer." under
 * "The Hub agent did not answer"): every word of it is in the title, tense aside.
 */
export function restatesTitle(title: string, text: string): boolean {
  const t = new Set(words(title))
  const d = words(text)
  return d.length > 0 && d.every((w) => t.has(w))
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A plan-wide BUSY (or LOCK_UNAVAILABLE) row names the environment it holds as `app/env`: that
 * app is not ready, even with no blocker of its own.
 */
export function heldByPlan(
  blockers: { code: string; text: string }[],
  app: { app: string; env: string }
): boolean {
  const name = new RegExp(`(^|[\\s(])${escapeRe(`${app.app}/${app.env}`)}($|[\\s:,.)—])`)
  return blockers.some(
    (b) => (b.code === 'BUSY' || b.code === 'LOCK_UNAVAILABLE') && name.test(b.text)
  )
}
