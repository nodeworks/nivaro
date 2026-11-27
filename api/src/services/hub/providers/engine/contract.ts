import type {
  Observed,
  OpError,
  OpResult,
  PlannedOp,
  ResourceScope,
  SnapshotRef
} from '../types.js'

/**
 * The change engine's public surface: the types the REST API (Task 2) and the UI (Task 3) speak,
 * and the functions Task 1 implements (bodies here throw until then). Every gate refusal is a
 * `ResourceChangeError` with a code from RESOURCE_CHANGE_CODES and its HTTP status.
 */

// ── Who is asking ──

export interface HubActor {
  /** nivaro_users id. */
  id: string
  isAdmin: boolean
  /** How the request came: own session, API key, MCP tool call, or View-as / run-as. */
  via: 'session' | 'key' | 'mcp' | 'view_as'
}

// ── Plan input ──

export type PlanAction = 'create' | 'update' | 'delete' | 'adopt' | 'reapply' | 'accept'

export interface PlanRequestOp {
  /**
   * create  — a new resource of `type` with `fields`.
   * update  — `resourceId` to `fields` (merged over its stored desired fields).
   * delete  — `resourceId`.
   * adopt   — bind `externalId` of `type` to the scope, no provider write.
   * reapply — plan `resourceId` back to its desired state (after drift).
   * accept  — desired := observed for `resourceId` (after drift), no provider write.
   */
  action: PlanAction
  resourceId?: number
  type?: string
  /** By FieldSpec key; `ref` fields as RefValue; `secret` fields as the plain new value or HUB_MASK (keep). */
  fields?: Record<string, unknown>
  externalId?: string
}

export interface PlanRequest {
  connectionId: number
  scope: ResourceScope
  /** Required for scope 'app'; ignored for 'shared'. */
  appId?: number
  environmentId?: number
  ops: PlanRequestOp[]
}

// ── Plan output ──

export type ChangeStatus =
  | 'planned'
  | 'pending_approval'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'declined'
  /** A planned / pending change whose plan no longer matches (re-plan). */
  | 'stale'

export interface ChangeGate {
  /** A RESOURCE_CHANGE_CODES code (e.g. 'FROZEN') or a passed check's name. */
  code: string
  passed: boolean
  message: string
}

export interface ChangeBlocker {
  code: string
  message: string
}

export interface ChangePlan {
  changeId: number
  planHash: string
  status: ChangeStatus
  /** In apply order (parents first for creates, children first for deletes); risk filled in. */
  ops: PlannedOp[]
  gates: ChangeGate[]
  /** The exact text the person must type to start (resource name, app key), or null. */
  needsConfirm: string | null
  /** True when an owner's change carries `cost`: start saves it as pending_approval. */
  needsApproval: boolean
  /** Anything that stops the start outright (SHARED_IN_USE, BUCKET_NOT_EMPTY…). */
  blockers: ChangeBlocker[]
  /** Task 44a: the change's cost totals (each op carries its own `cost`); null on old plans. */
  costTotal?: PlanCostTotal | null
}

/**
 * Task 44a: a change's estimate totals — the monthly difference, one-time and yearly amounts,
 * how many costed ops have no figure, and when the prices were read. Never part of plan_hash.
 */
export interface PlanCostTotal {
  deltaMonthlyCents: number
  oneTimeCents: number
  yearlyCents: number
  unknownOps: number
  checkedAt: string
}

/** What `nivaro_hub_resource_changes.plan` holds. */
export interface StoredChangePlan {
  request: PlanRequest
  ops: PlannedOp[]
  gates: ChangeGate[]
  needsConfirm: string | null
  needsApproval: boolean
  blockers: ChangeBlocker[]
  /** Hash of every op's preconditions (part of planHash). */
  preconditionFingerprint: string
  /** Task 44a: the estimate totals the plan showed (not part of planHash). */
  costTotal?: PlanCostTotal | null
  /** Same length as `ops`: the Hub resource row each op is for (null = a create not stored yet). */
  resourceIds: Array<number | null>
  /**
   * Task 1 (engine): same length as `ops` — the index in `request.ops` each planned op came from
   * (an adapter may answer several ops for one request op).
   */
  sources?: number[]
  /** Task 1: the pre-deploy checklist an owner's pending change was started with (claimed on approval). */
  checklistRunId?: number | null
  /** Task 1: the change this one undoes (undoResourceChange). */
  undoOf?: number | null
  /**
   * Task 1: the NEW plain values of secret fields this change sets, as ONE sealed envelope
   * (sealSecret of `{"<request op index>:<field>": plain}`); request ops hold only
   * `{fingerprint, changed}`. Never answer it: use plan.ts `publicStoredPlan`.
   */
  sealed?: string | null
  /**
   * Task 11a: the Hub run that carries this change (a promotion's provider step, a creation's
   * providers step, a retirement's resource deletes). Set only by the server through
   * planCarriedResourceChange, never by a request; re-judged at every plan and start.
   */
  origin?: ChangeOrigin | null
}

