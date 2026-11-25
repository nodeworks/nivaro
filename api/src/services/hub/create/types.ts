// Shapes of an app creation (phase 3): what the Create app panel sends, the facts the Hub
// gathers about it (gather.ts), the preview the planner builds from both (plan.ts) and the
// per-environment step list the creation runner walks (Task 9). Types only, plus STEP_ORDER.
//
// Nothing here holds a secret except CreateAppInput.signin.client_secret, which the planner
// never copies into the plan: a CreationPlan carries names only (no passwords, tokens or CI
// variable values) and may be answered as it is.
import type { ChecklistItem } from '../db/checklist.js'
import type { HubDbEngine } from '../db/connection.js'
import type { HubDatabase } from '../db/databases.js'
import type { HubDbServerRow } from '../db/servers.js'
import type { AgentHealth } from '../docker/agent-types.js'
import type { StackSettingsInput } from '../docker/stack-settings.js'
import type { DockerDriverRow } from '../drivers.js'
import type { SharedDeployment } from '../shared/store.js'
import type { HubTargetRow } from './targets.js'

/**
 * Where a created app goes (gap `create`, 0.3.215): a GitLab target (the deploy repository and its
 * pipeline, phase 3), a Docker driver (the Hub agent deploys the stack itself, phase 4's stack
 * path) or a shared deployment (the app is placed on it, phase 6's place-shared).
 */
export type CreationKind = 'gitlab' | 'docker' | 'shared'

/** A Docker creation's stack settings, the same for every environment (publish port aside). */
export interface DockerStackInput {
  size?: string
  redis?: string
  /** Plain settings (KEY: value). The creation sets OIDC_* and the database itself. */
  settings?: Record<string, string>
  /** Secrets (KEY: value); a preview sends the mask. SESSION_SECRET / ENCRYPTION_KEY: generated. */
  secrets?: Record<string, string>
  /** Extension id → <repo>@sha256:<64 hex>: the images must be in the agent's allow-list. */
  extension_pins?: Record<string, string>
}

export type CreateTargetInput =
  | { kind: 'gitlab'; id: number }
  | { kind: 'docker'; driver_id: number; stack?: DockerStackInput }
  | { kind: 'shared'; shared_id: number; pool_max?: number }

export interface CreateAppInput {
  key: string
  name: string
  owners: string[]
  first_admin: { email: string; first_name?: string; last_name?: string }
  /** A GitLab target (the phase-3 form); `target` names any kind and wins. */
  target_id?: number
  target?: CreateTargetInput
  /** Shared: the deployment's version (blank = it); GitLab / Docker: the release installed. */
  version: string
  /** Shared: extension ids the deployment loads. GitLab / Docker: none (Docker pins them). */
  extensions?: string[]
  /** Hub enhancement 24: a template from the library to install after the first admin. */
  template_id?: number | null
  /** Shared: optional (an app on a shared deployment signs in with the deployment's OIDC). */
  signin?: { issuer: string; client_id: string; client_secret: string }
  environments: Array<{
    key: string
    hostname?: string | null
    /** Docker, published-port edge: the port this environment's stack is published on. */
    publish_port?: number | null
    database:
      | { server_id: number; database_name?: string; login_name?: string }
      | { database_id: number }
  }>
}

export interface CreationFacts {
  /** An app with this key exists already. */
  keyTaken: boolean
  /** Owner ids that name no person (malformed ids included). */
  unknownOwners: string[]
  target: HubTargetRow | null
  servers: Record<number, HubDbServerRow>
  /** Database rows named by `{ database_id }` (masked answers). */
  existing: Record<number, HubDatabase>
  /** Every database the Hub records: host + name. */
  recordedNames: Array<{ host: string; database_name: string }>
  /**
   * Every hostname and base_url host of every existing environment, plus the Hub's own
   * hostnames (hubOwnHostnames). Lower case.
   */
  takenHostnames: string[]
  /** stackName() of every existing environment whose keys are creatable keys. */
  takenStackNames: string[]
  /** `${server_id}:${database}` → databaseExists on an automatic server ('unreachable' on failure). */
  serverHas: Record<string, boolean | 'unreachable'>
  projectExists: boolean | 'unreachable'
  digest: string | 'present' | null
  slimDigest: string | 'present' | null
  /** ENCRYPTION_KEY is usable (the creation seals tokens, the OIDC secret and connections). */
  encryptionKey: boolean
  /** The origin apps are told as HUB_URL: deployment-mode.ts hubPublicOrigin() (ruling X-5). */
  hubUrl: string | null
  /** Where the input sends the app (creationKindOf; the planner reads the input itself). */
  kind?: CreationKind
  docker?: DockerCreationFacts
  shared?: SharedCreationFacts
}

