import type { HubApp, HubEnvironment } from './apps.js'
import type { StackRole } from './docker/agent-types.js'
import type { StackSize } from './docker/templates.js'
import type { HubEnvState } from './status.js'

/**
 * Shared shapes of Hub promotions (phase 2): components (nivaro_hub_components), deploy rows
 * (nivaro_hub_deploys), and the pure planner's input and answer (promote-plan.ts). Types only —
 * importing this file runs nothing.
 */

/** One ordered piece of a placement, deployed through its own driver (GitLab, or Docker for a stack). */
export interface HubComponent {
  /** null on the implicit component of a phase-1 placement (no stored row). */
  id: number | null
  placement_id: number
  position: number
  name: string
  /** stack (phase 4): the one component of a Docker placement, deployed through the Hub agent. */
  kind: 'api' | 'frontend' | 'stack'
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
  /** phase 4: absent = gitlab (phase-2 inputs carry none). A docker driver has '' branch/job/pin. */
  kind?: 'gitlab' | 'docker'
  branch: string
  deploy_job: string
  pin_file: string
  /** docker only: manual = a new name may not serve yet when the deploy ends. */
  dns_mode?: 'automatic' | 'manual'
}

/**
 * phase 4: what gather learned about one stack component (Docker placement) before planning —
 * the agent's health, the stack's settings (names only, never a value) and the swarm stack.
 */
export interface StackFacts {
  /** The placement's target.stack; null = none set (NO_STACK_NAME). */
  stackName: string | null
  agent: 'ok' | 'unreachable' | 'refused' | 'incompatible'
  /** hubImage() is in the agent's allow-list (GET /v1/health `images`). */
  imageAllowed: boolean
  /** The Nivaro image repository (hubImage()); the step pins it by digest. */
  imageRepo: string
  /** Extension ids whose repository is not in the agent's allow-list. */
  disallowedExtensions: string[]
  /** missingSettings(); ['(no settings)'] when the environment has no settings row. */
  settingsMissing: string[]
  /** Routing problems: the driver's wildcard rule, the agent's host_suffixes (traefik edge). */
  hostnameProblems: string[]
  /** Names another Hub environment already claims (hostnameRefusals HOSTNAME_TAKEN). */
  hostnameTaken: string[]
  /** The agent's edge mode; null when the agent did not answer. */
  edge: 'traefik' | 'publish' | null
  /** publish edge: the settings' publish_port is missing or outside the agent's range. */
  publishPortProblem: string | null
  /** A dry render (masked values) refused: TEMPLATE_NONE or a StackRenderError. */
  renderProblem: { code: string; text: string } | null
  stackState: 'none' | 'hub' | 'not_hub' | 'other_owner' | 'unknown'
  size: StackSize | null
  /** The roles the template runs at `size` for this version (null = no template / no size). */
  roles: StackRole[] | null
  /** The extension set this deploy installs (Decision 10): id → <repo>@sha256:<64 hex>. */
  extensions: Record<string, string>
  /** Why the stored pins this deploy must install cannot be read (fails closed); null = read. */
  extensionsUnreadable: string | null
  /** app.extensions with no pin in `extensions`. */
  missingExtensions: string[]
  agentOrigin: string | null
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
  /** Driver id → its config. */
  drivers: Record<number, PlanDriver>
  /** phase 4: per component position (stack) — what gather learned (stack-gather.ts). */
  stacks?: Record<number, StackFacts>
  /** phase 4: published x.y.z tags of the Nivaro image, newest first (first all-stack environment). */
  registryVersions?: string[]
  /** phase 4: why the published releases could not be read (registryVersions is then []). */
  registryError?: string
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
  | 'IMAGE_MISSING'
  | 'IMAGE_NO_DIGEST'
  | 'NO_COMPONENTS'
  | 'BAD_VERSION'
  | 'NO_DRIVER'
  // phase 4 (stack components)
  | 'AGENT_UNREACHABLE'
  | 'AGENT_REFUSED'
  | 'AGENT_INCOMPATIBLE'
  | 'IMAGE_NOT_ALLOWED'
  | 'EXTENSION_NOT_ALLOWED'
  | 'EXTENSION_UNPINNED'
  | 'STACK_SETTINGS_MISSING'
  | 'STACK_SETTINGS_INVALID'
  | 'HOSTNAME_NOT_ALLOWED'
  | 'HOSTNAME_TAKEN'
  | 'PUBLISH_PORT_NOT_ALLOWED'
  | 'TEMPLATE_NONE'
  | 'STACK_NOT_HUB'
  | 'NO_STACK_NAME'
  | 'KIND_DRIVER_MISMATCH'

export interface PromotionBlocker {
  code: PromotionBlockerCode
  text: string
}

export interface PromotionStep {
  position: number
  component: string
  kind: 'api' | 'frontend' | 'stack'
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
  /** phase 4: the executor — absent = gitlab (push + deploy job), docker = the Hub agent. */
  driver?: 'gitlab' | 'docker'
  /** phase 4, docker steps: what the runner renders and applies. Never a setting or a secret. */
  stack?: {
    name: string
    /** <repo>@sha256:<64 hex> */
    image: string
    size: StackSize
    /** id → <repo>@sha256:<64 hex> */
    extensions: Record<string, string>
    agentOrigin: string
  }
}

export interface PromotionPlan {
  ok: boolean
  blockers: PromotionBlocker[]
  lines: string[]
  steps: PromotionStep[]
}
