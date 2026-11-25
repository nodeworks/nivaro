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
import type { HubTargetRow } from './targets.js'

export interface CreateAppInput {
  key: string
  name: string
  owners: string[]
  first_admin: { email: string; first_name?: string; last_name?: string }
  target_id: number
  version: string
  extensions?: string[]
  /** Hub enhancement 24: a template from the library to install after the first admin. */
  template_id?: number | null
  signin: { issuer: string; client_id: string; client_secret: string }
  environments: Array<{
    key: string
    hostname?: string | null
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

export interface CreationStepState {
  key: CreationStepKey
  status: 'pending' | 'running' | 'done' | 'waiting' | 'failed'
  at: string | null
  note: string | null
  sha?: string
}
