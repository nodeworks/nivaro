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
  /** Target environment: versions it deployed successfully (rollback). */
  targetDeployedVersions: string[]
  /** Per component position (api): the newest source-branch commit naming `nivaro <version>`. */
  sources: Record<number, { sha: string; subject: string } | null>
  /** Per component position (frontend): short sha the previous environment serves. */
  frontendServed: Record<number, string | null>
  digest: string | 'present' | null
  slimDigest: string | 'present' | null
  /** A promotion of this environment is running now. */
  running: boolean
  /** Current status of the target. */
  targetState: HubEnvState | null
  /** Driver id → its config. */
  drivers: Record<number, PlanDriver>
}

export interface PromotionBlocker {
  code: string
  text: string
}

export interface PromotionStep {
  position: number
  component: string
  kind: 'api' | 'frontend'
  driverId: number
  sourceSha: string | null
  targetBranch: string
  /** api only: the pin file's content and path on the target branch. */
  pinText: string | null
  pinFile: string | null
  beforeJob: string | null
  deployJob: string
  verifyUrl: string | null
  verifyField: string
  /** What verifyUrl's field must answer: the version (api) or the short sha (frontend). */
  want: string
}

export interface PromotionPlan {
  ok: boolean
  blockers: PromotionBlocker[]
  lines: string[]
  steps: PromotionStep[]
}
