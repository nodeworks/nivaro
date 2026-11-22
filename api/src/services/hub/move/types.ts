import type { SharedReadinessCode, SharedReadinessItem } from '../../hub-link/shared-readiness.js'
import type { StackEdge } from '../docker/render-spec.js'
import type { HubPlacementRow } from '../drivers.js'
import type { HubComponent } from '../promote-types.js'
import type { SharedDeployment } from '../shared/store.js'

/**
 * Nivaro Hub phase 6 (Task 15): the shapes of a move — an environment going from a dedicated
 * placement to a shared deployment (`to_shared`), back (`to_dedicated`), or from one shared
 * deployment to another (`between_shared`). The plan is pure (plan.ts); gather.ts reads every fact
 * it needs; the run (Task 16) consumes the plan.
 *
 * Nothing here ever holds a token, a ticket, an encryption key or a database connection: the
 * facts are versions, fingerprints, identities (hashed where they name a server), counts and
 * codes.
 */

export type MoveKind = 'to_shared' | 'to_dedicated' | 'between_shared'

export type MoveStepKey =
  | 'check'
  | 'files_warm'
  | 'maintenance_on'
  | 'wait_idle'
  | 'files_delta'
  | 'deploy_target'
  | 'place_on_target'
  | 'target_ready'
  | 'files_full'
  | 'route'
  | 'verify'
  | 'release'
  | 'retire_source'
  | 'done'

/**
 * One side of a move.
 * - `shared`: a shared deployment. `edge` is its Docker agent's edge when the deployment is
 *   `docker` and the agent answered; absent/null otherwise (registered, or the agent is down).
 * - `docker`: a dedicated placement on a Docker driver. `edge` is null when the agent could not
 *   be read (routing is then manual: the Hub cannot tell how the stack is reached).
 * - `gitlab`: a dedicated placement on a GitLab driver, with its components.
 */
export type PlacementSide =
  | { kind: 'shared'; shared: SharedDeployment; edge?: StackEdge | null }
  | {
      kind: 'docker'
      placement: HubPlacementRow
      driverId: number
      stack: string
      edge: StackEdge | null
    }
  | { kind: 'gitlab'; placement: HubPlacementRow; components: HubComponent[] }

/**
 * One route change. `drop_host`: the side's stack stops routing `host`. `add_host`: a shared
 * deployment's stack starts routing `host` by name (a name under its pattern needs none).
 * `apply_stack`: a dedicated Docker stack is applied with its names (it claims them).
 * `remove_stack`: not emitted by routeActions (the source stack is removed by `retire_source`).
 */
export type RouteAction = {
  side: 'source' | 'target'
  op: 'drop_host' | 'add_host' | 'remove_stack' | 'apply_stack'
  host?: string
}

/**
 * Why a move cannot start. Beside the plan's list (rulings): DATABASE_DIFFERS (R2, the target
 * reaches another database than the source serves), DB_IDENTITY_SHARED (T9 carry: another app on
 * the target reports the same database identity, so "same database" cannot be proven),
 * POOL_TOO_SMALL (T8 carry), REDIS_SHARED (T9 carry: source and target would share one Redis db
 * and prefix while holding the same hub token), TARGET_IN_USE (a dedicated target placement
 * another environment uses). SQLITE_NOT_SHARED is gone (M5): the readiness code SQLITE says it.
 */
export type MoveBlockerCode =
  | 'SAME_PLACEMENT'
  | 'NOT_HUB_LINKED'
  | 'LINK_UNREACHABLE'
  | 'VERSION_DIFFERS'
  | 'EXTENSION_NOT_ALLOWED'
  | 'EXTENSION_VERSION_DIFFERS'
  | 'NO_DATABASE_RECORD'
  | 'APP_KEY_UNKNOWN'
  | 'APP_KEY_MISMATCH'
  | 'SIGNIN_VIA_HUB'
  | 'ISSUER_DIFFERS'
  | 'POOL_BUDGET'
  | 'POOL_TOO_SMALL'
  | 'BUSY'
  | 'SHARED_BUSY'
  | 'SHARED_NOT_ACTIVE'
  | 'TARGET_UNREACHABLE'
  | 'TARGET_IN_USE'
  | 'DB_UNREACHABLE_FROM_TARGET'
  | 'DATABASE_DIFFERS'
  | 'DB_IDENTITY_SHARED'
  | 'REDIS_SHARED'
  | 'HOSTNAME_TAKEN'
  | 'DRIVER_UNSUPPORTED'
  // Fix round 1 (P6-15: a check that could not run is never a pass).
  | 'GATHER_FAILED'
  | SharedReadinessCode

/** What a move will cost or change. SIGNED_LINKS_RESET is the T12 carry. */
export type MoveWarningCode =
  | 'SIGN_IN_AGAIN'
  | 'SAME_APP_ON_DEPLOYMENT'
  | 'MULTI_NODE_VOLUMES'
  | 'MANUAL_ROUTE'
  | 'REPLAYS_NOT_MOVED'
  | 'OLD_STACK_STOP'
  | 'SIGNED_LINKS_RESET'
  // Fix round 1 (P6-15).
  | 'DB_IDENTITY_UNCHECKED'
  | 'REDIS_UNVERIFIED'
  | 'STORAGE_UNVERIFIED'
  | 'ISSUER_UNVERIFIED'
  | SharedReadinessCode