/**
 * Task 11a: a change made BY another Hub run, as its mechanism. Each kind is a narrow, explicit
 * exception the engine re-checks against the run's own row (gates.ts judgeOrigin):
 *  - promotion  the running deploy row of this environment: adopt / update only; the promotion
 *               already judged freezes, deploy windows and its checklist (rollbacks are exempt from
 *               freezes), so those are not judged twice; a retired app is still refused.
 *  - creation   the running creation of this environment: create / adopt / update only; the
 *               production checklist is the creation's, freezes and windows still apply.
 *  - retirement the open retirement of this app, its `remove` step running: deletes only; the
 *               app may be archived (ENV_ARCHIVED is not judged) and the retirement's own freeze
 *               `retire:<id>` is left out — every other freeze and window (action `retire`) still
 *               stops it, as for the retirement's own steps.
 */
export type ChangeOrigin =
  | { kind: 'promotion'; deployId: number }
  | { kind: 'creation'; creationId: number }
  | { kind: 'retirement'; retirementId: number }

/** One entry of `nivaro_hub_resource_changes.steps`, one per op (same order as plan.ops). */
export interface ChangeStep {
  index: number
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  resourceId: number | null
  /** The state read just before the op ran (kept for undo and audit). */
  before: Observed | null
  result: OpResult | null
  snapshot: SnapshotRef | null
  error: OpError | null
  startedAt: string | null
  finishedAt: string | null
  /**
   * Task 1: the resource's stored desired fields just before the op (refs as RefValue, secrets
   * sealed as StoredSecretField — never plain) — what an undo plans back to.
   */
  beforeDesired?: Record<string, unknown> | null
  /**
   * Task 11c: on a step that failed AUTH_FAILED, the connection's `secret_fingerprint` at the
   * failure (null = it had no secret). Resume lets the change through once the keys changed
   * (engine/resume-rule.ts). Absent on every other step.
   */
  connectionFingerprint?: string | null
}

// ── Errors ──

export const RESOURCE_CHANGE_CODES = {
  NOT_FOUND: 404,
  CONNECTION_NOT_FOUND: 404,
  UNKNOWN_TYPE: 400,
  INVALID_FIELDS: 400,
  CAPABILITY_MISSING: 400,
  CONFIRM_MISMATCH: 400,
  ADMIN_ONLY: 403,
  SHARED_ADMIN_ONLY: 403,
  CONNECTION_NOT_ALLOWED: 403,
  PRODUCTION_ADMIN_ONLY: 403,
  HUB_WRITE_NOT_FOR_AGENTS: 403,
  DELEGATED_NO_WRITE: 403,
  STALE_PLAN: 409,
  PRECONDITION_CHANGED: 409,
  BAD_STATUS: 409,
  APPROVAL_REQUIRED: 409,
  RESOURCE_BUSY: 409,
  RESOURCE_ALREADY_MANAGED: 409,
  NOT_REVERSIBLE: 409,
  SHARED_IN_USE: 409,
  BUCKET_NOT_EMPTY: 409,
  FROZEN: 409,
  MOVE_OPEN: 409,
  OUTSIDE_WINDOW: 409,
  CHECKLIST_REQUIRED: 409,
  CHECKLIST_INCOMPLETE: 409,
  PROVIDER_ERROR: 502,
  // Task 1 (engine) additions: the existing Hub gates' other answers, passed through as they are.
  CHECKLIST_MISMATCH: 409,
  CHECKLIST_USED: 409,
  CHECKLIST_UNKNOWN: 503,
  FREEZE_UNKNOWN: 503,
  MOVE_UNKNOWN: 503,
  ENV_ARCHIVED: 409,
  WINDOW_INVALID: 409,
  LOCK_UNAVAILABLE: 503,
  CONNECTION_DISABLED: 409,
  ALREADY_EXISTS: 409,
  // Task 11a: a carried change whose run is not (or no longer) the one it names.
  ORIGIN_INVALID: 409,
  NOT_IMPLEMENTED: 501,
  // Task 3b: the provider refused the connection's credentials (never retryable — fix the keys).
  AUTH_FAILED: 502,
  // Task 11c: a named op whose target is not the one its change may act on (another workflow,
  // GitHub environment, run or commit than planned) — nothing was sent.
  TARGET_MISMATCH: 409
} as const