/** What the Hub agent and the Hub say about a Docker creation (gather.ts, bounded looks). */
export interface DockerCreationFacts {
  driver: DockerDriverRow | null
  /** GET /v1/health; null when the agent did not answer (agentState says how). */
  health: AgentHealth | null
  agentState: 'ok' | 'unreachable' | 'refused' | 'incompatible' | 'not_asked'
  /** The repository the stack runs (hubImage()). */
  imageRepo: string
  /** Planned stack name → what the agent holds under it ('none' = free). */
  stacks: Record<string, 'none' | 'hub' | 'other' | 'unknown'>
  /** Stack names other placements of this driver deploy. */
  placementStacks: string[]
  /** Publish ports the stack settings of this driver's other environments hold (review L3). */
  takenPorts?: number[]
  /** The stack settings, checked like a Stack panel save (values sealed; never answered). */
  settings: { ok: true; row: StackSettingsInput } | { ok: false; code: string; message: string }
  /** Secret keys the input carries a value for (a preview's masks count). */
  secretKeys: string[]
}

export interface SharedCreationFacts {
  deployment: SharedDeployment | null
  /** Σ pool_max the deployment's placements in use take. */
  poolUsed: number
  /** Explicit names the deployment's newest successful run routed (beside its pattern). */
  routed: string[]
}

export interface CreationBlocker {
  code: string
  text: string
  env?: string
}

export interface CreationPlanDatabase {
  mode: 'automatic' | 'manual' | 'existing'
  server_name: string | null
  database_name: string
  login_name: string | null
  engine: HubDbEngine
  checklist: ChecklistItem[] | null
  /** An existing database whose last check found a Nivaro install (its ledger). */
  holds_nivaro?: { migrations: number | null; last_migration: string | null }
}

export interface CreationPlanEnvironment {
  key: string
  position: number
  hostname: string | null
  base_url: string | null
  dns_mode: 'automatic' | 'manual'
  ticket: string | null
  redirect_uri: string | null
  branch: string
  source_branch: string
  /** The swarm stack (`<app>--<env>`, hashed past 40 characters); null when the keys are bad. */
  stack_name: string | null
  /** Docker: the stack's size and Redis mode, and its published port on a publish edge. */
  stack?: { size: string; redis: string; publish_port: number | null }
  /** Shared: the database connections this environment may hold on the deployment. */
  pool_max?: number
  database: CreationPlanDatabase
}

export interface CreationPlan {
  ok: boolean
  blockers: CreationBlocker[]
  lines: string[]
  /**
   * Things to know that do not stop the creation (ruling P3-32): an existing database that
   * already holds a Nivaro install.
   */
  warnings: string[]
  app: { key: string; name: string; project_path: string }
  /** Where the app goes, by name (gap `create`). */
  target: { kind: CreationKind; name: string | null }
  environments: CreationPlanEnvironment[]
}

export type CreationStepKey =
  | 'database'
  | 'repository'
  | 'variables'
  | 'config'
  | 'deploy'
  | 'name'
  | 'link'
  | 'admin'
  | 'template'
  | 'stack'
  | 'place'

export const STEP_ORDER: readonly CreationStepKey[] = Object.freeze([
  'database',
  'repository',
  'variables',
  'config',
  'deploy',
  'name',
  'link',
  'admin',
  // Hub enhancement 24: the picked App Blueprint template (create/template-step.ts)
  'template'
])

/** A Docker creation: the stack (placement, component, settings), then phase 4's agent deploy. */
export const DOCKER_STEP_ORDER: readonly CreationStepKey[] = Object.freeze([
  'database',
  'stack',
  'deploy',
  'name',
  'link',
  'admin',
  // Hub enhancement 24: the picked template, after the first administrator (template-step.ts)
  'template'
])

/** A shared creation: the database, then place-shared (list, schema, first administrator). */
export const SHARED_STEP_ORDER: readonly CreationStepKey[] = Object.freeze(['database', 'place'])

/** The steps of a creation of this kind, in order. */
export function stepOrderFor(kind: CreationKind | undefined): readonly CreationStepKey[] {
  return kind === 'docker' ? DOCKER_STEP_ORDER : kind === 'shared' ? SHARED_STEP_ORDER : STEP_ORDER
}

/** The kind a request asks for: `target.kind`, else GitLab (the phase-3 `target_id`). */
export function creationKindOf(input: unknown): CreationKind {
  const t = (input as { target?: { kind?: unknown } } | null)?.target
  const k = t && typeof t === 'object' ? t.kind : undefined
  return k === 'docker' || k === 'shared' ? k : 'gitlab'
}

/** The GitLab target id a request names (`target.id`, else `target_id`). */
export function gitlabTargetIdOf(input: unknown): number {
  const i = (input ?? {}) as { target?: { kind?: unknown; id?: unknown }; target_id?: unknown }
  if (i.target && typeof i.target === 'object' && i.target.kind === 'gitlab')
    return Number(i.target.id)
  return Number(i.target_id)
}

export interface CreationStepState {
  key: CreationStepKey
  status: 'pending' | 'running' | 'done' | 'waiting' | 'failed'
  at: string | null
  note: string | null
  sha?: string
}