export interface MovePlan {
  kind: MoveKind
  routing: 'automatic' | 'manual'
  steps: MoveStepKey[]
  route: RouteAction[]
  manual_request: string | null
  version: string
  hostnames: string[]
  /**
   * count = objects on the env-driven local provider (what a move copies); bytes = every file's
   * size. `first_pull: 'full'` (T10 carry): the first copy of a run is always a full pull — a
   * manifest left from an earlier move would make a delta skip rows. Later copies are deltas.
   */
  files: { count: number; bytes: number; first_pull: 'full' }
  blockers: { code: MoveBlockerCode; text: string }[]
  warnings: { code: MoveWarningCode; text: string }[]
  checklist: { id: string; text: string; required: boolean }[]
  plan_hash: string
}

export type MoveTarget =
  | { kind: 'shared'; shared_id: number; pool_max?: number }
  | { kind: 'dedicated'; placement_id: number }

/** The source as read live: over its hub link (dedicated) or its deployment link (shared). */
export interface MoveSourceFacts {
  /** It answered. */
  reachable: boolean
  /** A code when it did not (HUB_LINK_MISSING, UNREACHABLE, LINK_REFUSED …). */
  error: string | null
  version: string | null
  /** keyFingerprint of the key the source runs with; null = it reports none. */
  key_fp: string | null
  oidc: { issuer_host: string; tenant: string | null } | null
  /** The issuer could not be read (a shared source's status failed): unknown, not "none". */
  oidc_unread?: boolean
  signin_hub: boolean
  /** `engine|server|port|database` as the source reaches its database; null = unknown. */
  db_identity: string | null
  files: { count: number; bytes: number; local: number } | null
  /** Extension id → the version the source runs. */
  extensions: Record<string, string>
  /** Dedicated source only: what shared would lose (Task 9). */
  readiness: SharedReadinessItem[]
  /** STORAGE_PROVIDER of the source's own config when the Hub can see it; null = unknown. */
  storage_provider: string | null
  /** A hash naming the Redis db + prefix the source uses; null = the Hub cannot see it. */
  redis: string | null
}

/** The target as read live, plus what the Hub knows of it. */
export interface MoveTargetFacts {
  reachable: boolean
  error: string | null
  /** A shared target: the version it runs (live, else its pin). Null for a dedicated target. */
  version: string | null
  oidc: { issuer_host: string; tenant: string | null } | null
  /** A shared target: the extensions it loads (its allow-list) and their pins. */
  extensions: string[]
  extension_pins: Record<string, string>
  /** A shared target's check of the app's database; null = not checked. */
  db: { reachable: boolean; identity: string | null; error: string | null } | null
  /** Other apps on the target whose database reports the same identity ("app/env"). */
  identity_shared_with: string[]
  pool: { used: number; budget: number; asked: number } | null
  /** Other environments of this app already on the target (env keys). */
  siblings: string[]
  storage_provider: string | null
  redis: string | null
  /** Swarm nodes when the target's volumes are local on a swarm of more than one node. */
  multi_node: number | null
  /** A Docker dedicated target: the ENCRYPTION_KEY fingerprint its stack settings hold. */
  stack_key_fp: string | null
  /** A dedicated target placement another environment uses ("app/env"); null when free. */
  in_use_by: string | null
  /**
   * Other apps on a shared target whose database could not be compared (past the cap of 25,
   * a check that failed or could not be opened, or past the pass's 30 s budget).
   */
  identity_unchecked: number
}

export interface MovePlanInput {
  kind: MoveKind
  app: { id: number; key: string; signin_mode: 'direct' | 'hub'; extensions: string[] }
  env: { id: number; key: string; hub_linked: boolean; version_pin: string | null }
  from: PlacementSide
  to: PlacementSide
  target: MoveTarget
  /** Every name the environment claims (environmentNames). */
  names: string[]
  /** Those of them another Hub environment claims too. */
  names_taken: string[]
  /** The Hub database record the environment's db_ref names. */
  database: { id: number; ready: boolean } | null
  /** `unreadable`: an entry is stored but the Hub cannot open it (M-9). */
  app_key: { known: boolean; fp: string | null; unreadable?: boolean }
  locks: {
    /** Who holds the environment's lock: a holder, 'held' (cannot tell who), 'unreadable'
     *  (Redis did not answer: never read as free), or null. Same for each shared `holder`. */
    env: string | null
    /** A move of this environment is still open (running, waiting or interrupted). */
    open_move: boolean
    shared: Array<{ id: number; key: string; holder: string | null; upgrading: boolean }>
  }
  source: MoveSourceFacts
  target_facts: MoveTargetFacts
  /** Why the dedicated side cannot be driven (no driver, no stack name, no template …). */
  driver_problem: string | null
  /** Parts of the gather that could not be read (GATHER_FAILED), in words. */
  gather_failed: string[]
}

/** A refusal before any plan can be made: `{statusCode, code, message}`, plain words. */
export class MoveError extends Error {
  code: string
  statusCode: number
  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.name = 'MoveError'
    this.code = code
    this.statusCode = statusCode
  }
}
