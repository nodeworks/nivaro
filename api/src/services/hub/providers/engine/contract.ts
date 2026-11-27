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
}

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
  NOT_IMPLEMENTED: 501
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
