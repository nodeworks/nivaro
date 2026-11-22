import type { HubApp, HubEnvironment } from './apps.js'
import type { HubEnvState } from './status.js'

/**
 * Shared shapes of Hub promotions (phase 2): components (nivaro_hub_components), deploy rows
 * (nivaro_hub_deploys), and the pure planner's input and answer (promote-plan.ts). Types only —
 * importing this file runs nothing.
 */

/** One ordered piece of a placement, deployed through its own GitLab driver. */
export interface HubComponent {
  /** null on the implicit component of a phase-1 placement (no stored row). */
  id: number | null
  placement_id: number
  position: number
  name: string
  kind: 'api' | 'frontend'
  driver_id: number
  source_branch: string
  /** null = the driver config's branch. */
  target_branch: string | null
  before_job: string | null
  /** null = the driver config's deploy_job. */
  deploy_job: string | null
  verify_url: string | null
  verify_field: string
  /** A phase-1 placement with no component rows behaves as one api component on its driver. */
  implicit?: boolean
}

/** An environment row with the phase-2 flag (migration 543). */
export type HubEnvironmentRow = HubEnvironment & { hub_managed: boolean }

export type HubDeployKind = 'promote' | 'rollback'
export type HubDeployStatus =
  | 'planned'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** A nivaro_hub_deploys row. */
export interface HubDeployRow {
  id: number
  app_id: number
  environment_id: number
  kind: HubDeployKind
  version: string
  from_version: string | null
  status: HubDeployStatus
  /** The last step started. */
  step: string | null
  error: string | null
  /** JSON of the PromotionPlan at start. */
  plan: string | null
  job_run_id: number | null
  started_by: string | null
  started_at: string | Date
  finished_at: string | Date | null
}

/** The driver config fields the planner resolves a component's branch, job and pin file from. */
export interface PlanDriver {
  branch: string
  deploy_job: string
  pin_file: string
  /** Which repository it deploys (GitLab base + project path): part of the plan hash. */
  identity?: string
}

/** Everything the planner needs, gathered beforehand (promote-gather.ts) so planning stays pure. */
export interface PlanInput {
  app: HubApp
  target: HubEnvironmentRow
  previous: HubEnvironmentRow | null
  components: HubComponent[]
  kind: HubDeployKind
  version: string
  /** From the status readers. */
  targetVersion: string | null
  previousVersion: string | null
  /** Previous environment: versions it deployed successfully. */
  previousDeployedVersions: string[]
  /**
   * Target environment: versions the Hub deployed here successfully with every component's
   * deployed commit recorded (rollback). Never versions from before the Hub.
   */
  targetDeployedVersions: string[]
  /**
   * The subset of targetDeployedVersions a rollback can redeploy: every component's build
   * (its deploy pipeline) is recorded. What /promotable offers for rollback.
   */
  rollbackVersions?: string[]
  /** Per component position (api): the newest source-branch commit naming `nivaro <version>`. */
  sources: Record<number, { sha: string; subject: string } | null>
  /** Per component position (frontend): short sha the previous environment serves. */
  frontendServed: Record<number, string | null>
  /** Per component position (frontend): the served commit is on the component's source_branch. Missing = not known = refused. */
  frontendOnSource: Record<number, boolean>
  /** Per component position (api): the source commit is already on the target branch. false = a re-stamp of the same version (allowed). */
  sourceOnTarget: Record<number, boolean>
  digest: string | 'present' | null
  slimDigest: string | 'present' | null
  /** A promotion of this environment is running now. */
  running: boolean
  /** The promotion lock could not be read (Redis unreachable): a plan line, never a blocker. */
  lockUnknown?: boolean
  /** Current status of the target. */
  targetState: HubEnvState | null
  /**
   * Per component position: the commits this environment's Hub runs recorded as deployed with
   * this version (step `deployedSha`, any run status). Missing = nothing recorded.
   */
  recordedDeploys?: Record<number, string[]>
  /**
   * Per component position (api, promote): the pin file's text on the target branch now (read
   * when the release commit is held or the target already answers the version).
   */
  pinOnTarget?: Record<number, string | null>
  /** Per component position (frontend, promote): the commit the TARGET serves now (short sha). */
  frontendOnTarget?: Record<number, string | null>
  /** Per component position (frontend, promote): the target branch already holds the commit. */
  frontendHeld?: Record<number, boolean>
  /** Per component position (frontend, promote, held): the target branch head at plan time. */
  frontendHead?: Record<number, string | null>
  /**
   * Per component position (rollback, every kind): the build the Hub recorded for this version
   * here — the commit its deploy job ran on, its pipeline — and why it cannot be rerun (null =
   * it can). A rollback redeploys exactly that build; it never commits a pin or merges.
   */
  rollbackBuild?: Record<
    number,
    { sha: string | null; pipelineId: number | null; problem: string | null }
  >
  /** Driver id → its config. */
  drivers: Record<number, PlanDriver>
}

export type PromotionBlockerCode =
  | 'NOT_HUB_MANAGED'
  | 'PROMOTION_RUNNING'
  | 'NO_PREVIOUS_ENVIRONMENT'
  | 'PREVIOUS_NEVER_RAN'
  | 'ALREADY_RUNS'
  | 'OLDER_THAN_CURRENT'
  | 'NOT_DEPLOYED_BEFORE'
  | 'NO_SOURCE_COMMIT'
  | 'FRONTEND_UNKNOWN'
  | 'FRONTEND_NOT_ON_SOURCE'
  | 'FRONTEND_ROLLBACK_NO_BUILD'
  | 'ROLLBACK_NO_BUILD'
  | 'ROLLBACK_NOT_RECORDED'
  | 'PIN_CHANGED'
  | 'HEAD_UNKNOWN'
  | 'IMAGE_MISSING'
  | 'IMAGE_NO_DIGEST'
  | 'NO_COMPONENTS'
  | 'BAD_VERSION'
  | 'NO_DRIVER'

export interface PromotionBlocker {
  code: PromotionBlockerCode
  text: string
}

export interface PromotionStep {
  position: number
  component: string
  kind: 'api' | 'frontend'
  driverId: number
  sourceSha: string | null
  targetBranch: string
  /** api promote only: the pin file's content and path on the target branch (null on rollback). */
  pinText: string | null
  pinFile: string | null
  beforeJob: string | null
  deployJob: string
  verifyUrl: string | null
  verifyField: string
  /** What verifyUrl's field must answer: the version (api) or the short sha (frontend). */
  want: string
  /**
   * api, promote: the target branch already holds the release commit and pins this version, and
   * the environment answers it — nothing is merged, committed or deployed (a promotion stopped
   * after this component and started again).
   */
  noop?: boolean
  /**
   * frontend, promote, target already holds the commit: the branch head the plan saw. The run
   * deploys the head and refuses (changing nothing) when the head moved since the plan.
   */
  expectHead?: string | null
  /**
   * api, promote of the version the target already runs: the pin file must already be there —
   * the run never creates a pin for the running version (PIN_CHANGED).
   */
  pinMustExist?: boolean
  /** frontend, rollback: the pipeline whose deploy job is rerun (the earlier build). */
  buildPipelineId?: number | null
  /** Written by the runner once the deploy passed: the commit the deploy job ran on. */
  deployedSha?: string | null
  /** Written by the runner once the deploy passed: the pipeline of that deploy job. */
  deployedPipelineId?: number | null
}

export interface PromotionPlan {
  ok: boolean
  blockers: PromotionBlocker[]
  lines: string[]
  steps: PromotionStep[]
  /** sha256 of what the plan would do (planHash): a start must send the one it previewed. */
  plan_hash: string
}