export type ResourceChangeCode = keyof typeof RESOURCE_CHANGE_CODES

export class ResourceChangeError extends Error {
  code: ResourceChangeCode
  status: number
  details?: Record<string, unknown>
  constructor(code: ResourceChangeCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ResourceChangeError'
    this.code = code
    this.status = RESOURCE_CHANGE_CODES[code]
    if (details) this.details = details
  }
}

// ── Engine functions (Task 1: plan.ts, run.ts, approval.ts, undo.ts) ──
// Loaded on call, so this module (types + errors) stays a leaf every engine file imports.

/** Reads the provider, diffs, stores a `planned` change. Nothing is written at the provider. */
export async function planResourceChange(req: PlanRequest, actor: HubActor): Promise<ChangePlan> {
  const { createPlannedChange } = await import('./run.js')
  return createPlannedChange(req, actor, { mode: 'request' })
}

/**
 * Task 11a: plans a change carried by another Hub run (see ChangeOrigin). Never reachable from a
 * request body: only Hub runs call it, with the origin they are.
 */
export async function planCarriedResourceChange(
  req: PlanRequest,
  actor: HubActor,
  origin: ChangeOrigin
): Promise<ChangePlan> {
  const { createPlannedChange } = await import('./run.js')
  return createPlannedChange(req, actor, { mode: 'request', origin })
}

/**
 * Starts a planned change (or saves it `pending_approval` for an owner's cost change). Refused
 * STALE_PLAN when `planHash` differs, CONFIRM_MISMATCH when `confirm` ≠ needsConfirm.
 * `checklistRunId` (Task 1, optional): the ticked pre-deploy checklist of a production change
 * (checklist version `resource-change-<changeId>`).
 */
export async function startResourceChange(
  changeId: number,
  input: { planHash: string; confirm?: string; checklistRunId?: number | null },
  actor: HubActor
): Promise<ChangePlan> {
  const { startChange } = await import('./run.js')
  return startChange(changeId, input, actor)
}

export async function cancelResourceChange(changeId: number, actor: HubActor): Promise<ChangePlan> {
  const { cancelChange } = await import('./run.js')
  return cancelChange(changeId, actor)
}

/** Re-runs an `interrupted` / failed-retryable change: only steps without a recorded success. */
export async function resumeResourceChange(changeId: number, actor: HubActor): Promise<ChangePlan> {
  const { resumeChange } = await import('./run.js')
  return resumeChange(changeId, actor)
}

/** A NEW planned change from the observed state back to the stored before-state. */
export async function undoResourceChange(changeId: number, actor: HubActor): Promise<ChangePlan> {
  const { undoChange } = await import('./undo.js')
  return undoChange(changeId, actor)
}

/** Hub admin approves a pending_approval change; starts it only if the plan hash still matches. */
export async function approveResourceChange(
  changeId: number,
  input: { planHash: string },
  actor: HubActor
): Promise<ChangePlan> {
  const { approveChange } = await import('./approval.js')
  return approveChange(changeId, input, actor)
}

export async function declineResourceChange(
  changeId: number,
  reason: string,
  actor: HubActor
): Promise<ChangePlan> {
  const { declineChange } = await import('./approval.js')
  return declineChange(changeId, reason, actor)
}

/**
 * Task 1: `applying` changes whose runner stopped (old heartbeat, lock gone) become
 * `interrupted`. Call it before reading changes (the REST layer) and from a Hub tick.
 */
export async function healResourceChanges(changeId?: number): Promise<number> {
  const run = await import('./run.js')
  return run.healResourceChanges(changeId)
}

/**
 * Task 3b: drops a resource row whose create never reached the provider (no provider call; the
 * failed change is closed as cancelled; one audit row). engine/discard.ts.
 */
export async function discardResourceCreate(
  resourceId: number,
  actor: HubActor
): Promise<{ resourceId: number; changeId: number | null }> {
  const { discardFailedCreate } = await import('./discard.js')
  return discardFailedCreate(resourceId, actor)
}
